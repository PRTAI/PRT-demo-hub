import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.mjs';

const origin = 'http://127.0.0.1:5173';
const content = { title: '跨层级需求验收', content: '需求正文及 https://team.feishu.cn/wiki/SharedSpec', category: '通用数据', assignedUserIds: ['preview-employee'] };
const description = { title: '层级验收样例', summary: '跨团队交付样例', category: '通用数据', content: '# 数据概述\n完整说明\n# 数据格式\ndata.csv', costEstimate: '两周成本 500 元', dataVolume: '两周 5000 条', difficulty: '低', notes: '注意字段单位', changes: '', usage: '按字段分析' };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-superiors-'));
  const ctx = createApp({ dataDir: root, demoMode: true, origin, llmApiKey: '' });
  t.after(() => { ctx.store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Separate this scenario from the preview requirement assigned to every team.
  ctx.store.run('DELETE FROM asset_requirements'); ctx.store.run('DELETE FROM requirement_assignees');
  ctx.store.run("UPDATE users SET roles='[\"supervisor\"]' WHERE id='preview-manager'");
  for (const [id, superior] of [['top', null], ['upper', 'top'], ['middle', 'upper']]) ctx.store.run('INSERT INTO users(id,open_id,name,roles,supervisor_id,created_at) VALUES(?,?,?,?,?,?)', id, 'preview:' + id, id + '主管', '["supervisor"]', superior, new Date().toISOString());
  ctx.store.run("UPDATE users SET supervisor_id='middle' WHERE id='preview-manager'");
  async function login(id) {
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/demo-login').set('Origin', origin).set('X-Requested-With', 'PRT').send({ userId: id }).expect(200);
    const me = (await agent.get('/api/auth/me')).body;
    const send = (method, endpoint, body) => agent[method]('/api' + endpoint).set('Origin', origin).set('X-Requested-With', 'PRT').set('X-CSRF-Token', me.csrf).send(body);
    const upload = (endpoint, name, bytes = 'sample content', status = 201) => agent.post('/api' + endpoint).set('Origin', origin).set('X-Requested-With', 'PRT').set('X-CSRF-Token', me.csrf).set('X-Revision', '0').attach('file', Buffer.from(bytes), name).expect(status);
    return { agent, get: endpoint => agent.get('/api' + endpoint), send, upload };
  }
  const pm = await login('preview-pm'), admin = await login('preview-admin');
  const publish = async (fields = {}) => (await pm.send('post', '/requirements', { ...content, ...fields }).expect(201)).body;
  const demo = async (requirementId, fields = {}) => {
    const owner = await login('preview-other');
    const asset = (await owner.send('post', '/assets', { description: { ...description, ...fields }, requirementIds: [requirementId] }).expect(201)).body;
    const file = (await owner.upload(`/versions/${asset.versionId}/files`, 'data.csv', 'id,value\n1,20')).body;
    return { ...asset, file, owner };
  };
  return { ...ctx, pm, admin, login, publish, demo };
}

test('every superior can read the full requirement, documents, calendar, wiki and all linked Demo descriptions and files', async t => {
  const ctx = await fixture(t), requirement = await ctx.publish();
  const document = (await ctx.pm.upload(`/requirements/${requirement.id}/documents`, '需求.txt', 'full requirement document')).body;
  const asset = await ctx.demo(requirement.id), hidden = await ctx.publish({ title: '不相关需求', assignedUserIds: ['preview-other'] });
  const hiddenAsset = await ctx.demo(hidden.id, { title: '未关联下属的私有样例' });
  for (const id of ['preview-manager', 'middle', 'upper', 'top']) {
    const superior = await ctx.login(id);
    const listed = (await superior.get('/requirements?q=' + encodeURIComponent('陈思远') + '&pageSize=1').expect(200)).body;
    assert.equal(listed.total, 1); assert.equal(listed.items[0].id, requirement.id); assert.equal(listed.items[0].demoCount, 1);
    assert.equal((await superior.get('/requirements?assigned=1').expect(200)).body.total, 0);
    const detail = (await superior.get(`/requirements/${requirement.id}`).expect(200)).body;
    assert.equal(detail.content, content.content); assert.equal(detail.documents.length, 1); assert.equal(detail.demos[0].id, asset.id);
    for (const flag of ['canManage', 'canStatusManage', 'canForward']) assert.equal(detail[flag], false);
    assert.deepEqual(detail.assignedUsers.map(user => user.id), ['preview-employee']);
    await superior.get(`/requirements/${requirement.id}/calendar`).expect(200);
    await superior.get(`/requirements/${requirement.id}/wiki`).expect(200);
    await superior.get(`/requirements/${requirement.id}/link-preview?` + new URLSearchParams({ url: 'https://team.feishu.cn/wiki/SharedSpec' })).expect(200);
    const downloaded = await superior.get(`/requirements/${requirement.id}/documents/${document.id}/download`).expect(200);
    assert.equal(downloaded.text || downloaded.body.toString(), 'full requirement document');
    const demo = (await superior.get('/assets/' + asset.id).expect(200)).body;
    assert.deepEqual(demo.latest.description.costEstimate, description.costEstimate); assert.equal(demo.latest.description.notes, description.notes); assert.equal(demo.latest.description.dataVolume, description.dataVolume);
    assert.equal(demo.canEdit, false); assert.equal(demo.canManage, false); assert.equal(demo.canGrant, false);
    assert.ok(demo.events.length); assert.equal(demo.versions.length, 1);
    const fileRoot = `/versions/${asset.versionId}/files/${asset.file.id}`;
    await superior.get(fileRoot + '/download').expect(200);
    assert.match((await superior.get(fileRoot + '/preview').expect(200)).body.content, /id,value/);
    const catalog = (await superior.get('/catalog?requirement=' + requirement.id).expect(200)).body;
    assert.deepEqual(catalog.items.map(item => item.id), [asset.id]);
    assert.ok((await superior.get('/catalog?scope=team').expect(200)).body.items.some(item => item.id === asset.id));
    assert.ok((await superior.get('/assets').expect(200)).body.some(item => item.id === asset.id));
    const rag = (await superior.send('post', '/search/rag', { question: '层级验收样例' }).expect(200)).body;
    assert.ok(rag.sources.some(item => item.id === asset.id)); assert.ok(!rag.sources.some(item => item.id === hiddenAsset.id));
    await superior.get(`/requirements/${hidden.id}`).expect(403); await superior.get('/assets/' + hiddenAsset.id).expect(404);
  }
  for (const id of ['preview-colleague', 'preview-other-manager', 'preview-admin']) {
    const unrelated = await ctx.login(id);
    await unrelated.get(`/requirements/${requirement.id}`).expect(403);
    await unrelated.get(`/requirements/${requirement.id}/documents/${document.id}/download`).expect(403);
    if (id !== 'preview-other-manager') await unrelated.get('/assets/' + asset.id).expect(404);
  }
});

test('inherited readers cannot edit, forward, change status, bind, upload, publish or grant permissions', async t => {
  const ctx = await fixture(t), requirement = await ctx.publish(), asset = await ctx.demo(requirement.id), superior = await ctx.login('top');
  const endpoint = `/requirements/${requirement.id}`;
  await superior.send('put', endpoint, { ...content, revision: 0 }).expect(403);
  await superior.send('post', endpoint + '/actions', { revision: 0, action: 'set_status', status: 'closed' }).expect(403);
  await superior.get(endpoint + '/forward-candidates').expect(403);
  await superior.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: ['preview-other'] }).expect(403);
  await superior.upload(endpoint + '/documents', 'forbidden.txt', 'data', 403);
  await superior.send('post', endpoint + '/demos', { revision: 1, assetId: asset.id }).expect(403);
  await superior.send('delete', endpoint + '/demos/' + asset.id, { revision: 1 }).expect(403);
  await superior.send('post', endpoint + '/personal-document-export', {}).expect(403);
  await superior.send('post', '/requirements/exports', {}).expect(403);
  await superior.send('put', `/versions/${asset.versionId}`, { description, revision: 1 }).expect(403);
  await superior.upload(`/versions/${asset.versionId}/files`, 'forbidden.txt', 'data', 403);
  await superior.send('delete', `/versions/${asset.versionId}/files/${asset.file.id}`, { revision: 1 }).expect(403);
  await superior.send('post', `/versions/${asset.versionId}/actions`, { revision: 1, action: 'publish' }).expect(403);
  await superior.send('post', `/versions/${asset.versionId}/description/generate`, { revision: 1 }).expect(403);
  await superior.get(`/assets/${asset.id}/grant-candidates`).expect(403);
  await superior.send('put', `/assets/${asset.id}/permissions/preview-colleague`, { level: 'manage' }).expect(403);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM asset_permissions WHERE asset_id=?', asset.id).count, 0);
  assert.equal(ctx.store.one('SELECT revision FROM requirements WHERE id=?', requirement.id).revision, 0);
});

