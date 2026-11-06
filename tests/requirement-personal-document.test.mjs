import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { seedPreview } from '../server/seed.mjs';
import { createPersonalRequirementDocuments, personalRequirementSnapshot } from '../server/requirement-personal-document.mjs';
import { createRequirementDocumentSync } from '../server/requirement-document-sync.mjs';

const origin = 'http://127.0.0.1:3100';
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-personal-document-'));
  const calls = [], controls = { identity: 'preview-pm', expiry: 7200 }, documents = [], batches = new Map(), wikiNodes = [], roots = new Map(), revisions = new Map();
  const ctx = createApp({ dataDir: root, origin, demoMode: false, production: false, appId: 'cli_test', appSecret: 'synthetic-secret', tenantKey: 'tenant', requirementWikiSampleUrl: 'https://team.feishu.cn/wiki/Sample', ...options,
    fetch: async url => ({ ok: true, json: async () => url.endsWith('/oauth/token') ? { access_token: 'user-token-' + controls.identity, expires_in: controls.expiry } : { code: 0, data: { open_id: 'ou_' + controls.identity, name: controls.identity, tenant_key: 'tenant' } } }),
    personalDocumentFetch: async (input, options) => {
      const url = new URL(input), body = options.body instanceof FormData ? options.body : options.body ? JSON.parse(options.body) : null, token = options.headers.Authorization;
      calls.push({ url, body, token });
      await controls.beforeRequest?.(url, body);
      assert.equal(url.origin, 'https://open.feishu.cn'); assert.equal(options.redirect, 'error');
      assert.ok(token.startsWith('Bearer user-token-'));
      const response = data => ({ ok: true, json: async () => ({ code: 0, data }) });
      if (controls.apiError) return { ok: false, status: 403, json: async () => ({ code: 99991672, msg: 'sensitive response user-token-private' }) };
      if (url.pathname === '/open-apis/wiki/v2/spaces/get_node') return response({ node: { space_id: 'Space1', node_token: url.searchParams.get('token'), parent_node_token: 'AncestorMustNotBeUsed' } });
      if (url.pathname === '/open-apis/wiki/v2/spaces/Space1/nodes') {
        if (options.method === 'GET') return response({ items: controls.hideNodes ? [] : wikiNodes.filter(node => node.parent_node_token === url.searchParams.get('parent_node_token')), has_more: false });
        assert.equal(body.obj_type, 'docx'); assert.equal(body.node_type, 'origin'); assert.ok(body.parent_node_token);
        const node = { ...body, node_token: 'ExportWiki' + (wikiNodes.length + 1), obj_token: 'WikiDoc' + (wikiNodes.length + 1) };
        wikiNodes.push(node); documents.push({ document_id: node.obj_token, title: node.title });
        roots.set(node.obj_token, []); revisions.set(node.obj_token, 0);
        if (controls.loseCreate) throw new Error('response lost with sensitive token');
        return response({ node });
      }
      if (url.pathname.endsWith('/update_title')) {
        const node = wikiNodes.find(node => url.pathname.includes('/' + node.node_token + '/'));
        assert.ok(node);
        if (controls.loseRename) return { ok: false, status: 400, json: async () => ({ code: 123 }) };
        node.title = body.title; return response({});
      }
      if (url.pathname === '/open-apis/docx/v1/documents') {
        assert.deepEqual(Object.keys(body), ['title'], 'user token and no folder_token create in the personal cloud root');
        const document = { document_id: 'PersonalDoc' + (documents.length + 1), title: body.title }; documents.push(document);
        roots.set(document.document_id, []); revisions.set(document.document_id, 0);
        if (controls.loseCreate) throw new Error('response lost with sensitive token');
        return response({ document });
      }
      if (url.pathname === '/open-apis/drive/v1/medias/upload_all') {
        assert.ok(body instanceof FormData); assert.equal(options.headers['Content-Type'], undefined);
        assert.equal(body.get('parent_type'), 'docx_file');
        assert.match(body.get('parent_node'), /^FileBlock/);
        assert.ok(JSON.parse(body.get('extra')).drive_route_token);
        assert.equal(body.get('file').size, Number(body.get('size')));
        if (controls.loseUpload) { controls.loseUpload = false; throw new Error('lost upload response'); }
        return response({ file_token: 'Media' + calls.length });
      }
      const documentId = url.pathname.match(/\/docx\/v1\/documents\/([^/]+)/)?.[1];
      if (options.method === 'GET' && /\/docx\/v1\/documents\/[^/]+$/.test(url.pathname)) return response({ document: { document_id: documentId, revision_id: revisions.get(documentId) } });
      if (options.method === 'GET' && url.pathname.endsWith('/children')) return response({ items: roots.get(documentId), has_more: false });
      if (options.method === 'DELETE' && url.pathname.endsWith('/children/batch_delete')) {
        assert.equal(Number(url.searchParams.get('document_revision_id')), revisions.get(documentId));
        roots.get(documentId).splice(body.start_index, body.end_index - body.start_index); revisions.set(documentId, revisions.get(documentId) + 1);
        if (controls.loseDelete) { controls.loseDelete = false; throw new Error('lost delete response'); }
        return response({});
      }
      if (options.method === 'PATCH' && body.update_text_elements) {
        const blockId = url.pathname.split('/').at(-1), block = roots.get(documentId).find(block => block.block_id === blockId);
        if (blockId === documentId) documents.find(doc => doc.document_id === documentId).title = body.update_text_elements.elements.map(item => item.text_run.content).join('');
        else {
          assert.ok(block, 'only existing blocks may be updated');
          const value = Object.values(block).find(item => Array.isArray(item?.elements)); assert.ok(value);
          value.elements = structuredClone(body.update_text_elements.elements);
        }
        revisions.set(documentId, revisions.get(documentId) + 1);
        if (controls.losePatch) { controls.losePatch = false; throw new Error('lost patch response'); }
        return response({});
      }
      if (options.method === 'PATCH') {
        assert.match(url.pathname, /\/blocks\/FileBlock/); assert.match(body.replace_file.token, /^Media/);
        if (controls.loseReplace) { controls.loseReplace = false; throw new Error('lost replace response'); }
        return response({});
      }
      assert.ok(url.pathname.endsWith('/children'));
      const key = url.searchParams.get('client_token'); assert.ok(key); assert.ok(body.children.length <= 40);
      if (!batches.has(key)) {
        const children = body.children.map((child, index) => child.block_type === 23
          ? { block_type: 33, block_id: 'ViewBlock' + key + index, children: ['FileBlock' + key + index], view: { view_type: 1 } }
          : { ...structuredClone(child), block_id: 'TextBlock' + key + index });
        batches.set(key, children); roots.get(documentId).splice(body.index ?? roots.get(documentId).length, 0, ...children);
        revisions.set(documentId, revisions.get(documentId) + 1);
      }
      if (controls.loseBatch) { controls.loseBatch = false; throw new Error('response lost with sensitive token'); }
      return response({ children: batches.get(key) });
    }
  });
  seedPreview(ctx.store); ctx.store.run("UPDATE users SET open_id='ou_' || id");
  const id = ctx.store.one('SELECT id FROM requirements').id;
  t.after(async () => { await ctx.requirementExports.drain(); await ctx.personalRequirementDocuments.drain(); await ctx.requirementWiki.drain(); ctx.store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function login(identity, personal = false, agent = request.agent(ctx.app)) {
    controls.identity = identity;
    const query = typeof personal === 'object' ? { ...personal, document_export: '1' } : personal === 'batch' ? { view: 'requirements', document_export: '1' } : personal ? { requirement: id, document_export: '1' } : {};
    const begin = await agent.get('/api/auth/feishu').query(query).expect(302), target = new URL(begin.headers.location);
    const callback = await agent.get('/api/auth/callback').query({ state: target.searchParams.get('state'), code: 'synthetic' }).expect(302);
    const me = (await agent.get('/api/auth/me').expect(200)).body;
    const send = (url, body = {}) => agent.post('/api' + url).set('Origin', origin).set('X-Requested-With', 'PRT').set('X-CSRF-Token', me.csrf).send(body);
    return { agent, send, target, callback };
  }
  return { ...ctx, id, controls, calls, documents, batches, wikiNodes, roots, login, endpoint: `/requirements/${id}/personal-document-export` };
}

test('personal export requires a PM user consent, uses that user token, preserves detail content and isolates each PM snapshot', async t => {
  const ctx = fixture(t), pm = await ctx.login('preview-pm');
  const fileId = randomUUID();
  ctx.store.run('INSERT INTO files VALUES(?,?,?,?,?,?)', fileId, '验收需求文档.pdf', 123, 'synthetic-checksum', 'preview-pm', new Date().toISOString());
  fs.writeFileSync(path.join(ctx.store.root, 'files', fileId), Buffer.alloc(123, 65));
  ctx.store.run('INSERT INTO requirement_files VALUES(?,?,?,?)', ctx.id, fileId, 'preview-pm', new Date().toISOString());
  for (const role of ['preview-business', 'preview-employee', 'preview-other-manager', 'preview-admin']) {
    const client = await ctx.login(role);
    await client.send(ctx.endpoint).expect(403);
    await client.agent.get('/api' + ctx.endpoint).expect(403);
    await client.agent.get('/api/auth/feishu').query({ document_export: '1', requirement: ctx.id }).expect(403);
  }
  const needed = (await pm.send(ctx.endpoint).expect(200)).body;
  assert.equal(needed.status, 'authorization_required'); assert.ok(needed.authorizationUrl.includes('document_export=1'));
  assert.equal(ctx.calls.length, 0);
  const consent = await ctx.login('preview-pm', true, pm.agent);
  assert.equal(consent.target.searchParams.get('scope'), 'docx:document docs:document.media:upload');
  assert.equal(consent.callback.headers.location, `/?view=requirements&requirement=${ctx.id}`);
  await consent.agent.post('/api' + ctx.endpoint).send({}).expect(403);
  const begin = (await consent.send(ctx.endpoint).expect(202)).body;
  const repeated = await consent.send(ctx.endpoint);
  assert.ok([200, 202].includes(repeated.status)); assert.equal(repeated.body.id, begin.id);
  await ctx.personalRequirementDocuments.drain();
  const ready = (await consent.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(ready.status, 'ready'); assert.match(ready.url, /^https:\/\/team\.feishu\.cn\/docx\/PersonalDoc1$/);
  assert.equal(ready.completedBlocks, ready.totalBlocks);
  assert.ok(ctx.calls.every(call => call.token === 'Bearer user-token-preview-pm'));
  const contents = JSON.stringify([...ctx.batches.values()]);
  for (const label of ['需求信息', '需求内容', '商务负责人', '研发负责人', '需求文档', 'Demo', '数据简介', '数据说明', '数据量级', '成本预估', '难度说明', '注意事项']) assert.ok(contents.includes(label));
  assert.ok(contents.includes('/?demo='));
  assert.ok(contents.includes('验收需求文档.pdf'));
  assert.ok(!contents.includes('user-token-'));
  assert.equal(ctx.documents[0].title, ctx.store.one('SELECT title FROM requirements WHERE id=?', ctx.id).title);
  assert.ok(ready.totalAttachments > 1); assert.equal(ready.completedAttachments, ready.totalAttachments);
  const upload = ctx.calls.find(call => call.body instanceof FormData && call.body.get('file_name') === '验收需求文档.pdf');
  assert.ok(upload); assert.deepEqual(Buffer.from(await upload.body.get('file').arrayBuffer()), Buffer.alloc(123, 65));
  assert.equal(upload.body.get('file').name, '验收需求文档.pdf');
  assert.ok(ctx.calls.some(call => call.url.pathname.endsWith('/' + upload.body.get('parent_node')) && call.body.replace_file));
  const cached = (await consent.send(ctx.endpoint).expect(200)).body;
  assert.equal(cached.id, begin.id); assert.equal(ctx.documents.length, 1);
  const secondPm = await ctx.login('preview-manager');
  assert.equal((await secondPm.agent.get('/api' + ctx.endpoint).expect(200)).body.status, 'not_created');
  const authorizedSecond = await ctx.login('preview-manager', true, secondPm.agent);
  await authorizedSecond.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  assert.equal(ctx.documents.length, 2); assert.ok(ctx.calls.some(call => call.token === 'Bearer user-token-preview-manager'));
  ctx.store.run('UPDATE requirements SET content=? WHERE id=?', '内容更新后的新快照', ctx.id);
  await consent.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  assert.equal(ctx.documents.length, 3);
});

test('personal export resumes the same document and idempotent batch after a lost response and sanitizes authorization errors', async t => {
  const ctx = fixture(t), pm = await ctx.login('preview-pm'), authorized = await ctx.login('preview-pm', true, pm.agent);
  ctx.controls.loseBatch = true;
  await authorized.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  let state = (await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(state.status, 'failed'); assert.ok(!state.error.includes('sensitive'));
  const firstBatch = ctx.calls.find(call => call.url.pathname.endsWith('/children'));
  await authorized.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  state = (await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(state.status, 'ready'); assert.equal(ctx.documents.length, 1);
  const retries = ctx.calls.filter(call => call.url.searchParams.get('client_token') === firstBatch.url.searchParams.get('client_token'));
  assert.equal(retries.length, 2); assert.deepEqual(retries[0].body, retries[1].body);
  ctx.store.run('UPDATE requirements SET content=? WHERE id=?', '权限失败快照', ctx.id); ctx.controls.apiError = true;
  await authorized.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  state = (await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(state.status, 'failed'); assert.equal(state.authorizationRequired, true);
  assert.ok(!JSON.stringify(state).includes('sensitive')); assert.ok(!JSON.stringify(state).includes('user-token'));
});

test('status changes invalidate old exports even when collaboration sync fails, and current exports win over late older jobs', async t => {
  const ctx = fixture(t, { wikiFetch: async url => ({ ok: true, json: async () => url.includes('tenant_access_token')
    ? { code: 0, tenant_access_token: 'synthetic-application-token', expire: 7200 }
    : { code: 99991672 } }) });
  const pm = await ctx.login('preview-pm'), authorized = await ctx.login('preview-pm', true, pm.agent);
  const old = (await authorized.send(ctx.endpoint).expect(202)).body;
  await ctx.personalRequirementDocuments.drain();
  const oldReady = (await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(oldReady.status, 'ready');
  ctx.requirementWiki.enqueue(ctx.id);
  const detail = (await authorized.agent.get('/api/requirements/' + ctx.id).expect(200)).body;
  await authorized.send(`/requirements/${ctx.id}/actions`, { revision: detail.revision, action: 'set_status', status: 'delivered' }).expect(200);
  ctx.controls.apiError = true;
  await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'authorization_required');
  assert.match(ctx.requirementWiki.info(ctx.id).error, /99991672/);
  ctx.controls.apiError = false;
  const stale = (await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(stale.status, 'outdated'); assert.ok(!stale.url);
  // Failure on the new content must never fall back to the prior successful document.
  ctx.controls.loseBatch = true;
  const fresh = (await authorized.send(ctx.endpoint).expect(202)).body;
  assert.notEqual(fresh.id, old.id);
  await ctx.personalRequirementDocuments.drain();
  const failed = (await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(failed.status, 'failed'); assert.equal(failed.id, fresh.id); assert.equal(failed.url, '');
  assert.equal((await authorized.send(ctx.endpoint).expect(202)).body.id, fresh.id);
  await ctx.personalRequirementDocuments.drain();
  // Simulate a delayed retry/progress write by a batch exporting the older snapshot.
  ctx.store.run('UPDATE requirement_personal_documents SET updated_at=? WHERE id=?', '2099-01-01T00:00:00Z', old.id);
  const ready = (await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(ready.status, 'ready'); assert.equal(ready.id, fresh.id); assert.notEqual(ready.url, oldReady.url);
  const snapshot = JSON.parse(ctx.store.one('SELECT snapshot FROM requirement_personal_documents WHERE id=?', ready.id).snapshot);
  const status = snapshot.blocks.find(block => block.text?.elements?.[0]?.text_run?.content === '状态：');
  assert.equal(status.text.elements[1].text_run.content, '已交付');
  assert.equal((await authorized.send(ctx.endpoint).expect(200)).body.id, ready.id);
  assert.equal(ctx.documents.length, 2);
  // Linked Demo edits do not need a requirement revision bump to invalidate an export.
  const version = ctx.store.one('SELECT v.* FROM versions v JOIN asset_requirements ar ON ar.asset_id=v.asset_id WHERE ar.requirement_id=? LIMIT 1', ctx.id);
  const description = JSON.parse(version.description);
  ctx.store.run('UPDATE versions SET description=? WHERE id=?', JSON.stringify({ ...description, notes: '负责人补充的最新注意事项' }), version.id);
  assert.equal((await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body.status, 'outdated');
});

test('attachment failures block completion and retry binds the saved token without duplicating blocks or uploading the same file again', async t => {
  const ctx = fixture(t), pm = await ctx.login('preview-pm'), authorized = await ctx.login('preview-pm', true, pm.agent);
  ctx.controls.loseReplace = true;
  await authorized.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  const failed = (await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(failed.status, 'failed'); assert.equal(failed.completedBlocks, failed.totalBlocks);
  assert.ok(failed.totalAttachments > 0); assert.equal(failed.completedAttachments, 0); assert.equal(failed.url, '');
  const failedReplace = ctx.calls.find(call => call.body?.replace_file), blockId = failedReplace.url.pathname.split('/').at(-1);
  const blockRequests = ctx.calls.filter(call => call.url.pathname.endsWith('/children')).length;
  await authorized.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  const ready = (await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(ready.status, 'ready'); assert.equal(ready.completedAttachments, ready.totalAttachments);
  assert.equal(ctx.documents.length, 1); assert.equal(ctx.calls.filter(call => call.url.pathname.endsWith('/children')).length, blockRequests);
  assert.equal(ctx.calls.filter(call => call.body instanceof FormData && call.body.get('parent_node') === blockId).length, 1);
  assert.equal(ctx.calls.filter(call => call.url.href === failedReplace.url.href).length, 2);
});

test('ambiguous personal document creation never blindly creates a duplicate, and a restart resumes recorded blocks', async t => {
  const ctx = fixture(t), pm = await ctx.login('preview-pm'), authorized = await ctx.login('preview-pm', true, pm.agent);
  ctx.controls.loseCreate = true;
  await authorized.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  assert.equal((await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body.status, 'uncertain');
  await authorized.send(ctx.endpoint).expect(200);
  assert.equal(ctx.documents.length, 1);
  ctx.controls.loseCreate = false;
  ctx.store.run('UPDATE requirements SET content=? WHERE id=?', '重启快照', ctx.id);
  ctx.controls.loseBatch = true;
  await authorized.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  const row = ctx.store.one("SELECT * FROM requirement_personal_documents WHERE status='failed'");
  ctx.store.run("UPDATE requirement_personal_documents SET status='pending' WHERE id=?", row.id);
  const resumed = createPersonalRequirementDocuments(ctx.store, ctx.config);
  assert.equal(resumed.latest(ctx.id, 'preview-pm').status, 'failed');
  resumed.start(ctx.id, 'preview-pm', JSON.parse(row.snapshot), 'user-token-preview-pm');
  await resumed.drain();
  assert.equal(resumed.latest(ctx.id, 'preview-pm').status, 'ready'); assert.equal(ctx.documents.length, 2);
});

test('personal document consent remains bound to the initiating PM, tokens expire, and revoked roles stop exporting', async t => {
  const ctx = fixture(t), pm = await ctx.login('preview-pm');
  const begin = await pm.agent.get('/api/auth/feishu').query({ requirement: ctx.id, document_export: '1' }).expect(302);
  ctx.controls.identity = 'preview-manager';
  const target = new URL(begin.headers.location);
  const denied = await pm.agent.get('/api/auth/callback').query({ state: target.searchParams.get('state'), code: 'synthetic' }).expect(302);
  assert.match(decodeURIComponent(denied.headers.location), /本人/);
  ctx.controls.expiry = 1;
  const authorized = await ctx.login('preview-pm', true, pm.agent);
  assert.equal((await authorized.send(ctx.endpoint).expect(200)).body.status, 'authorization_required');
  ctx.store.run("UPDATE users SET roles='[\"employee\"]' WHERE id='preview-pm'");
  await authorized.send(ctx.endpoint).expect(403);
  assert.equal(ctx.calls.length, 0);
});

test('preview export never calls Feishu and a PM role revoked before background execution prevents document creation', async t => {
  const previewCtx = fixture(t, { demoMode: true }), pm = await previewCtx.login('preview-pm');
  const preview = await pm.send(previewCtx.endpoint).expect(400); assert.match(preview.body.error, /演示环境/);
  assert.equal(previewCtx.calls.length, 0);
  const ctx = fixture(t);
  const snapshot = { title: '权限变更', blocks: [{ block_type: 2, text: { elements: [{ text_run: { content: '合成内容' } }] } }] };
  ctx.personalRequirementDocuments.start(ctx.id, 'preview-pm', snapshot, 'user-token-preview-pm');
  ctx.store.run("UPDATE users SET roles='[\"employee\"]' WHERE id='preview-pm'");
  await ctx.personalRequirementDocuments.drain();
  assert.equal(ctx.calls.length, 0);
  const failed = ctx.personalRequirementDocuments.latest(ctx.id, 'preview-pm');
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /项目经理权限/);
});

test('long requirement and Demo text is preserved across bounded blocks without leaking unsafe links', () => {
  const content = '长说明😀'.repeat(2000);
  const snapshot = personalRequirementSnapshot({ title: '长需求', status: 'open', publisher: { name: '发布人' }, publishDate: '2026-10-28', updatedAt: '2026-10-28', content, documents: [], demos: [], shareUrl: origin + '/?view=requirements', calendar: { appLink: 'https://evil.example/?token=secret' }, wiki: { url: 'https://evil.example' } });
  const paragraphs = snapshot.blocks.filter(block => block.text).flatMap(block => block.text.elements.map(element => element.text_run.content));
  assert.ok(paragraphs.every(value => Array.from(value).length <= 1000));
  assert.ok(paragraphs.join('').includes(content)); assert.ok(!JSON.stringify(snapshot).includes('evil.example'));
});

function secondBatchRequirement(ctx) {
  const id = randomUUID();
  ctx.store.run("UPDATE requirements SET title='批量个人导出-甲',content='冻结的需求正文',deadline_date='2028-01-02' WHERE id=?", ctx.id);
  ctx.store.run(`INSERT INTO requirements(id,title,content,category,status,publisher_id,created_at,updated_at,planned_date,deadline_date)
    SELECT ?,'批量个人导出-乙','第二份需求正文',category,status,publisher_id,created_at,updated_at,planned_date,'2028-02-01' FROM requirements WHERE id=?`, id, ctx.id);
  return id;
}

test('batch Excel export freezes personal documents before consent, returns to the list and blocks download until every document completes without wiki configuration', async t => {
  const ctx = fixture(t, { requirementWikiSampleUrl: '' }), second = secondBatchRequirement(ctx), pm = await ctx.login('preview-pm');
  const job = (await pm.send('/requirements/exports', { q: '批量个人导出-', status: 'open', pageSize: 1, page: 2 }).expect(202)).body;
  assert.equal(job.status, 'authorization_required'); assert.equal(job.total, 2); assert.equal(ctx.calls.length, 0);
  assert.equal(new URL(job.authorizationUrl, origin).searchParams.get('view'), 'requirements');
  await pm.agent.get(`/api/requirements/exports/${job.id}/file.xlsx?sync=skip`).expect(409);
  ctx.store.run("UPDATE requirements SET content='授权以后修改的正文',deadline_date='2029-01-01' WHERE id=?", ctx.id);
  const consent = await ctx.login('preview-pm', 'batch', pm.agent);
  assert.equal(consent.callback.headers.location, '/?view=requirements');
  assert.equal(consent.target.searchParams.get('scope'), 'docx:document docs:document.media:upload');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  ctx.controls.beforeRequest = () => gate;
  try {
    const pending = (await consent.send(`/requirements/exports/${job.id}/retry`).expect(200)).body;
    assert.equal(pending.status, 'pending');
    await consent.agent.get(`/api/requirements/exports/${job.id}/file.xlsx`).expect(409);
    assert.equal((await consent.send(`/requirements/exports/${job.id}/retry`).expect(200)).body.id, job.id);
  } finally { release(); }
  await ctx.requirementExports.drain();
  const ready = (await consent.agent.get(`/api/requirements/exports/${job.id}`).expect(200)).body;
  assert.equal(ready.status, 'ready'); assert.equal(ready.completed, 2); assert.equal(ctx.documents.length, 2);
  const content = JSON.stringify([...ctx.batches.values()]);
  assert.ok(content.includes('冻结的需求正文')); assert.ok(!content.includes('授权以后修改的正文'));
  assert.ok(content.includes('数据说明')); assert.ok(content.includes('成本预估'));
  assert.ok(ctx.calls.every(call => call.token === 'Bearer user-token-preview-pm' && (call.url.pathname.startsWith('/open-apis/docx/') || call.url.pathname.startsWith('/open-apis/drive/v1/medias/'))));
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_wiki').count, 0);
  const file = await consent.agent.get(`/api/requirements/exports/${job.id}/file.xlsx`).buffer(true).parse((res, callback) => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks))); res.on('error', callback);
  }).expect(200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(file.body); const sheet = workbook.worksheets[0];
  assert.equal(sheet.columnCount, 8); assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell('G2').value.toISOString().slice(0, 10), '2028-01-02');
  assert.equal(new URL(sheet.getCell('A3').hyperlink).searchParams.get('requirement'), second);
  const otherPm = await ctx.login('preview-manager');
  await otherPm.agent.get(`/api/requirements/exports/${job.id}`).expect(404);
  await otherPm.agent.get(`/api/requirements/exports/${job.id}/file.xlsx`).expect(404);
  await otherPm.send(`/requirements/exports/${job.id}/retry`).expect(404);
  const business = await ctx.login('preview-business');
  await business.send('/requirements/exports', {}).expect(403);
  await business.agent.get(`/api/requirements/exports/${job.id}`).expect(403);
});

test('batch and single personal exports reuse identical documents and failed batch retries continue only unfinished document blocks', async t => {
  const ctx = fixture(t, { requirementWikiSampleUrl: '' }); secondBatchRequirement(ctx);
  const pm = await ctx.login('preview-pm'), consent = await ctx.login('preview-pm', true, pm.agent);
  await consent.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  const single = (await consent.agent.get('/api' + ctx.endpoint).expect(200)).body;
  ctx.controls.loseBatch = true;
  const batch = (await consent.send('/requirements/exports', { q: '批量个人导出-' }).expect(202)).body;
  await ctx.requirementExports.drain();
  const failed = (await consent.agent.get(`/api/requirements/exports/${batch.id}`).expect(200)).body;
  assert.equal(failed.status, 'failed'); assert.equal(failed.completed, 1); assert.equal(failed.failed, 1);
  assert.equal(ctx.documents.length, 2);
  await consent.agent.get(`/api/requirements/exports/${batch.id}/file.xlsx?sync=skip`).expect(409);
  const records = ctx.store.all('SELECT * FROM requirement_export_items WHERE export_id=? ORDER BY position', batch.id);
  assert.equal(records[0].personal_document_id, single.id);
  await consent.send(`/requirements/exports/${batch.id}/retry`).expect(200); await ctx.requirementExports.drain();
  assert.equal((await consent.agent.get(`/api/requirements/exports/${batch.id}`).expect(200)).body.status, 'ready');
  assert.equal(ctx.documents.length, 2);
  const repeated = (await consent.send('/requirements/exports', { q: '批量个人导出-' }).expect(202)).body;
  await ctx.requirementExports.drain();
  assert.equal((await consent.agent.get(`/api/requirements/exports/${repeated.id}`).expect(200)).body.status, 'ready');
  assert.equal(ctx.documents.length, 2);
});

test('batch authorization failures preserve the batch and finished items until reauthorization; role revocation blocks downloads', async t => {
  const ctx = fixture(t); secondBatchRequirement(ctx);
  const pm = await ctx.login('preview-pm'), consent = await ctx.login('preview-pm', 'batch', pm.agent);
  ctx.controls.apiError = true;
  const batch = (await consent.send('/requirements/exports', { q: '批量个人导出-' }).expect(202)).body;
  await ctx.requirementExports.drain();
  const paused = (await consent.agent.get(`/api/requirements/exports/${batch.id}`).expect(200)).body;
  assert.equal(paused.status, 'authorization_required'); assert.equal(paused.authorizationRequired, true);
  assert.equal(paused.failed, 1); assert.equal(ctx.documents.length, 0);
  assert.ok(!JSON.stringify(paused).includes('user-token'));
  ctx.controls.apiError = false;
  const renewed = await ctx.login('preview-pm', 'batch', consent.agent);
  await renewed.send(`/requirements/exports/${batch.id}/retry`).expect(200); await ctx.requirementExports.drain();
  assert.equal((await renewed.agent.get(`/api/requirements/exports/${batch.id}`).expect(200)).body.status, 'ready');
  assert.equal(ctx.documents.length, 2);
  ctx.store.run("UPDATE users SET roles='[\"employee\"]' WHERE id='preview-pm'");
  await renewed.agent.get(`/api/requirements/exports/${batch.id}/file.xlsx`).expect(403);
});

const exportWikiParent = 'https://zi4kl3ktexa.feishu.cn/wiki/UUsWwv96viopGXkfgHFcFyi8ncf';

async function liveFixture(t, options = {}) {
  const ctx = fixture(t, { wikiFetch: async () => assert.fail('sync must not use the application wiki identity'), ...options });
  const pm = await ctx.login('preview-pm'), authorized = await ctx.login('preview-pm', true, pm.agent);
  await authorized.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain(); await ctx.requirementWiki.drain();
  const exported = (await authorized.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'synced');
  const row = ctx.store.one('SELECT * FROM requirement_personal_documents WHERE id=?', exported.id);
  return { ...ctx, authorized, exported, documentId: row.document_id };
}
const documentText = blocks => JSON.stringify(blocks);
const uploads = ctx => ctx.calls.filter(call => call.url.pathname.includes('/medias/upload')).length;
const changeBody = (ctx, content) => { ctx.store.run('UPDATE requirements SET content=? WHERE id=?', content, ctx.id); ctx.requirementWiki.enqueue(ctx.id); };

test('live sync updates the exported wiki document with the original PM identity, no sample lookup and no repeated attachment uploads', async t => {
  const ctx = await liveFixture(t, { requirementExportWikiParentUrl: exportWikiParent });
  const originalIds = ctx.roots.get(ctx.documentId).map(block => block.block_id), uploaded = uploads(ctx), start = ctx.calls.length;
  // A stale or invalid sample setting must not break a known, successfully exported document.
  ctx.config.requirementWikiSampleUrl = 'https://invalid.example/sample';
  const detail = (await ctx.authorized.agent.get('/api/requirements/' + ctx.id).expect(200)).body;
  await ctx.authorized.send(`/requirements/${ctx.id}/actions`, { revision: detail.revision, action: 'set_status', status: 'delivered' }).expect(200);
  await ctx.requirementWiki.drain();
  const state = ctx.requirementWiki.info(ctx.id);
  assert.equal(state.status, 'synced'); assert.equal(state.url, ctx.exported.url);
  assert.equal(ctx.documents.length, 1); assert.equal(uploads(ctx), uploaded);
  assert.deepEqual(ctx.roots.get(ctx.documentId).map(block => block.block_id), originalIds);
  assert.match(documentText(ctx.roots.get(ctx.documentId)), /已交付/);
  const syncCalls = ctx.calls.slice(start);
  assert.ok(syncCalls.length > 0); assert.ok(syncCalls.every(call => call.token === 'Bearer user-token-preview-pm'));
  assert.ok(syncCalls.every(call => call.url.pathname.startsWith('/open-apis/docx/v1/documents/' + ctx.documentId)));
  const current = (await ctx.authorized.send(ctx.endpoint).expect(200)).body;
  assert.equal(current.id, ctx.exported.id); assert.equal(current.url, ctx.exported.url);
  ctx.store.run("UPDATE requirements SET title='更新的需求名称' WHERE id=?", ctx.id); ctx.requirementWiki.enqueue(ctx.id);
  await ctx.requirementWiki.drain();
  assert.equal(ctx.wikiNodes[0].title, '更新的需求名称'); assert.equal(ctx.documents.length, 1);
});

test('structural sync preserves manual blocks and reuses unchanged media, then adds and removes real requirement attachments', async t => {
  const ctx = await liveFixture(t), beforeUploads = uploads(ctx), manual = { block_id: 'ManualNote', block_type: 2, text: { elements: [{ text_run: { content: '人工补充必须保留' } }] } };
  ctx.roots.get(ctx.documentId).splice(3, 0, manual);
  changeBody(ctx, '## 新增小节\n第一段说明\n\n第二段说明'); await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'synced'); assert.equal(ctx.documents.length, 1);
  assert.equal(uploads(ctx), beforeUploads); assert.ok(ctx.roots.get(ctx.documentId).includes(manual));
  assert.match(documentText(ctx.roots.get(ctx.documentId)), /第二段说明/);
  const fileId = randomUUID(), time = new Date().toISOString();
  ctx.store.run('INSERT INTO files VALUES(?,?,?,?,?,?)', fileId, '新需求.pdf', 8, 'new-checksum', 'preview-pm', time);
  fs.writeFileSync(path.join(ctx.store.root, 'files', fileId), 'new-data');
  ctx.store.run('INSERT INTO requirement_files VALUES(?,?,?,?)', ctx.id, fileId, 'preview-pm', time);
  ctx.requirementWiki.enqueue(ctx.id); await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'synced'); assert.equal(uploads(ctx), beforeUploads + 1);
  assert.match(documentText(ctx.roots.get(ctx.documentId)), /新需求.pdf/);
  const requirement = (await ctx.authorized.agent.get('/api/requirements/' + ctx.id).expect(200)).body;
  await ctx.authorized.agent.delete(`/api/requirements/${ctx.id}/documents/${fileId}`).set('Origin', origin).set('X-Requested-With', 'PRT')
    .set('X-CSRF-Token', (await ctx.authorized.agent.get('/api/auth/me').expect(200)).body.csrf).send({ revision: requirement.revision }).expect(200);
  await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'synced'); assert.equal(uploads(ctx), beforeUploads + 1);
  assert.ok(!documentText(ctx.roots.get(ctx.documentId)).includes('新需求.pdf'));
  assert.ok(ctx.roots.get(ctx.documentId).includes(manual));
  const stored = ctx.store.one('SELECT snapshot,block_ids FROM requirement_document_sync WHERE requirement_id=?', ctx.id);
  assert.equal(ctx.roots.get(ctx.documentId).length, JSON.parse(stored.block_ids).length + 1);
});

test('live text updates recover after a lost PATCH response without creating a new document', async t => {
  const ctx = await liveFixture(t);
  ctx.controls.losePatch = true;
  ctx.store.run("UPDATE requirements SET status='delivered' WHERE id=?", ctx.id); ctx.requirementWiki.enqueue(ctx.id);
  await ctx.requirementWiki.drain(); assert.equal(ctx.requirementWiki.info(ctx.id).status, 'pending');
  assert.match(documentText(ctx.roots.get(ctx.documentId)), /已交付/);
  ctx.requirementWiki.retry(ctx.id); await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'synced'); assert.equal(ctx.documents.length, 1);
  assert.equal(ctx.requirementWiki.info(ctx.id).url, ctx.exported.url);
});

for (const failure of ['loseBatch', 'loseDelete']) test(`structural live sync resumes after ${failure} without duplicated blocks and applies a newer queued generation`, async t => {
  const ctx = await liveFixture(t), manual = { block_id: 'ManualTail', block_type: 2, text: { elements: [{ text_run: { content: '人工尾注' } }] } };
  ctx.roots.get(ctx.documentId).push(manual);
  ctx.controls[failure] = true;
  changeBody(ctx, '## 第一版小节\n第一版正文'); await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'pending');
  changeBody(ctx, '## 最终小节\n最终正文\n\n补充第二段'); await ctx.requirementWiki.drain();
  // The saved operation completes its frozen snapshot first; a newer generation stays queued.
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'pending');
  await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'synced'); assert.equal(ctx.documents.length, 1);
  const blocks = ctx.roots.get(ctx.documentId), saved = ctx.store.one('SELECT snapshot,block_ids FROM requirement_document_sync WHERE requirement_id=?', ctx.id);
  assert.match(documentText(blocks), /最终正文/); assert.ok(!documentText(blocks).includes('第一版正文'));
  assert.ok(blocks.includes(manual)); assert.equal(blocks.length, JSON.parse(saved.block_ids).length + 1);
  assert.equal(new Set(blocks.map(block => block.block_id)).size, blocks.length);
});

