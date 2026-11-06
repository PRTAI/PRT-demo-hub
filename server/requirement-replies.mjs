import { z } from 'zod';
import { uid, now, parse } from './db.mjs';
import { developmentOwnerRoles } from '../shared/requirement-owners.mjs';

export function setupRequirementReplies(app, store, { requirementFor, canView, canReply, notifications, event, fail }) {
  const { one, all, run, tx } = store;
  const visibleRequirement = req => {
    const requirement = requirementFor(req.params.id);
    if (!canView(req.user, requirement)) fail(403, '该需求未指定给当前账号');
    return requirement;
  };
  const view = row => ({
    id: row.id, sequence: row.sequence, content: row.content, createdAt: row.created_at,
    author: { id: row.author_id, name: one('SELECT name FROM users WHERE id=?', row.author_id).name },
    parent: row.parent_id ? one(`SELECT r.id,r.content,u.name AS authorName FROM requirement_replies r JOIN users u ON u.id=r.author_id WHERE r.id=?`, row.parent_id) : null,
    mentions: all('SELECT user_id AS id,name FROM requirement_reply_mentions WHERE reply_id=? ORDER BY rowid', row.id)
  });
  const isCandidate = (user, requirement) => user?.enabled && !user.deleted_at && parse(user.roles, []).some(role => developmentOwnerRoles.includes(role)) && canView(user, requirement);
  app.get('/api/requirements/:id/replies', (req, res) => {
    const requirement = visibleRequirement(req);
    const query = z.object({ before: z.coerce.number().int().positive().optional(), after: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    if (query.before !== undefined && query.after !== undefined) fail(400, '不能同时指定前后分页位置');
    const ascending = query.after !== undefined, cursor = query.before ?? query.after;
    const rows = all(`SELECT * FROM requirement_replies WHERE requirement_id=? ${cursor !== undefined ? `AND sequence${ascending ? '>' : '<'}?` : ''} ORDER BY sequence ${ascending ? 'ASC' : 'DESC'} LIMIT ?`, requirement.id, ...(cursor !== undefined ? [cursor] : []), query.limit + 1);
    const hasMore = rows.length > query.limit, page = rows.slice(0, query.limit);
    if (!ascending) page.reverse();
    res.json({ items: page.map(view), hasMore, beforeCursor: page[0]?.sequence || null, afterCursor: page.at(-1)?.sequence || null,
      total: one('SELECT COUNT(*) AS count FROM requirement_replies WHERE requirement_id=?', requirement.id).count, canReply: canReply(req.user, requirement) });
  });
  app.get('/api/requirements/:id/reply-candidates', (req, res) => {
    const requirement = visibleRequirement(req);
    if (!canReply(req.user, requirement)) fail(403, '当前账号仅可查看需求回复');
    const q = z.string().max(100).default('').parse(req.query.q).trim().toLowerCase();
    const items = all('SELECT * FROM users WHERE enabled=1 AND deleted_at IS NULL ORDER BY name,id')
      .filter(user => user.name.toLowerCase().includes(q) && isCandidate(user, requirement)).slice(0, 50)
      .map(user => ({ id: user.id, name: user.name, roles: parse(user.roles, []) }));
    res.json({ items });
  });
  app.post('/api/requirements/:id/replies', (req, res) => {
    const input = z.object({ content: z.string().trim().min(1).max(5000), mentionUserIds: z.array(z.string().min(1).max(100)).max(20).default([]), parentId: z.uuid().nullable().default(null), requestId: z.uuid() }).parse(req.body);
    const result = tx(() => {
      const requirement = visibleRequirement(req);
      if (!canReply(req.user, requirement)) fail(403, '当前账号仅可查看需求回复');
      const ids = [...new Set(input.mentionUserIds)].sort(), payload = JSON.stringify({ requirementId: requirement.id, content: input.content, parentId: input.parentId, mentionUserIds: ids });
      const previous = one('SELECT * FROM requirement_replies WHERE author_id=? AND request_id=?', req.user.id, input.requestId);
      if (previous) {
        if (previous.payload !== payload) fail(409, '此回复请求已经发送，请刷新后重新填写');
        return { reply: view(previous), repeated: true };
      }
      const parent = input.parentId ? one('SELECT * FROM requirement_replies WHERE id=? AND requirement_id=?', input.parentId, requirement.id) : null;
      if (input.parentId && !parent) fail(400, '被回复的内容不存在或不属于当前需求');
      const people = ids.map(id => one('SELECT * FROM users WHERE id=?', id));
      if (people.some(user => !isCandidate(user, requirement))) fail(400, '@ 人员中包含无权查看该需求或已停用的研发人员，请刷新人员后重试');
      const id = uid();
      run('INSERT INTO requirement_replies(id,requirement_id,author_id,content,parent_id,request_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?)', id, requirement.id, req.user.id, input.content, input.parentId, input.requestId, payload, now());
      for (const user of people) run('INSERT INTO requirement_reply_mentions(reply_id,user_id,name) VALUES(?,?,?)', id, user.id, user.name);
      const row = one('SELECT * FROM requirement_replies WHERE id=?', id);
      const recipients = new Set(ids);
      if (parent) recipients.add(parent.author_id);
      const recipientIds = [...recipients].filter(id => id !== req.user.id).filter(id => {
        const user = one('SELECT * FROM users WHERE id=?', id);
        return user?.enabled && !user.deleted_at && parse(user.roles, []).length && canView(user, requirement);
      });
      notifications.enqueueRequirementReply(requirement, row, req.user, recipientIds);
      event(req.user, 'requirement_reply', null, null, { requirementId: requirement.id, replyId: id, parentId: input.parentId, mentionUserIds: ids });
      return { reply: view(row), repeated: false };
    });
    res.status(result.repeated ? 200 : 201).json(result.reply);
  });
}