test('assignment removal, forwarding and directory transfers immediately recalculate inherited reads without altering actual assignees', async t => {
  const ctx = await fixture(t), requirement = await ctx.publish({ assignedUserIds: [] }), asset = await ctx.demo(requirement.id);
  const superior = await ctx.login('top'), manager = await ctx.login('preview-manager'), newManager = await ctx.login('preview-other-manager');
  const endpoint = `/requirements/${requirement.id}`;
  await superior.get(endpoint).expect(403);
  await ctx.pm.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: ['preview-employee', 'preview-colleague'] }).expect(200);
  assert.equal((await superior.get('/requirements?q=' + encodeURIComponent(content.title)).expect(200)).body.total, 1);
  await superior.get('/assets/' + asset.id).expect(200);
  // Transfer both assigned employees to a different branch; the logged-in old ancestors lose access immediately.
  for (const id of ['preview-employee', 'preview-colleague']) await ctx.admin.send('put', '/admin/users/' + id, { revision: 0, roles: ['employee'], enabled: true, supervisorId: 'preview-other-manager' }).expect(200);
  await superior.get(endpoint).expect(403); await manager.get('/assets/' + asset.id).expect(404);
  await newManager.get(endpoint).expect(200); await newManager.get('/assets/' + asset.id).expect(200);
  await ctx.pm.send('put', endpoint, { ...content, revision: 1, assignedUserIds: [] }).expect(200);
  await newManager.get(endpoint).expect(403);
  await newManager.get('/assets/' + asset.id).expect(404);
  await newManager.get(`/versions/${asset.versionId}/files/${asset.file.id}/download`).expect(404);
});

