import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.mjs';
import { openStore } from '../server/db.mjs';
import { seedPreview } from '../server/seed.mjs';
import { createOpsWorker, runCheck } from '../server/ops-worker.mjs';
import { corePath, sourceFile, sourceSnapshot, validateSourceSnapshot, sha256 } from '../server/ops-source.mjs';
import { createLatestOpsBackup, backupInWorker } from '../server/ops-backup.mjs';
import { createOpsMaintenance, initializeOps, recordOpsDeployment, nextShanghaiMidnight, OPS_ACCOUNT_ID } from '../server/ops-maintenance.mjs';
import { pushCoreToGithub } from '../server/ops-github.mjs';
import { restoreBackup } from '../scripts/restore.mjs';
import { applyOpsSource } from '../scripts/apply-ops-source.mjs';
import { readModelConfig } from '../server/model-config.mjs';

const origin = 'http://127.0.0.1:3100', workerToken = 'synthetic-worker-secret-with-32-characters';
function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-ops-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function source(root) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}'); fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'example.js'), 'export const value = 1;\n'); return sourceSnapshot(root); }
async function fixture(t, options = {}) {
  const root = directory(t), workspace = path.join(root, 'source'); source(workspace);
  const worker = createOpsWorker({ root: workspace, token: workerToken, check: async (root, kind) => ({ kind, success: true, output: 'synthetic checks passed' }) });
  const workerCalls = [];
  const ctx = createApp({ dataDir: path.join(root, 'data'), demoMode: true, production: false, origin, descriptionAgentKey: 'synthetic-model-key', descriptionAgentUrl: 'https://api.deepseek.com/v1', descriptionAgentModel: 'deepseek-v4-pro', opsSourceDir: workspace, opsWorkerUrl: 'http://worker.test', opsWorkerToken: workerToken, opsWorkerFetch: async (url, options) => {
    if (new URL(url).pathname === '/health') return { ok: true, json: async () => ({ ok: true }) };
    const body = JSON.parse(options.body); workerCalls.push(body);
    const reply = await request(worker).post('/tool').set('Authorization', options.headers.Authorization).send(body);
    return { ok: reply.status === 200, status: reply.status, json: async () => reply.body };
  }, ...options });
  t.after(async () => { await ctx.opsAgent.stop(); await ctx.opsMaintenance.drain(); ctx.store.db.close(); });
  async function login(id) {
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/demo-login').set('Origin', origin).set('X-Requested-With', 'PRT').send({ userId: id }).expect(200);
    const me = (await agent.get('/api/auth/me')).body;
    return { agent, send: (method, url, body = {}) => agent[method]('/api' + url).set('Origin', origin).set('X-Requested-With', 'PRT').set('X-CSRF-Token', me.csrf).send(body) };
  }
  return { ...ctx, root, workspace, worker, workerCalls, login };
}