test('expired or logged-out exporter authorization pauses live sync; reauthorization resumes the same document and revoked roles never fall back to app access', async t => {
  const ctx = await liveFixture(t), start = ctx.calls.length;
  await ctx.authorized.send('/auth/logout').expect(200);
  changeBody(ctx, '退出后等待同步'); await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'authorization_required'); assert.equal(ctx.calls.length, start);
  const pm = await ctx.login('preview-pm'); ctx.controls.expiry = 1;
  const expired = await ctx.login('preview-pm', true, pm.agent);
  ctx.requirementWiki.retry(ctx.id); await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'authorization_required'); assert.equal(ctx.calls.length, start);
  ctx.controls.expiry = 7200;
  const renewed = await ctx.login('preview-pm', true, expired.agent);
  await renewed.send(`/requirements/${ctx.id}/wiki/retry`).expect(200); await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).status, 'synced'); assert.equal(ctx.requirementWiki.info(ctx.id).url, ctx.exported.url);
  assert.match(documentText(ctx.roots.get(ctx.documentId)), /退出后等待同步/);
  const after = ctx.calls.length;
  for (const sql of ["UPDATE users SET enabled=0 WHERE id='preview-pm'", "UPDATE users SET enabled=1,roles='[\"employee\"]' WHERE id='preview-pm'"]) {
    ctx.store.run(sql); changeBody(ctx, '权限已撤销'); await ctx.requirementWiki.drain();
    assert.equal(ctx.requirementWiki.info(ctx.id).status, 'authorization_required'); assert.equal(ctx.calls.length, after);
  }
  assert.ok(!JSON.stringify(ctx.requirementWiki.info(ctx.id)).includes('user-token')); assert.equal(ctx.documents.length, 1);
});