test('inactive assignees and broken management chains cannot grant inherited access, and normal explicit access still works', async t => {
  const ctx = await fixture(t), requirement = await ctx.publish(), superior = await ctx.login('top'), endpoint = `/requirements/${requirement.id}`;
  await superior.get(endpoint).expect(200);
  for (const update of ["enabled=0", "deleted_at='2026-10-29T00:00:00Z'"]) {
    ctx.store.run(`UPDATE users SET ${update} WHERE id='preview-employee'`);
    await superior.get(endpoint).expect(403);
    ctx.store.run("UPDATE users SET enabled=1,deleted_at=NULL WHERE id='preview-employee'");
  }
  ctx.store.run("UPDATE users SET roles='[\"employee\"]' WHERE id='middle'"); await superior.get(endpoint).expect(403);
  ctx.store.run("UPDATE users SET roles='[\"supervisor\"]',enabled=0 WHERE id='middle'"); await superior.get(endpoint).expect(403);
  ctx.store.run("UPDATE users SET enabled=1 WHERE id='middle'"); await superior.get(endpoint).expect(200);
  await ctx.pm.send('post', endpoint + '/forward', { revision: 0, assignedUserIds: ['top'] }).expect(200);
  assert.equal((await superior.get(endpoint).expect(200)).body.canForward, true);
  assert.equal((await superior.get('/requirements?assigned=1').expect(200)).body.total, 1);
  await superior.send('post', endpoint + '/forward', { revision: 1, assignedUserIds: ['preview-other'] }).expect(200);
});

