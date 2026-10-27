import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.mjs';
import { createBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore.mjs';
import ExcelJS from 'exceljs';

const origin = 'http://127.0.0.1:5173';
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '.prt-test-'));
  const ctx = createApp({ dataDir: path.join(root, 'data'), demoMode: true, origin, backupDir: path.join(root, 'backups'), ...options });
  t.after(() => { ctx.store.db.close(); if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + '.prt-test-')) throw new Error('Unexpected cleanup path'); fs.rmSync(root, { recursive: true, force: true }); });
  async function login(id) {
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/demo-login').set('Origin', origin).set('X-Requested-With', 'PRT').send({ userId: id }).expect(200);
    const me = await agent.get('/api/auth/me').expect(200);
    return { agent, get: url => agent.get('/api' + url), send: (method, url, body) => agent[method]('/api' + url).set('Origin', origin).set('X-Requested-With', 'PRT').set('X-CSRF-Token', me.body.csrf).send(body), upload: (id, revision, name = '数据样例.zip', data = Buffer.from('zip sample content')) => agent.post(`/api/versions/${id}/files`).set('Origin', origin).set('X-Requested-With', 'PRT').set('X-CSRF-Token', me.body.csrf).set('X-Revision', String(revision)).attach('file', data, name) };
  }
  return { ...ctx, root, login };
}
const description = { title: '测试 Demo', summary: '需求验收数据', category: '通用数据', tags: ['测试'], content: '# 数据概述\n字段和内容说明\n\n# 数据格式\n```text\ndata.csv  # 数据文件\n```', usage: '', costEstimate: '低成本，使用现有工具即可处理。', difficulty: '低难度，具备基础数据分析能力即可。', notes: '', changes: '', schemaVersion: 1 };
async function create(client) { const requirements = (await client.get('/requirements?status=open').expect(200)).body.items; return (await client.send('post', '/assets', { description, requirementIds: [requirements[0].id] }).expect(201)).body; }
async function detail(client, id) { return (await client.get('/assets/' + id).expect(200)).body; }
async function action(client, vid, revision, action, reason = '') { return client.send('post', `/versions/${vid}/actions`, { revision, action, reason }); }

test('my requirements only include assignments, including for product managers and business publishers', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), business = await ctx.login('preview-business'), employee = await ctx.login('preview-employee');
  const assigned = await publishRequirement(business, { title: '指派给产品经理', assignedUserIds: ['preview-pm'] });
  const authored = await publishRequirement(pm, { title: '自己发布但未指定自己', assignedUserIds: ['preview-employee'] });
  const mine = (await pm.get('/requirements?assigned=1').expect(200)).body.items;
  assert.ok(mine.some(item => item.id === assigned.id)); assert.ok(!mine.some(item => item.id === authored.id));
  assert.ok((await pm.get('/requirements').expect(200)).body.items.some(item => item.id === authored.id));
  assert.ok(!(await employee.get('/requirements?assigned=0').expect(200)).body.items.some(item => item.id === assigned.id));
  assert.ok((await employee.get('/requirements?assigned=1').expect(200)).body.items.some(item => item.id === authored.id));
});

test('requirement status changes allow PM and business roles, enforce revisions, and keep closed bindings blocked', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), business = await ctx.login('preview-business'), employee = await ctx.login('preview-employee'), manager = await ctx.login('preview-other-manager'), admin = await ctx.login('preview-admin');
  let requirement = await publishRequirement(business, { assignedUserIds: ['preview-employee', 'preview-other-manager', 'preview-admin'] });
  for (const client of [employee, manager, admin]) await client.send('post', `/requirements/${requirement.id}/actions`, { revision: requirement.revision, action: 'set_status', status: 'delivered' }).expect(403);
  for (const status of ['needs_update', 'delivered', 'closed', 'open']) {
    const previous = requirement.revision;
    requirement = (await pm.send('post', `/requirements/${requirement.id}/actions`, { revision: previous, action: 'set_status', status }).expect(200)).body;
    assert.equal(requirement.status, status);
    assert.ok((await pm.get('/requirements?status=' + status).expect(200)).body.items.some(item => item.id === requirement.id));
    await business.send('post', `/requirements/${requirement.id}/actions`, { revision: previous, action: 'set_status', status: 'needs_update' }).expect(409);
  }
  requirement = (await business.send('post', `/requirements/${requirement.id}/actions`, { revision: requirement.revision, action: 'set_status', status: 'needs_update' }).expect(200)).body;
  await employee.send('post', '/assets', { description, requirementIds: [requirement.id] }).expect(201);
  assert.ok((await employee.get('/requirements?status=active').expect(200)).body.items.some(item => item.id === requirement.id));
});

test('rejecting a Demo changes only linked open requirements to needs update and publication keeps their status', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee'), manager = await ctx.login('preview-manager'), pm = await ctx.login('preview-pm');
  const first = await publishRequirement(pm), second = await publishRequirement(pm), third = await publishRequirement(pm);
  const demo = (await employee.send('post', '/assets', { description, requirementIds: [first.id, second.id, third.id] }).expect(201)).body;
  await pm.send('post', `/requirements/${second.id}/actions`, { revision: second.revision, action: 'set_status', status: 'delivered' }).expect(200);
  await pm.send('post', `/requirements/${third.id}/actions`, { revision: third.revision, action: 'close' }).expect(200);
  await employee.upload(demo.versionId, 0).expect(201);
  await action(manager, demo.versionId, 1, 'reject', '无效退回').then(result => assert.equal(result.status, 409));
  assert.equal((await pm.get(`/requirements/${first.id}`).expect(200)).body.status, 'open');
  await employee.send('post', `/versions/${demo.versionId}/actions`, { revision: 1, action: 'submit', supervisorId: 'preview-manager' }).expect(200);
  await action(manager, demo.versionId, 2, 'reject', '补充字段').then(result => assert.equal(result.status, 200));
  for (const [id, status] of [[first.id, 'needs_update'], [second.id, 'delivered'], [third.id, 'closed']]) assert.equal((await pm.get(`/requirements/${id}`).expect(200)).body.status, status);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM events WHERE action='requirement_status' AND asset_id=?", demo.id).count, 1);
  await employee.send('post', `/versions/${demo.versionId}/actions`, { revision: 3, action: 'submit', supervisorId: 'preview-manager' }).expect(200);
  await action(manager, demo.versionId, 4, 'publish').then(result => assert.equal(result.status, 200));
  assert.equal((await pm.get(`/requirements/${first.id}`).expect(200)).body.status, 'needs_update');
});

test('Feishu requirement preview enforces assignment and only reads links stored in the requirement', async t => {
  const ctx = await fixture(t), business = await ctx.login('preview-business'), employee = await ctx.login('preview-employee'), other = await ctx.login('preview-other');
  const url = 'https://team.feishu.cn/wiki/WikiToken';
  const requirement = await publishRequirement(business, { content: '查看 ' + url, assignedUserIds: ['preview-employee'] });
  const endpoint = `/requirements/${requirement.id}/link-preview?`;
  await other.get(endpoint + new URLSearchParams({ url })).expect(403);
  await employee.get(endpoint + new URLSearchParams({ url: 'https://team.feishu.cn/docx/OtherToken' })).expect(400);
  await employee.get(endpoint + new URLSearchParams({ url: 'http://127.0.0.1/internal' })).expect(400);
  const result = (await employee.get(endpoint + new URLSearchParams({ url })).expect(200)).body;
  assert.equal(result.available, false); assert.equal(result.url, url);
});

test('admins can disable and delete accounts with history, restore them, and cannot remove the last admin', async t => {
  const ctx = await fixture(t), admin = await ctx.login('preview-admin'), employee = await ctx.login('preview-employee');
  const account = id => ctx.store.one('SELECT * FROM users WHERE id=?', id);
  await employee.send('delete', '/admin/users/preview-other', { revision: 0 }).expect(403);
  await admin.send('delete', '/admin/users/preview-employee', { revision: 0 }).expect(409);
  const before = ctx.store.one('SELECT COUNT(*) AS count FROM assets WHERE owner_id=?', 'preview-employee').count;
  await admin.send('put', '/admin/users/preview-admin', { revision: 0, roles: ['admin'], supervisorId: null, enabled: false }).expect(400);
  await admin.send('put', '/admin/users/preview-employee', { revision: 0, roles: ['employee'], supervisorId: 'unavailable-supervisor', enabled: false }).expect(200);
  assert.equal(account('preview-employee').supervisor_id, null);
  await employee.get('/config').expect(401);
  await admin.send('delete', '/admin/users/preview-employee', { revision: 0 }).expect(409);
  await admin.send('delete', '/admin/users/preview-employee', { revision: 1 }).expect(200);
  assert.ok((await admin.get('/admin/users').expect(200)).body.find(user => user.id === 'preview-employee').deletedAt);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM assets WHERE owner_id=?', 'preview-employee').count, before);
  assert.ok(account('preview-employee').deleted_at);
  await admin.send('put', '/admin/users/preview-employee', { revision: 2, roles: ['employee'], supervisorId: null, enabled: true }).expect(409);
  await admin.send('post', '/admin/users/preview-employee/restore', { revision: 2 }).expect(200);
  assert.equal(account('preview-employee').enabled, 0); assert.equal(account('preview-employee').deleted_at, null);
  await admin.send('put', '/admin/users/preview-manager', { revision: 0, roles: ['supervisor', 'pm'], supervisorId: null, enabled: false }).expect(200);
  assert.equal(account('preview-colleague').supervisor_id, null);
  assert.deepEqual(ctx.store.all('PRAGMA foreign_key_check'), []);
});

test('network discovery is public with narrowly allowed CORS while both configured origins retain CSRF checks', async t => {
  const publicOrigin = 'http://data.prt-ai.cn:8001', intranetOrigin = 'http://192.168.110.25:8001';
  const ctx = await fixture(t, { publicOrigin, intranetOrigin }), employee = await ctx.login('preview-employee');
  const response = await request(ctx.app).get('/api/network').set('Origin', publicOrigin).expect(200);
  assert.equal(response.body.intranetOrigin, intranetOrigin); assert.equal(response.headers['access-control-allow-origin'], publicOrigin);
  const foreign = await request(ctx.app).get('/api/network').set('Origin', 'https://attacker.example').expect(200);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  await request(ctx.app).options('/api/network').set('Origin', publicOrigin).expect(204);
  await employee.agent.post('/api/assets').set('Origin', publicOrigin).set('X-Requested-With', 'PRT').send({ description }).expect(403);
  await employee.send('post', '/assets', { description }).expect(201);
});

