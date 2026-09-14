import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.mjs';

test('Feishu callback validates browser-bound state, tenant, replay and bootstrap identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-oauth-'));
  let tenant = 'allowed-enterprise', openId = 'ou_initial_admin', calls = 0;
  const mock = async (url, options) => {
    calls++;
    if (url.endsWith('/oauth/token')) { const payload = JSON.parse(options.body); assert.equal(payload.client_id, 'cli_test'); assert.ok(payload.code_verifier.length >= 43); return { ok: true, json: async () => ({ access_token: 'fake-token' }) }; }
    assert.equal(options.headers.Authorization, 'Bearer fake-token');
    return { ok: true, json: async () => ({ code: 0, data: { open_id: openId, name: '飞书测试员工', tenant_key: tenant } }) };
  };
  const { app, store } = createApp({ demoMode: false, production: false, dataDir: root, appId: 'cli_test', appSecret: 'test-only', tenantKey: 'allowed-enterprise', origin: 'http://127.0.0.1:3100', bootstrapIds: ['ou_initial_admin'], fetch: mock });
  t.after(() => { store.db.close(); if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'prt-oauth-')) throw new Error('Unexpected cleanup path'); fs.rmSync(root, { recursive: true, force: true }); });
  await request(app).get('/api/auth/demo-users').expect(404);
  const agent = request.agent(app);
  async function begin() { const response = await agent.get('/api/auth/feishu').expect(302); const url = new URL(response.headers.location); assert.equal(url.hostname, 'accounts.feishu.cn'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); return url.searchParams.get('state'); }
  let state = await begin();
  await request(app).get('/api/auth/callback').query({ state, code: 'test-code' }).expect(302);
  assert.equal(calls, 0, 'state must be bound to initiating browser');
  await agent.get('/api/auth/callback').query({ state, code: 'test-code' }).expect(302);
  assert.equal((await agent.get('/api/auth/me')).body.user.roles[0], 'admin');
  const prior = calls; await agent.get('/api/auth/callback').query({ state, code: 'test-code' }).expect(302); assert.equal(calls, prior, 'state is one-time');
  tenant = 'other-enterprise'; openId = 'ou_foreign'; state = await begin();
  const blocked = await agent.get('/api/auth/callback').query({ state, code: 'test-code' }).expect(302); assert.ok(blocked.headers.location.includes('authError')); assert.equal(store.one('SELECT id FROM users WHERE open_id=?', openId), undefined);
  tenant = 'allowed-enterprise'; openId = 'ou_new_employee'; state = await begin(); await agent.get('/api/auth/callback').query({ state, code: 'test-code' }).expect(302);
  assert.deepEqual((await agent.get('/api/auth/me')).body.user.roles, []);
  await agent.get('/api/assets').expect(403);
});
