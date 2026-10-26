import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.mjs';

const secret = randomBytes(32).toString('base64url');
function assertion(patch = {}, key = secret) {
  const payload = Buffer.from(JSON.stringify({ iss: 'prt-agent-server', aud: 'prt-demo-hub', appId: 'prt-development', tenantKey: 'prt-development', openId: 'ou_prt_dev_member', nonce: randomBytes(24).toString('base64url'), exp: Date.now() + 60000, ...patch })).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'prt-harness-hub-'));
  const ctx = createApp({ dataDir: root, demoMode: true, production: false, origin: 'http://127.0.0.1:3100', harnessSharedSecret: secret });
  t.after(() => { ctx.store.db.close(); rmSync(root, { recursive: true, force: true }); });
  return ctx;
}

test('delegation requires a signed, unexpired, one-use assertion for the same application and enterprise', async t => {
  const { app } = fixture(t);
  const exchange = value => request(app).post('/api/harness/exchange').send({ assertion: value });
  const valid = assertion();
  await exchange(valid).expect(200);
  await exchange(valid).expect(401);
  for (const patch of [{ appId: 'other-app' }, { tenantKey: 'other-tenant' }, { aud: 'other' }, { iss: 'other' }, { exp: Date.now() - 1000 }, { exp: Date.now() + 120000 }, { nonce: 1234 }]) await exchange(assertion(patch)).expect(401);
  await exchange(assertion({}, 'wrong secret')).expect(401);
  await exchange(assertion({ openId: 'ou_unknown' })).expect(403);
});

test('delegated employee sees assigned requirements and uploads a draft with original permissions and file revision checks', async t => {
  const { app, store } = fixture(t);
  const response = await request(app).post('/api/harness/exchange').send({ assertion: assertion() }).expect(200);
  const bearer = 'Bearer ' + response.body.access_token;
  const get = path => request(app).get('/api' + path).set('Authorization', bearer);
  const list = await get('/requirements?assigned=1&status=active').expect(200);
  assert.equal(list.body.items.length, 2);
  const requirement = list.body.items[0];
  assert.ok(requirement.publishDate); assert.ok(requirement.deadlineDate);
  await get('/admin/users').expect(401);
  const created = await request(app).post('/api/assets').set('Authorization', bearer).send({ requestId: randomUUID(), requirementIds: [requirement.id], description: { title: 'Harness 自动说明', summary: '自动生成', content: '# 数据概述\n合成 CSV\n\n# 数据格式\nCSV', usage: '打开 CSV', costEstimate: '未评估', difficulty: '低', notes: '合成数据' } }).expect(201);
  const upload = revision => request(app).post(`/api/versions/${created.body.versionId}/files`).set('Authorization', bearer).set('X-Revision', String(revision)).attach('file', Buffer.from('id,value\n1,3\n'), 'sample.csv');
  await upload(0).expect(201); await upload(0).expect(409);
  const saved = (await get('/assets/' + created.body.id).expect(200)).body;
  assert.equal(saved.latest.status, 'draft'); assert.equal(saved.latest.files[0].name, 'sample.csv');
  assert.ok(saved.requirements.some(row => row.id === requirement.id));
  await request(app).post(`/api/versions/${created.body.versionId}/actions`).set('Authorization', bearer).send({ revision: 1, action: 'publish' }).expect(403);
  store.run('UPDATE users SET enabled=0 WHERE id=?', 'harness-preview-member');
  await get('/requirements').expect(401);
});
