import { z } from 'zod';
import { uid, now } from './db.mjs';
import { publicUser } from './auth.mjs';
import { queryCatalog } from './catalog.mjs';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { textLinks, feishuDocumentLink } from '../shared/requirement-links.mjs';
import { previewFeishuDocument } from './feishu-documents.mjs';
import { requirementDate, validRequirementDate } from '../shared/requirement-schedule.mjs';
import { businessOwnerRoles, developmentOwnerRoles, defaultResponsibility, splitRequirementOwners } from '../shared/requirement-owners.mjs';
import { createRequirementExports, requirementExportRows, requirementWorkbook } from './requirement-export.mjs';

const userIdsSchema = z.array(z.string().trim().min(1).max(100)).max(100);
const dateSchema = z.string().refine(value => value === '' || validRequirementDate(value), '请选择有效日期').optional();
const contentSchema = z.object({ title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(20000), category: z.string().trim().max(80).default(''), assignedUserIds: userIdsSchema.default([]), businessUserIds: userIdsSchema.optional(), developmentUserIds: userIdsSchema.optional(), plannedDate: dateSchema, publishDate: dateSchema, deadlineDate: dateSchema });
const revisionSchema = z.object({ revision: z.number().int().nonnegative() });
const idsSchema = z.array(z.uuid()).max(20).transform(ids => [...new Set(ids)]);
const filterSchema = z.object({ q: z.string().max(200).default(''), status: z.enum(['all', 'active', 'open', 'needs_update', 'delivered', 'closed']).default('all'), assigned: z.enum(['0', '1']).default('0') });
const listSchema = filterSchema.extend({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(10) });
// Keep closed requirements last; within each group, dated requirements precede undated ones.
const requirementOrder = "(r.status='closed') ASC,(r.deadline_date='') ASC,r.deadline_date ASC,r.updated_at DESC,r.rowid DESC";

