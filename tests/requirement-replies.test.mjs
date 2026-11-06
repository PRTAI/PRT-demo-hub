import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app.mjs';
import { createNotifications } from '../server/notifications.mjs';
import { createBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore.mjs';

const origin = 'http://127.0.0.1:5173';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-replies-'));
  const ctx = createApp({ dataDir: path.join(root, 'data'), demoMode: true, origin });
  t.after(() => { ctx.store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  ctx.store.run("UPDATE users SET supervisor_id='preview-other-manager' WHERE id='preview-manager'");
  async function login(id) {
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/demo-login').set('Origin', origin).set('X-Requested-With', 'PRT').send({ userId: id }).expect(200);
    const { csrf } = (await agent.get('/api/auth/me').expect(200)).body;
    return { agent, get: url => agent.get('/api' + url), send: (url, body) => agent.post('/api' + url).set('Origin', origin).set('X-Requested-With', 'PRT').set('X-CSRF-Token', csrf).send(body) };
  }
  const pm = await login('preview-pm');
  const publish = async (assignedUserIds = ['preview-employee', 'preview-colleague']) => (await pm.send('/requirements', { title: '回复功能验收需求', content: '需求正文', assignedUserIds }).expect(201)).body;
  const requirement = await publish();
  const endpoint = `/requirements/${requirement.id}/replies`;
  return { ...ctx, root, login, pm, publish, requirement, endpoint, reply: (client, input = {}) => client.send(endpoint, { content: '进展反馈', requestId: randomUUID(), ...input }) };
}

test('requirement replies allow PM/business/direct assignees and keep inherited readers read-only without changing the requirement', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee'), business = await ctx.login('preview-business'), superior = await ctx.login('preview-other-manager'), outsider = await ctx.login('preview-other');
  await outsider.get(ctx.endpoint).expect(403); await ctx.reply(outsider).expect(403);
  await superior.get(ctx.endpoint).expect(200).then(result => assert.equal(result.body.canReply, false));
  await ctx.reply(superior).expect(403); await superior.get(`/requirements/${ctx.requirement.id}/reply-candidates`).expect(403);
  await ctx.reply(employee, { content: '第一批数据已完成，正在复核' }).expect(201);
  await ctx.reply(business, { content: '客户反馈已补充' }).expect(201);
  await ctx.reply(ctx.pm, { content: '请继续推进' }).expect(201);
  const result = (await employee.get(ctx.endpoint).expect(200)).body;
  assert.equal(result.total, 3); assert.equal(result.canReply, true);
  assert.deepEqual(result.items.map(reply => reply.author.id), ['preview-employee', 'preview-business', 'preview-pm']);
  assert.equal(result.items[0].content, '第一批数据已完成，正在复核');
  const current = (await ctx.pm.get('/requirements/' + ctx.requirement.id).expect(200)).body;
  assert.equal(current.content, ctx.requirement.content); assert.equal(current.status, ctx.requirement.status); assert.equal(current.revision, ctx.requirement.revision);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM events WHERE action='requirement_reply'").count, 3);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM notifications WHERE kind='requirement_reply'").count, 0);
  await employee.agent.post('/api' + ctx.endpoint).send({ content: '伪造请求', requestId: randomUUID() }).expect(403);
});

test('mention candidates only include enabled development people who can view this requirement, and invalid cross-requirement replies or mentions are rejected atomically', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee');
  const candidates = (await employee.get(`/requirements/${ctx.requirement.id}/reply-candidates`).expect(200)).body.items;
  assert.ok(candidates.some(person => person.id === 'preview-colleague')); assert.ok(candidates.some(person => person.id === 'preview-other-manager'));
  assert.ok(!candidates.some(person => ['preview-other', 'preview-business', 'preview-admin'].includes(person.id)));
  const name = ctx.store.one("SELECT name FROM users WHERE id='preview-colleague'").name;
  assert.deepEqual((await employee.get(`/requirements/${ctx.requirement.id}/reply-candidates?q=${encodeURIComponent(name)}`).expect(200)).body.items.map(person => person.id), ['preview-colleague']);
  for (const input of [{ content: '   ' }, { content: '超'.repeat(5001) }, { mentionUserIds: ['preview-other'] }, { mentionUserIds: ['preview-business'] }, { mentionUserIds: ['missing'] }, { parentId: randomUUID() }]) await ctx.reply(employee, input).expect(400);
  ctx.store.run("UPDATE users SET enabled=0 WHERE id='preview-colleague'");
  await ctx.reply(employee, { mentionUserIds: ['preview-colleague'] }).expect(400);
  ctx.store.run("UPDATE users SET enabled=1,deleted_at='2026-11-02' WHERE id='preview-colleague'");
  await ctx.reply(employee, { mentionUserIds: ['preview-colleague'] }).expect(400);
  ctx.store.run("UPDATE users SET deleted_at=NULL WHERE id='preview-colleague'");
  const another = await ctx.publish();
  const parent = (await ctx.pm.send(`/requirements/${another.id}/replies`, { content: '其他需求', requestId: randomUUID() }).expect(201)).body;
  await ctx.reply(employee, { parentId: parent.id }).expect(400);
  assert.equal((await employee.get(ctx.endpoint).expect(200)).body.total, 0);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM notifications WHERE kind='requirement_reply'").count, 0);
});