test('identity: anonymous denied, unassigned waiting, production never allows preview', async t => {
  const f = await fixture(t);
  await request(f.app).get('/api/assets').expect(401);
  const unknown = await f.login('preview-unassigned'); await unknown.get('/assets').expect(403);
  assert.throws(() => createApp({ production: true, demoMode: true }), /refuses/);
  assert.throws(() => createApp({ dataDir: path.join(f.root, 'data'), demoMode: false }), /separate/);
});
test('permissions: employee ownership, selected supervisor, PM management and admin no file access', async t => {
  const f = await fixture(t), employee = await f.login('preview-employee'), other = await f.login('preview-other'), manager = await f.login('preview-other-manager'), pm = await f.login('preview-pm'), admin = await f.login('preview-admin');
  const list = (await employee.get('/assets')).body; assert.ok(list.length); assert.ok(list.every(a => a.owner.id === 'preview-employee'));
  const item = list[0], v = item.latest;
  await other.get('/assets/' + item.id).expect(404); await manager.get('/assets/' + item.id).expect(404); await admin.get('/assets/' + item.id).expect(404);
  await other.get(`/versions/${v.id}/files/${v.files[0].id}/download`).expect(404);
  await pm.get('/assets/' + item.id).expect(200); await pm.get(`/versions/${v.id}/files/${v.files[0].id}/download`).expect(200);
  await pm.send('post', '/assets', { description }).expect(403);
  await pm.send('put', `/versions/${v.id}`, { description, revision: v.revision }).expect(409);
  await action(pm, v.id, v.revision, 'unpublish', 'test').then(r => assert.equal(r.status, 200));
});
test('employee workflow: upload, submit, locked revision, reject, resubmit, supervisor edit then publish', async t => {
  const f = await fixture(t), employee = await f.login('preview-employee'), manager = await f.login('preview-manager');
  const asset = await create(employee), vid = asset.versionId;
  await employee.upload(vid, 0).expect(201);
  let d = await detail(employee, asset.id); assert.equal(d.latest.files[0].name, '数据样例.zip');
  assert.equal((await action(employee, vid, 1, 'publish')).status, 403);
  assert.equal((await action(employee, vid, 1, 'submit')).status, 200);
  await employee.send('put', `/versions/${vid}`, { description, revision: 2 }).expect(403);
  assert.equal((await action(manager, vid, 2, 'reject', '补充使用步骤')).status, 200);
  assert.equal((await action(employee, vid, 3, 'submit')).status, 200);
  await manager.send('put', `/versions/${vid}`, { description: { ...description, usage: '主管修订使用步骤' }, revision: 4 }).expect(200);
  assert.equal((await action(manager, vid, 5, 'publish')).status, 200);
  d = await detail(employee, asset.id); assert.equal(d.latest.status, 'published'); assert.equal(d.currentVersionId, vid); assert.equal(d.submissions.length, 2); assert.equal(d.submissions[0].snapshot.description.usage, description.usage); assert.equal(d.latest.description.usage, '主管修订使用步骤');
  assert.equal((await action(manager, vid, 5, 'publish')).status, 409);
  await employee.send('put', `/versions/${vid}`, { description, revision: 6 }).expect(409);
});
test('versions preserve prior files and descriptions, prevent duplicate working versions and revoke offline downloads', async t => {
  const f = await fixture(t), manager = await f.login('preview-manager'); const asset = await create(manager);
  await manager.upload(asset.versionId, 0, 'sample.exe').expect(201);
  assert.equal((await action(manager, asset.versionId, 1, 'publish')).status, 200);
  let d = await detail(manager, asset.id); const oldFile = d.latest.files[0];
  const next = await manager.send('post', `/assets/${asset.id}/versions`, { baseVersionId: asset.versionId, revision: d.revision }).expect(201);
  await manager.send('post', `/assets/${asset.id}/versions`, { baseVersionId: asset.versionId, revision: d.revision }).expect(409);
  await manager.send('put', `/versions/${next.body.versionId}`, { description: { ...description, changes: '更新说明', content: '第二版内容' }, revision: 0 }).expect(200);
  d = await detail(manager, asset.id); assert.equal(d.currentVersionId, asset.versionId); assert.equal(d.versions.find(v => v.id === asset.versionId).description.content, description.content);
  await manager.get(`/versions/${asset.versionId}/files/${oldFile.id}/download`).expect(200);
  assert.equal((await action(manager, next.body.versionId, 1, 'publish')).status, 200);
  assert.equal((await action(manager, next.body.versionId, 2, 'unpublish', '停止使用')).status, 200);
  await manager.get(`/versions/${next.body.versionId}/files/${oldFile.id}/download`).expect(403);
  await manager.get(`/versions/${asset.versionId}/files/${oldFile.id}/download`).expect(200);
  d = await detail(manager, asset.id); assert.equal(d.currentVersionId, null);
  assert.equal((await action(manager, asset.versionId, 2, 'set_default')).status, 200);
  assert.equal((await action(manager, next.body.versionId, 3, 'restore', '恢复使用')).status, 200);
});
test('concurrent writes and repeated transitions fail without overwriting', async t => {
  const f = await fixture(t), employee = await f.login('preview-employee'); const a = await create(employee);
  const results = await Promise.all([employee.send('put', `/versions/${a.versionId}`, { revision: 0, description: { ...description, title: 'A' } }), employee.send('put', `/versions/${a.versionId}`, { revision: 0, description: { ...description, title: 'B' } })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});
test('repeated create request returns one asset', async t => {
  const f = await fixture(t), employee = await f.login('preview-employee');
  const body = { description, requestId: '95729d44-49c6-4827-b941-d0e5c8932526' };
  const first = await employee.send('post', '/assets', body).expect(201);
  const second = await employee.send('post', '/assets', body).expect(201);
  assert.equal(first.body.id, second.body.id);
  assert.equal(f.store.one('SELECT COUNT(*) AS n FROM assets WHERE id=?', first.body.id).n, 1);
});
test('CSRF and foreign origins rejected', async t => {
  const f = await fixture(t), employee = await f.login('preview-employee');
  await employee.agent.post('/api/assets').send({ description }).expect(403);
  await employee.agent.post('/api/assets').set('Origin', 'https://evil.example').set('X-Requested-With', 'PRT').send({ description }).expect(403);
  await employee.agent.post('/api/assets').set('Origin', origin).set('X-Requested-With', 'PRT').send({ description }).expect(403);
});
test('selected reviewer keeps access independently from the employee directory supervisor', async t => {
  const f = await fixture(t), admin = await f.login('preview-admin'), old = await f.login('preview-manager'), next = await f.login('preview-other-manager'), employee = await f.login('preview-employee');
  // Preview manager also has PM access; remove that role to test team scope.
  let users = (await admin.get('/admin/users')).body; let u = users.find(u => u.id === 'preview-manager');
  await admin.send('put', '/admin/users/' + u.id, { ...u, roles: ['supervisor'] }).expect(200);
  const a = await create(employee); await employee.upload(a.versionId, 0).expect(201); assert.equal((await action(employee, a.versionId, 1, 'submit')).status, 200);
  u = users.find(u => u.id === 'preview-employee');
  await admin.send('put', '/admin/users/' + u.id, { ...u, supervisorId: 'preview-other-manager' }).expect(200);
  await old.get('/assets/' + a.id).expect(200); await next.get('/assets/' + a.id).expect(404);
  assert.equal((await action(old, a.versionId, 2, 'publish')).status, 200);
  const d = await detail(employee, a.id);
  await admin.send('post', `/admin/assets/${a.id}/transfer`, { revision: d.revision, ownerId: 'preview-other', reason: '人员交接' }).expect(200);
  await employee.get('/assets/' + a.id).expect(404);
  const newOwner = await f.login('preview-other'); const updated = await detail(newOwner, a.id); assert.equal(updated.creator.id, 'preview-employee'); assert.equal(updated.owner.id, 'preview-other');
});
test('Demo uploads and submission ignore stored size limits while enforcing file count and rejecting empty files', async t => {
  const f = await fixture(t), admin = await f.login('preview-admin'), employee = await f.login('preview-employee');
  const conf = (await admin.get('/config')).body; await admin.send('put', '/admin/settings', { ...conf, maxFileMB: 1, maxVersionMB: 1, maxFiles: 1 }).expect(200);
  const a = await create(employee);
  await employee.upload(a.versionId, 0, 'empty.zip', Buffer.alloc(0)).expect(400);
  assert.equal((await detail(employee, a.id)).latest.files.length, 0);
  await employee.upload(a.versionId, 0, 'large.zip', Buffer.alloc(1048577)).expect(201);
  await employee.upload(a.versionId, 1, 'another.txt').expect(400);
  assert.equal((await detail(employee, a.id)).latest.files.length, 1);
  assert.equal((await detail(employee, a.id)).latest.files[0].size, 1048577);
  assert.equal((await action(employee, a.versionId, 1, 'submit')).status, 200);
  assert.equal(fs.readdirSync(path.join(f.root, 'data', 'tmp')).length, 0);
});
test('missing supervisor and incomplete explanation block submission', async t => {
  const f = await fixture(t), admin = await f.login('preview-admin'), employee = await f.login('preview-employee');
  const a = await create(employee); assert.equal((await action(employee, a.versionId, 0, 'submit')).status, 400);
  await employee.upload(a.versionId, 0).expect(201);
  const u = (await admin.get('/admin/users')).body.find(u => u.id === 'preview-employee');
  await admin.send('put', '/admin/users/' + u.id, { ...u, supervisorId: null }).expect(200);
  assert.equal((await action(employee, a.versionId, 1, 'submit')).status, 400);
});
test('deletion restricted to never-submitted drafts', async t => {
  const f = await fixture(t), employee = await f.login('preview-employee'); const a = await create(employee);
  await employee.upload(a.versionId, 0).expect(201); assert.equal((await action(employee, a.versionId, 1, 'submit')).status, 200); assert.equal((await action(employee, a.versionId, 2, 'withdraw')).status, 200);
  await employee.send('delete', `/versions/${a.versionId}`, { revision: 3 }).expect(409);
  const draft = await create(employee); await employee.send('delete', `/versions/${draft.versionId}`, { revision: 0 }).expect(200); await employee.get('/assets/' + draft.id).expect(404);
});
test('backup and restore preserve files, versions, audit while removing live sessions', async t => {
  const f = await fixture(t), employee = await f.login('preview-employee'); const a = await create(employee); await employee.upload(a.versionId, 0).expect(201);
  const result = await createBackup(path.join(f.root, 'data'), path.join(f.root, 'backup')); assert.ok(result.files > 0);
  await restoreBackup(path.join(f.root, 'backup'), path.join(f.root, 'restored'));
  const restored = createApp({ dataDir: path.join(f.root, 'restored'), demoMode: true, origin });
  try { assert.equal(restored.store.one('SELECT COUNT(*) AS n FROM sessions').n, 0); assert.ok(restored.store.one('SELECT * FROM assets WHERE id=?', a.id)); const file = restored.store.one('SELECT file_id FROM version_files WHERE version_id=?', a.versionId); assert.ok(fs.existsSync(path.join(f.root, 'restored', 'files', file.file_id))); } finally { restored.store.db.close(); }
});


test('catalog paginates after access control and escapes search wildcards', async t => {
  const f = await fixture(t), employee = await f.login('preview-employee'), pm = await f.login('preview-pm'), other = await f.login('preview-other'), admin = await f.login('preview-admin');
  const all = (await pm.get('/assets').expect(200)).body;
  const first = (await pm.get('/catalog?pageSize=5').expect(200)).body;
  const second = (await pm.get('/catalog?pageSize=5&page=2').expect(200)).body;
  assert.equal(first.total, all.length); assert.equal(first.items.length, 5); assert.equal(first.pages, 2);
  assert.equal(new Set([...first.items, ...second.items].map(a => a.id)).size, all.length);
  const mine = (await employee.get('/catalog').expect(200)).body;
  assert.ok(mine.items.every(a => a.owner.id === 'preview-employee'));
  assert.deepEqual(mine.owners.map(u => u.id), ['preview-employee']); assert.equal(mine.total, mine.stats.total);
  const ownId = mine.items[0].id;
  assert.equal((await other.get('/catalog?owner=preview-employee').expect(200)).body.total, 0);
  assert.equal((await employee.get('/catalog?scope=team').expect(200)).body.total, 0);
  await admin.get('/catalog').expect(200).then(r => assert.equal(r.body.total, 0));
  const term = encodeURIComponent(mine.items[0].latest.description.title);
  assert.ok((await employee.get('/catalog?q=' + term).expect(200)).body.items.some(a => a.id === ownId));
  for (const term of ['%', '_', "' OR 1=1 --", '\\']) assert.equal((await pm.get('/catalog?q=' + encodeURIComponent(term)).expect(200)).body.total, 0);
  await pm.get('/catalog?pageSize=999999').expect(400); await pm.get('/catalog?sort=invalid').expect(400);
  assert.equal((await pm.get('/catalog?page=999').expect(200)).body.page, 1);
});

test('catalog published includes an asset with an unpublished next version', async t => {
  const f = await fixture(t), manager = await f.login('preview-manager');
  const a = await create(manager); await manager.upload(a.versionId, 0).expect(201);
  await action(manager, a.versionId, 1, 'publish');
  const d = await detail(manager, a.id);
  await manager.send('post', `/assets/${a.id}/versions`, { baseVersionId: a.versionId, revision: d.revision }).expect(201);
  const list = (await manager.get('/catalog?status=published').expect(200)).body;
  const found = list.items.find(v => v.id === a.id); assert.equal(found.latest.status, 'draft'); assert.equal(found.currentVersion, 1);
  assert.equal(found.latest.files.length, 0); // catalog avoids attachment payloads
  assert.ok((await detail(manager, a.id)).latest.files.length > 0);
});

test('admin backup endpoint verifies files without leaking credentials or sessions', async t => {
  const f = await fixture(t), admin = await f.login('preview-admin'), employee = await f.login('preview-employee');
  await employee.send('post', '/admin/backups', {}).expect(403);
  await admin.send('post', '/admin/backups', {}).expect(202);
  let health;
  for (let i = 0; i < 100; i++) { health = (await admin.get('/admin/health').expect(200)).body; if (health.backupTask.status !== 'running') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(health.backupTask.status, 'complete'); assert.ok(health.backup.files > 0);
  assert.equal(typeof health.feishu.appSecret, 'boolean'); assert.equal(health.mode, 'preview');
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, 'backups', 'backup-' + health.backupTask.id, 'manifest.json')));
  assert.equal(manifest.files, health.backup.files);
  await admin.get('/admin/events').expect(200).then(r => assert.ok(r.body.some(e => e.action === 'backup_complete')));
});

test('preview enforces visibility and supports text, ZIP entries and media ranges', async t => {
  const ctx = await fixture(t), owner = await ctx.login('preview-employee'), other = await ctx.login('preview-other');
  const demo = await create(owner);
  const upload = await owner.upload(demo.versionId, 0, 'preview.zip', fs.readFileSync(new URL('./fixtures/preview.zip', import.meta.url))).expect(201);
  const url = `/versions/${demo.versionId}/files/${upload.body.id}/preview`;
  const listing = await owner.get(url).expect(200);
  assert.equal(listing.body.kind, 'archive');
  const code = listing.body.entries.find(e => e.name === 'folder/code.py');
  assert.ok(code);
  const content = await owner.get(url + '?entry=' + code.id).expect(200);
  assert.equal(content.body.content, 'print(123)');
  await owner.get(url + '?entry=../../etc/passwd').expect(400);
  await owner.get(url + '?entry=99999').expect(400);
  await other.get(url).expect(404);
  const text = await owner.upload(demo.versionId, 1, 'page.html', Buffer.from('<script>alert(1)</script>')).expect(201);
  const textUrl = `/versions/${demo.versionId}/files/${text.body.id}/preview`;
  assert.equal((await owner.get(textUrl).expect(200)).body.kind, 'text');
  await owner.get(textUrl + '?raw=1').expect(400);
  const media = await owner.upload(demo.versionId, 2, 'clip.mp4', Buffer.from('0123456789')).expect(201);
  const mediaUrl = `/versions/${demo.versionId}/files/${media.body.id}/preview?raw=1`;
  const part = await owner.get(mediaUrl).set('Range','bytes=2-5').expect(206);
  assert.equal(part.headers['content-range'], 'bytes 2-5/10');
  ctx.store.db.prepare("UPDATE versions SET status='offline' WHERE id=?").run(demo.versionId);
  await owner.get(url).expect(403);
  await owner.get(mediaUrl).expect(403);
});

test('Feishu notifications queue atomically, deliver to supervisor then PM, and retry safely', async t => {
  const ctx = await fixture(t), owner = await ctx.login('preview-employee'), manager = await ctx.login('preview-manager');
  const demo = await create(owner);
  await owner.upload(demo.versionId,0).expect(201);
  await owner.send('post',`/versions/${demo.versionId}/actions`,{revision:1,action:'submit'}).expect(200);
  assert.equal(ctx.notifications.list().length,1);
  assert.equal(ctx.notifications.list()[0].recipient_id,'preview-manager');
  await owner.send('post',`/versions/${demo.versionId}/actions`,{revision:1,action:'submit'}).expect(409);
  assert.equal(ctx.notifications.list().length,1);
  await manager.send('post',`/versions/${demo.versionId}/actions`,{revision:2,action:'publish'}).expect(200);
  assert.equal(ctx.notifications.list().filter(n=>n.kind==='publish').length,3);
  const {createNotifications} = await import('../server/notifications.mjs');
  ctx.store.run("UPDATE users SET open_id='ou_mock_' || id");
  let calls=[], fail=true;
  const sender=createNotifications(ctx.store,{demoMode:false,appId:'test',appSecret:'test',origin,notificationFetch:async(url,options)=>{
    if(url.includes('tenant_access_token'))return {ok:true,json:async()=>({code:0,tenant_access_token:'mock',expire:7200})};
    calls.push(JSON.parse(options.body));
    return {ok:!fail,json:async()=>({code:fail?230013:0})};
  }});
  await sender.drain();
  assert.equal(sender.list().find(n=>n.kind==='submit').status,'skipped');
  const pending=sender.list().find(n=>n.kind==='publish');
  assert.equal(pending.status,'pending'); assert.equal(pending.attempts,1);
  fail=false;ctx.store.run('UPDATE notifications SET next_at=0');
  await sender.drain();
  assert.equal(sender.list().find(n=>n.kind==='publish').status,'sent');
  for (const job of sender.list().filter(item => item.kind === 'publish')) {
    const attempts = calls.filter(call => call.uuid === job.id);
    assert.equal(attempts.length, 2); assert.equal(job.status, 'sent');
  }
  assert.ok(JSON.parse(calls[0].content).text.includes('审核通过'));
  const appMessage=JSON.parse(calls[0].content).text;
  assert.ok(appMessage.includes('https://applink.feishu.cn/client/web_app/open?'));
  assert.ok(appMessage.includes('appId=test'));
  assert.ok(appMessage.includes('mode=appCenter'));
  assert.ok(appMessage.includes(`demo=${demo.id}`));
  assert.ok(!appMessage.includes(origin));
  await sender.drain();assert.equal(calls.length,6);
  await owner.get('/admin/notifications').expect(403);
});


test('all workflow transitions queue notifications for the responsible people', async t => {
  const ctx=await fixture(t), owner=await ctx.login('preview-employee'), manager=await ctx.login('preview-manager');
  const demo=await create(owner); await owner.upload(demo.versionId,0).expect(201);
  await owner.send('post',`/versions/${demo.versionId}/actions`,{revision:1,action:'submit'}).expect(200);
  await manager.send('post',`/versions/${demo.versionId}/actions`,{revision:2,action:'reject',reason:'请补充字段口径'}).expect(200);
  await owner.send('post',`/versions/${demo.versionId}/actions`,{revision:3,action:'submit'}).expect(200);
  await owner.send('post',`/versions/${demo.versionId}/actions`,{revision:4,action:'withdraw'}).expect(200);
  await owner.send('post',`/versions/${demo.versionId}/actions`,{revision:5,action:'submit'}).expect(200);
  await manager.send('post',`/versions/${demo.versionId}/actions`,{revision:6,action:'publish'}).expect(200);
  await manager.send('post',`/versions/${demo.versionId}/actions`,{revision:7,action:'unpublish',reason:'数据更新'}).expect(200);
  await manager.send('post',`/versions/${demo.versionId}/actions`,{revision:8,action:'restore',reason:'更新完成'}).expect(200);
  await manager.send('post',`/versions/${demo.versionId}/actions`,{revision:9,action:'set_default'}).expect(200);
  const jobs=ctx.notifications.list(), kinds=new Set(jobs.map(job=>job.kind));
  for(const kind of ['submit','reject','withdraw','publish','unpublish','restore','set_default']) assert.ok(kinds.has(kind),`missing ${kind}`);
  const reject=jobs.find(job=>job.kind==='reject'); assert.equal(reject.recipient_id,'preview-employee'); assert.equal(JSON.parse(reject.detail).reason,'请补充字段口径');
  assert.ok(jobs.filter(job=>job.kind==='submit').every(job=>job.recipient_id==='preview-manager'));
  for(const kind of ['publish','restore']) assert.deepEqual(new Set(jobs.filter(job=>job.kind===kind).map(job=>job.recipient_id)),new Set(['preview-employee','preview-manager','preview-pm']));
  for(const kind of ['unpublish','set_default']) assert.deepEqual(new Set(jobs.filter(job=>job.kind===kind).map(job=>job.recipient_id)),new Set(['preview-employee','preview-pm']));
});

test('dashboard status shortcuts can query the matching incomplete list', async t => {
  const ctx=await fixture(t), owner=await ctx.login('preview-employee'), manager=await ctx.login('preview-manager');
  await create(owner);
  const returned=await create(owner); await owner.upload(returned.versionId,0).expect(201);
  await owner.send('post',`/versions/${returned.versionId}/actions`,{revision:1,action:'submit'}).expect(200);
  await manager.send('post',`/versions/${returned.versionId}/actions`,{revision:2,action:'reject',reason:'补充说明'}).expect(200);
  const result=await owner.get('/catalog?scope=mine&status=incomplete&pageSize=50').expect(200);
  assert.ok(result.body.total >= 2);
  assert.ok(result.body.items.some(item=>item.id===returned.id && item.latest.status==='returned'));
  assert.ok(result.body.items.every(item=>['draft','returned'].includes(item.latest.status)));
});