test('ops is an independent role; only human ops accounts access the workspace, and the virtual employee cannot log in or gain business roles', async t => {
  const ctx = await fixture(t), admin = await ctx.login('preview-admin');
  const virtual = ctx.store.one('SELECT * FROM users WHERE id=?', OPS_ACCOUNT_ID);
  assert.equal(virtual.account_type, 'virtual'); assert.deepEqual(JSON.parse(virtual.roles), ['ops']);
  await request(ctx.app).post('/api/auth/demo-login').set('Origin', origin).set('X-Requested-With', 'PRT').send({ userId: OPS_ACCOUNT_ID }).expect(400);
  const list = (await admin.send('get', '/admin/users').expect(200)).body;
  assert.equal(list.find(user => user.id === OPS_ACCOUNT_ID).virtual, true);
  for (const role of ['preview-admin', 'preview-employee', 'preview-pm', 'preview-business', 'preview-other-manager']) {
    const client = await ctx.login(role);
    for (const [method, url] of [
      ['get', '/ops/status'], ['get', '/ops/threads'], ['post', '/ops/threads'],
      ['get', '/ops/threads/example'], ['post', '/ops/threads/example/messages'],
      ['post', '/ops/threads/example/cancel'], ['get', '/ops/source'], ['post', '/ops/maintenance/example/retry']
    ]) await client.send(method, url).expect(403);
  }
  await admin.send('put', '/admin/users/preview-unassigned', { roles: ['ops'], enabled: true, supervisorId: null, revision: 0 }).expect(200);
  const ops = await ctx.login('preview-unassigned');
  const status = (await ops.send('get', '/ops/status').expect(200)).body;
  assert.equal(status.reasoningEffort, 'max'); assert.equal(status.maxTokens, null); assert.equal(status.thinking, true);
  assert.ok(!JSON.stringify(status).includes(workerToken)); assert.ok(!JSON.stringify(status).includes('synthetic-model-key'));
  await ops.send('get', '/admin/users').expect(403);
  const people = (await admin.send('get', '/notification-candidates').expect(200)).body;
  assert.ok(!people.some(user => user.id === OPS_ACCOUNT_ID));
  await admin.send('put', '/admin/users/' + OPS_ACCOUNT_ID, { roles: ['admin'], enabled: true, supervisorId: null, revision: 0 }).expect(400);
  await admin.send('put', '/admin/users/' + OPS_ACCOUNT_ID, { roles: ['ops'], enabled: false, supervisorId: null, revision: 0 }).expect(200);
  const thread = (await ops.send('post', '/ops/threads', { title: '测试' }).expect(201)).body;
  await ops.send('post', `/ops/threads/${thread.id}/messages`, { content: '检查状态' }).expect(409);
  ctx.store.run("UPDATE users SET roles='[\"employee\"]' WHERE id='preview-unassigned'");
  await ops.send('get', '/ops/status').expect(403);
  await request(ctx.app).get('/api/ops/status').expect(401);
});

test('an administrator must explicitly add ops to their account and loses workspace access as soon as ops is removed', async t => {
  const ctx = await fixture(t), admin = await ctx.login('preview-admin');
  await admin.send('get', '/ops/status').expect(403);
  await admin.send('put', '/admin/users/preview-admin', { roles: ['admin', 'ops'], enabled: true, supervisorId: null, revision: 0 }).expect(200);
  await admin.send('get', '/ops/status').expect(200);
  const thread = (await admin.send('post', '/ops/threads', { title: '显式运维授权' }).expect(201)).body;
  await admin.send('put', '/admin/users/preview-admin', { roles: ['admin'], enabled: true, supervisorId: null, revision: 1 }).expect(200);
  await admin.send('get', '/ops/threads/' + thread.id).expect(403);
  await admin.send('get', '/ops/source').expect(403);
  await admin.send('get', '/admin/users').expect(200);
});