test('admin configuration rejects cyclic chains atomically and legacy cycles terminate without inheriting from oneself', async t => {
  const ctx = await fixture(t);
  await ctx.admin.send('put', '/admin/users/top', { revision: 0, roles: ['supervisor'], enabled: true, supervisorId: 'preview-manager' }).expect(400);
  assert.equal(ctx.store.one("SELECT supervisor_id FROM users WHERE id='top'").supervisor_id, null);
  assert.equal(ctx.store.one("SELECT revision FROM users WHERE id='top'").revision, 0);
  const requirement = await ctx.publish({ assignedUserIds: ['top'] }), asset = await ctx.demo(requirement.id);
  ctx.store.run("UPDATE users SET supervisor_id='middle' WHERE id='top'"); // Existing corrupt chain: top -> middle -> upper -> top.
  const superior = await ctx.login('top');
  await superior.get('/requirements').expect(200); await superior.get(`/requirements/${requirement.id}`).expect(200);
  await superior.get('/assets/' + asset.id).expect(404); // Direct requirement assignment alone is not Demo ownership/management.
  const childRequirement = await ctx.publish();
  await superior.get(`/requirements/${childRequirement.id}`).expect(200);
});

test('both owner groups, forwarded assignments and automatic Demo requirements grant all superior levels the same read scope', async t => {
  const ctx = await fixture(t);
  ctx.store.run("UPDATE users SET supervisor_id='preview-manager' WHERE id='preview-business'");
  const requirement = await ctx.publish({ assignedUserIds: [], businessUserIds: ['preview-business'], developmentUserIds: ['preview-employee', 'preview-colleague'] });
  const superior = await ctx.login('top');
  const listed = (await superior.get('/requirements?q=' + encodeURIComponent(content.title) + '&pageSize=1').expect(200)).body;
  assert.equal(listed.total, 1); assert.equal(listed.pages, 1);
  await ctx.pm.send('put', `/requirements/${requirement.id}`, { ...content, revision: 0, businessUserIds: ['preview-business'], developmentUserIds: [] }).expect(200);
  await superior.get(`/requirements/${requirement.id}`).expect(200);
  const employee = await ctx.login('preview-employee');
  const asset = (await employee.send('post', '/assets', { description, requirementIds: [] }).expect(201)).body;
  await employee.upload(`/versions/${asset.versionId}/files`, 'sample.csv');
  const automatic = ctx.store.one('SELECT requirement_id FROM asset_requirements WHERE asset_id=?', asset.id).requirement_id;
  await superior.get(`/requirements/${automatic}`).expect(200); await superior.get('/assets/' + asset.id).expect(200);
  assert.equal((await superior.get('/requirements?assigned=1').expect(200)).body.total, 0);
  await ctx.pm.send('post', `/requirements/${requirement.id}/actions`, { revision: 1, action: 'close' }).expect(200);
  assert.ok((await superior.get('/requirements?status=closed').expect(200)).body.items.some(item => item.id === requirement.id));
});

test('a superior with an additional business role sees full linked descriptions while ordinary business field restrictions still apply elsewhere', async t => {
  const ctx = await fixture(t), assigned = await ctx.publish(), asset = await ctx.demo(assigned.id);
  const unrelated = await ctx.publish({ title: '另一个部门的需求', assignedUserIds: ['preview-other'] }), otherAsset = await ctx.demo(unrelated.id);
  ctx.store.run("UPDATE users SET roles='[\"supervisor\",\"business\"]' WHERE id='top'");
  const superior = await ctx.login('top');
  const inherited = (await superior.get('/assets/' + asset.id).expect(200)).body;
  assert.equal(inherited.businessRestricted, false); assert.equal(inherited.latest.description.costEstimate, description.costEstimate);
  const globalBusiness = (await superior.get('/assets/' + otherAsset.id).expect(200)).body;
  assert.equal(globalBusiness.businessRestricted, true); assert.equal(globalBusiness.latest.description.costEstimate, undefined);
});