test('publishing queues robot notifications for selected CC recipients and product managers', async t => {
  const ctx=await fixture(t),owner=await ctx.login('preview-employee'),manager=await ctx.login('preview-manager');
  const demo=await create(owner); await owner.upload(demo.versionId,0).expect(201);
  await owner.send('post',`/versions/${demo.versionId}/actions`,{revision:1,action:'submit',supervisorId:'preview-manager'}).expect(200);
  await manager.send('post',`/versions/${demo.versionId}/actions`,{revision:2,action:'publish',ccUserIds:['preview-other']}).expect(200);
  const recipients=new Set(ctx.notifications.list().filter(item=>item.kind==='publish').map(item=>item.recipient_id));
  assert.ok(recipients.has('preview-other')); assert.ok(recipients.has('preview-pm')); assert.ok(recipients.has('preview-employee'));
});
test('Demo grants keep readonly, upload and management permissions separate', async t => {
  const f=await fixture(t),owner=await f.login('preview-employee'),pm=await f.login('preview-pm'),other=await f.login('preview-other');
  const demo=await create(owner);
  await pm.send('put',`/assets/${demo.id}/permissions/preview-other`,{level:'readonly'}).expect(200);
  let granted=await other.get('/assets/'+demo.id).expect(200); assert.equal(granted.body.canEdit,false); assert.equal(granted.body.accessLevel,'readonly');
  await other.send('put',`/versions/${demo.versionId}`,{description,revision:0}).expect(403);
  await pm.send('put',`/assets/${demo.id}/permissions/preview-other`,{level:'upload'}).expect(200);
  granted=await other.get('/assets/'+demo.id).expect(200); assert.equal(granted.body.canEdit,true); assert.equal(granted.body.canManage,false); assert.equal(granted.body.accessLevel,'upload');
  await other.send('put',`/versions/${demo.versionId}`,{description:{...description,title:'协作维护'},revision:0}).expect(200);
  await action(other,demo.versionId,1,'publish').then(response=>assert.equal(response.status,403));
  await pm.send('put',`/assets/${demo.id}/permissions/preview-other`,{level:'manage'}).expect(200);
  granted=await other.get('/assets/'+demo.id).expect(200); assert.equal(granted.body.canManage,true); assert.equal(granted.body.accessLevel,'manage');
  await pm.send('delete',`/assets/${demo.id}/permissions/preview-other`).expect(200); await other.get('/assets/'+demo.id).expect(404);
});

test('business can view and download every Demo but cannot change data', async t => {
  const ctx = await fixture(t), business = await ctx.login('preview-business'), owner = await ctx.login('preview-employee');
  const all = await business.get('/catalog?pageSize=100').expect(200);
  assert.equal(all.body.total, ctx.store.one('SELECT COUNT(*) AS n FROM assets').n);
  const demo = await create(owner); await owner.upload(demo.versionId, 0).expect(201);
  const detail = await business.get('/assets/' + demo.id).expect(200);
  assert.equal(detail.body.canEdit, false); assert.equal(detail.body.canManage, false);
  assert.equal(detail.body.businessRestricted, true);
  assert.equal(detail.body.latest.id, detail.body.versions[0].id);
  assert.equal(detail.body.latest.description.content, description.content);
  assert.equal(detail.body.latest.description.difficulty, description.difficulty);
  for (const hidden of ['costEstimate', 'notes', 'changes', 'usage']) assert.equal(detail.body.latest.description[hidden], undefined);
  assert.deepEqual(detail.body.events, []); assert.deepEqual(detail.body.submissions, []);
  await business.get(`/versions/${demo.versionId}/files/${detail.body.latest.files[0].id}/download`).expect(200);
  await business.send('post', '/assets', { description }).expect(403);
  await business.send('put', `/versions/${demo.versionId}`, { description, revision: 1 }).expect(403);
  await business.send('post', `/versions/${demo.versionId}/actions`, { revision: 1, action: 'publish' }).expect(403);
});

test('RAG search only returns visible descriptions and can use an LLM answer', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee'), business = await ctx.login('preview-business');
  const local = await employee.send('post', '/search/rag', { question: '门店销售趋势分析' }).expect(200);
  assert.ok(local.body.sources.length > 0);
  assert.ok(local.body.sources.every(a => a.owner.id === 'preview-employee'));
  const global = await business.send('post', '/search/rag', { question: '设备故障监测' }).expect(200);
  assert.ok(global.body.sources.some(a => a.latest.description.title.includes('设备')));
  const secret = await employee.send('post', '/assets', { description: { ...description, title: '公开标题', summary: '普通简介', content: '普通数据说明', costEstimate: 'COSTSECRETZXQ999' } }).expect(201);
  const protectedSearch = await business.send('post', '/search/rag', { question: 'COSTSECRETZXQ999' }).expect(200);
  assert.ok(!protectedSearch.body.sources.some(asset => asset.id === secret.body.id));
  await employee.send('post', '/search/rag', { question: '一' }).expect(400);
});

test('RAG search excludes offline Demos', async t => {
  const ctx = await fixture(t), manager = await ctx.login('preview-manager');
  const marker = 'OFFLINESEARCHZXQ999';
  const requirementId = (await manager.get('/requirements').expect(200)).body.items[0].id;
  const demo = (await manager.send('post', '/assets', { description: { ...description, title: '待下架检索样例', content: marker }, requirementIds: [requirementId] }).expect(201)).body;
  await manager.upload(demo.versionId, 0).expect(201);
  assert.equal((await action(manager, demo.versionId, 1, 'publish')).status, 200);
  let result = await manager.send('post', '/search/rag', { question: marker }).expect(200);
  assert.ok(result.body.sources.some(asset => asset.id === demo.id));
  assert.equal((await action(manager, demo.versionId, 2, 'unpublish', '停止使用')).status, 200);
  result = await manager.send('post', '/search/rag', { question: marker }).expect(200);
  assert.ok(!result.body.sources.some(asset => asset.id === demo.id));
});

test('RAG uses official DeepSeek Pro with thinking disabled through multiple tool rounds', async t => {
  const calls = [];
  const ctx = await fixture(t, { llmApiKey: 'official-test-key', fetch: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer official-test-key');
    assert.equal(body.model, 'deepseek-v4-pro');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(Object.hasOwn(body, 'max_tokens'), false);
    if (calls.length === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'search_demos', arguments: JSON.stringify({ query: '销售' }) } }] } }] }));
    const tool = body.messages.find(message => message.role === 'tool');
    assert.ok(tool);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '建议使用门店销售数据 [1]。' } }] }));
  } });
  const employee = await ctx.login('preview-employee');
  const result = await employee.send('post', '/search/rag', { question: '门店销售分析' }).expect(200);
  assert.equal(result.body.modelUsed, true);
  assert.equal(result.body.modelError, '');
  assert.equal(calls.length, 2);
  assert.ok(result.body.sources.length > 0);
  assert.ok(result.body.sources.every(asset => asset.owner.id === 'preview-employee'));
});

test('RAG sends token caps only when configured and rejects invalid caps before requesting', async t => {
  const requests = [];
  const ctx = await fixture(t, { llmApiKey: 'official-test-key', fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '测试检索回答' } }] }));
  } });
  const employee = await ctx.login('preview-employee');
  for (const budget of [undefined, null, '', '   ', 4096, '16384']) {
    ctx.config.llmMaxTokens = budget;
    const response = await employee.send('post', '/search/rag', { question: '门店销售分析' }).expect(200);
    assert.equal(response.body.modelUsed, true);
    const sent = requests.at(-1);
    if (budget === 4096 || budget === '16384') assert.equal(sent.max_tokens, Number(budget));
    else assert.equal(Object.hasOwn(sent, 'max_tokens'), false);
  }
  const count = requests.length;
  for (const budget of [0, -1, 1000, 32769, 8192.5, 'invalid']) {
    ctx.config.llmMaxTokens = budget;
    const response = await employee.send('post', '/search/rag', { question: '门店销售分析' }).expect(200);
    assert.equal(response.body.modelUsed, false);
    assert.match(response.body.modelError, /RAG_LLM_MAX_TOKENS/);
  }
  assert.equal(requests.length, count);
});

test('RAG falls back to local results when the model output is truncated', async t => {
  const ctx = await fixture(t, { llmApiKey: 'official-test-key', fetch: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '截断的答案' } }] })) });
  const employee = await ctx.login('preview-employee');
  const result = await employee.send('post', '/search/rag', { question: '门店销售分析' }).expect(200);
  assert.equal(result.body.modelUsed, false);
  assert.match(result.body.modelError, /额度上限/);
  assert.match(result.body.modelError, /模型服务默认值/);
  assert.ok(!result.body.answer.includes('截断的答案'));
  assert.ok(result.body.sources.length > 0);
});

test('RAG stream emits visible agent retrieval stages before its result', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee');
  const response = await employee.send('post', '/search/rag/stream', { question: '门店销售趋势分析' }).expect(200);
  const events = response.text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'stage');
  assert.ok(events.some(event => event.type === 'stage' && event.text.includes('检索')));
  const result = events.find(event => event.type === 'result'); assert.ok(result); assert.ok(result.sources.length > 0);
  assert.ok(result.sources.every(asset => asset.owner.id === 'preview-employee'));
});

test('description agent runs in background, preserves the draft and queues requester notification', async t => {
  let prompt = '';
  const markdown = '# 数据概述\n\n本数据包含任务定义和运行材料。\n\n# 数据格式\n\n```text\n单个任务/\n├── instruction.md  # 任务说明\n└── data/            # 输入材料\n```\n\ninstruction.md 保存任务要求。';
  const ctx = await fixture(t, { descriptionAgentKey: 'independent-test-key', descriptionAgentUrl: 'https://agent.test', descriptionAgentModel: 'claude-test', descriptionAgentRunner: async input => { prompt = input.prompt; await new Promise(resolve => setTimeout(resolve, 20)); return { markdown }; } });
  const owner = await ctx.login('preview-employee'), demo = await create(owner);
  await owner.upload(demo.versionId, 0, 'preview.zip', fs.readFileSync(new URL('./fixtures/preview.zip', import.meta.url))).expect(201);
  const queued = await owner.send('post', `/versions/${demo.versionId}/description/generate`, { revision: 1 }).expect(202);
  assert.ok(['pending','running'].includes(queued.body.status));
  await owner.send('put', `/versions/${demo.versionId}`, { revision: 1, description: { ...description, notes: '生成期间继续编辑' } }).expect(200);
  let job; for (let i=0;i<50;i++) { job=(await owner.get(`/description/jobs/${queued.body.id}`).expect(200)).body; if (['complete','failed'].includes(job.status)) break; await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.equal(job.status, 'complete'); assert.equal(job.result.markdown, markdown); assert.match(prompt, /folder\/code\.py/);
  const latest = await owner.get(`/versions/${demo.versionId}/description/jobs/latest`).expect(200); assert.equal(latest.body.id, queued.body.id);
  const unchanged = await detail(owner, demo.id); assert.equal(unchanged.latest.description.content, description.content);
  assert.equal(unchanged.latest.description.notes, '生成期间继续编辑');
  assert.ok(ctx.notifications.list().some(item => item.kind === 'description_generated' && item.recipient_id === 'preview-employee'));
  await owner.send('post', `/description/jobs/${queued.body.id}/review`, { action: 'accepted' }).expect(200);
  await owner.get(`/versions/${demo.versionId}/description/jobs/latest`).expect(200).then(response => assert.equal(response.body, null));
  await (await ctx.login('preview-other')).get(`/description/jobs/${queued.body.id}`).expect(404);
  await (await ctx.login('preview-other')).send('post', `/versions/${demo.versionId}/description/generate`, { revision: 1 }).expect(404);
});

test('description agent falls back to the API when explicitly selected Claude CLI is unavailable', async t => {
  const markdown = '# 数据概述\n\n本数据用于验证兼容接口。\n\n# 数据格式\n\n```text\ndata.csv  # 数据文件\n```';
  let authorization = '';
  const ctx = await fixture(t, {
    descriptionAgentKey: 'compatible-test-key', descriptionAgentUrl: 'https://agent.test', descriptionAgentModel: 'compatible-test-model',
    descriptionAgentCommand: 'missing-claude-command-for-test',
    descriptionAgentTransport: 'cli',
    descriptionAgentFetch: async (_url, options) => {
      authorization = options.headers.authorization;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ markdown }) } }] }) };
    }
  });
  const owner = await ctx.login('preview-employee'), demo = await create(owner);
  await owner.upload(demo.versionId, 0, 'data.csv', Buffer.from('id,value\n1,2')).expect(201);
  const queued = await owner.send('post', `/versions/${demo.versionId}/description/generate`, { revision: 1 }).expect(202);
  let job; for (let i=0;i<50;i++) { job=(await owner.get(`/description/jobs/${queued.body.id}`).expect(200)).body; if (['complete','failed'].includes(job.status)) break; await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.equal(job.status, 'complete');
  assert.equal(job.result.markdown, markdown);
  assert.equal(authorization, 'Bearer compatible-test-key');
});