test('the built-in harness uses shared DeepSeek credentials, max thinking and tool results, writes source, checks it and keeps conversations private', async t => {
  const calls = [];
  const ctx = await fixture(t, { opsModelFetch: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/v1/chat/completions'); assert.equal(options.headers.Authorization, 'Bearer synthetic-model-key');
    const body = JSON.parse(options.body); calls.push(body);
    assert.equal(body.reasoning_effort, 'max'); assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.max_tokens, undefined);
    const reply = (message, finish_reason = 'tool_calls') => ({ ok: true, json: async () => ({ choices: [{ message, finish_reason }] }) });
    const invoke = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    if (calls.length === 1) return reply({ role: 'assistant', content: '先检查现有代码。', reasoning_content: 'private synthetic thinking', tool_calls: [invoke('read_source', { path: 'src/example.js' }, 'read1')] });
    if (calls.length === 2) {
      assert.equal(body.messages.at(-2).reasoning_content, 'private synthetic thinking');
      const file = JSON.parse(body.messages.at(-1).content);
      return reply({ content: '', reasoning_content: 'private synthetic followup', tool_calls: [invoke('write_source', { path: file.path, expectedSha256: file.sha256, content: 'export const value = 2;\n' }, 'write1'), invoke('run_checks', { kind: 'test' }, 'test1'), invoke('run_checks', { kind: 'build' }, 'build1')] });
    }
    assert.equal(body.messages.filter(message => message.role === 'tool').length, 4);
    return reply({ content: '代码已修改，测试和构建通过；请下载源码并部署。' }, 'stop');
  } });
  ctx.store.run("UPDATE users SET roles='[\"admin\",\"ops\"]' WHERE id='preview-admin'");
  const admin = await ctx.login('preview-admin'), thread = (await admin.send('post', '/ops/threads', { title: '修改示例代码' }).expect(201)).body;
  await admin.agent.post(`/api/ops/threads/${thread.id}/messages`).send({ content: '修改代码' }).expect(403);
  await admin.send('post', `/ops/threads/${thread.id}/messages`, { content: '请把 value 改成 2，并验证' }).expect(202);
  await ctx.opsAgent.drain();
  const detail = (await admin.send('get', '/ops/threads/' + thread.id).expect(200)).body;
  assert.equal(detail.runs[0].status, 'complete'); assert.ok(detail.messages.some(message => message.role === 'activity'));
  assert.ok(!JSON.stringify(detail).includes('private synthetic')); assert.ok(!JSON.stringify(detail).includes('synthetic-model-key'));
  assert.equal(fs.readFileSync(path.join(ctx.workspace, 'src/example.js'), 'utf8'), 'export const value = 2;\n');
  const snapshot = (await admin.send('get', '/ops/source').expect(200)).body; validateSourceSnapshot(snapshot);
  const second = await ctx.login('preview-manager'); ctx.store.run("UPDATE users SET roles='[\"ops\"]' WHERE id='preview-manager'");
  await second.send('get', '/ops/threads/' + thread.id).expect(404); assert.equal((await second.send('get', '/ops/threads').expect(200)).body.length, 0);
  assert.equal(ctx.store.one("SELECT COUNT(*) AS count FROM events WHERE action='ops_tool'").count, 4);
  ctx.config.opsModelFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.messages.map(message => message.role), ['system', 'user', 'user']);
    assert.match(body.messages[1].content, /代码已修改/);
    assert.equal(body.messages.at(-1).content, '继续说明刚才的改动');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '已将 value 从 1 改为 2。' }, finish_reason: 'stop' }] }) };
  };
  await admin.send('post', `/ops/threads/${thread.id}/messages`, { content: '继续说明刚才的改动' }).expect(202); await ctx.opsAgent.drain();
  assert.equal((await admin.send('get', '/ops/threads/' + thread.id)).body.runs[0].status, 'complete');
});

test('cancellation and live permission revocation stop further tools without losing completed edits or leaving running jobs', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  const ctx = await fixture(t, { opsModelFetch: async () => { started(); await gate; return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ id: 'tool1', function: { name: 'write_source', arguments: JSON.stringify({ path: 'src/new.js', expectedSha256: null, content: 'changed' }) } }] } }] }) }; } });
  ctx.store.run("UPDATE users SET roles='[\"admin\",\"ops\"]' WHERE id='preview-admin'");
  const admin = await ctx.login('preview-admin'), thread = (await admin.send('post', '/ops/threads', { title: '中断' })).body;
  await admin.send('post', `/ops/threads/${thread.id}/messages`, { content: '执行修改' }).expect(202); await ready;
  await admin.send('post', `/ops/threads/${thread.id}/messages`, { content: '重复请求' }).expect(409);
  await admin.send('post', `/ops/threads/${thread.id}/cancel`).expect(200); release(); await ctx.opsAgent.drain();
  assert.equal((await admin.send('get', '/ops/threads/' + thread.id)).body.runs[0].status, 'cancelled'); assert.equal(ctx.workerCalls.length, 0);
  ctx.config.opsModelFetch = async () => { ctx.store.run("UPDATE users SET roles='[\"admin\"]' WHERE id='preview-admin'"); return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ id: 'read1', function: { name: 'read_source', arguments: '{"path":"src/example.js"}' } }] } }] }) }; };
  await admin.send('post', `/ops/threads/${thread.id}/messages`, { content: '读取源码' }).expect(202); await ctx.opsAgent.drain();
  assert.equal(ctx.workerCalls.length, 0); assert.equal(ctx.store.one('SELECT status FROM ops_runs ORDER BY rowid DESC LIMIT 1').status, 'failed');
});

