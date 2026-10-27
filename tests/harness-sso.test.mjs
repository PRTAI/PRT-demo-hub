import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.mjs';

const secret = randomBytes(32).toString('base64url'), callback = 'http://203.0.113.10:8082/auth/demohub/callback';
const hash = value => createHash('sha256').update(value).digest('base64url');
function sign(aud, values, key = secret) {
  const payload = Buffer.from(JSON.stringify({ iss: 'prt-agent-server', aud, exp: Date.now() + 60000, nonce: randomBytes(32).toString('base64url'), redirectUri: callback, ...values })).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'prt-hub-sso-'));
  const ctx = createApp({ dataDir: root, demoMode: true, production: false, origin: 'http://127.0.0.1:3100',
    appId: 'cli_shared', appSecret: 'synthetic-app-secret', tenantKey: 'tenant', harnessServerUrl: 'http://203.0.113.10:8082', harnessSharedSecret: secret,
    fetch: async url => url.includes('/oauth/token') ? { ok: true, json: async () => ({ access_token: 'synthetic' }) }
      : { ok: true, json: async () => ({ code: 0, data: { open_id: 'ou_prt_dev_admin', tenant_key: 'tenant', name: 'SSO admin' } }) } });
  t.after(() => { ctx.store.db.close(); rmSync(root, { recursive: true, force: true }); });
  return ctx;
}
async function authorize(t, context) {
  const { app } = context ?? fixture(t), agent = request.agent(app), verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const assertion = sign('prt-demo-hub-login', { state, challenge: hash(verifier) });
  const start = await agent.get('/api/harness/authorize').query({ request: assertion }).expect(302);
  assert.ok(start.headers.location.startsWith('/api/auth/feishu?'));
  const feishu = await agent.get(start.headers.location).expect(302), target = new URL(feishu.headers.location);
  assert.equal(target.searchParams.get('client_id'), 'cli_shared');
  assert.equal(target.searchParams.get('redirect_uri'), 'http://127.0.0.1:3100/api/auth/callback');
  const logged = await agent.get('/api/auth/callback').query({ state: target.searchParams.get('state'), code: 'synthetic' }).expect(302);
  assert.ok(logged.headers.location.startsWith('/api/harness/authorize?'));
  const completed = await agent.get(logged.headers.location).expect(302), redirect = new URL(completed.headers.location);
  assert.equal(redirect.origin + redirect.pathname, callback); assert.equal(redirect.searchParams.get('state'), state);
  return { app, agent, verifier, state, code: redirect.searchParams.get('code'), authorizePath: logged.headers.location };
}

test('Harness reuses Demo Hub Feishu login and exchanges a one-use, PKCE-bound code for the existing identity', async t => {
  const flow = await authorize(t);
  const exchange = patch => request(flow.app).post('/api/harness/sso/exchange').send({ assertion: sign('prt-demo-hub-login-exchange', { code: flow.code, verifier: flow.verifier, ...patch }) });
  await exchange({ verifier: randomBytes(32).toString('base64url') }).expect(401);
  const result = await exchange({}).expect(200);
  const [payload, signature] = result.body.assertion.split('.');
  assert.equal(signature, createHmac('sha256', secret).update(payload).digest('base64url'));
  const identity = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(identity.user.open_id, 'ou_prt_dev_admin'); assert.equal(identity.user.tenant_key, 'tenant');
  assert.equal(identity.appId, 'cli_shared'); assert.ok(identity.roles.includes('admin'));
  assert.ok(!JSON.stringify(result.body).includes('synthetic'));
  await exchange({}).expect(401);
  const reused = await flow.agent.get(flow.authorizePath).expect(302);
  assert.equal(new URL(reused.headers.location).origin, 'http://203.0.113.10:8082');
});

test('SSO rejects forged requests, unapproved callbacks, expiry and disabled users', async t => {
  const ctx = fixture(t), state = randomBytes(32).toString('base64url'), challenge = hash('verifier');
  for (const patch of [{ redirectUri: 'https://evil.example/callback' }, { exp: Date.now() - 1 }, { state: 'bad' }, { challenge: 'bad' }]) {
    await request(ctx.app).get('/api/harness/authorize').query({ request: sign('prt-demo-hub-login', { state, challenge, ...patch }) }).expect(400);
  }
  await request(ctx.app).get('/api/harness/authorize').query({ request: sign('prt-demo-hub-login', { state, challenge }, 'wrong') }).expect(400);
  const flow = await authorize(t, ctx);
  ctx.store.run("UPDATE users SET enabled=0 WHERE open_id='ou_prt_dev_admin'");
  await request(ctx.app).post('/api/harness/sso/exchange').send({ assertion: sign('prt-demo-hub-login-exchange', { code: flow.code, verifier: flow.verifier }) }).expect(403);
  await flow.agent.get(flow.authorizePath).expect(403);
});