test('description jobs remain discoverable while running and can be retried after timing out', async t => {
  let calls = 0;
  const ctx = await fixture(t, {
    descriptionAgentKey: 'test-key', descriptionAgentUrl: 'https://agent.test', descriptionAgentModel: 'test-model', descriptionAgentTimeoutMs: 150,
    descriptionAgentRunner: async () => { calls++; return calls === 1 ? new Promise(() => {}) : { markdown: description.content }; }
  });
  const owner = await ctx.login('preview-employee'), demo = await create(owner);
  await owner.upload(demo.versionId, 0, 'data.csv', Buffer.from('id,value\n1,2')).expect(201);
  const queued = await owner.send('post', `/versions/${demo.versionId}/description/generate`, { revision: 1 }).expect(202);
  const latest = await owner.get(`/versions/${demo.versionId}/description/jobs/latest`).expect(200);
  assert.equal(latest.body.id, queued.body.id); assert.equal(latest.body.result, null);
  const duplicate = await owner.send('post', `/versions/${demo.versionId}/description/generate`, { revision: 1 }).expect(202);
  assert.equal(duplicate.body.id, queued.body.id);
  let job;
  for (let attempt = 0; attempt < 100; attempt++) {
    job = (await owner.get(`/description/jobs/${queued.body.id}`).expect(200)).body;
    if (job.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'failed'); assert.match(job.error, /生成超时/);
  const failed = await owner.get(`/versions/${demo.versionId}/description/jobs/latest`).expect(200);
  assert.equal(failed.body.status, 'failed'); assert.match(failed.body.error, /生成超时/);
  const retry = await owner.send('post', `/versions/${demo.versionId}/description/generate`, { revision: 1 }).expect(202);
  assert.notEqual(retry.body.id, queued.body.id);
  for (let attempt = 0; attempt < 100; attempt++) {
    job = (await owner.get(`/description/jobs/${retry.body.id}`).expect(200)).body;
    if (['complete', 'failed'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'complete'); assert.equal(calls, 2);
});

test('startup releases description jobs interrupted by a previous server process', async t => {
  const ctx = await fixture(t), owner = await ctx.login('preview-employee'), demo = await create(owner);
  for (const status of ['pending', 'running']) ctx.store.run('INSERT INTO description_jobs(id,version_id,requester_id,status,base_revision,created_at) VALUES(?,?,?,?,?,?)', `interrupted-${status}`, demo.versionId, 'preview-employee', status, 0, new Date().toISOString());
  const restarted = createApp({ dataDir: ctx.store.root, demoMode: true, origin });
  try {
    const jobs = restarted.store.all('SELECT status,error,completed_at FROM description_jobs WHERE version_id=?', demo.versionId);
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every(job => job.status === 'failed' && job.completed_at && job.error.includes('服务重启')));
  } finally { restarted.store.db.close(); }
  const latest = await owner.get(`/versions/${demo.versionId}/description/jobs/latest`).expect(200);
  assert.equal(latest.body.status, 'failed');
});

test('admin can atomically transfer a filtered selection of assets', async t => {
  const ctx = await fixture(t), admin = await ctx.login('preview-admin'), owner = await ctx.login('preview-employee');
  const first = await create(owner), second = await create(owner);
  const firstDetail = await detail(owner, first.id), secondDetail = await detail(owner, second.id);
  const payload = { assets: [{ id: first.id, revision: firstDetail.revision }, { id: second.id, revision: secondDetail.revision }], ownerId: 'preview-other', reason: '批量调整负责人' };
  const result = await admin.send('post', '/admin/assets/transfer-batch', payload).expect(200);
  assert.equal(result.body.count, 2);
  assert.equal(ctx.store.one('SELECT owner_id FROM assets WHERE id=?', first.id).owner_id, 'preview-other');
  assert.equal(ctx.store.one('SELECT owner_id FROM assets WHERE id=?', second.id).owner_id, 'preview-other');
  const events = ctx.store.all("SELECT detail FROM events WHERE action='transfer' AND asset_id IN (?,?)", first.id, second.id);
  assert.equal(events.length, 2); assert.ok(events.every(e => JSON.parse(e.detail).batchSize === 2));
  await admin.send('post', '/admin/assets/transfer-batch', payload).expect(409);
});

const requirementContent = { title: '门店经营演示需求', content: '需要门店和订单的合成数据，支持按区域展示销售趋势，并提供清晰的字段说明。', category: '零售与消费' };
async function publishRequirement(client, extra = {}) { return (await client.send('post', '/requirements', { ...requirementContent, assignedUserIds: ['preview-employee'], ...extra }).expect(201)).body; }
async function requirementUpload(client, id, contents = Buffer.from('requirement document'), name = '需求说明.txt', status = 201) {
  const csrf = (await client.agent.get('/api/auth/me')).body.csrf;
  return client.agent.post(`/api/requirements/${id}/documents`).set('Origin', origin).set('X-Requested-With', 'PRT').set('X-CSRF-Token', csrf).attach('file', contents, name).expect(status);
}

test('requirement forwarding adds multiple recipients without replacing existing assignments and grants document access', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), business = await ctx.login('preview-business'), manager = await ctx.login('preview-other-manager'), employee = await ctx.login('preview-other'), colleague = await ctx.login('preview-colleague');
  const requirement = await publishRequirement(pm);
  const document = await requirementUpload(pm, requirement.id);
  const owner = await ctx.login('preview-employee');
  const demo = (await owner.send('post', '/assets', { description, requirementIds: [requirement.id] }).expect(201)).body;
  const endpoint = `/requirements/${requirement.id}`;
  await employee.get(endpoint).expect(403);
  await employee.get(`${endpoint}/documents/${document.body.id}/download`).expect(403);
  const original = ctx.store.one('SELECT * FROM requirement_assignees WHERE requirement_id=? AND user_id=?', requirement.id, 'preview-employee');
  const forwarded = (await business.send('post', endpoint + '/forward', { revision: document.body.revision, assignedUserIds: ['preview-other-manager', 'preview-colleague', 'preview-colleague'] }).expect(200)).body;
  assert.deepEqual(forwarded.addedUserIds, ['preview-other-manager', 'preview-colleague']);
  assert.equal(forwarded.revision, 2);
  assert.deepEqual(forwarded.assignedUsers.map(user => user.id).sort(), ['preview-employee', 'preview-other-manager', 'preview-colleague'].sort());
  assert.deepEqual(ctx.store.one('SELECT * FROM requirement_assignees WHERE requirement_id=? AND user_id=?', requirement.id, 'preview-employee'), original);
  const managerDetail = (await manager.get(endpoint).expect(200)).body;
  assert.equal(managerDetail.canForward, true); assert.equal(managerDetail.canManage, false); assert.equal(managerDetail.canStatusManage, false);
  const next = (await manager.send('post', endpoint + '/forward', { revision: 2, assignedUserIds: ['preview-other', 'preview-colleague'] }).expect(200)).body;
  assert.deepEqual(next.addedUserIds, ['preview-other']);
  assert.equal(next.revision, 3); assert.equal(next.assignedUsers.length, 4);
  for (const client of [employee, colleague]) {
    assert.equal((await client.get(endpoint).expect(200)).body.canForward, false);
    assert.ok((await client.get('/requirements?assigned=1').expect(200)).body.items.some(item => item.id === requirement.id));
    await client.get(`${endpoint}/documents/${document.body.id}/download`).expect(200);
    await client.get(`/assets/${demo.id}`).expect(404);
    await client.send('put', endpoint, { ...requirementContent, revision: 3 }).expect(403);
    await client.send('post', endpoint + '/actions', { revision: 3, action: 'set_status', status: 'delivered' }).expect(403);
  }
  const repeat = (await business.send('post', endpoint + '/forward', { revision: 3, assignedUserIds: ['preview-colleague', 'preview-other-manager'] }).expect(200)).body;
  assert.deepEqual(repeat.addedUserIds, []); assert.equal(repeat.revision, 3);
  assert.equal(ctx.store.one('SELECT assigned_by FROM requirement_assignees WHERE requirement_id=? AND user_id=?', requirement.id, 'preview-other').assigned_by, 'preview-other-manager');
  const events = ctx.store.all("SELECT actor_id,detail FROM events WHERE action='requirement_forward'");
  assert.equal(events.length, 2);
  assert.equal(events[0].actor_id, 'preview-business');
  assert.deepEqual(JSON.parse(events[1].detail).recipients.map(user => user.id), ['preview-other']);
  const unchanged = (await pm.get(endpoint).expect(200)).body;
  assert.equal(unchanged.title, requirement.title); assert.equal(unchanged.content, requirement.content); assert.equal(unchanged.status, requirement.status); assert.equal(unchanged.publisher.id, requirement.publisher.id);
});

test('PM and business may forward any visible requirement to supervisors and employees but not other role-only accounts', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), business = await ctx.login('preview-business');
  for (const actor of [pm, business]) {
    const requirement = await publishRequirement(actor === pm ? business : pm, { assignedUserIds: [] });
    const endpoint = `/requirements/${requirement.id}`;
    const candidates = (await actor.get(endpoint + '/forward-candidates').expect(200)).body;
    assert.deepEqual(candidates.allowedRoles, ['supervisor', 'employee']);
    assert.equal(candidates.assignedCount, 0); assert.equal(candidates.revision, 0);
    assert.ok(candidates.items.some(user => user.id === 'preview-other-manager'));
    assert.ok(candidates.items.some(user => user.id === 'preview-employee'));
    for (const id of ['preview-admin', 'preview-pm', 'preview-business', 'preview-unassigned', 'missing-user']) {
      assert.ok(!candidates.items.some(user => user.id === id));
      await actor.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: ['preview-employee', id] }).expect(400);
    }
    await actor.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: [] }).expect(400);
    assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_assignees WHERE requirement_id=?', requirement.id).count, 0);
    const forwarded = (await actor.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: ['preview-other-manager', 'preview-employee'] }).expect(200)).body;
    assert.equal(forwarded.assignedUsers.length, 2);
  }
});

test('supervisors only forward requirements they can view to employees and ordinary recipients cannot forward', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), manager = await ctx.login('preview-other-manager'), employee = await ctx.login('preview-employee'), admin = await ctx.login('preview-admin');
  ctx.store.run('UPDATE users SET roles=? WHERE id=?', JSON.stringify(['supervisor', 'employee']), 'preview-manager');
  const requirement = await publishRequirement(pm, { assignedUserIds: ['preview-other-manager', 'preview-employee', 'preview-admin'] });
  const endpoint = `/requirements/${requirement.id}`;
  const candidates = (await manager.get(endpoint + '/forward-candidates').expect(200)).body;
  assert.deepEqual(candidates.allowedRoles, ['employee']);
  assert.ok(candidates.items.some(user => user.id === 'preview-colleague'));
  assert.equal(candidates.items.find(user => user.id === 'preview-employee').assigned, true);
  assert.ok(candidates.items.every(user => user.roles.includes('employee') && !user.roles.includes('supervisor')));
  for (const id of ['preview-manager', 'preview-other-manager', 'preview-pm', 'preview-admin']) {
    await manager.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: ['preview-colleague', id] }).expect(400);
  }
  for (const client of [employee, admin]) {
    assert.equal((await client.get(endpoint).expect(200)).body.canForward, false);
    await client.get(endpoint + '/forward-candidates').expect(403);
    await client.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: ['preview-colleague'] }).expect(403);
  }
  const hidden = await publishRequirement(pm, { assignedUserIds: [] });
  await manager.get(`/requirements/${hidden.id}/forward-candidates`).expect(403);
  await manager.send('post', `/requirements/${hidden.id}/forward`, { revision: 0, assignedUserIds: ['preview-colleague'] }).expect(403);
  await manager.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: ['preview-colleague', 'preview-other'] }).expect(200);
  await manager.send('put', endpoint, { ...requirementContent, revision: 1 }).expect(403);
  await manager.send('post', endpoint + '/actions', { revision: 1, action: 'set_status', status: 'closed' }).expect(403);
});

test('forwarding rechecks live roles, account state and access and rejects the whole batch on failure', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), manager = await ctx.login('preview-other-manager');
  const requirement = await publishRequirement(pm, { assignedUserIds: ['preview-other-manager'] });
  const endpoint = `/requirements/${requirement.id}`;
  await manager.get(endpoint + '/forward-candidates').expect(200);
  for (const update of ["enabled=0", "roles='[\"supervisor\",\"employee\"]'", "deleted_at='2026-10-19T00:00:00Z'"]) {
    ctx.store.run(`UPDATE users SET ${update} WHERE id=?`, 'preview-colleague');
    await manager.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: ['preview-employee', 'preview-colleague'] }).expect(400);
    assert.equal(ctx.store.one('SELECT revision FROM requirements WHERE id=?', requirement.id).revision, 0);
    assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_assignees WHERE requirement_id=?', requirement.id).count, 1);
    ctx.store.run('UPDATE users SET enabled=1,roles=?,deleted_at=NULL WHERE id=?', JSON.stringify(['employee']), 'preview-colleague');
  }
  await pm.send('put', endpoint, { ...requirementContent, assignedUserIds: [], revision: 0 }).expect(200);
  await manager.get(endpoint + '/forward-candidates').expect(403);
  await manager.send('post', endpoint + '/forward', { revision: 1, assignedUserIds: ['preview-employee'] }).expect(403);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM events WHERE action='requirement_forward'").count, 0);
});

test('forwarding checks revisions so concurrent forwards and stale publisher edits never erase recipients', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), business = await ctx.login('preview-business');
  const requirement = await publishRequirement(pm), endpoint = `/requirements/${requirement.id}`;
  const targets = ['preview-colleague', 'preview-other'];
  const responses = await Promise.all([pm, business].map((actor, index) => actor.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: [targets[index]] })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const current = (await pm.get(endpoint).expect(200)).body;
  assert.equal(current.assignedUsers.length, 2); assert.ok(current.assignedUsers.some(user => user.id === 'preview-employee'));
  await pm.send('put', endpoint, { ...requirementContent, assignedUserIds: ['preview-employee'], revision: 0 }).expect(409);
  const remaining = targets.filter(id => !current.assignedUsers.some(user => user.id === id));
  const completed = (await business.send('post', endpoint + '/forward', { revision: current.revision, assignedUserIds: remaining }).expect(200)).body;
  assert.equal(completed.assignedUsers.length, 3);
  assert.deepEqual(ctx.store.all('PRAGMA foreign_key_check'), []);
});

test('forwarding enforces the total assignee limit without partially applying a batch', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm');
  const ids = Array.from({ length: 100 }, (_, index) => `forward-employee-${index}`);
  for (const id of ids) ctx.store.run('INSERT INTO users(id,open_id,name,roles,created_at) VALUES(?,?,?,?,?)', id, 'preview:' + id, id, JSON.stringify(['employee']), new Date().toISOString());
  const requirement = await publishRequirement(pm, { assignedUserIds: ids.slice(0, 99) }), endpoint = `/requirements/${requirement.id}`;
  await pm.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: [ids[99], 'preview-other'] }).expect(400);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_assignees WHERE requirement_id=?', requirement.id).count, 99);
  const forwarded = (await pm.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: [ids[99]] }).expect(200)).body;
  assert.equal(forwarded.assignedUsers.length, 100);
  const candidates = (await pm.get(endpoint + '/forward-candidates').expect(200)).body;
  assert.equal(candidates.assignedCount, 100); assert.equal(candidates.maxAssignees, 100);
  await pm.send('post', endpoint + '/forward', { revision: 1, assignedUserIds: ['preview-other'] }).expect(400);
});

test('only product managers and business users can publish requirements and publishers manage their own', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), business = await ctx.login('preview-business');
  for (const id of ['preview-employee', 'preview-other-manager', 'preview-admin']) {
    const user = await ctx.login(id);
    await user.send('post', '/requirements', requirementContent).expect(403);
  }
  const requirement = await publishRequirement(pm), businessRequirement = await publishRequirement(business, { title: '商务客户演示需求' });
  assert.equal(requirement.publisher.id, 'preview-pm'); assert.equal(businessRequirement.publisher.id, 'preview-business');
  await pm.send('post', '/requirements', { ...requirementContent, title: '  ' }).expect(400);
  await business.send('put', `/requirements/${requirement.id}`, { ...requirementContent, revision: 0 }).expect(403);
  await business.send('post', `/requirements/${requirement.id}/actions`, { revision: 0, action: 'close' }).expect(403);
  const edited = await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, title: '修订后的需求', revision: 0 }).expect(200);
  assert.equal(edited.body.revision, 1);
  await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, revision: 0 }).expect(409);
  const closed = await pm.send('post', `/requirements/${requirement.id}/actions`, { revision: 1, action: 'close' }).expect(200);
  assert.equal(closed.body.status, 'closed');
  await pm.send('post', `/requirements/${requirement.id}/actions`, { revision: 2, action: 'close' }).expect(409);
  await pm.send('post', `/requirements/${requirement.id}/actions`, { revision: 2, action: 'reopen' }).expect(200);
  const events = ctx.store.all("SELECT action FROM events WHERE detail LIKE ?", `%${requirement.id}%`).map(item => item.action);
  for (const action of ['requirement_publish', 'requirement_edit', 'requirement_close', 'requirement_reopen']) assert.ok(events.includes(action));
});

test('requirements support optional assignees and documents with read-only assigned access', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee'), admin = await ctx.login('preview-admin'), other = await ctx.login('preview-other');
  const requirement = await publishRequirement(pm, { assignedUserIds: ['preview-employee', 'preview-admin'] });
  const pmList = (await pm.get('/requirements')).body.items;
  assert.ok(pmList.some(item => item.id === requirement.id));
  const employeeList = (await employee.get('/requirements')).body.items;
  assert.ok(employeeList.some(item => item.id === requirement.id));
  const otherList = (await other.get('/requirements')).body.items;
  assert.ok(!otherList.some(item => item.id === requirement.id));
  await other.get(`/requirements/${requirement.id}`).expect(403);
  await employee.send('put', `/requirements/${requirement.id}`, { ...requirementContent, assignedUserIds: [], revision: 0 }).expect(403);
  const document = await requirementUpload(pm, requirement.id);
  assert.equal(document.body.revision, 1);
  const detailData = (await employee.get(`/requirements/${requirement.id}`).expect(200)).body;
  assert.equal(detailData.documents.length, 1); assert.equal(detailData.documents[0].name, '需求说明.txt');
  const downloaded = await employee.get(`/requirements/${requirement.id}/documents/${document.body.id}/download`).expect(200);
  assert.equal(downloaded.text || downloaded.body.toString(), 'requirement document');
  assert.match(downloaded.headers['content-disposition'], /attachment/);
  await admin.get(`/requirements/${requirement.id}/documents/${document.body.id}/download`).expect(200);
  await other.get(`/requirements/${requirement.id}/documents/${document.body.id}/download`).expect(403);
  for (const client of [employee, admin]) {
    await client.get('/requirements/assignees').expect(403);
    for (const actionName of ['close', 'reopen']) await client.send('post', `/requirements/${requirement.id}/actions`, { revision: 1, action: actionName }).expect(403);
    await requirementUpload(client, requirement.id, Buffer.from('forbidden'), 'forbidden.txt', 403);
  }
  const demo = (await employee.send('post', '/assets', { description, requirementIds: [requirement.id] }).expect(201)).body;
  await employee.send('post', `/requirements/${requirement.id}/demos`, { assetId: demo.id, revision: 0 }).expect(403);
  await employee.send('delete', `/requirements/${requirement.id}/demos/${demo.id}`, { revision: 0 }).expect(403);
  const candidates = (await employee.get(`/requirements/${requirement.id}/demo-candidates`).expect(200)).body;
  assert.ok(candidates.items.every(item => !item.canBind));
  await other.get(`/requirements/${requirement.id}/demo-candidates`).expect(403);
  await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, assignedUserIds: [], revision: 1 }).expect(200);
  await employee.get(`/requirements/${requirement.id}`).expect(403);
  await employee.get(`/requirements/${requirement.id}/documents/${document.body.id}/download`).expect(403);
  assert.ok(!(await employee.get('/requirements').expect(200)).body.items.some(item => item.id === requirement.id));
});