test('reply retries are idempotent, reply and mention notifications deduplicate, and permission checks happen again on retry', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee'), colleague = await ctx.login('preview-colleague');
  const parent = (await ctx.reply(employee).expect(201)).body;
  const input = { content: '已定位并安排修复', parentId: parent.id, mentionUserIds: ['preview-employee', 'preview-employee', 'preview-colleague'], requestId: randomUUID() };
  const reply = (await ctx.reply(colleague, input).expect(201)).body;
  assert.equal(reply.parent.id, parent.id); assert.equal(reply.parent.authorName, parent.author.name); assert.equal(reply.mentions.length, 2);
  assert.equal((await ctx.reply(colleague, input).expect(200)).body.id, reply.id);
  assert.equal((await colleague.get(ctx.endpoint).expect(200)).body.total, 2);
  const jobs = ctx.store.all("SELECT * FROM notifications WHERE kind='requirement_reply'");
  assert.equal(jobs.length, 1); assert.equal(jobs[0].recipient_id, 'preview-employee'); assert.equal(jobs[0].round, reply.sequence);
  await ctx.reply(colleague, { ...input, content: '同请求不同内容' }).expect(409);
  const repliesBefore = ctx.store.one('SELECT COUNT(*) AS count FROM requirement_replies').count;
  const enqueue = ctx.notifications.enqueueRequirementReply;
  ctx.notifications.enqueueRequirementReply = () => { throw new Error('simulated reply notification failure'); };
  const retry = { content: '失败后原请求可重试', mentionUserIds: ['preview-employee'], requestId: randomUUID() };
  await ctx.reply(colleague, retry).expect(500);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_replies').count, repliesBefore);
  ctx.notifications.enqueueRequirementReply = enqueue;
  await ctx.reply(colleague, retry).expect(201);
  ctx.store.run('DELETE FROM requirement_assignees WHERE requirement_id=? AND user_id=?', ctx.requirement.id, 'preview-colleague');
  await ctx.reply(colleague, input).expect(403); await colleague.get(ctx.endpoint).expect(403);
  assert.deepEqual(ctx.store.all('PRAGMA foreign_key_check'), []);
});

test('reply paging retains chronological order across equal timestamps and supports incremental polling without gaps', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee');
  const saved = [];
  for (let index = 0; index < 35; index++) saved.push((await ctx.reply(employee, { content: `进度 ${index}` }).expect(201)).body);
  ctx.store.run("UPDATE requirement_replies SET created_at='2026-11-02T00:00:00.000Z'");
  const first = (await employee.get(ctx.endpoint).expect(200)).body;
  assert.equal(first.total, 35); assert.equal(first.items.length, 30); assert.equal(first.hasMore, true); assert.equal(first.items[0].id, saved[5].id);
  const older = (await employee.get(ctx.endpoint + '?before=' + first.beforeCursor).expect(200)).body;
  assert.equal(older.items.length, 5); assert.equal(older.hasMore, false); assert.deepEqual(older.items.map(reply => reply.id), saved.slice(0, 5).map(reply => reply.id));
  await ctx.reply(employee, { content: '轮询后新增' }).expect(201);
  const next = (await employee.get(ctx.endpoint + '?after=' + first.afterCursor).expect(200)).body;
  assert.equal(next.items.length, 1); assert.equal(next.items[0].content, '轮询后新增');
  await employee.get(ctx.endpoint + '?after=1&before=2').expect(400);
  await employee.get(ctx.endpoint + '?limit=101').expect(400);
});

