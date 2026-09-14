import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.mjs';
import { createBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore.mjs';

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
async function create(client) { return (await client.send('post', '/assets', { description }).expect(201)).body; }
async function detail(client, id) { return (await client.get('/assets/' + id).expect(200)).body; }
async function action(client, vid, revision, action, reason = '') { return client.send('post', `/versions/${vid}/actions`, { revision, action, reason }); }

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
test('upload limits and empty files never become version files', async t => {
  const f = await fixture(t), admin = await f.login('preview-admin'), employee = await f.login('preview-employee');
  const conf = (await admin.get('/config')).body; await admin.send('put', '/admin/settings', { ...conf, maxFileMB: 1, maxVersionMB: 1, maxFiles: 1 }).expect(200);
  const a = await create(employee);
  await employee.upload(a.versionId, 0, 'large.zip', Buffer.alloc(1048577)).expect(400);
  await employee.upload(a.versionId, 0, 'empty.zip', Buffer.alloc(0)).expect(400);
  assert.equal((await detail(employee, a.id)).latest.files.length, 0);
  await employee.upload(a.versionId, 0, '../../escaped.txt').expect(201);
  await employee.upload(a.versionId, 1, 'another.txt').expect(400);
  assert.equal((await detail(employee, a.id)).latest.files.length, 1);
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
  assert.equal(ctx.notifications.list().filter(n=>n.kind==='publish').length,2);
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
  assert.equal(calls[0].uuid,calls[2].uuid);
  assert.ok(JSON.parse(calls[2].content).text.includes('审核通过'));
  const appMessage=JSON.parse(calls[2].content).text;
  assert.ok(appMessage.includes('https://applink.feishu.cn/client/web_app/open?'));
  assert.ok(appMessage.includes('appId=test'));
  assert.ok(appMessage.includes('mode=appCenter'));
  assert.ok(appMessage.includes(`demo=${demo.id}`));
  assert.ok(!appMessage.includes(origin));
  await sender.drain();assert.equal(calls.length,4);
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
  for(const kind of ['publish','unpublish','restore','set_default']) assert.deepEqual(new Set(jobs.filter(job=>job.kind===kind).map(job=>job.recipient_id)),new Set(['preview-employee','preview-pm']));
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