test('requirements without assignees stay private to publishers and invalid assignments roll back', async t => {
  const ctx = await fixture(t), business = await ctx.login('preview-business'), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee');
  const requirement = (await business.send('post', '/requirements', requirementContent).expect(201)).body;
  assert.deepEqual(requirement.assignedUsers, []);
  await pm.get(`/requirements/${requirement.id}`).expect(200);
  await employee.get(`/requirements/${requirement.id}`).expect(403);
  await business.send('put', `/requirements/${requirement.id}`, { ...requirementContent, assignedUserIds: ['missing-user'], revision: 0 }).expect(400);
  assert.equal(ctx.store.one('SELECT revision FROM requirements WHERE id=?', requirement.id).revision, 0);
  await business.send('put', `/requirements/${requirement.id}`, { ...requirementContent, assignedUserIds: ['preview-employee', 'preview-employee'], revision: 0 }).expect(200);
  assert.equal((await employee.get(`/requirements/${requirement.id}`).expect(200)).body.assignedUsers.length, 1);
  await requirementUpload(business, requirement.id, Buffer.alloc(0), 'empty.txt', 400);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_files WHERE requirement_id=?', requirement.id).count, 0);
  assert.deepEqual(fs.readdirSync(path.join(ctx.store.root, 'tmp')), []);
});

test('multiple requirement documents are retained and independently downloadable after additional uploads', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee');
  const requirement = await publishRequirement(pm);
  const first = await requirementUpload(pm, requirement.id, Buffer.from('first document'), '需求一.txt');
  const second = await requirementUpload(pm, requirement.id, Buffer.from('second document'), '需求二.txt');
  const current = (await employee.get(`/requirements/${requirement.id}`).expect(200)).body;
  assert.equal(current.documents.length, 2);
  assert.deepEqual(new Set(current.documents.map(file => file.name)), new Set(['需求一.txt', '需求二.txt']));
  assert.equal(second.body.revision, first.body.revision + 1);
  for (const [document, contents] of [[first.body, 'first document'], [second.body, 'second document']]) {
    const response = await employee.get(`/requirements/${requirement.id}/documents/${document.id}/download`).expect(200);
    assert.equal(response.text || response.body.toString(), contents);
  }
});

test('Demo requirement bindings support many-to-many and stay within Demo visibility', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee'), other = await ctx.login('preview-other'), admin = await ctx.login('preview-admin');
  const first = await publishRequirement(pm, { assignedUserIds: ['preview-employee', 'preview-admin', 'preview-other'] }), second = await publishRequirement(pm, { title: '第二个演示需求' });
  const own = (await employee.send('post', '/assets', { description, requirementIds: [first.id, second.id, first.id] }).expect(201)).body;
  const hidden = (await other.send('post', '/assets', { description, requirementIds: [first.id] }).expect(201)).body;
  const detailData = await detail(employee, own.id);
  assert.equal(detailData.requirements.length, 2);
  assert.deepEqual(new Set(detailData.latest.requirements.map(item => item.id)), new Set([first.id, second.id]));
  const employeeView = (await employee.get(`/requirements/${first.id}`).expect(200)).body;
  assert.deepEqual(employeeView.demos.map(asset => asset.id), [own.id]);
  const pmView = (await pm.get(`/requirements/${first.id}`).expect(200)).body;
  assert.equal(pmView.demos.length, 2);
  const adminView = (await admin.get(`/requirements/${first.id}`).expect(200)).body;
  assert.equal(adminView.demos.length, 0);
  const candidates = (await employee.get(`/requirements/${second.id}/demo-candidates`).expect(200)).body;
  assert.ok(candidates.items.every(asset => asset.owner.id === 'preview-employee'));
  assert.ok(!JSON.stringify(candidates).includes(hidden.id));
  const filtered = (await employee.get(`/catalog?requirement=${first.id}`).expect(200)).body;
  assert.deepEqual(filtered.items.map(asset => asset.id), [own.id]);
  const list = (await employee.get('/requirements?q=' + encodeURIComponent(first.title)).expect(200)).body;
  assert.equal(list.items.find(item => item.id === first.id).demoCount, 1);
  await employee.send('post', `/requirements/${second.id}/demos`, { assetId: hidden.id, revision: 0 }).expect(404);
});

test('business publishers bind visible Demos without gaining permission to edit Demo content', async t => {
  const ctx = await fixture(t), business = await ctx.login('preview-business'), employee = await ctx.login('preview-employee');
  const requirement = await publishRequirement(business), demo = (await employee.send('post', '/assets', { description }).expect(201)).body;
  await business.send('post', `/requirements/${requirement.id}/demos`, { assetId: demo.id, revision: 0 }).expect(200);
  let current = await detail(employee, demo.id);
  assert.deepEqual(current.requirements.map(item => item.id), [requirement.id]); assert.equal(current.revision, 1);
  await business.send('put', `/versions/${demo.versionId}`, { revision: 0, description }).expect(403);
  await business.send('delete', `/requirements/${requirement.id}/demos/${demo.id}`, { revision: 1 }).expect(200);
  current = await detail(employee, demo.id); assert.equal(current.requirements.length, 0);
  const anotherPublisher = await ctx.login('preview-pm'), foreignRequirement = await publishRequirement(anotherPublisher);
  await business.send('post', `/requirements/${foreignRequirement.id}/demos`, { assetId: demo.id, revision: current.revision }).expect(403);
});

test('drafts may be unbound but submission and publication require a requirement', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee'), manager = await ctx.login('preview-manager'), pm = await ctx.login('preview-pm');
  const requirement = await publishRequirement(pm);
  for (const [client, transition] of [[employee, 'submit'], [manager, 'publish']]) {
    const demo = (await client.send('post', '/assets', { description }).expect(201)).body;
    await client.upload(demo.versionId, 0, 'sample.csv', Buffer.from('id,value\n1,2')).expect(201);
    const denied = await action(client, demo.versionId, 1, transition); assert.equal(denied.status, 400); assert.match(denied.body.error, /绑定至少一个需求/);
    const before = await detail(client, demo.id);
    await client.send('put', `/versions/${demo.versionId}`, { revision: 1, assetRevision: before.revision, description, requirementIds: [requirement.id] }).expect(200);
    assert.equal((await action(client, demo.versionId, 2, transition)).status, 200);
    const after = await detail(client, demo.id);
    assert.deepEqual(after.requirements.map(item => item.id), [requirement.id]);
    const blocked = await pm.send('delete', `/requirements/${requirement.id}/demos/${demo.id}`, { revision: after.revision }).expect(409);
    assert.match(blocked.body.error, /保留至少一个/);
    if (transition === 'submit') {
      assert.equal(after.submissions[0].snapshot.requirements[0].id, requirement.id);
      await manager.send('put', `/versions/${demo.versionId}`, { revision: 3, assetRevision: after.revision, description, requirementIds: [] }).expect(409);
    }
  }
});

test('closed requirements preserve existing links and reject new links until reopened', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee'), pm = await ctx.login('preview-pm');
  const requirement = await publishRequirement(pm);
  const demo = (await employee.send('post', '/assets', { description, requirementIds: [requirement.id] }).expect(201)).body;
  await pm.send('post', `/requirements/${requirement.id}/actions`, { revision: 0, action: 'close' }).expect(200);
  const before = await detail(employee, demo.id);
  await employee.send('put', `/versions/${demo.versionId}`, { revision: 0, assetRevision: before.revision, description, requirementIds: [requirement.id] }).expect(200);
  await employee.send('post', '/assets', { description, requirementIds: [requirement.id] }).expect(409);
  const next = (await employee.send('post', '/assets', { description }).expect(201)).body;
  await pm.send('post', `/requirements/${requirement.id}/demos`, { assetId: next.id, revision: 0 }).expect(409);
  await pm.send('post', `/requirements/${requirement.id}/actions`, { revision: 1, action: 'reopen' }).expect(200);
  await pm.send('post', `/requirements/${requirement.id}/demos`, { assetId: next.id, revision: 0 }).expect(200);
});

test('binding edits are atomic and reject stale asset revisions or invalid requirements', async t => {
  const ctx = await fixture(t), employee = await ctx.login('preview-employee'), pm = await ctx.login('preview-pm');
  const first = await publishRequirement(pm), second = await publishRequirement(pm);
  const demo = (await employee.send('post', '/assets', { description, requirementIds: [first.id] }).expect(201)).body;
  await pm.send('post', `/requirements/${second.id}/demos`, { assetId: demo.id, revision: 0 }).expect(200);
  await employee.send('put', `/versions/${demo.versionId}`, { revision: 0, assetRevision: 0, description: { ...description, title: '冲突覆盖' }, requirementIds: [first.id] }).expect(409);
  let current = await detail(employee, demo.id); assert.equal(current.latest.description.title, description.title); assert.equal(current.requirements.length, 2);
  await employee.send('put', `/versions/${demo.versionId}`, { revision: 0, assetRevision: current.revision, description, requirementIds: ['00000000-0000-4000-8000-000000000000'] }).expect(404);
  current = await detail(employee, demo.id); assert.equal(current.latest.revision, 0); assert.equal(current.requirements.length, 2);
  const count = ctx.store.one('SELECT COUNT(*) AS count FROM assets').count;
  await employee.send('post', '/assets', { description, requirementIds: ['invalid'] }).expect(400);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM assets').count, count);
  await employee.send('put', `/versions/${demo.versionId}`, { revision: 0, assetRevision: current.revision, description, requirementIds: [] }).expect(200);
  assert.equal((await detail(employee, demo.id)).requirements.length, 0);
});

test('requirement bindings persist through backup, restore and Demo version creation', async t => {
  const ctx = await fixture(t), manager = await ctx.login('preview-manager'), pm = await ctx.login('preview-pm');
  const requirement = await publishRequirement(pm, { businessUserIds: ['preview-business'], developmentUserIds: ['preview-employee'], publishDate: '2028-02-28', deadlineDate: '2028-02-29' }), demo = (await manager.send('post', '/assets', { description, requirementIds: [requirement.id] }).expect(201)).body;
  const document = await requirementUpload(pm, requirement.id);
  await manager.upload(demo.versionId, 0, 'data.csv', Buffer.from('id,value\n1,2')).expect(201);
  assert.equal((await action(manager, demo.versionId, 1, 'publish')).status, 200);
  const published = await detail(manager, demo.id);
  await manager.send('post', `/assets/${demo.id}/versions`, { revision: published.revision, baseVersionId: demo.versionId }).expect(201);
  assert.equal((await detail(manager, demo.id)).versions.every(version => version.requirements[0].id === requirement.id), true);
  const backupPath = path.join(ctx.root, 'requirement-backup'), restorePath = path.join(ctx.root, 'requirement-restore');
  await createBackup(ctx.store.root, backupPath); await restoreBackup(backupPath, restorePath);
  const restored = createApp({ dataDir: restorePath, demoMode: true, origin });
  try {
    assert.equal(restored.store.one('SELECT title FROM requirements WHERE id=?', requirement.id).title, requirement.title);
    assert.equal(restored.store.one('SELECT requirement_id FROM asset_requirements WHERE asset_id=?', demo.id).requirement_id, requirement.id);
    assert.deepEqual(restored.store.all('SELECT user_id,responsibility FROM requirement_assignees WHERE requirement_id=? ORDER BY user_id', requirement.id).map(user => ({ ...user })), [{ user_id: 'preview-business', responsibility: 'business' }, { user_id: 'preview-employee', responsibility: 'development' }]);
    const dates = restored.store.one('SELECT planned_date,deadline_date FROM requirements WHERE id=?', requirement.id);
    assert.equal(dates.planned_date, '2028-02-28'); assert.equal(dates.deadline_date, '2028-02-29');
    assert.equal(restored.store.one('SELECT file_id FROM requirement_files WHERE requirement_id=?', requirement.id).file_id, document.body.id);
    assert.equal(fs.readFileSync(path.join(restorePath, 'files', document.body.id), 'utf8'), 'requirement document');
    assert.equal(restored.store.one('PRAGMA foreign_key_check'), undefined);
  } finally { restored.store.db.close(); }
});

test('publication notifies all PMs and only linked business publishers, deduplicating roles and CCs', async t => {
  const ctx = await fixture(t), manager = await ctx.login('preview-manager'), business = await ctx.login('preview-business');
  ctx.store.run('UPDATE users SET roles=? WHERE id=?', JSON.stringify(['business', 'pm']), 'preview-other-manager');
  ctx.store.run('UPDATE users SET roles=? WHERE id IN (?,?)', JSON.stringify(['business']), 'preview-other', 'preview-colleague');
  ctx.store.run('UPDATE users SET roles=?,enabled=0 WHERE id=?', JSON.stringify(['pm']), 'preview-admin');
  const secondBusiness = await ctx.login('preview-other-manager'), unrelatedBusiness = await ctx.login('preview-other'), disabledBusiness = await ctx.login('preview-colleague');
  const first = await publishRequirement(business, { title: '商务需求一' }), second = await publishRequirement(business, { title: '商务需求二' });
  const third = await publishRequirement(secondBusiness, { title: '另一位商务的需求' }), fourth = await publishRequirement(disabledBusiness, { title: '已停用商务的需求' });
  await publishRequirement(unrelatedBusiness, { title: '未关联的商务需求' });
  const demo = (await manager.send('post', '/assets', { description, requirementIds: [first.id, second.id, third.id, fourth.id] }).expect(201)).body;
  await manager.upload(demo.versionId, 0).expect(201);
  await business.send('post', `/requirements/${first.id}/actions`, { revision: 0, action: 'close' }).expect(200);
  ctx.store.run('UPDATE users SET enabled=0 WHERE id=?', 'preview-colleague');
  await manager.send('post', `/versions/${demo.versionId}/actions`, { revision: 1, action: 'publish', ccUserIds: ['preview-employee', 'missing-user'] }).expect(400);
  assert.equal(ctx.store.one('SELECT status FROM versions WHERE id=?', demo.versionId).status, 'draft');
  assert.equal(ctx.notifications.list().filter(job => job.version_id === demo.versionId).length, 0);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM version_cc WHERE version_id=?', demo.versionId).count, 0);
  await manager.send('post', `/versions/${demo.versionId}/actions`, { revision: 1, action: 'publish', ccUserIds: ['preview-business', 'preview-other-manager', 'preview-employee', 'preview-employee'] }).expect(200);
  const jobs = ctx.notifications.list().filter(job => job.version_id === demo.versionId && job.kind === 'publish');
  assert.deepEqual(new Set(jobs.map(job => job.recipient_id)), new Set(['preview-manager', 'preview-pm', 'preview-business', 'preview-other-manager', 'preview-employee']));
  assert.equal(jobs.length, 5);
  for (const job of jobs) assert.deepEqual(new Set(JSON.parse(job.detail).requirements.map(requirement => requirement.id)), new Set([first.id, second.id, third.id, fourth.id]));
  await manager.send('post', `/versions/${demo.versionId}/actions`, { revision: 2, action: 'publish' }).expect(409);
  assert.equal(ctx.notifications.list().filter(job => job.version_id === demo.versionId).length, jobs.length);
});