test('legacy root IDs are adopted only for an exact exported prefix, with a safe re-export prompt when manual changes prevent identification', async t => {
  for (const modified of [false, true]) {
    const ctx = await liveFixture(t);
    ctx.store.run("UPDATE requirement_document_sync SET block_ids='[]' WHERE requirement_id=?", ctx.id);
    if (modified) ctx.roots.get(ctx.documentId).unshift({ block_id: 'ManualBefore', block_type: 2, text: { elements: [{ text_run: { content: '人工前言' } }] } });
    const original = structuredClone(ctx.roots.get(ctx.documentId));
    changeBody(ctx, '## 升级后的内容\n新的正文'); await ctx.requirementWiki.drain();
    if (modified) {
      assert.match(ctx.requirementWiki.info(ctx.id).error, /重新导出一次/);
      assert.deepEqual(ctx.roots.get(ctx.documentId), original);
    } else {
      assert.equal(ctx.requirementWiki.info(ctx.id).status, 'synced'); assert.match(documentText(ctx.roots.get(ctx.documentId)), /升级后的内容/);
    }
    assert.equal(ctx.documents.length, 1);
  }
});

test('restarting live sync retains its document target and checkpoints without persisting user tokens or restoring application identity', async t => {
  const ctx = await liveFixture(t), persisted = ctx.store.one('SELECT * FROM requirement_document_sync WHERE requirement_id=?', ctx.id);
  let token = null;
  const snapshot = JSON.parse(persisted.snapshot); snapshot.blocks.push({ block_type: 2, text: { elements: [{ text_run: { content: '重启后的正文' } }] } });
  const reopened = createRequirementDocumentSync(ctx.store, ctx.config, { snapshotFor: () => snapshot, tokenFor: () => token });
  reopened.enqueue(ctx.id); await reopened.drain();
  assert.equal(reopened.info(ctx.id).status, 'authorization_required'); assert.equal(reopened.info(ctx.id).url, ctx.exported.url);
  assert.ok(!JSON.stringify(ctx.store.one('SELECT * FROM requirement_document_sync WHERE requirement_id=?', ctx.id)).includes('user-token'));
  token = 'user-token-preview-pm'; reopened.retry(ctx.id); await reopened.drain();
  assert.equal(reopened.info(ctx.id).status, 'synced'); assert.equal(ctx.documents.length, 1);
  assert.match(documentText(ctx.roots.get(ctx.documentId)), /重启后的正文/);
});