test('reply notifications deliver with stable IDs and skip people whose live access has been removed', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee');
  ctx.store.run("UPDATE users SET open_id='ou_' || id");
  const parent = (await ctx.reply(ctx.pm, { content: '请确认处理进展' }).expect(201)).body;
  await ctx.reply(employee, { content: '已完成首轮复核', mentionUserIds: ['preview-colleague'], parentId: parent.id }).expect(201);
  ctx.store.run("UPDATE notifications SET status='skipped' WHERE kind<>'requirement_reply'");
  const calls = []; let failing = true;
  const sender = createNotifications(ctx.store, { demoMode: false, appId: 'test', appSecret: 'synthetic', notificationFetch: async (url, options) => {
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }) };
    const message = JSON.parse(options.body); calls.push(message);
    return { ok: true, json: async () => ({ code: failing ? 123 : 0 }) };
  } });
  await sender.drain(); assert.equal(calls.length, 2);
  ctx.store.run('DELETE FROM requirement_assignees WHERE requirement_id=? AND user_id=?', ctx.requirement.id, 'preview-colleague');
  failing = false; ctx.store.run('UPDATE notifications SET next_at=0'); await sender.drain();
  const jobs = ctx.store.all("SELECT * FROM notifications WHERE kind='requirement_reply'");
  assert.equal(jobs.find(job => job.recipient_id === 'preview-colleague').status, 'skipped');
  const pm = jobs.find(job => job.recipient_id === 'preview-pm'); assert.equal(pm.status, 'sent');
  assert.equal(calls.filter(call => call.uuid === pm.id).length, 2);
  const text = JSON.parse(calls.at(-1).content).text;
  assert.match(text, /已完成首轮复核/); assert.ok(text.includes(ctx.requirement.id)); assert.match(text, /需求有新回复/);
  await sender.drain(); assert.equal(calls.length, 3);
});

test('reply history, mentions and parents persist through database reopening and verified backup restore', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee');
  const first = (await ctx.reply(employee, { mentionUserIds: ['preview-colleague'] }).expect(201)).body;
  await ctx.reply(ctx.pm, { parentId: first.id, content: '已收到反馈' }).expect(201);
  await createBackup(ctx.store.root, path.join(ctx.root, 'backup'));
  await restoreBackup(path.join(ctx.root, 'backup'), path.join(ctx.root, 'restored'));
  const restored = createApp({ dataDir: path.join(ctx.root, 'restored'), demoMode: true, origin });
  try {
    assert.equal(restored.store.one('SELECT COUNT(*) AS count FROM requirement_replies WHERE requirement_id=?', ctx.requirement.id).count, 2);
    assert.equal(restored.store.one('SELECT user_id FROM requirement_reply_mentions WHERE reply_id=?', first.id).user_id, 'preview-colleague');
    assert.equal(restored.store.one('SELECT parent_id FROM requirement_replies WHERE parent_id=?', first.id).parent_id, first.id);
    assert.deepEqual(restored.store.all('PRAGMA foreign_key_check'), []);
  } finally { restored.store.db.close(); }
});

test('reply notification rechecks access after awaiting the application token before sending any content', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee');
  ctx.store.run("UPDATE users SET open_id='ou_' || id");
  await ctx.reply(employee, { mentionUserIds: ['preview-colleague'] }).expect(201);
  ctx.store.run("UPDATE notifications SET status='skipped' WHERE kind<>'requirement_reply'");
  let messages = 0;
  const sender = createNotifications(ctx.store, { demoMode: false, appId: 'test', appSecret: 'synthetic', notificationFetch: async url => {
    if (url.includes('tenant_access_token')) {
      ctx.store.run('DELETE FROM requirement_assignees WHERE requirement_id=? AND user_id=?', ctx.requirement.id, 'preview-colleague');
      return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }) };
    }
    messages++;
    return { ok: true, json: async () => ({ code: 0 }) };
  } });
  await sender.drain();
  assert.equal(messages, 0);
  assert.equal(ctx.store.one("SELECT status FROM notifications WHERE kind='requirement_reply'").status, 'skipped');
});