test('Feishu sends requirement snapshots to business publishers and retries publication and restore notifications safely', async t => {
  const ctx = await fixture(t), manager = await ctx.login('preview-manager'), business = await ctx.login('preview-business');
  const requirement = await publishRequirement(business, { title: '商务演示验收需求' });
  const demo = (await manager.send('post', '/assets', { description, requirementIds: [requirement.id] }).expect(201)).body;
  await manager.upload(demo.versionId, 0).expect(201);
  await action(manager, demo.versionId, 1, 'publish').then(result => assert.equal(result.status, 200));
  await business.send('put', `/requirements/${requirement.id}`, { ...requirementContent, title: '发布后的新需求标题', revision: 0 }).expect(200);
  ctx.store.run("DELETE FROM notifications WHERE kind='requirement_publish'");
  const { createNotifications } = await import('../server/notifications.mjs');
  ctx.store.run("UPDATE users SET open_id='ou_mock_' || id");
  const calls = [];
  let failBusiness = true;
  const sender = createNotifications(ctx.store, { demoMode: false, appId: 'test', appSecret: 'test', notificationFetch: async (url, options) => {
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'mock', expire: 7200 }) };
    const message = JSON.parse(options.body); calls.push(message);
    const failed = failBusiness && message.receive_id === 'ou_mock_preview-business';
    return { ok: !failed, json: async () => ({ code: failed ? 230013 : 0 }) };
  } });
  await sender.drain();
  const pending = sender.list().find(job => job.kind === 'publish' && job.recipient_id === 'preview-business');
  assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 1);
  failBusiness = false; ctx.store.run('UPDATE notifications SET next_at=0');
  await sender.drain();
  const businessCalls = calls.filter(message => message.receive_id === 'ou_mock_preview-business');
  assert.equal(businessCalls.length, 2); assert.equal(businessCalls[0].uuid, businessCalls[1].uuid);
  assert.equal(sender.list().find(job => job.id === pending.id).status, 'sent');
  assert.ok(sender.list().filter(job => job.kind === 'publish').every(job => job.status === 'sent'));
  assert.deepEqual(new Set(calls.map(message => message.receive_id)), new Set(['ou_mock_preview-manager', 'ou_mock_preview-pm', 'ou_mock_preview-business']));
  const text = JSON.parse(businessCalls[1].content).text;
  assert.ok(text.includes('商务演示验收需求')); assert.ok(!text.includes('发布后的新需求标题'));
  assert.ok(text.includes(description.title)); assert.ok(text.includes('版本：V1')); assert.ok(text.includes(`demo=${demo.id}`));
  assert.ok(!text.includes(description.costEstimate)); assert.ok(!text.includes(description.content));
  await sender.drain(); assert.equal(calls.length, 4);
  await action(manager, demo.versionId, 2, 'unpublish', '更新文件').then(result => assert.equal(result.status, 200));
  await action(manager, demo.versionId, 3, 'restore', '更新完成').then(result => assert.equal(result.status, 200));
  const restored = sender.list().filter(job => job.kind === 'restore');
  assert.deepEqual(new Set(restored.map(job => job.recipient_id)), new Set(['preview-manager', 'preview-pm', 'preview-business']));
  calls.length = 0;
  await sender.drain();
  assert.equal(calls.length, 3);
  const restoredText = JSON.parse(calls.find(message => message.receive_id === 'ou_mock_preview-business').content).text;
  assert.ok(restoredText.includes('Demo 已恢复发布')); assert.ok(restoredText.includes('发布后的新需求标题'));
  assert.ok(sender.list().filter(job => job.kind === 'restore').every(job => job.status === 'sent'));
});

test('queued business notifications are skipped when accounts, roles or requirement bindings change', async t => {
  const ctx = await fixture(t), manager = await ctx.login('preview-manager'), pm = await ctx.login('preview-pm'), business = await ctx.login('preview-business');
  ctx.store.run('UPDATE users SET roles=? WHERE id IN (?,?)', JSON.stringify(['business']), 'preview-other-manager', 'preview-colleague');
  const secondBusiness = await ctx.login('preview-other-manager'), thirdBusiness = await ctx.login('preview-colleague');
  const first = await publishRequirement(business), second = await publishRequirement(secondBusiness), third = await publishRequirement(thirdBusiness), pmRequirement = await publishRequirement(pm);
  const demo = (await manager.send('post', '/assets', { description, requirementIds: [first.id, second.id, third.id, pmRequirement.id] }).expect(201)).body;
  await manager.upload(demo.versionId, 0).expect(201);
  await action(manager, demo.versionId, 1, 'publish').then(result => assert.equal(result.status, 200));
  ctx.store.run('UPDATE users SET enabled=0 WHERE id=?', 'preview-business');
  ctx.store.run('UPDATE users SET roles=? WHERE id=?', JSON.stringify(['employee']), 'preview-other-manager');
  const asset = await detail(pm, demo.id);
  await thirdBusiness.send('delete', `/requirements/${third.id}/demos/${demo.id}`, { revision: asset.revision }).expect(200);
  ctx.store.run("DELETE FROM notifications WHERE kind='requirement_publish'");
  const { createNotifications } = await import('../server/notifications.mjs');
  ctx.store.run("UPDATE users SET open_id='ou_mock_' || id");
  const calls = [];
  const sender = createNotifications(ctx.store, { demoMode: false, appId: 'test', appSecret: 'test', notificationFetch: async (url, options) => {
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'mock', expire: 7200 }) };
    calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ code: 0 }) };
  } });
  await sender.drain();
  for (const recipient of ['preview-business', 'preview-other-manager', 'preview-colleague']) {
    const job = sender.list().find(item => item.version_id === demo.versionId && item.recipient_id === recipient);
    assert.equal(job.status, 'skipped'); assert.equal(job.attempts, 0);
  }
  assert.deepEqual(new Set(calls.map(message => message.receive_id)), new Set(['ou_mock_preview-manager', 'ou_mock_preview-pm']));
});

test('requirement search matches multiple responsible people without duplicate rows and preserves visibility and literal wildcards', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee');
  ctx.store.run('DELETE FROM requirement_assignees');
  ctx.store.run('UPDATE users SET name=? WHERE id=?', '测试负责人_%甲', 'preview-employee');
  ctx.store.run('UPDATE users SET name=? WHERE id=?', '测试负责人_%乙', 'preview-colleague');
  const first = await publishRequirement(pm, { assignedUserIds: ['preview-employee', 'preview-colleague'] });
  const second = await publishRequirement(pm, { assignedUserIds: ['preview-colleague'] });
  const third = await publishRequirement(pm, { assignedUserIds: ['preview-other'] });
  const query = new URLSearchParams({ q: '测试负责人_%', pageSize: '1' });
  const page = (await pm.get('/requirements?' + query).expect(200)).body;
  assert.equal(page.total, 2); assert.equal(page.pages, 2); assert.equal(page.items.length, 1);
  const next = (await pm.get('/requirements?' + query + '&page=2').expect(200)).body;
  assert.deepEqual(new Set([page.items[0].id, next.items[0].id]), new Set([first.id, second.id]));
  const visible = (await employee.get('/requirements?q=' + encodeURIComponent('测试负责人_%')).expect(200)).body;
  assert.equal(visible.total, 1); assert.equal(visible.items[0].id, first.id);
  assert.equal(visible.items[0].assignedUsers.length, 2);
  assert.equal((await pm.get('/requirements?q=' + encodeURIComponent('%')).expect(200)).body.total, 2);
  assert.equal((await pm.get('/requirements?q=' + encodeURIComponent("' OR 1=1 --")).expect(200)).body.total, 0);
  await pm.send('post', `/requirements/${third.id}/forward`, { revision: 0, assignedUserIds: ['preview-colleague'] }).expect(200);
  assert.equal((await pm.get('/requirements?' + query).expect(200)).body.total, 3);
});

test('requirements put closed items last before pagination and preserve search, assignment visibility and status filters', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee');
  const items = [];
  for (const [status, updatedAt, assignee] of [
    ['closed', '2025-01-06T00:00:00Z', 'preview-employee'],
    ['open', '2025-01-01T00:00:00Z', 'preview-employee'],
    ['needs_update', '2025-01-02T00:00:00Z', 'preview-employee'],
    ['delivered', '2025-01-03T00:00:00Z', 'preview-employee'],
    ['closed', '2025-01-04T00:00:00Z', 'preview-employee'],
    ['open', '2025-01-05T00:00:00Z', 'preview-other']
  ]) {
    const item = await publishRequirement(pm, { title: `排序验收需求-${items.length}`, assignedUserIds: [assignee] });
    ctx.store.run('UPDATE requirements SET status=?,updated_at=? WHERE id=?', status, updatedAt, item.id);
    items.push(item);
  }
  const query = '/requirements?q=' + encodeURIComponent('排序验收需求-');
  const actual = [];
  for (let page = 1; page <= 3; page++) {
    const result = (await pm.get(`${query}&pageSize=2&page=${page}`).expect(200)).body;
    assert.equal(result.total, 6); assert.equal(result.pages, 3);
    actual.push(...result.items.map(item => item.id));
  }
  assert.deepEqual(actual, [5, 3, 2, 1, 0, 4].map(index => items[index].id));
  const mine = (await employee.get(query + '&assigned=1').expect(200)).body;
  assert.equal(mine.total, 5);
  assert.deepEqual(mine.items.map(item => item.id), [3, 2, 1, 0, 4].map(index => items[index].id));
  assert.deepEqual((await pm.get(query + '&status=closed').expect(200)).body.items.map(item => item.id), [items[0].id, items[4].id]);
  await pm.send('post', `/requirements/${items[0].id}/actions`, { revision: 0, action: 'set_status', status: 'open' }).expect(200);
  assert.equal((await employee.get(query).expect(200)).body.items[0].id, items[0].id);
});

test('requirement deadlines sort globally before pagination, put missing dates behind dated items and keep closed items last', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee');
  const items = [];
  for (const [status, deadline, updatedAt, assignee] of [
    ['closed', '2028-01-01', '2025-01-06', 'preview-employee'],
    ['open', '2028-01-03', '2025-01-01', 'preview-employee'],
    ['needs_update', '2028-01-02', '2025-01-02', 'preview-employee'],
    ['delivered', '', '2025-01-03', 'preview-employee'],
    ['closed', '2028-01-02', '2025-01-04', 'preview-employee'],
    ['open', '2028-01-02', '2025-01-05', 'preview-other'],
    ['open', '2027-01-01', '2025-01-06', 'preview-employee'],
    ['open', '', '2025-01-02', 'preview-employee']
  ]) {
    const item = await publishRequirement(pm, { title: `截止排序需求-${items.length}`, publishDate: '2026-01-01', deadlineDate: deadline, assignedUserIds: [assignee] });
    ctx.store.run('UPDATE requirements SET status=?,updated_at=? WHERE id=?', status, updatedAt + 'T00:00:00Z', item.id);
    items.push(item);
  }
  const query = '/requirements?q=' + encodeURIComponent('截止排序需求-'), actual = [];
  for (let page = 1; page <= 4; page++) {
    const result = (await pm.get(`${query}&pageSize=2&page=${page}`).expect(200)).body;
    assert.equal(result.total, 8); actual.push(...result.items.map(item => item.id));
  }
  assert.deepEqual(actual, [6, 5, 2, 1, 3, 7, 0, 4].map(index => items[index].id));
  assert.deepEqual((await employee.get(query).expect(200)).body.items.map(item => item.id), [6, 2, 1, 3, 7, 0, 4].map(index => items[index].id));
  assert.deepEqual((await pm.get(query + '&status=closed').expect(200)).body.items.map(item => item.id), [items[0].id, items[4].id]);
});

test('only PMs export the eight-column template with one requirement per row, separate owners and valid filtered links', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee'), business = await ctx.login('preview-business'), other = await ctx.login('preview-other'), admin = await ctx.login('preview-admin'), supervisor = await ctx.login('preview-other-manager');
  const first = await publishRequirement(pm, { title: '表格导出验收-近', publishDate: '2028-01-01', deadlineDate: '2028-01-02', businessUserIds: ['preview-business'], developmentUserIds: ['preview-employee'] });
  const second = await publishRequirement(pm, { title: '表格导出验收-远', publishDate: '2028-01-01', deadlineDate: '2028-02-01', assignedUserIds: ['preview-pm'] });
  const noDemo = await publishRequirement(pm, { title: '表格导出验收-无日期', assignedUserIds: ['preview-employee'] });
  const link = 'https://team.feishu.cn/docx/DemoExport';
  const wikiUrl = 'https://team.feishu.cn/wiki/PublishedRequirement';
  ctx.store.run("UPDATE requirement_wiki SET url=?,status='synced' WHERE requirement_id=?", wikiUrl, first.id);
  const firstDemo = (await employee.send('post', '/assets', { description: { ...description, title: '=导出 Demo A', content: `[飞书说明](${link})`, notes: '私密备注' }, requirementIds: [first.id] }).expect(201)).body;
  await employee.send('post', '/assets', { description: { ...description, title: '导出 Demo B', content: '没有飞书文档链接' }, requirementIds: [first.id] }).expect(201);
  await other.send('post', '/assets', { description: { ...description, title: '其他人的 Demo', content: 'https://team.feishu.cn/docx/HiddenDemo' }, requirementIds: [first.id] }).expect(201);
  await other.send('post', '/assets', { description: { ...description, title: '无权查看的需求 Demo' }, requirementIds: [second.id] }).expect(201);
  async function exported(client, query) {
    const result = await client.get('/requirements/export.xlsx?' + query).buffer(true).parse((res, callback) => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks))); res.on('error', callback);
    }).expect(200);
    assert.match(result.headers['content-type'], /application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet/);
    assert.match(result.headers['content-disposition'], /attachment;.*\.xlsx/);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(result.body);
    return workbook.worksheets[0];
  }
  await requirementUpload(pm, first.id, Buffer.from('export requirement document'), '导出需求文档.pdf');
  const query = 'q=' + encodeURIComponent('表格导出验收-') + '&pageSize=1&page=2';
  const sheet = await exported(pm, query);
  assert.equal(sheet.columnCount, 8); assert.equal(sheet.rowCount, 4);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['标题', '需求说明', '需求文档', '商务负责人', '研发负责人', '进度', '截止日期', '样例']);
  assert.equal(sheet.getCell('G2').value.toISOString().slice(0, 10), '2028-01-02');
  assert.equal(sheet.getCell('G3').value.toISOString().slice(0, 10), '2028-02-01');
  assert.equal(sheet.getCell('G4').text, '/'); assert.equal(sheet.getCell('H4').text, '/');
  assert.equal(new URL(sheet.getCell('A2').hyperlink).searchParams.get('requirement'), first.id);
  assert.equal(sheet.getCell('C2').text, '导出需求文档.pdf');
  assert.equal(sheet.getCell('C2').hyperlink, sheet.getCell('A2').hyperlink);
  assert.match(sheet.getCell('H2').text, /=导出 Demo A/); assert.match(sheet.getCell('H2').text, /导出 Demo B/);
  assert.equal(sheet.getCell('H2').hyperlink, sheet.getCell('A2').hyperlink);
  assert.equal(sheet.getCell('H2').formula, undefined);
  assert.match(sheet.getCell('D2').text, /商务同事/); assert.match(sheet.getCell('E2').text, /陈思远/);
  assert.equal(sheet.getCell('F2').text, '进行中');
  for (const client of [employee, business, other, admin, supervisor]) {
    await client.get('/requirements/export.xlsx?' + query).expect(403);
    assert.equal((await client.get('/requirements').expect(200)).body.canExport, false);
  }
  assert.equal((await pm.get('/requirements').expect(200)).body.canExport, true);
  assert.equal((await exported(pm, query + '&assigned=1')).rowCount, 2);
  assert.equal((await exported(pm, query + '&status=closed')).rowCount, 1);
  ctx.store.run("UPDATE requirements SET status='closed' WHERE id=?", second.id);
  assert.equal((await exported(pm, query + '&status=open')).rowCount, 3);
  const closed = await exported(pm, query + '&status=closed');
  assert.equal(closed.rowCount, 2); assert.equal(closed.getCell('H2').text, '无权查看的需求 Demo');
  assert.ok(new URL(closed.getCell('H2').hyperlink).searchParams.get('demo'));
  assert.equal((await exported(pm, 'q=' + encodeURIComponent('商务同事'))).getCell('G2').value.toISOString().slice(0, 10), '2028-01-02');
  await pm.get('/requirements/export.xlsx?status=invalid').expect(400);
  await request(ctx.app).get('/api/requirements/export.xlsx').expect(401);
  assert.equal((await pm.get(`/requirements/${noDemo.id}`).expect(200)).body.demos.length, 0);
  assert.equal((await employee.get(`/assets/${firstDemo.id}`).expect(200)).body.latest.description.title, '=导出 Demo A');
});