test('a late older export cannot replace the live target established by a newer successful export', async t => {
  const ctx = fixture(t), pm = await ctx.login('preview-pm'), authorized = await ctx.login('preview-pm', true, pm.agent);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let held = false;
  ctx.controls.beforeRequest = async url => { if (!held && url.pathname.includes('/PersonalDoc1/') && url.pathname.endsWith('/children')) { held = true; entered(); await gate; } };
  const older = (await authorized.send(ctx.endpoint).expect(202)).body;
  await waiting;
  changeBody(ctx, '当前应该采用的新需求内容');
  const newer = (await authorized.send(ctx.endpoint).expect(202)).body;
  await ctx.personalRequirementDocuments.wait(newer.id);
  const newerUrl = ctx.store.one('SELECT url FROM requirement_personal_documents WHERE id=?', newer.id).url;
  assert.equal(ctx.requirementWiki.info(ctx.id).url, newerUrl);
  release(); await ctx.personalRequirementDocuments.wait(older.id); await ctx.requirementWiki.drain();
  assert.equal(ctx.requirementWiki.info(ctx.id).url, newerUrl); assert.equal(ctx.requirementWiki.info(ctx.id).status, 'synced');
  assert.equal(ctx.store.one('SELECT export_id FROM requirement_document_sync WHERE requirement_id=?', ctx.id).export_id, newer.id);
});