test('worker authenticates requests, bounds paths and optimistic writes, and exposes only fixed check commands', async t => {
  const root = directory(t); source(root);
  const app = createOpsWorker({ root, token: workerToken, check: async (root, kind) => { if (!['build', 'test'].includes(kind)) throw new Error('仅支持 test 或 build'); return { success: true }; } });
  const send = (name, args = {}) => request(app).post('/tool').set('Authorization', 'Bearer ' + workerToken).send({ name, args });
  await request(app).post('/tool').send({ name: 'list_source' }).expect(401);
  for (const name of ['../package.json', '.env', 'src/../../.env', 'src/.env', '/etc/passwd', 'src\\a.js', 'src/../package.json', 'node_modules/a.js', 'data/platform.sqlite']) await send('read_source', { path: name }).expect(400);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'src', 'linked'));
  await send('write_source', { path: 'src/linked/escape.js', expectedSha256: null, content: 'escape' }).expect(400);
  fs.unlinkSync(path.join(root, 'src', 'linked'));
  fs.symlinkSync(path.join(root, 'missing.js'), path.join(root, 'src', 'broken.js'));
  await send('write_source', { path: 'src/broken.js', expectedSha256: null, content: 'escape' }).expect(400);
  fs.unlinkSync(path.join(root, 'src', 'broken.js'));
  const file = (await send('read_source', { path: 'src/example.js' }).expect(200)).body.result;
  await send('write_source', { path: file.path, expectedSha256: 'stale', content: 'new' }).expect(400);
  await send('write_source', { path: file.path, expectedSha256: file.sha256, content: 'changed' }).expect(200);
  await send('delete_source', { path: file.path, expectedSha256: file.sha256 }).expect(400);
  await send('delete_source', { path: file.path, expectedSha256: sha256('changed') }).expect(200);
  await send('shell', { command: 'ls' }).expect(400); await send('run_checks', { kind: 'test; echo hacked' }).expect(400);
  assert.equal((await send('run_checks', { kind: 'test' }).expect(200)).body.result.success, true);
});

test('source snapshots exclude secrets and runtime data, reject leaked credentials and import only into a new directory', t => {
  const root = directory(t), input = path.join(root, 'source'); source(input);
  fs.writeFileSync(path.join(input, '.env'), 'SECRET=synthetic'); fs.mkdirSync(path.join(input, 'data')); fs.writeFileSync(path.join(input, 'data', 'private.txt'), 'private');
  const snapshot = sourceSnapshot(input); assert.deepEqual(snapshot.files.map(file => file.path), ['package.json', 'src/example.js']);
  assert.equal(corePath('src/example.js'), true); assert.equal(corePath('src/node_modules/private.txt'), false);
  const bad = structuredClone(snapshot); bad.files[0].content = Buffer.from('changed').toString('base64'); assert.throws(() => validateSourceSnapshot(bad), /校验失败/);
  fs.writeFileSync(path.join(input, 'src', 'secret.js'), 'const token = "sk-' + 'a'.repeat(32) + '";'); assert.throws(() => validateSourceSnapshot(sourceSnapshot(input)), /疑似包含密钥/); fs.unlinkSync(path.join(input, 'src', 'secret.js'));
  const output = path.join(root, 'imported'); applyOpsSource(snapshot, output); assert.equal(sourceSnapshot(output).hash, snapshot.hash);
  assert.throws(() => applyOpsSource(snapshot, output), /新目录/);
});

test('fixed check runner passes no model or platform credentials and terminates timed-out code', async t => {
  const root = directory(t); source(root); fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'probe.test.mjs'), "import assert from 'node:assert/strict'; assert.equal(process.env.DEEPSEEK_API_KEY, undefined); assert.equal(process.env.OPS_WORKER_TOKEN, undefined);");
  assert.equal((await runCheck(root, 'test')).success, true);
  fs.writeFileSync(path.join(root, 'tests', 'probe.test.mjs'), 'setInterval(() => {}, 1000);');
  const result = await runCheck(root, 'test', { timeout: 150 }); assert.equal(result.stopped, true); assert.equal(result.success, false);
});

