// Explicitly limited to the local synthetic-data environment.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
const origin = process.env.SMOKE_ORIGIN || 'http://127.0.0.1:8080';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const statePath = 'test-results/docker-smoke.json';
assert.equal((await (await fetch(origin + '/api/auth/me')).json()).demoMode, true, 'Refusing to mutate a non-preview environment');
async function login(userId) {
  const r = await fetch(origin + '/api/auth/demo-login', { method: 'POST', headers: { Origin: origin, 'X-Requested-With': 'PRT', 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const me = await (await fetch(origin + '/api/auth/me', { headers: { Cookie: cookie } })).json();
  async function call(route, method = 'GET', body, expected = 200) {
    const response = await fetch(origin + '/api' + route, { method, headers: { Cookie: cookie, Origin: origin, 'X-Requested-With': 'PRT', 'X-CSRF-Token': me.csrf, ...(body instanceof FormData ? { 'X-Revision': '0' } : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    assert.equal(response.status, expected, method + ' ' + route + ': ' + response.status);
    if (route.endsWith('/download')) return Buffer.from(await response.arrayBuffer());
    return response.json();
  }
  return call;
}
const employee = await login('preview-employee'), manager = await login('preview-manager'), pm = await login('preview-pm'), other = await login('preview-other'), admin = await login('preview-admin');
let state;
if (process.argv.includes('--verify')) state = JSON.parse(fs.readFileSync(statePath));
else {
  const description = { title: '容器验收 · 零售数据样例', summary: 'Docker 上传、审核与持久化验收合成数据', category: '通用数据', tags: ['容器验收'], content: '压缩包包含销售 CSV 和使用说明，所有内容为合成样例。', usage: '下载后解压，用电子表格打开 CSV。', notes: '仅用于功能测试', changes: '', schemaVersion: 1 };
  const asset = await employee('/assets', 'POST', { description, requestId: randomUUID() }, 201);
  const payload = fs.readFileSync('tests/fixtures/retail-demo.zip'), form = new FormData();
  form.append('file', new Blob([payload]), '容器验收样例.zip');
  const file = await employee(`/versions/${asset.versionId}/files`, 'POST', form, 201);
  await employee(`/versions/${asset.versionId}/actions`, 'POST', { revision: file.revision, action: 'submit' });
  const pending = await manager('/assets/' + asset.id);
  assert.equal(pending.latest.status, 'pending');
  await manager(`/versions/${asset.versionId}/actions`, 'POST', { revision: pending.latest.revision, action: 'publish' });
  await admin('/admin/backups', 'POST', {}, 202);
  let health;
  for (let i = 0; i < 100; i++) { health = await admin('/admin/health'); if (health.backupTask.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(health.backupTask.status, 'complete');
  state = { assetId: asset.id, versionId: asset.versionId, fileId: file.id, checksum: createHash('sha256').update(payload).digest('hex'), backupId: health.backupTask.id, createdAt: new Date().toISOString() };
  fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
const detail = await employee('/assets/' + state.assetId);
assert.equal(detail.latest.status, 'published');
assert.ok(detail.events.some(e => e.action === 'publish'));
assert.equal(detail.submissions.length, 1);
const downloaded = await pm(`/versions/${state.versionId}/files/${state.fileId}/download`);
assert.equal(createHash('sha256').update(downloaded).digest('hex'), state.checksum);
await other('/assets/' + state.assetId, 'GET', undefined, 404);
await other(`/versions/${state.versionId}/files/${state.fileId}/download`, 'GET', undefined, 404);
await admin('/assets/' + state.assetId, 'GET', undefined, 404);
const catalog = await pm('/catalog?pageSize=5'); assert.equal(catalog.items.length, 5);
assert.ok((await admin('/admin/health')).backup.at);
console.log(JSON.stringify({ ok: true, mode: process.argv.includes('--verify') ? 'restart-persistence-verified' : 'upload-review-download-backup-verified', ...state }, null, 2));