export function createRequirements(app, store, helpers) {
  const { one, all, run, tx } = store;
  const { has, fail, assetFor, visible, summary, event, touch, checkRevision, settings, notifications, requirementCalendar, requirementWiki } = helpers;
  const exports = createRequirementExports(store, requirementWiki, { demoMode: helpers.demoMode });
  const requireExportPermission = user => { if (!has(user, 'pm')) fail(403, '仅项目经理可以导出需求表格'); };
  const canPublish = user => has(user, 'pm') || has(user, 'business');
  const canManage = (user, requirement) => canPublish(user) && requirement.publisher_id === user.id;
  const canStatusManage = user => canPublish(user);
  const canRetryCalendar = user => canPublish(user) || has(user, 'admin');
  const assigned = id => all('SELECT u.*,ra.responsibility FROM users u JOIN requirement_assignees ra ON ra.user_id=u.id WHERE ra.requirement_id=? ORDER BY u.name,u.id', id);
  const documents = id => all('SELECT f.id,f.original_name AS name,f.size,f.checksum,f.created_at AS createdAt FROM files f JOIN requirement_files rf ON rf.file_id=f.id WHERE rf.requirement_id=? ORDER BY rf.created_at,rf.file_id', id);
  const canView = (user, requirement) => canPublish(user) || !!one('SELECT 1 FROM requirement_assignees WHERE requirement_id=? AND user_id=?', requirement.id, user.id);
  const canForward = (user, requirement) => canView(user, requirement) && (canPublish(user) || has(user, 'supervisor'));
  const canReceiveForward = (actor, recipient) => recipient && recipient.enabled && !recipient.deleted_at && recipient.id !== actor.id && (canPublish(actor) ? has(recipient, 'supervisor') || has(recipient, 'employee') : has(recipient, 'employee') && !has(recipient, 'supervisor'));
  const validateAssignees = ids => {
    const unique = [...new Set(ids)];
    for (const id of unique) if (!one('SELECT id FROM users WHERE id=? AND enabled=1 AND deleted_at IS NULL', id)) fail(400, '指定人员中包含无效或已停用账号');
    return unique;
  };
  const updateAssignees = (requirementId, content, actorId) => {
    const previous = assigned(requirementId), groups = splitRequirementOwners(previous);
    const people = new Map();
    if (content.businessUserIds !== undefined || content.developmentUserIds !== undefined) {
      for (const [field, responsibility, roles, existing] of [
        ['businessUserIds', 'business', businessOwnerRoles, groups.businessOwners],
        ['developmentUserIds', 'development', developmentOwnerRoles, groups.developmentOwners]
      ]) {
        for (const id of validateAssignees(content[field] ?? existing.map(user => user.id))) {
          const user = one('SELECT * FROM users WHERE id=?', id);
          if (!roles.some(role => has(user, role)) && !existing.some(person => person.id === id)) fail(400, responsibility === 'business' ? '商务负责人请选择已启用的商务账号' : '研发负责人请选择已启用的员工、主管或产品经理账号');
          people.set(id, people.has(id) ? 'both' : responsibility);
        }
      }
    } else {
      for (const id of validateAssignees(content.assignedUserIds)) {
        const user = publicUser(one('SELECT * FROM users WHERE id=?', id));
        people.set(id, previous.find(person => person.id === id)?.responsibility || defaultResponsibility(user.roles));
      }
    }
    if (people.size > 100) fail(400, '每条需求最多关联 100 位人员');
    run('DELETE FROM requirement_assignees WHERE requirement_id=?', requirementId);
    for (const [id, responsibility] of people) run('INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at,responsibility) VALUES(?,?,?,?,?)', requirementId, id, actorId, now(), responsibility);
  };
  const schedule = (content, requirement) => {
    const publishDate = content.publishDate || content.plannedDate || requirement?.planned_date || requirementDate(requirement?.created_at);
    const deadlineDate = content.deadlineDate ?? requirement?.deadline_date ?? '';
    if (deadlineDate && deadlineDate < publishDate) fail(400, '截止日期不能早于发布日期');
    return { publishDate, deadlineDate };
  };
  const requirementFor = id => {
    const requirement = one('SELECT * FROM requirements WHERE id=?', id);
    if (!requirement) fail(404, '需求不存在');
    return requirement;
  };
  const data = (user, requirement) => {
    const people = assigned(requirement.id), groups = splitRequirementOwners(people), dates = schedule({}, requirement);
    return { id: requirement.id, title: requirement.title, content: requirement.content, category: requirement.category, status: requirement.status, publisher: publicUser(one('SELECT * FROM users WHERE id=?', requirement.publisher_id)), assignedUsers: people.map(publicUser), businessOwners: groups.businessOwners.map(publicUser), developmentOwners: groups.developmentOwners.map(publicUser), ...dates, plannedDate: dates.publishDate, calendar: requirementCalendar.info(requirement.id), canRetryCalendar: canRetryCalendar(user), wiki: requirementWiki.info(requirement.id), canSyncWiki: canRetryCalendar(user), documents: documents(requirement.id), revision: requirement.revision, createdAt: requirement.created_at, updatedAt: requirement.updated_at, canManage: canManage(user, requirement), canStatusManage: canStatusManage(user), canView: canView(user, requirement), canForward: canForward(user, requirement) };
  };
  const linkedAssets = (user, id) => all('SELECT a.* FROM assets a JOIN asset_requirements ar ON ar.asset_id=a.id WHERE ar.requirement_id=? ORDER BY a.updated_at DESC,a.id', id).filter(asset => visible(user, asset));
  const forAsset = id => all('SELECT r.id,r.title,r.category,r.status FROM requirements r JOIN asset_requirements ar ON ar.requirement_id=r.id WHERE ar.asset_id=? ORDER BY r.created_at,r.id', id);
  const validateIds = (input, previous = []) => {
    const ids = idsSchema.parse(input);
    for (const id of ids) {
      const requirement = requirementFor(id);
      if (requirement.status === 'closed' && !previous.includes(id)) fail(409, '已关闭的需求不能新增绑定，请选择进行中的需求');
    }
    return ids;
  };
  const replace = (user, asset, input) => {
    const before = forAsset(asset.id), ids = validateIds(input, before.map(requirement => requirement.id));
    if (!ids.length && before.length && one("SELECT id FROM versions WHERE asset_id=? AND status IN ('pending','published') LIMIT 1", asset.id)) fail(409, '待审核或已发布 Demo 必须保留至少一个关联需求');
    if (ids.length === before.length && before.every(requirement => ids.includes(requirement.id))) return;
    run('DELETE FROM asset_requirements WHERE asset_id=?', asset.id);
    for (const id of ids) run('INSERT INTO asset_requirements VALUES(?,?,?,?)', asset.id, id, user.id, now());
    for (const id of new Set([...before.map(requirement => requirement.id), ...ids])) requirementWiki.enqueueExisting(id);
    event(user, 'requirements_update', asset.id, null, { before, after: forAsset(asset.id) });
  };

  const filteredRequirements = (user, query) => {
    const conditions = [], args = [];
    if (query.assigned === '1' || !canPublish(user)) { conditions.push('EXISTS(SELECT 1 FROM requirement_assignees ra WHERE ra.requirement_id=r.id AND ra.user_id=?)'); args.push(user.id); }
    if (query.status === 'active') conditions.push("r.status IN ('open','needs_update')");
    else if (query.status !== 'all') { conditions.push('r.status=?'); args.push(query.status); }
    if (query.q.trim()) {
      conditions.push("(r.title LIKE ? ESCAPE '\\' OR r.content LIKE ? ESCAPE '\\' OR r.category LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM requirement_assignees search_ra JOIN users search_u ON search_u.id=search_ra.user_id WHERE search_ra.requirement_id=r.id AND search_u.name LIKE ? ESCAPE '\\'))");
      const pattern = '%' + query.q.trim().replace(/[\\%_]/g, '\\$&') + '%'; args.push(pattern, pattern, pattern, pattern, pattern);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const from = 'FROM requirements r JOIN users u ON u.id=r.publisher_id';
    return { from, where, args };
  };
  app.get('/api/requirements', (req, res) => {
    const query = listSchema.parse(req.query), { from, where, args } = filteredRequirements(req.user, query);
    const total = one(`SELECT COUNT(*) AS total ${from} ${where}`, ...args).total, pages = Math.max(1, Math.ceil(total / query.pageSize)), page = Math.min(query.page, pages);
    const items = all(`SELECT r.* ${from} ${where} ORDER BY ${requirementOrder} LIMIT ? OFFSET ?`, ...args, query.pageSize, (page - 1) * query.pageSize).map(requirement => ({ ...data(req.user, requirement), demoCount: linkedAssets(req.user, requirement.id).length }));
    res.json({ items, total, pages, page, canPublish: canPublish(req.user), canExport: has(req.user, 'pm') });
  });
  app.get('/api/requirements/export.xlsx', async (req, res) => {
    requireExportPermission(req.user);
    const query = filterSchema.parse(req.query), { from, where, args } = filteredRequirements(req.user, query);
    const rows = all(`SELECT r.* ${from} ${where} ORDER BY ${requirementOrder}`, ...args).flatMap(requirement => requirementExportRows(requirement, assigned(requirement.id), linkedAssets(req.user, requirement.id).map(asset => summary(req.user, asset, false)), requirementWiki.info(requirement.id).url));
    const file = await requirementWorkbook(rows);
    res.attachment(`requirements-${requirementDate()}.xlsx`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(file);
  });
  app.post('/api/requirements/exports', (req, res) => {
    requireExportPermission(req.user);
    const query = filterSchema.parse(req.body), { from, where, args } = filteredRequirements(req.user, query);
    const selected = all(`SELECT r.* ${from} ${where} ORDER BY ${requirementOrder}`, ...args);
    if (!helpers.demoMode && selected.length) {
      const error = requirementWiki.configurationError();
      if (error) fail(400, error);
    }
    const items = selected.map(requirement => ({ id: requirement.id, title: requirement.title, rows: requirementExportRows(requirement, assigned(requirement.id), linkedAssets(req.user, requirement.id).map(asset => summary(req.user, asset, false))) }));
    const job = exports.create(req.user.id, query, items);
    event(req.user, 'requirement_export', null, null, { exportId: job.id, filters: query, requirements: items.length });
    res.status(202).json(job);
  });
  app.get('/api/requirements/exports/:id', (req, res) => {
    requireExportPermission(req.user);
    const job = exports.status(req.params.id, req.user.id);
    if (!job) fail(404, '导出任务不存在或已过期，请重新按当前筛选导出');
    res.json(job);
  });
  app.post('/api/requirements/exports/:id/retry', (req, res) => {
    requireExportPermission(req.user);
    const job = exports.retry(req.params.id, req.user.id);
    if (!job) fail(404, '导出任务不存在或已过期，请重新按当前筛选导出');
    res.json(job);
  });
  app.get('/api/requirements/exports/:id/file.xlsx', async (req, res) => {
    requireExportPermission(req.user);
    const job = exports.status(req.params.id, req.user.id);
    if (!job) fail(404, '导出任务不存在或已过期，请重新按当前筛选导出');
    if (job.status !== 'ready') fail(409, job.status === 'failed' ? '部分飞书文档同步失败，请先重试失败项再导出' : '飞书文档正在创建或更新，请等待同步完成后下载');
    const file = await requirementWorkbook(exports.rows(job.id, req.user.id));
    res.attachment(`requirements-${requirementDate()}.xlsx`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(file);
  });
  app.get('/api/requirements/assignees', (req, res) => {
    if (!canPublish(req.user)) fail(403, '仅产品经理和商务可以指定需求人员');
    res.json({ items: all('SELECT * FROM users WHERE enabled=1 ORDER BY name,id').map(publicUser) });
  });
  app.post('/api/requirements', (req, res) => {
    if (!canPublish(req.user)) fail(403, '仅产品经理和商务可以发布需求');
    const content = contentSchema.parse(req.body);
    const id = uid(), time = now();
    tx(() => {
      const dates = schedule(content);
      run("INSERT INTO requirements(id,title,content,category,status,publisher_id,created_at,updated_at,planned_date,deadline_date) VALUES(?,?,?,?,'open',?,?,?,?,?)", id, content.title, content.content, content.category, req.user.id, time, time, dates.publishDate, dates.deadlineDate);
      updateAssignees(id, content, req.user.id);
      event(req.user, 'requirement_publish', null, null, { requirementId: id, title: content.title });
      notifications.enqueueRequirement(requirementFor(id));
      requirementCalendar.enqueue(id);
      requirementWiki.enqueue(id);
    });
    res.status(201).json(data(req.user, requirementFor(id)));
  });
  app.get('/api/requirements/:id', (req, res) => {
    const requirement = requirementFor(req.params.id);
    if (!canView(req.user, requirement)) fail(403, '该需求未指定给当前账号');
    res.json({ ...data(req.user, requirement), demos: linkedAssets(req.user, requirement.id).map(asset => summary(req.user, asset, false)) });
  });
  app.get('/api/requirements/:id/calendar', (req, res) => {
    const requirement = requirementFor(req.params.id);
    if (!canView(req.user, requirement)) fail(403, '该需求未指定给当前账号');
    res.json(requirementCalendar.info(requirement.id));
  });
  app.get('/api/requirements/:id/wiki', (req, res) => {
    const requirement = requirementFor(req.params.id);
    if (!canView(req.user, requirement)) fail(403, '该需求未指定给当前账号');
    res.json(requirementWiki.info(requirement.id));
  });
  app.post('/api/requirements/:id/wiki/retry', (req, res) => {
    if (!canRetryCalendar(req.user)) fail(403, '仅商务、项目经理和管理员可以同步需求飞书文档');
    const requirement = requirementFor(req.params.id);
    if (!requirementWiki.retry(requirement.id)) fail(409, '文档正在同步，请稍后刷新');
    event(req.user, 'requirement_wiki_retry', null, null, { requirementId: requirement.id });
    res.json(requirementWiki.info(requirement.id));
  });
  app.post('/api/requirements/:id/calendar/retry', (req, res) => {
    if (!canRetryCalendar(req.user)) fail(403, '仅商务、产品经理和管理员可以重试需求日历同步');
    tx(() => {
      const requirement = requirementFor(req.params.id);
      if (!requirementCalendar.retry(requirement.id)) fail(409, '仅失败的日历任务可以重试，请刷新后查看状态');
      event(req.user, 'requirement_calendar_retry', null, null, { requirementId: requirement.id });
    });
    res.json(requirementCalendar.info(req.params.id));
  });
  app.put('/api/requirements/:id', (req, res) => {
    const { revision } = revisionSchema.parse(req.body), content = contentSchema.parse(req.body);
    tx(() => {
      const requirement = requirementFor(req.params.id);
      if (!canManage(req.user, requirement)) fail(403, '仅发布人可以修改自己的需求');
      checkRevision(requirement, revision);
      const dates = schedule(content, requirement);
      run('UPDATE requirements SET title=?,content=?,category=?,planned_date=?,deadline_date=?,revision=revision+1,updated_at=? WHERE id=?', content.title, content.content, content.category, dates.publishDate, dates.deadlineDate, now(), requirement.id);
      updateAssignees(requirement.id, content, req.user.id);
      requirementCalendar.enqueue(requirement.id);
      requirementWiki.enqueueExisting(requirement.id);
      event(req.user, 'requirement_edit', null, null, { requirementId: requirement.id, before: { title: requirement.title, content: requirement.content, category: requirement.category }, after: content });
    });
    res.json(data(req.user, requirementFor(req.params.id)));
  });
  app.get('/api/requirements/:id/forward-candidates', (req, res) => {
    const requirement = requirementFor(req.params.id);
    if (!canForward(req.user, requirement)) fail(403, '仅商务、产品经理及有权查看该需求的主管可以转发需求');
    const assignedIds = new Set(all('SELECT user_id FROM requirement_assignees WHERE requirement_id=?', requirement.id).map(item => item.user_id));
    const items = all('SELECT * FROM users WHERE enabled=1 AND deleted_at IS NULL ORDER BY name,id').filter(user => canReceiveForward(req.user, user)).map(user => ({ ...publicUser(user), assigned: assignedIds.has(user.id) }));
    res.json({ items, revision: requirement.revision, assignedCount: assignedIds.size, maxAssignees: 100, allowedRoles: canPublish(req.user) ? ['supervisor', 'employee'] : ['employee'] });
  });
  app.post('/api/requirements/:id/forward', (req, res) => {
    const { revision, assignedUserIds } = revisionSchema.extend({ assignedUserIds: z.array(z.string().trim().min(1).max(100)).min(1).max(100).transform(ids => [...new Set(ids)]) }).parse(req.body);
    const addedUserIds = tx(() => {
      const requirement = requirementFor(req.params.id);
      if (!canForward(req.user, requirement)) fail(403, '仅商务、产品经理及有权查看该需求的主管可以转发需求');
      checkRevision(requirement, revision);
      const recipients = assignedUserIds.map(id => {
        const recipient = one('SELECT * FROM users WHERE id=?', id);
        if (!canReceiveForward(req.user, recipient)) fail(400, canPublish(req.user) ? '只能转发给其他已启用的主管或员工' : '主管只能转发给已启用的员工，不能转发给主管');
        return recipient;
      });
      const before = all('SELECT user_id FROM requirement_assignees WHERE requirement_id=?', requirement.id).map(item => item.user_id);
      const added = recipients.filter(recipient => !before.includes(recipient.id));
      if (before.length + added.length > 100) fail(400, '每条需求最多关联 100 位人员');
      if (!added.length) return [];
      const time = now();
      for (const recipient of added) run("INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at,responsibility) VALUES(?,?,?,?,'development')", requirement.id, recipient.id, req.user.id, time);
      run('UPDATE requirements SET revision=revision+1,updated_at=? WHERE id=?', time, requirement.id);
      requirementCalendar.enqueue(requirement.id);
      requirementWiki.enqueueExisting(requirement.id);
      event(req.user, 'requirement_forward', null, null, { requirementId: requirement.id, title: requirement.title, recipients: added.map(recipient => ({ id: recipient.id, name: recipient.name })) });
      return added.map(recipient => recipient.id);
    });
    res.json({ ...data(req.user, requirementFor(req.params.id)), addedUserIds });
  });
  app.get('/api/requirements/:id/link-preview', async (req, res) => {
    const requirement = requirementFor(req.params.id);
    if (!canView(req.user, requirement)) fail(403, '该需求未指定给当前账号');
    const url = z.string().max(2000).parse(req.query.url);
    if (!textLinks(requirement.content).includes(url) || !feishuDocumentLink(url)) fail(400, '只能预览该需求正文中的飞书文档链接');
    res.json(await previewFeishuDocument(url, helpers.documentToken(req)));
  });
  app.post('/api/requirements/:id/actions', (req, res) => {
    const { revision, action, status } = revisionSchema.extend({ action: z.enum(['close', 'reopen', 'set_status']), status: z.enum(['open', 'needs_update', 'delivered', 'closed']).optional() }).parse(req.body);
    tx(() => {
      const requirement = requirementFor(req.params.id);
      if (action === 'set_status' ? !canStatusManage(req.user) : !canManage(req.user, requirement)) fail(403, action === 'set_status' ? '仅产品经理和商务可以修改需求状态' : '仅发布人可以关闭或重新开启自己的需求');
      checkRevision(requirement, revision);
      const next = action === 'set_status' ? status : action === 'close' ? 'closed' : 'open';
      if (!next || requirement.status === next) fail(409, '需求状态已变化，请刷新后重试');
      if (action !== 'set_status' && requirement.status !== (action === 'close' ? 'open' : 'closed')) fail(409, '需求状态已变化，请刷新后重试');
      run('UPDATE requirements SET status=?,revision=revision+1,updated_at=? WHERE id=?', next, now(), requirement.id);
      requirementCalendar.enqueue(requirement.id);
      event(req.user, action === 'set_status' ? 'requirement_status' : 'requirement_' + action, null, null, { requirementId: requirement.id, title: requirement.title, from: requirement.status, to: next });
    });
    res.json(data(req.user, requirementFor(req.params.id)));
  });
  app.post('/api/requirements/:id/documents', async (req, res, next) => {
    let uploaded;
    try {
      const requirement = requirementFor(req.params.id);
      if (!canManage(req.user, requirement)) fail(403, '仅需求发布人可以上传或管理需求文档');
      const conf = settings();
      const upload = multer({ storage: multer.diskStorage({ destination: path.join(store.root, 'tmp'), filename: (r, f, cb) => cb(null, uid()) }), limits: { fileSize: conf.maxFileMB * 1048576, files: 1, fields: 0, parts: 2 } }).single('file');
      await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
      uploaded = req.file;
      if (!uploaded || uploaded.size === 0) fail(400, '请选择非空需求文档');
      const checksum = createHash('sha256'); for await (const chunk of fs.createReadStream(uploaded.path)) checksum.update(chunk);
      const fileId = uid(), decoded = Buffer.from(uploaded.originalname, 'latin1').toString('utf8'), original = decoded.includes('\uFFFD') ? uploaded.originalname : decoded;
      const name = path.win32.basename(path.posix.basename(original)).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 240) || '需求文档';
      tx(() => {
        const current = requirementFor(req.params.id); if (!canManage(req.user, current)) fail(403, '仅需求发布人可以上传需求文档');
        fs.renameSync(uploaded.path, path.join(store.root, 'files', fileId)); uploaded.finalPath = path.join(store.root, 'files', fileId);
        run('INSERT INTO files VALUES(?,?,?,?,?,?)', fileId, name, uploaded.size, checksum.digest('hex'), req.user.id, now());
        run('INSERT INTO requirement_files VALUES(?,?,?,?)', current.id, fileId, req.user.id, now());
        run('UPDATE requirements SET revision=revision+1,updated_at=? WHERE id=?', now(), current.id);
        requirementWiki.enqueueExisting(current.id);
        event(req.user, 'requirement_document_upload', null, null, { requirementId: current.id, fileId, name, size: uploaded.size });
      });
      uploaded.committed = true; res.status(201).json({ id: fileId, name, revision: requirementFor(requirement.id).revision });
    } catch (error) { next(error); }
    finally { if (uploaded) { if (fs.existsSync(uploaded.path)) fs.unlinkSync(uploaded.path); if (uploaded.finalPath && !uploaded.committed && fs.existsSync(uploaded.finalPath)) fs.unlinkSync(uploaded.finalPath); } }
  });
  app.get('/api/requirements/:id/documents/:fileId/download', (req, res, next) => {
    try {
      const requirement = requirementFor(req.params.id); if (!canView(req.user, requirement)) fail(403, '该需求未指定给当前账号');
      const file = all('SELECT f.* FROM files f JOIN requirement_files rf ON rf.file_id=f.id WHERE rf.requirement_id=? AND f.id=?', requirement.id, req.params.fileId)[0];
      if (!file) fail(404, '需求文档不存在');
      const target = path.join(store.root, 'files', file.id); if (!fs.existsSync(target)) fail(404, '需求文档文件缺失，请联系管理员恢复');
      res.download(target, file.original_name, { dotfiles: 'allow', cacheControl: false }, error => { if (error) { if (!res.headersSent) next(error); } else event(req.user, 'requirement_document_download', null, null, { requirementId: requirement.id, fileId: file.id, name: file.original_name }); });
    } catch (error) { next(error); }
  });
  app.get('/api/requirements/:id/demo-candidates', (req, res) => {
    const requirement = requirementFor(req.params.id);
    if (!canView(req.user, requirement)) fail(403, '该需求未指定给当前账号');
    const catalog = queryCatalog(store, req.user, { q: req.query.q, page: req.query.page, pageSize: 10 });
    res.json({ ...catalog, assets: undefined, items: catalog.assets.map(asset => ({ ...summary(req.user, asset, false), canBind: canManage(req.user, requirement) })) });
  });
  app.post('/api/requirements/:id/demos', (req, res) => {
    const { assetId, revision } = revisionSchema.extend({ assetId: z.string().min(1).max(100) }).parse(req.body);
    tx(() => {
      const requirement = requirementFor(req.params.id), asset = assetFor(req.user, assetId);
      if (!canManage(req.user, requirement)) fail(403, '仅需求发布人可以在需求中心绑定 Demo');
      checkRevision(asset, revision);
      const ids = forAsset(asset.id).map(item => item.id);
      if (!ids.includes(requirement.id)) { replace(req.user, asset, [...ids, requirement.id]); touch(asset.id); }
    });
    res.json({ ok: true });
  });
  app.delete('/api/requirements/:id/demos/:assetId', (req, res) => {
    const { revision } = revisionSchema.parse(req.body);
    tx(() => {
      const requirement = requirementFor(req.params.id), asset = assetFor(req.user, req.params.assetId);
      if (!canManage(req.user, requirement)) fail(403, '仅需求发布人可以在需求中心解除绑定');
      checkRevision(asset, revision);
      const ids = forAsset(asset.id).map(item => item.id);
      if (ids.includes(requirement.id)) { replace(req.user, asset, ids.filter(id => id !== requirement.id)); touch(asset.id); }
    });
    res.json({ ok: true });
  });
  return { forAsset, validateIds, replace };
}