test('verified nightly backup replaces only the last successful ops backup and remains restorable after failures', async t => {
  const root = directory(t), dataDir = path.join(root, 'data'), backupDir = path.join(root, 'backup'), codeDir = path.join(root, 'source');
  const store = openStore(dataDir); seedPreview(store); initializeOps(store);
  t.after(() => store.db.close());
  const snapshot = source(codeDir), first = await backupInWorker({ dataDir, backupDir, snapshot });
  assert.ok(fs.existsSync(path.join(first.path, 'source/src/example.js'))); assert.equal(first.sourceHash, snapshot.hash);
  const restored = await restoreBackup(first.path, path.join(root, 'restored')); assert.ok(restored.files > 0);
  await createLatestOpsBackup({ dataDir, backupDir, snapshot }); assert.deepEqual(fs.readdirSync(backupDir), ['latest']);
  const file = store.one('SELECT id FROM files LIMIT 1'); fs.writeFileSync(path.join(dataDir, 'files', file.id), 'corrupt');
  await assert.rejects(createLatestOpsBackup({ dataDir, backupDir, snapshot }), /integrity/);
  assert.deepEqual(fs.readdirSync(backupDir), ['latest']); assert.ok(fs.existsSync(path.join(backupDir, 'latest/manifest.json')));
});

test('deployment scheduler uses Shanghai midnight, coalesces same-day deployments and retries GitHub without repeating a verified backup', async t => {
  const root = directory(t), store = openStore(path.join(root, 'data')); t.after(() => store.db.close()); seedPreview(store);
  let clock = Date.parse('2026-11-03T15:59:00Z'), backups = 0, pushes = 0, failing = true;
  const sourceDir = path.join(root, 'source'); const snapshot = source(sourceDir);
  const config = { opsEnabled: true, opsSourceDir: sourceDir, opsClock: () => clock, opsGithubToken: 'synthetic-github', opsBackup: async ({ snapshot }) => { backups++; return { path: '/backups/latest', files: 4, sourceHash: snapshot.hash }; }, opsGithub: async (snapshot, options) => { pushes++; assert.equal(options.branch, 'feature/deepseek'); if (failing) throw new Error('synthetic-github unavailable'); return { sha: 'commit1', branch: options.branch }; } };
  const maintenance = createOpsMaintenance(store, config);
  assert.equal(new Date(nextShanghaiMidnight(clock)).toISOString(), '2026-11-03T16:00:00.000Z');
  const old = maintenance.record(); assert.equal(maintenance.record().id, old.id); await maintenance.tick(); assert.equal(backups, 0);
  fs.writeFileSync(path.join(sourceDir, 'src/example.js'), 'new deployed source'); const latest = maintenance.record();
  clock = Date.parse('2026-11-03T16:00:00Z'); await Promise.all([maintenance.tick(), maintenance.tick()]);
  assert.equal(backups, 1); assert.equal(pushes, 1); assert.equal(maintenance.status().deployments.find(job => job.id === latest.id).status, 'failed');
  assert.ok(!JSON.stringify(maintenance.status()).includes('synthetic-github'));
  failing = false; assert.equal(maintenance.retry(latest.id), true); await maintenance.tick();
  assert.equal(backups, 1); assert.equal(pushes, 2); assert.equal(store.one('SELECT status FROM ops_deployments WHERE id=?', old.id).status, 'superseded');
  assert.equal(store.one('SELECT status FROM ops_deployments WHERE id=?', latest.id).status, 'complete');
  await maintenance.tick(); assert.equal(pushes, 2);
  assert.equal(new Date(nextShanghaiMidnight(Date.parse('2026-11-03T16:00:00Z'))).toISOString(), '2026-11-04T16:00:00.000Z');
});