test('prepared exports freeze the selected filter scope, restrict job access and block downloads until all document syncs succeed', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee'), business = await ctx.login('preview-business'), manager = await ctx.login('preview-manager'), admin = await ctx.login('preview-admin');
  const first = await publishRequirement(pm, { title: '历史导出批次-甲', publishDate: '2028-01-01', deadlineDate: '2028-01-02', assignedUserIds: ['preview-pm'] });
  const second = await publishRequirement(pm, { title: '历史导出批次-乙', publishDate: '2028-01-01', deadlineDate: '2028-02-01', assignedUserIds: ['preview-employee'] });
  const excluded = await publishRequirement(pm, { title: '历史导出批次-已关闭' });
  ctx.store.run("UPDATE requirements SET status='closed' WHERE id=?", excluded.id);
  await employee.send('post', '/assets', { description: { ...description, title: '历史快照 Demo' }, requirementIds: [first.id] }).expect(201);
  const filters = { q: '历史导出批次-', status: 'open', assigned: '0', page: 2, pageSize: 1 };
  for (const client of [employee, business, admin]) await client.send('post', '/requirements/exports', filters).expect(403);
  await request(ctx.app).post('/api/requirements/exports').expect(403);
  await pm.agent.post('/api/requirements/exports').set('Origin', origin).set('X-Requested-With', 'PRT').send(filters).expect(403);
  await pm.send('post', '/requirements/exports', { status: 'invalid' }).expect(400);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_exports').count, 0);
  const job = (await pm.send('post', '/requirements/exports', filters).expect(202)).body;
  assert.equal(job.total, 2); assert.equal(job.status, 'ready'); assert.equal(job.preview, true);
  assert.deepEqual(job.filters, { q: filters.q, status: 'open', assigned: '0' });
  await publishRequirement(pm, { title: '历史导出批次-导出后新增' });
  ctx.store.run("UPDATE requirements SET deadline_date='2028-12-31' WHERE id=?", first.id);
  for (const client of [employee, business, admin]) {
    await client.get(`/requirements/exports/${job.id}`).expect(403);
    await client.get(`/requirements/exports/${job.id}/file.xlsx`).expect(403);
    await client.send('post', `/requirements/exports/${job.id}/retry`, {}).expect(403);
  }
  await manager.get(`/requirements/exports/${job.id}`).expect(404);
  await manager.get(`/requirements/exports/${job.id}/file.xlsx`).expect(404);
  await manager.send('post', `/requirements/exports/${job.id}/retry`, {}).expect(404);
  const own = (await pm.send('post', '/requirements/exports', { ...filters, assigned: '1' }).expect(202)).body;
  assert.equal(own.total, 1);
  ctx.store.run('UPDATE requirement_exports SET preview=0 WHERE id=?', job.id);
  ctx.store.run("UPDATE requirement_export_items SET completed=0,url='' WHERE export_id=?", job.id);
  ctx.store.run("UPDATE requirement_wiki SET status='pending' WHERE requirement_id=?", first.id);
  ctx.store.run("UPDATE requirement_wiki SET status='failed',attempts=5,error='飞书文档权限不足' WHERE requirement_id=?", second.id);
  let progress = (await pm.get(`/requirements/exports/${job.id}`).expect(200)).body;
  assert.equal(progress.status, 'pending'); assert.equal(progress.failed, 1); assert.equal(progress.pending, 1);
  await pm.get(`/requirements/exports/${job.id}/file.xlsx`).expect(409);
  ctx.store.run("UPDATE requirement_wiki SET status='failed',attempts=5 WHERE requirement_id=?", first.id);
  progress = (await pm.get(`/requirements/exports/${job.id}`).expect(200)).body;
  assert.equal(progress.status, 'failed');
  await pm.get(`/requirements/exports/${job.id}/file.xlsx`).expect(409);
  progress = (await pm.send('post', `/requirements/exports/${job.id}/retry`, {}).expect(200)).body;
  assert.equal(progress.status, 'pending'); assert.equal(progress.failed, 0);
  for (const [index, id] of [first.id, second.id].entries()) ctx.store.run("UPDATE requirement_wiki SET status='synced',url=? WHERE requirement_id=?", 'https://team.feishu.cn/wiki/Export' + index, id);
  assert.equal((await pm.get(`/requirements/exports/${job.id}`).expect(200)).body.status, 'ready');
  const file = await pm.get(`/requirements/exports/${job.id}/file.xlsx`).buffer(true).parse((res, callback) => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks))); res.on('error', callback);
  }).expect(200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(file.body); const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, 3); assert.equal(sheet.columnCount, 8);
  assert.equal(sheet.getCell('G2').value.toISOString().slice(0, 10), '2028-01-02');
  assert.equal(sheet.getCell('H2').text, '历史快照 Demo');
  assert.equal(new URL(sheet.getCell('H2').hyperlink).searchParams.get('requirement'), first.id);
  assert.equal(new URL(sheet.getCell('A3').hyperlink).searchParams.get('requirement'), second.id);
  assert.equal(sheet.getCell('H3').text, '/');
  ctx.store.run("UPDATE users SET roles='[\"employee\"]' WHERE id='preview-pm'");
  await pm.get(`/requirements/exports/${job.id}/file.xlsx`).expect(403);
});

test('Demo uploads, saved descriptions, workflow and bindings queue all linked wiki updates without blocking uploads or backfilling history', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee'), manager = await ctx.login('preview-manager');
  const first = await publishRequirement(pm, { assignedUserIds: ['preview-employee'] });
  const second = await publishRequirement(pm, { assignedUserIds: ['preview-employee'] });
  const unrelated = await publishRequirement(pm);
  const ids = [first.id, second.id];
  async function queued(operation, affected = ids) {
    ctx.store.run("UPDATE requirement_wiki SET status='synced'");
    const before = ctx.store.all('SELECT requirement_id,generation FROM requirement_wiki');
    const result = await operation();
    for (const row of before) {
      const next = ctx.store.one('SELECT generation,status FROM requirement_wiki WHERE requirement_id=?', row.requirement_id);
      if (affected.includes(row.requirement_id)) { assert.equal(next.status, 'pending'); assert.ok(next.generation > row.generation); }
      else { assert.equal(next.status, 'synced'); assert.equal(next.generation, row.generation); }
    }
    return result;
  }
  const demo = (await queued(() => employee.send('post', '/assets', { description, requirementIds: ids }).expect(201))).body;
  const revision = () => ctx.store.one('SELECT revision FROM versions WHERE id=?', demo.versionId).revision;
  const assetRevision = () => ctx.store.one('SELECT revision FROM assets WHERE id=?', demo.id).revision;
  const queuedAction = (client, value, reason = '') => queued(() => client.send('post', `/versions/${demo.versionId}/actions`, { revision: revision(), action: value, reason }).expect(200));
  const file = (await queued(() => employee.upload(demo.versionId, revision()).expect(201))).body;
  await queued(() => employee.send('put', `/versions/${demo.versionId}`, { revision: revision(), description: { ...description, notes: '同步注意事项' } }).expect(200));
  const beforeConflict = ctx.store.one('SELECT generation FROM requirement_wiki WHERE requirement_id=?', first.id).generation;
  await employee.send('put', `/versions/${demo.versionId}`, { revision: 0, description }).expect(409);
  assert.equal(ctx.store.one('SELECT generation FROM requirement_wiki WHERE requirement_id=?', first.id).generation, beforeConflict);
  await queued(() => employee.send('delete', `/versions/${demo.versionId}/files/${file.id}`, { revision: revision() }).expect(200));
  await queued(() => employee.upload(demo.versionId, revision()).expect(201));
  await queuedAction(employee, 'submit');
  await queuedAction(manager, 'reject', '待更新说明');
  await queuedAction(employee, 'submit');
  await queuedAction(manager, 'publish');
  await queuedAction(manager, 'unpublish', '下架测试');
  await queuedAction(manager, 'restore', '恢复测试');
  const next = (await queued(() => employee.send('post', `/assets/${demo.id}/versions`, { revision: assetRevision(), baseVersionId: demo.versionId }).expect(201))).body;
  await queued(() => employee.send('delete', `/versions/${next.versionId}`, { revision: 0 }).expect(200));
  await queued(() => pm.send('delete', `/requirements/${first.id}/demos/${demo.id}`, { revision: assetRevision() }).expect(200));
  await queued(() => pm.send('post', `/requirements/${first.id}/demos`, { assetId: demo.id, revision: assetRevision() }).expect(200));
  const draft = (await employee.send('post', '/assets', { description, requirementIds: ids }).expect(201)).body;
  await queued(() => employee.send('delete', `/versions/${draft.versionId}`, { revision: 0 }).expect(200));
  assert.equal(ctx.store.one('SELECT id FROM assets WHERE id=?', draft.id), undefined);
  const history = ctx.store.one('SELECT r.id FROM requirements r LEFT JOIN requirement_wiki w ON w.requirement_id=r.id WHERE w.requirement_id IS NULL').id;
  const historicalDemo = (await queued(() => employee.send('post', '/assets', { description, requirementIds: [history] }).expect(201), [])).body;
  await queued(() => employee.upload(historicalDemo.versionId, 0).expect(201), []);
  assert.equal(ctx.requirementWiki.info(history).status, 'not_created'); assert.equal(ctx.requirementWiki.info(unrelated.id).status, 'synced');
});

test('requirement wiki jobs follow publication, attachment uploads, forwarding and account changes with restricted sync endpoints', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), business = await ctx.login('preview-business'), employee = await ctx.login('preview-employee'), other = await ctx.login('preview-other'), admin = await ctx.login('preview-admin');
  const history = ctx.store.one('SELECT id FROM requirements').id;
  assert.equal(ctx.requirementWiki.info(history).status, 'not_created');
  let requirement = await publishRequirement(pm, { title: '飞书协作文档需求', content: '平台原有完整输入内容应保留。', assignedUserIds: ['preview-employee'] });
  assert.equal(requirement.content, '平台原有完整输入内容应保留。'); assert.equal(requirement.wiki.status, 'pending');
  const job = () => ctx.store.one('SELECT * FROM requirement_wiki WHERE requirement_id=?', requirement.id);
  assert.equal(job().generation, 1);
  assert.equal((await employee.get(`/requirements/${requirement.id}/wiki`).expect(200)).body.status, 'pending');
  await other.get(`/requirements/${requirement.id}/wiki`).expect(403);
  await employee.send('post', `/requirements/${requirement.id}/wiki/retry`, {}).expect(403);
  await pm.send('post', `/requirements/${requirement.id}/wiki/retry`, {}).expect(409);
  await requirementUpload(pm, requirement.id, Buffer.from('doc contents'), '需求.pdf');
  assert.equal(job().generation, 2);
  requirement = (await pm.get(`/requirements/${requirement.id}`).expect(200)).body;
  requirement = (await business.send('post', `/requirements/${requirement.id}/forward`, { revision: requirement.revision, assignedUserIds: ['preview-colleague'] }).expect(200)).body;
  assert.equal(job().generation, 3);
  requirement = (await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, title: '更新后的标题', assignedUserIds: ['preview-employee', 'preview-colleague'], revision: requirement.revision }).expect(200)).body;
  assert.equal(job().generation, 4);
  const target = ctx.store.one("SELECT * FROM users WHERE id='preview-colleague'");
  await admin.send('put', '/admin/users/preview-colleague', { revision: target.revision, roles: ['employee'], supervisorId: null, enabled: false }).expect(200);
  assert.equal(job().generation, 5);
  for (const client of [pm, business, admin]) {
    ctx.store.run("UPDATE requirement_wiki SET status='failed',error='权限不足' WHERE requirement_id=?", requirement.id);
    await client.send('post', `/requirements/${requirement.id}/wiki/retry`, {}).expect(200);
    assert.equal(job().status, 'pending');
  }
  await pm.send('post', `/requirements/${requirement.id}/wiki/retry`, {}).expect(409);
  await business.get('/admin/requirement-wiki').expect(403);
  assert.equal((await admin.get('/admin/requirement-wiki').expect(200)).body.length, 1);
  await pm.send('post', `/requirements/${history}/wiki/retry`, {}).expect(200);
  assert.equal(ctx.requirementWiki.info(history).status, 'pending');
  const jobCount = ctx.store.one('SELECT COUNT(*) AS count FROM requirement_wiki').count;
  await ctx.requirementWiki.drain(); assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_wiki').count, jobCount);
  await pm.send('post', '/requirements/missing/wiki/retry', {}).expect(404);
});

test('publishing a requirement atomically queues deduplicated notifications and one calendar task with a valid date', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm');
  const requirement = await publishRequirement(pm, { plannedDate: '2027-12-31', assignedUserIds: ['preview-pm', 'preview-employee', 'preview-employee', 'preview-colleague'] });
  const jobs = ctx.store.all('SELECT * FROM notifications WHERE requirement_id=?', requirement.id);
  assert.equal(jobs.length, 3);
  assert.deepEqual(new Set(jobs.map(job => job.recipient_id)), new Set(['preview-pm', 'preview-employee', 'preview-colleague']));
  assert.ok(jobs.every(job => job.kind === 'requirement_publish' && job.version_id === null && job.status === 'pending'));
  assert.equal(requirement.plannedDate, '2027-12-31'); assert.equal(requirement.calendar.status, 'pending');
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_calendar WHERE requirement_id=?', requirement.id).count, 1);
  assert.equal(requirement.wiki.status, 'pending');
  const counts = () => ['requirements', 'notifications', 'requirement_calendar', 'requirement_wiki'].map(table => ctx.store.one(`SELECT COUNT(*) AS count FROM ${table}`).count);
  const before = counts();
  for (const plannedDate of ['2027-02-29', '2027-13-01', 'tomorrow']) await pm.send('post', '/requirements', { ...requirementContent, plannedDate }).expect(400);
  await pm.send('post', '/requirements', { ...requirementContent, assignedUserIds: ['missing'] }).expect(400);
  assert.deepEqual(counts(), before);
  const unassigned = await publishRequirement(pm, { assignedUserIds: [] });
  assert.deepEqual(ctx.store.all('SELECT recipient_id FROM notifications WHERE requirement_id=?', unassigned.id).map(job => job.recipient_id), ['preview-pm']);
  assert.match(unassigned.plannedDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('requirements separate optional owner groups, deduplicate dual roles and preserve read-only access and forwarding', async testContext => {
  const ctx = await fixture(testContext), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee'), outsider = await ctx.login('preview-other');
  ctx.store.run('UPDATE users SET roles=? WHERE id=?', JSON.stringify(['business', 'employee']), 'preview-colleague');
  let requirement = await publishRequirement(pm, { businessUserIds: ['preview-business', 'preview-colleague'], developmentUserIds: ['preview-employee', 'preview-colleague'], publishDate: '2028-02-28', deadlineDate: '2028-02-29' });
  assert.deepEqual(new Set(requirement.businessOwners.map(user => user.id)), new Set(['preview-business', 'preview-colleague']));
  assert.deepEqual(new Set(requirement.developmentOwners.map(user => user.id)), new Set(['preview-employee', 'preview-colleague']));
  assert.equal(requirement.assignedUsers.length, 3);
  assert.equal(ctx.store.one('SELECT responsibility FROM requirement_assignees WHERE requirement_id=? AND user_id=?', requirement.id, 'preview-colleague').responsibility, 'both');
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM notifications WHERE requirement_id=?', requirement.id).count, 4);
  const readonly = (await employee.get(`/requirements/${requirement.id}`).expect(200)).body;
  assert.equal(readonly.canManage, false); assert.equal(readonly.canStatusManage, false);
  await employee.send('put', `/requirements/${requirement.id}`, { ...requirementContent, revision: 0 }).expect(403);
  await outsider.get(`/requirements/${requirement.id}`).expect(403);
  for (const owner of [...requirement.businessOwners, ...requirement.developmentOwners]) {
    const found = (await pm.get('/requirements?q=' + encodeURIComponent(owner.name)).expect(200)).body.items;
    assert.equal(found.filter(item => item.id === requirement.id).length, 1);
  }
  requirement = (await pm.send('post', `/requirements/${requirement.id}/forward`, { revision: 0, assignedUserIds: ['preview-other'] }).expect(200)).body;
  assert.ok(requirement.developmentOwners.some(user => user.id === 'preview-other'));
  assert.equal(requirement.businessOwners.length, 2);
  await outsider.get(`/requirements/${requirement.id}`).expect(200);
  const optional = await publishRequirement(pm, { businessUserIds: [], developmentUserIds: [] });
  assert.deepEqual(optional.businessOwners, []); assert.deepEqual(optional.developmentOwners, []); assert.deepEqual(optional.assignedUsers, []);
});

test('owner groups validate current roles and account state atomically and retain legacy groups after role changes', async testContext => {
  const ctx = await fixture(testContext), pm = await ctx.login('preview-pm');
  ctx.store.run('UPDATE users SET enabled=0 WHERE id=?', 'preview-other');
  ctx.store.run('UPDATE users SET deleted_at=? WHERE id=?', new Date().toISOString(), 'preview-colleague');
  const counts = () => ['requirements', 'requirement_assignees', 'notifications', 'requirement_calendar'].map(table => ctx.store.one(`SELECT COUNT(*) AS count FROM ${table}`).count);
  const before = counts();
  for (const fields of [
    { businessUserIds: ['preview-employee'], developmentUserIds: [] },
    { businessUserIds: [], developmentUserIds: ['preview-business'] },
    { businessUserIds: [], developmentUserIds: ['preview-other'] },
    { businessUserIds: [], developmentUserIds: ['preview-colleague'] },
    { businessUserIds: ['missing'], developmentUserIds: [] }
  ]) await pm.send('post', '/requirements', { ...requirementContent, ...fields }).expect(400);
  assert.deepEqual(counts(), before);
  let requirement = await publishRequirement(pm, { assignedUserIds: ['preview-business', 'preview-admin'] });
  assert.deepEqual(requirement.businessOwners.map(user => user.id), ['preview-business']);
  assert.deepEqual(requirement.developmentOwners.map(user => user.id), ['preview-admin']);
  ctx.store.run('UPDATE users SET roles=? WHERE id=?', JSON.stringify(['employee']), 'preview-business');
  requirement = (await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, businessUserIds: ['preview-business'], developmentUserIds: ['preview-admin'], revision: 0 }).expect(200)).body;
  assert.deepEqual(requirement.businessOwners.map(user => user.id), ['preview-business']);
  assert.deepEqual(requirement.developmentOwners.map(user => user.id), ['preview-admin']);
  const snapshot = ctx.store.one('SELECT * FROM requirements WHERE id=?', requirement.id);
  await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, title: '不得部分保存', businessUserIds: ['preview-employee'], developmentUserIds: [], revision: requirement.revision }).expect(400);
  assert.deepEqual(ctx.store.one('SELECT * FROM requirements WHERE id=?', requirement.id), snapshot);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_assignees WHERE requirement_id=?', requirement.id).count, 2);
});