test('configured wiki exports create children of the target itself with the PM user token and single/batch exports reuse the same document', async t => {
  const ctx = fixture(t, { requirementExportWikiParentUrl: exportWikiParent });
  ctx.store.run("UPDATE requirements SET title='指定目录验收' WHERE id=?", ctx.id);
  const pm = await ctx.login('preview-pm');
  const before = (await pm.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(before.destination, 'wiki'); assert.equal(before.destinationUrl, exportWikiParent);
  assert.equal((await pm.send(ctx.endpoint).expect(200)).body.status, 'authorization_required');
  const consent = await ctx.login('preview-pm', true, pm.agent);
  assert.equal(consent.target.searchParams.get('scope'), 'docx:document docs:document.media:upload wiki:wiki');
  await consent.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  const ready = (await consent.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(ready.status, 'ready'); assert.equal(ready.destination, 'wiki');
  assert.equal(ready.url, 'https://zi4kl3ktexa.feishu.cn/wiki/ExportWiki1');
  assert.equal(ctx.wikiNodes.length, 1); assert.equal(ctx.wikiNodes[0].parent_node_token, 'UUsWwv96viopGXkfgHFcFyi8ncf');
  assert.equal(ctx.wikiNodes[0].title, '指定目录验收');
  assert.ok(ctx.calls.some(call => call.url.pathname.includes('/WikiDoc1/blocks/WikiDoc1/children')));
  assert.ok(!ctx.calls.some(call => call.url.pathname === '/open-apis/docx/v1/documents'));
  assert.ok(ctx.calls.every(call => call.token === 'Bearer user-token-preview-pm'));
  const batch = (await consent.send('/requirements/exports', { q: '指定目录验收' }).expect(202)).body;
  assert.equal(batch.destinationUrl, exportWikiParent); await ctx.requirementExports.drain();
  assert.equal((await consent.agent.get(`/api/requirements/exports/${batch.id}`).expect(200)).body.status, 'ready');
  assert.equal(ctx.documents.length, 1);
  assert.equal(ctx.store.one('SELECT personal_document_id FROM requirement_export_items WHERE export_id=?', batch.id).personal_document_id, ready.id);
});

test('changing from personal root to wiki never reuses the wrong destination and requires the additional consent before API calls', async t => {
  const ctx = fixture(t), pm = await ctx.login('preview-pm'), original = await ctx.login('preview-pm', true, pm.agent);
  await original.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  const rootDocument = (await original.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(rootDocument.destination, 'personal');
  ctx.config.requirementExportWikiParentUrl = exportWikiParent;
  assert.equal((await original.agent.get('/api' + ctx.endpoint).expect(200)).body.status, 'not_created');
  const count = ctx.calls.length;
  assert.equal((await original.send(ctx.endpoint).expect(200)).body.status, 'authorization_required');
  assert.equal(ctx.calls.length, count);
  const consent = await ctx.login('preview-pm', true, original.agent);
  await consent.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  const wikiDocument = (await consent.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.notEqual(wikiDocument.id, rootDocument.id); assert.equal(ctx.documents.length, 2);
  ctx.config.requirementExportWikiParentUrl = '';
  assert.equal((await consent.agent.get('/api' + ctx.endpoint).expect(200)).body.id, rootDocument.id);
});

test('a batch freezes its destination before consent and preserves wiki authorization when the default setting later changes', async t => {
  const ctx = fixture(t, { requirementExportWikiParentUrl: exportWikiParent }); secondBatchRequirement(ctx);
  const pm = await ctx.login('preview-pm');
  const batch = (await pm.send('/requirements/exports', { q: '批量个人导出-' }).expect(202)).body;
  assert.equal(batch.status, 'authorization_required');
  ctx.config.requirementExportWikiParentUrl = '';
  const consent = await ctx.login('preview-pm', { view: 'requirements', export: batch.id }, pm.agent);
  assert.equal(consent.target.searchParams.get('scope'), 'docx:document docs:document.media:upload wiki:wiki');
  await consent.send(`/requirements/exports/${batch.id}/retry`).expect(200); await ctx.requirementExports.drain();
  const ready = (await consent.agent.get(`/api/requirements/exports/${batch.id}`).expect(200)).body;
  assert.equal(ready.status, 'ready'); assert.equal(ready.destinationUrl, exportWikiParent);
  assert.equal(ctx.wikiNodes.length, 2); assert.ok(ctx.wikiNodes.every(node => node.parent_node_token === 'UUsWwv96viopGXkfgHFcFyi8ncf'));
});

test('lost wiki creation responses recover by stable job title and never blindly create when the previous node is invisible', async t => {
  const ctx = fixture(t, { requirementExportWikiParentUrl: exportWikiParent }), pm = await ctx.login('preview-pm'), consent = await ctx.login('preview-pm', true, pm.agent);
  ctx.controls.loseCreate = true;
  await consent.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  assert.equal((await consent.agent.get('/api' + ctx.endpoint).expect(200)).body.status, 'uncertain');
  assert.equal(ctx.wikiNodes.length, 1);
  ctx.controls.loseCreate = false; ctx.controls.hideNodes = true;
  await consent.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  assert.equal((await consent.agent.get('/api' + ctx.endpoint).expect(200)).body.status, 'uncertain');
  assert.equal(ctx.wikiNodes.length, 1);
  ctx.controls.hideNodes = false;
  await consent.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  assert.equal((await consent.agent.get('/api' + ctx.endpoint).expect(200)).body.status, 'ready');
  assert.equal(ctx.wikiNodes.length, 1);
});

test('wiki title failures resume the same recorded document without rewriting blocks and invalid destinations fail before export starts', async t => {
  const ctx = fixture(t, { requirementExportWikiParentUrl: exportWikiParent }), pm = await ctx.login('preview-pm'), consent = await ctx.login('preview-pm', true, pm.agent);
  ctx.controls.loseRename = true;
  await consent.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  const failed = (await consent.agent.get('/api' + ctx.endpoint).expect(200)).body;
  assert.equal(failed.status, 'failed'); assert.equal(failed.completedBlocks, failed.totalBlocks);
  const batches = ctx.calls.filter(call => call.url.pathname.endsWith('/children')).length;
  ctx.controls.loseRename = false;
  await consent.send(ctx.endpoint).expect(202); await ctx.personalRequirementDocuments.drain();
  assert.equal((await consent.agent.get('/api' + ctx.endpoint).expect(200)).body.status, 'ready');
  assert.equal(ctx.wikiNodes.length, 1); assert.equal(ctx.calls.filter(call => call.url.pathname.endsWith('/children')).length, batches);
  ctx.config.requirementExportWikiParentUrl = 'https://zi4kl3ktexa.feishu.cn/docx/NotAWikiParent';
  await consent.send(ctx.endpoint).expect(400);
  const invalid = await consent.send('/requirements/exports', {}).expect(400);
  assert.match(invalid.body.error, /FEISHU_REQUIREMENT_EXPORT_WIKI_PARENT_URL/);
});

test('deleting a requirement preserves its exported document and stops an in-flight sync without reviving its job', async t => {
  const ctx = await liveFixture(t);
  const start = ctx.calls.length;
  let removed = false;
  ctx.controls.beforeRequest = async () => {
    if (removed) return;
    removed = true;
    const me = (await ctx.authorized.agent.get('/api/auth/me').expect(200)).body;
    await ctx.authorized.agent.delete('/api/requirements/' + ctx.id).set('Origin', origin).set('X-Requested-With', 'PRT').set('X-CSRF-Token', me.csrf).send({ revision: 0 }).expect(200);
  };
  changeBody(ctx, '删除时停止同步的新正文'); await ctx.requirementWiki.drain();
  assert.ok(removed); assert.equal(ctx.calls.length, start + 1);
  assert.equal(ctx.store.one('SELECT status FROM requirement_document_sync WHERE requirement_id=?', ctx.id).status, 'deleted');
  assert.equal(ctx.store.one('SELECT status FROM requirement_personal_documents WHERE id=?', ctx.exported.id).status, 'ready');
  assert.equal(ctx.documents.length, 1); assert.ok(ctx.roots.get(ctx.documentId).length);
  const calls = ctx.calls.length;
  ctx.requirementWiki.enqueue(ctx.id); await ctx.requirementWiki.drain(); assert.equal(ctx.calls.length, calls);
  await ctx.authorized.send(ctx.endpoint).expect(404);
});