test('restart catch-up persists deployment identity, respects a disabled virtual employee and does not schedule preview data', async t => {
  const root = directory(t), sourceDir = path.join(root, 'source'); source(sourceDir);
  let store = openStore(path.join(root, 'data')); seedPreview(store);
  let backups = 0, clock = Date.parse('2026-11-03T10:00:00Z');
  const options = { opsEnabled: true, opsSourceDir: sourceDir, opsClock: () => clock, opsBackup: async () => { backups++; return { path: '/latest' }; }, opsGithub: async () => ({ sha: 'commit' }) };
  let maintenance = createOpsMaintenance(store, options); const job = maintenance.record(); store.db.close();
  store = openStore(path.join(root, 'data')); t.after(() => store.db.close()); clock = Date.parse('2026-11-04T01:00:00Z'); maintenance = createOpsMaintenance(store, options);
  store.run('UPDATE users SET enabled=0 WHERE id=?', OPS_ACCOUNT_ID); await maintenance.tick(); assert.equal(backups, 0);
  store.run('UPDATE users SET enabled=1 WHERE id=?', OPS_ACCOUNT_ID); await maintenance.tick(); assert.equal(backups, 1); assert.equal(store.one('SELECT status FROM ops_deployments WHERE id=?', job.id).status, 'complete');
  assert.equal(createOpsMaintenance(store, { ...options, demoMode: true }).record(), null);
});

test('GitHub archive creates the selected feature branch, uploads only core paths and never force pushes or exposes the token', async t => {
  const root = directory(t), snapshot = source(root), calls = [];
  const call = async (url, options) => {
    const route = url.replace('https://api.github.com/repos/PRTAI/PRT-demo-hub', ''), body = options.body && JSON.parse(options.body); calls.push({ route, options, body });
    const result = data => ({ ok: true, json: async () => data });
    if (route === '/git/ref/heads/feature%2Fdeepseek') return { ok: false, status: 404 };
    if (route === '/git/ref/heads/main') return result({ object: { sha: 'base' } });
    if (route === '/git/refs') return result({ object: { sha: 'base' } });
    if (route === '/git/commits/base') return result({ sha: 'base', tree: { sha: 'old-tree' }, message: 'before' });
    if (route.startsWith('/git/trees/old-tree')) return result({ tree: [{ path: '.env', type: 'blob', sha: 'private' }, { path: 'src/removed.js', type: 'blob', mode: '100644' }], truncated: false });
    if (route === '/git/blobs') return result({ sha: 'blob' + calls.length });
    if (route === '/git/trees') { assert.ok(!body.tree.some(item => item.path === '.env')); assert.ok(body.tree.some(item => item.path === 'src/removed.js' && item.sha === null)); return result({ sha: 'tree' }); }
    if (route === '/git/commits') { assert.deepEqual(body.parents, ['base']); return result({ sha: 'new-commit' }); }
    if (route === '/git/refs/heads/feature%2Fdeepseek') { assert.equal(body.force, false); return result({}); }
    assert.fail(route);
  };
  const result = await pushCoreToGithub(snapshot, { token: 'synthetic-github-key', fetch: call });
  assert.equal(result.branch, 'feature/deepseek'); assert.equal(result.sha, 'new-commit'); assert.ok(calls.every(call => call.options.redirect === 'error'));
  await assert.rejects(pushCoreToGithub(snapshot, { token: 'test', branch: 'main', fetch: call }), /主分支/);
  await assert.rejects(pushCoreToGithub(snapshot), /OPS_GITHUB_TOKEN/);
});

test('ops model configuration shares description key and URL but enables max thinking independently without a default output cap', () => {
  const config = readModelConfig({ DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1', DEEPSEEK_ENABLE_THINKING: 'false' });
  assert.equal(config.descriptionAgentKey, 'test'); assert.equal(config.opsReasoningEffort, 'max'); assert.equal(config.opsMaxTokens, undefined);
  assert.equal(config.descriptionAgentEnableThinking, false); assert.equal(config.opsGithubBranch, 'feature/deepseek');
  assert.throws(() => readModelConfig({ OPS_REASONING_EFFORT: 'unsupported' }), /OPS_REASONING_EFFORT/);
});