test('publication and deadline dates validate atomically, persist independently and retain legacy plannedDate compatibility', async testContext => {
  const ctx = await fixture(testContext), pm = await ctx.login('preview-pm');
  let requirement = await publishRequirement(pm, { publishDate: '2028-02-28', deadlineDate: '2028-02-29' });
  assert.equal(requirement.publishDate, '2028-02-28'); assert.equal(requirement.plannedDate, requirement.publishDate); assert.equal(requirement.deadlineDate, '2028-02-29');
  const job = ctx.store.one('SELECT * FROM requirement_calendar WHERE requirement_id=?', requirement.id);
  for (const fields of [
    { publishDate: '2028-03-01' },
    { deadlineDate: '2028-02-27' },
    { publishDate: '2027-02-29' },
    { deadlineDate: '2028-02-30' },
    { deadlineDate: 'tomorrow' }
  ]) await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, ...fields, revision: 0 }).expect(400);
  assert.deepEqual(ctx.store.one('SELECT * FROM requirement_calendar WHERE requirement_id=?', requirement.id), job);
  assert.equal((await pm.get(`/requirements/${requirement.id}`).expect(200)).body.revision, 0);
  requirement = (await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, publishDate: '2028-02-29', assignedUserIds: ['preview-employee'], revision: 0 }).expect(200)).body;
  assert.equal(requirement.deadlineDate, '2028-02-29');
  requirement = (await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, plannedDate: '2028-03-01', deadlineDate: '', assignedUserIds: ['preview-employee'], revision: 1 }).expect(200)).body;
  assert.equal(requirement.publishDate, '2028-03-01'); assert.equal(requirement.deadlineDate, '');
  assert.equal(ctx.store.one('SELECT deadline_date FROM requirements WHERE id=?', requirement.id).deadline_date, '');
});

test('requirement notification snapshots distinguish owner groups and dates without duplicate recipients', async testContext => {
  const ctx = await fixture(testContext), pm = await ctx.login('preview-pm');
  ctx.store.run('UPDATE users SET roles=? WHERE id=?', JSON.stringify(['business', 'pm']), 'preview-pm');
  const requirement = await publishRequirement(pm, { businessUserIds: ['preview-pm'], developmentUserIds: ['preview-pm', 'preview-employee'], publishDate: '2028-02-28', deadlineDate: '2028-02-29' });
  await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, businessUserIds: ['preview-pm'], developmentUserIds: ['preview-pm', 'preview-employee'], publishDate: '2028-03-01', deadlineDate: '', revision: 0 }).expect(200);
  ctx.store.run("UPDATE users SET open_id='ou_mock_' || id");
  const calls = [], { createNotifications } = await import('../server/notifications.mjs');
  const sender = createNotifications(ctx.store, { demoMode: false, appId: 'test', appSecret: 'test', notificationFetch: async (url, options) => {
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'mock', expire: 7200 }) };
    calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ code: 0 }) };
  } });
  await sender.drain();
  assert.equal(calls.length, 2); assert.equal(calls.filter(call => call.receive_id === 'ou_mock_preview-pm').length, 1);
  for (const call of calls) {
    const text = JSON.parse(call.content).text;
    assert.ok(text.includes('商务负责人：周亦舒')); assert.ok(text.includes('研发负责人：'));
    assert.ok(text.includes('陈思远')); assert.ok(text.includes('发布日期：2028-02-28')); assert.ok(text.includes('截止日期：2028-02-29'));
    assert.ok(!text.includes('2028-03-01'));
  }
});

test('new requirement notifications retry with stable IDs and skip revoked, disabled and deleted recipients', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm');
  const requirement = await publishRequirement(pm, { assignedUserIds: ['preview-pm', 'preview-employee', 'preview-colleague', 'preview-other', 'preview-manager'] });
  ctx.store.run("UPDATE users SET open_id='ou_mock_' || id");
  ctx.store.run('DELETE FROM requirement_assignees WHERE requirement_id=? AND user_id=?', requirement.id, 'preview-colleague');
  ctx.store.run('UPDATE users SET enabled=0 WHERE id=?', 'preview-other');
  ctx.store.run('UPDATE users SET deleted_at=? WHERE id=?', new Date().toISOString(), 'preview-manager');
  const calls = []; let fail = true;
  const { createNotifications } = await import('../server/notifications.mjs');
  const sender = createNotifications(ctx.store, { demoMode: false, appId: 'test', appSecret: 'test', notificationFetch: async (url, options) => {
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'mock', expire: 7200 }) };
    const message = JSON.parse(options.body); calls.push(message);
    const failed = fail && message.receive_id === 'ou_mock_preview-employee';
    return { ok: !failed, json: async () => ({ code: failed ? 230013 : 0 }) };
  } });
  await sender.drain();
  const pending = ctx.store.one('SELECT * FROM notifications WHERE requirement_id=? AND recipient_id=?', requirement.id, 'preview-employee');
  assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 1);
  for (const id of ['preview-colleague', 'preview-other', 'preview-manager']) assert.equal(ctx.store.one('SELECT status FROM notifications WHERE requirement_id=? AND recipient_id=?', requirement.id, id).status, 'skipped');
  assert.deepEqual(new Set(calls.map(call => call.receive_id)), new Set(['ou_mock_preview-employee', 'ou_mock_preview-pm']));
  fail = false; ctx.store.run('UPDATE notifications SET next_at=0'); await sender.drain();
  const attempts = calls.filter(call => call.receive_id === 'ou_mock_preview-employee');
  assert.equal(attempts.length, 2); assert.equal(attempts[0].uuid, attempts[1].uuid);
  const message = JSON.parse(attempts[1].content).text;
  assert.ok(message.includes('新需求已发布')); assert.ok(message.includes(requirement.title));
  assert.ok(message.includes('requirement=' + requirement.id)); assert.ok(!message.includes(requirement.content));
  assert.equal(ctx.store.one('SELECT status FROM notifications WHERE id=?', pending.id).status, 'sent');
  await sender.drain(); assert.equal(calls.length, 3);
});

test('publishing a requirement creates one Feishu event with native invitations and separately delivers linked schedule cards to its audience', async t => {
  const messages = [], calendarCalls = []; let attendees = [];
  const ctx = await fixture(t, { appId: 'cli_test', appSecret: 'test', calendarFetch: async (url, options) => {
    const parsed = new URL(url), body = options.body ? JSON.parse(options.body) : undefined;
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'mock', expire: 7200 }) };
    calendarCalls.push({ url: parsed, method: options.method, body });
    let data;
    if (parsed.pathname.endsWith('/calendars')) data = { calendar: { calendar_id: 'cal_test' } };
    else if (parsed.pathname.endsWith('/attendees') && options.method === 'GET') data = { items: attendees, has_more: false };
    else if (parsed.pathname.endsWith('/attendees') && options.method === 'POST') { attendees = body.attendees; data = { attendees }; }
    else data = { event: { event_id: 'event_test', app_link: 'https://applink.feishu.cn/client/calendar/event/detail?event_id=event_test' } };
    return { ok: true, json: async () => ({ code: 0, data }) };
  }, notificationFetch: async (url, options) => {
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'mock', expire: 7200 }) };
    messages.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ code: 0 }) };
  } });
  const pm = await ctx.login('preview-pm');
  ctx.store.run('DELETE FROM requirement_calendar');
  const requirement = await publishRequirement(pm, { businessUserIds: ['preview-business'], developmentUserIds: ['preview-employee', 'preview-pm'], publishDate: '2028-02-28', deadlineDate: '2028-02-29' });
  ctx.store.run("UPDATE users SET open_id='ou_' || id"); ctx.config.demoMode = false;
  await ctx.notifications.drain();
  assert.equal(messages.length, 3); assert.ok(messages.every(message => message.msg_type === 'text'));
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM notifications WHERE kind='requirement_calendar'").count, 0);
  await ctx.requirementCalendar.drain();
  const event = calendarCalls.find(call => call.url.pathname.endsWith('/events') && call.method === 'POST');
  assert.deepEqual(event.body.start_time, { date: '2028-02-28' }); assert.deepEqual(event.body.end_time, { date: '2028-03-01' });
  assert.equal(calendarCalls.find(call => call.url.pathname.endsWith('/attendees') && call.method === 'POST').body.need_notification, true);
  const audience = new Set(['ou_preview-pm', 'ou_preview-business', 'ou_preview-employee']);
  assert.deepEqual(new Set(attendees.map(attendee => attendee.user_id)), audience);
  await ctx.notifications.drain();
  const cards = messages.filter(message => message.msg_type === 'interactive');
  assert.equal(cards.length, 3); assert.deepEqual(new Set(cards.map(message => message.receive_id)), audience);
  const info = (await pm.get(`/requirements/${requirement.id}/calendar`).expect(200)).body;
  assert.equal(info.status, 'synced'); assert.equal(info.messages.sent, 3); assert.ok(info.appLink.includes('event_test'));
  await ctx.requirementCalendar.drain(); await ctx.notifications.drain(); assert.equal(messages.length, 6);
});

test('calendar updates share one event key across edits, forwarding and status changes while the admin queue stays restricted', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), employee = await ctx.login('preview-employee'), other = await ctx.login('preview-other'), admin = await ctx.login('preview-admin');
  const requirement = await publishRequirement(pm, { plannedDate: '2028-02-29' });
  const job = () => ctx.store.one('SELECT * FROM requirement_calendar WHERE requirement_id=?', requirement.id);
  const key = job().event_key;
  await employee.get(`/requirements/${requirement.id}/calendar`).expect(200);
  await other.get(`/requirements/${requirement.id}/calendar`).expect(403);
  await pm.send('put', `/requirements/${requirement.id}`, { ...requirementContent, assignedUserIds: ['preview-employee'], plannedDate: '2028-03-01', revision: 0 }).expect(200);
  await pm.send('post', `/requirements/${requirement.id}/forward`, { revision: 1, assignedUserIds: ['preview-colleague'] }).expect(200);
  await pm.send('post', `/requirements/${requirement.id}/actions`, { revision: 2, action: 'set_status', status: 'delivered' }).expect(200);
  assert.equal(job().generation, 4); assert.equal(job().event_key, key);
  assert.equal((await employee.get(`/requirements/${requirement.id}`).expect(200)).body.plannedDate, '2028-03-01');
  await pm.get('/admin/requirement-calendar').expect(403);
  await employee.send('post', `/admin/requirement-calendar/${requirement.id}/retry`, {}).expect(403);
  await admin.send('post', `/admin/requirement-calendar/${requirement.id}/retry`, {}).expect(409);
  ctx.store.run("UPDATE requirement_calendar SET status='failed',attempts=5,error='飞书日历同步失败' WHERE requirement_id=?", requirement.id);
  await admin.send('post', `/admin/requirement-calendar/${requirement.id}/retry`, {}).expect(200);
  assert.equal(job().status, 'pending'); assert.equal(job().attempts, 0); assert.equal(job().event_key, key);
  assert.ok((await admin.get('/admin/requirement-calendar').expect(200)).body.some(item => item.requirement_id === requirement.id));
  await admin.send('put', '/admin/users/preview-employee', { revision: 0, roles: ['employee'], supervisorId: null, enabled: false }).expect(200);
  assert.equal(job().generation, 5);
});

test('business, PM and admin users can retry a failed requirement calendar from its detail without gaining other management access', async t => {
  const ctx = await fixture(t), pm = await ctx.login('preview-pm'), business = await ctx.login('preview-business'), admin = await ctx.login('preview-admin');
  const employee = await ctx.login('preview-employee'), supervisor = await ctx.login('preview-other-manager'), other = await ctx.login('preview-other');
  const requirement = await publishRequirement(pm, { assignedUserIds: ['preview-employee', 'preview-other-manager', 'preview-admin'] });
  const endpoint = `/requirements/${requirement.id}/calendar/retry`;
  const job = () => ctx.store.one('SELECT * FROM requirement_calendar WHERE requirement_id=?', requirement.id);
  const eventKey = job().event_key, generation = job().generation, notificationCount = ctx.notifications.list().length;
  ctx.store.run("UPDATE requirement_calendar SET event_id='existing_event',calendar_id='existing_calendar',status='failed',attempts=5,next_at=123,error='飞书日历同步失败' WHERE requirement_id=?", requirement.id);
  for (const client of [employee, supervisor]) {
    assert.equal((await client.get(`/requirements/${requirement.id}`).expect(200)).body.canRetryCalendar, false);
    await client.send('post', endpoint, {}).expect(403);
  }
  await other.send('post', endpoint, {}).expect(403);
  assert.equal(job().status, 'failed'); assert.equal(job().attempts, 5);
  for (const client of [business, pm, admin]) {
    assert.equal((await client.get(`/requirements/${requirement.id}`).expect(200)).body.canRetryCalendar, true);
    const retry = (await client.send('post', endpoint, {}).expect(200)).body;
    assert.equal(retry.status, 'pending'); assert.equal(retry.error, '');
    assert.equal(job().attempts, 0); assert.equal(job().next_at, 0); assert.equal(job().event_key, eventKey);
    assert.equal(job().generation, generation); assert.equal(job().event_id, 'existing_event'); assert.equal(job().calendar_id, 'existing_calendar');
    await client.send('post', endpoint, {}).expect(409);
    ctx.store.run("UPDATE requirement_calendar SET status='failed',attempts=5 WHERE requirement_id=?", requirement.id);
  }
  assert.equal(ctx.notifications.list().length, notificationCount);
  assert.equal(ctx.store.one('SELECT revision FROM requirements WHERE id=?', requirement.id).revision, requirement.revision);
  const events = ctx.store.all("SELECT actor_id,detail FROM events WHERE action='requirement_calendar_retry'");
  assert.deepEqual(new Set(events.map(event => event.actor_id)), new Set(['preview-business', 'preview-pm', 'preview-admin']));
  assert.ok(events.every(event => JSON.parse(event.detail).requirementId === requirement.id));
  for (const client of [business, pm]) {
    await client.get('/admin/requirement-calendar').expect(403);
    await client.send('post', `/admin/requirement-calendar/${requirement.id}/retry`, {}).expect(403);
    await client.get('/admin/users').expect(403);
    await client.send('post', '/requirements/nonexistent/calendar/retry', {}).expect(404);
  }
  ctx.store.run("UPDATE requirement_calendar SET status='synced' WHERE requirement_id=?", requirement.id);
  await business.send('post', endpoint, {}).expect(409);
});

test('calendar retry checks live roles and account state and requires CSRF protection', async t => {
  const ctx = await fixture(t), business = await ctx.login('preview-business');
  const requirement = await publishRequirement(business, { assignedUserIds: ['preview-business'] }), endpoint = `/requirements/${requirement.id}/calendar/retry`;
  ctx.store.run("UPDATE requirement_calendar SET status='failed',attempts=5 WHERE requirement_id=?", requirement.id);
  await business.agent.post('/api' + endpoint).set('Origin', origin).set('X-Requested-With', 'PRT').send({}).expect(403);
  ctx.store.run('UPDATE users SET roles=? WHERE id=?', JSON.stringify(['employee']), 'preview-business');
  assert.equal((await business.get(`/requirements/${requirement.id}`).expect(200)).body.canRetryCalendar, false);
  await business.send('post', endpoint, {}).expect(403);
  ctx.store.run('UPDATE users SET roles=?,enabled=0 WHERE id=?', JSON.stringify(['business']), 'preview-business');
  await business.send('post', endpoint, {}).expect(403);
  const job = ctx.store.one('SELECT * FROM requirement_calendar WHERE requirement_id=?', requirement.id);
  assert.equal(job.status, 'failed'); assert.equal(job.attempts, 5);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM events WHERE action='requirement_calendar_retry'").count, 0);
});
