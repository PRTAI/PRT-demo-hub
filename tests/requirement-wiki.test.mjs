import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, uid, now } from '../server/db.mjs';
import { seedPreview } from '../server/seed.mjs';
import { createRequirementWiki } from '../server/requirement-wiki.mjs';
import { createRequirementExports } from '../server/requirement-export.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-wiki-test-'));
  const ctx = { root, store: openStore(root), calls: [], nodes: [], blocks: new Map(), members: new Map(), tokens: new Map(), controls: {} };
  t.after(() => { ctx.store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  seedPreview(ctx.store);
  ctx.store.run('DELETE FROM asset_requirements');
  ctx.id = ctx.store.one('SELECT id FROM requirements').id;
  ctx.store.run("UPDATE users SET open_id='ou_' || id");
  ctx.store.run('DELETE FROM requirement_assignees');
  for (const id of ['preview-pm', 'preview-employee']) ctx.store.run('INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)', ctx.id, id, 'preview-pm', now());
  ctx.config = { demoMode: false, appId: 'cli_mock', appSecret: 'secret_mock', publicOrigin: 'http://data.prt-ai.cn:8001', origin: 'http://127.0.0.1:3100', requirementWikiSampleUrl: 'https://team.feishu.cn/wiki/SampleToken?create_from=create_doc_to_wiki', ...options };
  ctx.config.wikiFetch = async (value, options) => {
    const url = new URL(value), method = options.method, body = options.body ? JSON.parse(options.body) : null;
    ctx.calls.push({ url, method, body });
    assert.equal(url.origin, 'https://open.feishu.cn'); assert.equal(options.redirect, 'error');
    if (ctx.controls.onRequest) await ctx.controls.onRequest({ url, method, body });
    const response = data => ({ ok: true, json: async () => ({ code: 0, data }) });
    if (url.pathname.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'token_mock', expire: 7200 }) };
    assert.equal(options.headers.Authorization, 'Bearer token_mock');
    if (ctx.controls.apiError) return { ok: false, status: 403, json: async () => ({ code: 99991672, msg: 'sensitive secret_mock data' }) };
    if (url.pathname.endsWith('/spaces/get_node')) {
      assert.equal(url.searchParams.get('token'), 'SampleToken');
      return response({ node: { space_id: 'Space123', node_token: 'SampleToken', parent_node_token: ctx.controls.rootSample ? '' : 'ParentToken' } });
    }
    if (url.pathname.endsWith('/nodes') && method === 'GET') return response({ items: ctx.nodes, has_more: false });
    if (url.pathname.endsWith('/nodes') && method === 'POST') {
      const node = { ...body, space_id: 'Space123', node_token: 'Wiki' + (ctx.nodes.length + 1), obj_token: 'Doc' + (ctx.nodes.length + 1) };
      ctx.nodes.push(node);
      if (ctx.controls.loseCreate) { ctx.controls.loseCreate--; throw new Error('lost create secret_mock'); }
      return response({ node });
    }
    if (url.pathname.endsWith('/update_title')) { ctx.nodes[0].title = body.title; return response({}); }
    if (url.pathname.endsWith('/children') && method === 'POST') {
      const token = url.searchParams.get('client_token'); assert.ok(token);
      if (!ctx.tokens.has(token)) {
        assert.ok(body.children.length <= 50);
        const offset = ctx.blocks.size;
        const children = body.children.map((block, index) => ({ ...block, block_id: 'Block' + (offset + index) }));
        for (const block of children) ctx.blocks.set(block.block_id, block);
        ctx.tokens.set(token, children);
      }
      if (ctx.controls.loseBlocks) { ctx.controls.loseBlocks--; throw new Error('lost blocks secret_mock'); }
      return response({ children: ctx.tokens.get(token) });
    }
    if (url.pathname.includes('/blocks/') && method === 'PATCH') {
      const block = ctx.blocks.get(url.pathname.split('/').pop()); assert.ok(block);
      block.text.elements = body.update_text_elements.elements; return response({ block });
    }
    if (url.pathname.endsWith('/members') && method === 'GET') return response({ items: [...ctx.members.values()] });
    if (url.pathname.endsWith('/members') && method === 'POST') {
      if (ctx.controls.failGrant) { ctx.controls.failGrant--; throw new Error('lost grant secret_mock'); }
      assert.equal(body.perm, 'edit'); assert.equal(body.perm_type, 'single_page'); assert.equal(url.searchParams.get('type'), 'wiki');
      ctx.members.set(body.member_id, body); return response({ member: body });
    }
    if (url.pathname.includes('/members/') && method === 'PUT') {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      ctx.members.set(id, { ...ctx.members.get(id), ...body, member_id: id }); return response({ member: ctx.members.get(id) });
    }
    if (url.pathname.includes('/members/') && method === 'DELETE') { ctx.members.delete(decodeURIComponent(url.pathname.split('/').pop())); return response({}); }
    throw new Error('Unexpected mock request ' + method + ' ' + url.pathname);
  };
  ctx.wiki = createRequirementWiki(ctx.store, ctx.config);
  ctx.job = () => ctx.store.one('SELECT * FROM requirement_wiki WHERE requirement_id=?', ctx.id);
  ctx.ready = () => ctx.store.run('UPDATE requirement_wiki SET next_at=0');
  ctx.file = name => {
    const id = uid();
    ctx.store.run('INSERT INTO files VALUES(?,?,?,?,?,?)', id, name, 123, 'checksum', 'preview-pm', now());
    ctx.store.run('INSERT INTO requirement_files VALUES(?,?,?,?)', ctx.id, id, 'preview-pm', now());
    return id;
  };
  ctx.demo = (description = {}, status = 'draft', withFile = true) => {
    const id = uid(), versionId = uid(), fileId = uid(), time = now();
    ctx.store.run('INSERT INTO assets(id,owner_id,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)', id, 'preview-employee', 'preview-employee', time, time);
    ctx.store.run('INSERT INTO versions(id,asset_id,number,status,description,creator_id,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?)', versionId, id, status, JSON.stringify(description), 'preview-employee', time, time);
    ctx.store.run('INSERT INTO asset_requirements VALUES(?,?,?,?)', id, ctx.id, 'preview-employee', time);
    ctx.store.run('INSERT INTO files VALUES(?,?,?,?,?,?)', fileId, '原始文件.zip', 123, 'checksum', 'preview-employee', time);
    if (withFile) ctx.store.run('INSERT INTO version_files VALUES(?,?)', versionId, fileId);
    return { id, versionId, fileId };
  };
  ctx.documentText = () => [...ctx.blocks.values()].flatMap(block => (block.text || block.heading2)?.elements || []).map(element => element.text_run.content).join('\n');
  return ctx;
}

test('wiki creates a separate sibling document with only the requirement name and document links and deduplicated editors', async t => {
  const ctx = fixture(t);
  assert.equal(ctx.wiki.info(ctx.id).status, 'not_created'); assert.equal(ctx.wiki.list().length, 0);
  const fileId = ctx.file('需求文档 & 样例.pdf');
  ctx.wiki.enqueue(ctx.id);
  await Promise.all([ctx.wiki.drain(), ctx.wiki.drain()]);
  assert.equal(ctx.nodes.length, 1); assert.equal(ctx.nodes[0].parent_node_token, 'ParentToken');
  assert.equal(ctx.nodes[0].title, ctx.store.one('SELECT title FROM requirements WHERE id=?', ctx.id).title);
  assert.equal(ctx.wiki.info(ctx.id).status, 'synced'); assert.equal(ctx.wiki.info(ctx.id).url, 'https://team.feishu.cn/wiki/Wiki1');
  assert.equal(ctx.blocks.size, 4);
  assert.equal(ctx.blocks.get('Block0').heading2.elements[0].text_run.content, '需求简述');
  assert.equal(ctx.blocks.get('Block2').heading2.elements[0].text_run.content, '需求文档');
  const summary = ctx.blocks.get('Block1').text.elements[0].text_run.content;
  assert.equal(summary, ctx.nodes[0].title); assert.ok(!summary.includes('合成数据'));
  assert.equal(ctx.blocks.get('Block3').text.elements[0].text_run.text_element_style.link.url, `http://data.prt-ai.cn:8001/api/requirements/${ctx.id}/documents/${fileId}/download`);
  assert.deepEqual(new Set(ctx.members.keys()), new Set(['ou_preview-pm', 'ou_preview-employee']));
  assert.ok([...ctx.members.values()].every(member => member.perm === 'edit'));
  const count = ctx.calls.length; await ctx.wiki.drain(); assert.equal(ctx.calls.length, count);
});

test('wiki recovers lost node and block responses after SQLite reopens without creating duplicate documents or sections', async t => {
  const ctx = fixture(t); ctx.wiki.enqueue(ctx.id); ctx.controls.loseCreate = 1;
  await ctx.wiki.drain(); assert.equal(ctx.nodes.length, 1); assert.equal(ctx.job().node_token, '');
  ctx.store.db.close(); ctx.store = openStore(ctx.root); ctx.wiki = createRequirementWiki(ctx.store, ctx.config);
  ctx.controls.loseBlocks = 1; ctx.ready(); await ctx.wiki.drain();
  assert.equal(ctx.nodes.length, 1); assert.equal(ctx.job().node_token, 'Wiki1'); assert.equal(ctx.job().summary_block, ''); assert.equal(ctx.blocks.size, 4);
  ctx.store.db.close(); ctx.store = openStore(ctx.root); ctx.wiki = createRequirementWiki(ctx.store, ctx.config);
  ctx.ready(); await ctx.wiki.drain();
  assert.equal(ctx.wiki.info(ctx.id).status, 'synced'); assert.equal(ctx.nodes.length, 1); assert.equal(ctx.blocks.size, 4); assert.equal(ctx.tokens.size, 1);
});

test('wiki updates only application blocks, keeps manual Demo content and adjusts only application-managed edit permissions', async t => {
  const ctx = fixture(t);
  ctx.members.set('ou_preview-employee', { member_type: 'openid', member_id: 'ou_preview-employee', perm: 'view' });
  ctx.members.set('ou_preexisting-admin', { member_type: 'openid', member_id: 'ou_preexisting-admin', perm: 'full_access' });
  ctx.wiki.enqueue(ctx.id); await ctx.wiki.drain();
  ctx.blocks.set('ManualDemo', { block_id: 'ManualDemo', text: { elements: [{ text_run: { content: '负责人补充的 Demo 代码与链接' } }] } });
  ctx.file('补充需求.docx'); ctx.store.run('UPDATE requirements SET title=? WHERE id=?', '新需求标题', ctx.id);
  ctx.store.run('INSERT INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)', ctx.id, 'preview-colleague', 'preview-pm', now());
  ctx.store.run("UPDATE users SET enabled=0 WHERE id='preview-employee'");
  ctx.wiki.enqueueExisting(ctx.id); await ctx.wiki.drain();
  assert.equal(ctx.nodes.length, 1); assert.equal(ctx.nodes[0].title, '新需求标题');
  assert.equal(ctx.blocks.get('Block1').text.elements[0].text_run.content, '新需求标题');
  assert.equal(ctx.blocks.get('Block3').text.elements[0].text_run.content, '补充需求.docx');
  assert.equal(ctx.blocks.get('ManualDemo').text.elements[0].text_run.content, '负责人补充的 Demo 代码与链接');
  assert.equal(ctx.members.get('ou_preview-employee').perm, 'view');
  assert.equal(ctx.members.get('ou_preview-colleague').perm, 'edit'); assert.equal(ctx.members.get('ou_preexisting-admin').perm, 'full_access');
  ctx.store.run("DELETE FROM requirement_assignees WHERE user_id='preview-colleague'"); ctx.wiki.enqueueForUser('preview-pm'); await ctx.wiki.drain();
  assert.equal(ctx.members.has('ou_preview-colleague'), false); assert.equal(ctx.members.has('ou_preexisting-admin'), true);
});

test('wiki failures retry independently with saved IDs and safe errors, while later retries use the same document', async t => {
  const ctx = fixture(t); ctx.wiki.enqueue(ctx.id); ctx.controls.failGrant = 5;
  for (let attempt = 0; attempt < 5; attempt++) { ctx.ready(); await ctx.wiki.drain(); }
  assert.equal(ctx.job().status, 'failed'); assert.ok(!ctx.job().error.includes('secret_mock'));
  assert.equal(ctx.nodes.length, 1); assert.equal(ctx.job().node_token, 'Wiki1');
  assert.equal(ctx.wiki.retry(ctx.id), true); assert.equal(ctx.wiki.retry(ctx.id), false);
  await ctx.wiki.drain(); assert.equal(ctx.job().status, 'synced'); assert.equal(ctx.nodes.length, 1);
  assert.equal(ctx.wiki.retry(ctx.id), true); await ctx.wiki.drain(); assert.equal(ctx.nodes.length, 1);
});

test('wiki preserves a pending generation when a requirement changes during document synchronization', async t => {
  const ctx = fixture(t); ctx.wiki.enqueue(ctx.id);
  let changed = false;
  ctx.controls.onRequest = ({ url, method }) => {
    if (!changed && url.pathname.endsWith('/members') && method === 'POST') {
      changed = true; ctx.store.run('UPDATE requirements SET title=? WHERE id=?', '并发变更标题', ctx.id); ctx.wiki.enqueue(ctx.id);
    }
  };
  await ctx.wiki.drain(); assert.equal(ctx.job().status, 'pending');
  await ctx.wiki.drain(); assert.equal(ctx.job().status, 'synced'); assert.equal(ctx.nodes[0].title, '并发变更标题'); assert.equal(ctx.nodes.length, 1);
});

test('wiki validates its configured sample and skips all external writes in preview mode', async t => {
  const ctx = fixture(t, { requirementWikiSampleUrl: 'https://evil.example/wiki/Token' }); ctx.wiki.enqueue(ctx.id);
  await ctx.wiki.drain(); assert.equal(ctx.calls.length, 0); assert.match(ctx.job().error, /FEISHU_REQUIREMENT_WIKI_SAMPLE_URL/);
  ctx.config.requirementWikiSampleUrl = 'https://team.feishu.cn/wiki/SampleToken'; ctx.config.demoMode = true; ctx.ready(); await ctx.wiki.drain(); assert.equal(ctx.calls.length, 0);
  ctx.config.demoMode = false; ctx.controls.rootSample = true; ctx.ready(); await ctx.wiki.drain();
  assert.equal(ctx.job().status, 'synced'); assert.equal(ctx.nodes[0].parent_node_token, undefined);
});

test('wiki automatically copies the five saved Demo description sections and keeps manual blocks when descriptions change', async t => {
  const ctx = fixture(t);
  ctx.wiki.enqueue(ctx.id); await ctx.wiki.drain();
  const demo = ctx.demo({ title: '负责人上传样例', summary: '简介内容', content: '# 数据概述\n概述甲\n# 数据格式\n格式甲', costEstimate: '成本甲', difficulty: '难度甲', notes: '注意甲' });
  ctx.blocks.set('ManualDemo', { block_type: 2, text: { elements: [{ text_run: { content: '人工补充：请保留' } }] } });
  ctx.wiki.enqueueForAsset(demo.id); await ctx.wiki.drain();
  assert.equal(ctx.wiki.info(ctx.id).status, 'synced'); assert.equal(ctx.nodes.length, 1);
  let content = ctx.documentText();
  for (const value of ['负责人上传样例', 'V1 · 草稿', '数据概述', '概述甲', '数据格式', '格式甲', '成本预估', '成本甲', '难度说明', '难度甲', '注意事项', '注意甲', '人工补充：请保留']) assert.ok(content.includes(value), value);
  const links = [...ctx.blocks.values()].flatMap(block => block.text?.elements || []).map(element => element.text_run.text_element_style?.link?.url).filter(Boolean);
  assert.ok(links.includes('http://data.prt-ai.cn:8001/?demo=' + demo.id));
  const blockCount = ctx.blocks.size;
  ctx.store.run('UPDATE versions SET description=? WHERE id=?', JSON.stringify({ title: '新名称', content: '# 数据概述\n概述乙\n# 数据格式\n格式乙', costEstimate: '成本乙', difficulty: '难度乙', notes: '' }), demo.versionId);
  ctx.wiki.enqueueForAsset(demo.id); await ctx.wiki.drain();
  content = ctx.documentText(); assert.equal(ctx.blocks.size, blockCount);
  for (const value of ['新名称', '概述乙', '格式乙', '成本乙', '难度乙', '人工补充：请保留']) assert.ok(content.includes(value), value);
  for (const value of ['概述甲', '格式甲', '成本甲', '难度甲', '注意甲', '简介内容']) assert.ok(!content.includes(value), value);
  const before = ctx.calls.length; ctx.wiki.enqueueForAsset(demo.id); await ctx.wiki.drain();
  assert.ok(!ctx.calls.slice(before).some(call => call.url.pathname.includes('/blocks/')));
});

test('wiki aggregates uploaded Demos, uses the latest usable version and clears content after file removal or unbinding', async t => {
  const ctx = fixture(t), uploaded = ctx.demo({ title: '第一份 Demo', content: '已发布版本说明' }, 'published');
  const unuploaded = ctx.demo({ title: '尚未上传的 Demo', content: '不能提前出现' }, 'draft', false);
  const another = ctx.demo({ title: '第二份 Demo', content: '第二份说明' });
  ctx.wiki.enqueue(ctx.id); await ctx.wiki.drain();
  assert.ok(ctx.documentText().includes('第一份 Demo')); assert.ok(ctx.documentText().includes('第二份 Demo')); assert.ok(!ctx.documentText().includes('尚未上传的 Demo'));
  const newVersion = uid();
  ctx.store.run('INSERT INTO versions(id,asset_id,number,status,description,creator_id,created_at,updated_at) VALUES(?,?,2,?,?,?,?,?)', newVersion, uploaded.id, 'draft', JSON.stringify({ title: '第一份 Demo V2', content: '新版说明' }), 'preview-employee', now(), now());
  ctx.wiki.enqueueForAsset(uploaded.id); await ctx.wiki.drain();
  assert.ok(!ctx.documentText().includes('新版说明'));
  ctx.store.run('INSERT INTO version_files VALUES(?,?)', newVersion, uploaded.fileId);
  ctx.wiki.enqueueForAsset(uploaded.id); await ctx.wiki.drain();
  assert.ok(ctx.documentText().includes('新版说明')); assert.ok(!ctx.documentText().includes('已发布版本说明'));
  ctx.store.run("UPDATE versions SET status='offline' WHERE id=?", newVersion);
  ctx.wiki.enqueueForAsset(uploaded.id); await ctx.wiki.drain();
  assert.ok(!ctx.documentText().includes('新版说明')); assert.ok(ctx.documentText().includes('已发布版本说明'));
  ctx.store.run('DELETE FROM version_files WHERE version_id=?', uploaded.versionId);
  ctx.store.run('DELETE FROM asset_requirements WHERE asset_id=?', another.id); ctx.wiki.enqueueExisting(ctx.id);
  await ctx.wiki.drain();
  assert.ok(!ctx.documentText().includes('第二份说明')); assert.ok(!ctx.documentText().includes('已发布版本说明')); assert.ok(ctx.documentText().includes('暂无包含文件的关联 Demo'));
  assert.equal(ctx.wiki.info(ctx.id).status, 'synced'); assert.ok(unuploaded.id);
});

test('wiki persists Demo append requests across restarts and retries without duplicate content, even if the saved description changes', async t => {
  const ctx = fixture(t); ctx.wiki.enqueue(ctx.id); await ctx.wiki.drain();
  const demo = ctx.demo({ title: '恢复测试 Demo', content: '中断前说明' });
  ctx.controls.loseBlocks = 1; ctx.wiki.enqueueForAsset(demo.id); await ctx.wiki.drain();
  const blockCount = ctx.blocks.size;
  assert.equal(ctx.job().status, 'pending'); assert.ok(ctx.store.one('SELECT pending_content FROM requirement_wiki_demo_content').pending_content);
  ctx.store.run('UPDATE versions SET description=? WHERE id=?', JSON.stringify({ title: '恢复测试 Demo', content: '中断后最新说明' }), demo.versionId);
  ctx.store.db.close(); ctx.store = openStore(ctx.root); ctx.wiki = createRequirementWiki(ctx.store, ctx.config);
  ctx.ready(); await ctx.wiki.drain();
  assert.equal(ctx.blocks.size, blockCount); assert.equal(ctx.nodes.length, 1); assert.equal(ctx.job().status, 'synced');
  assert.ok(ctx.documentText().includes('中断后最新说明')); assert.ok(!ctx.documentText().includes('中断前说明'));
  assert.equal([...ctx.blocks.values()].filter(block => block.heading2?.elements?.[0]?.text_run.content === 'Demo 内容（平台自动同步）').length, 1);
});

test('wiki splits long saved descriptions into API-sized blocks and batches while preserving all content', async t => {
  const ctx = fixture(t), long = '长段落🙂'.repeat(4000);
  for (let index = 0; index < 10; index++) ctx.demo({ title: '长说明 Demo ' + index, content: long, costEstimate: '完整成本', difficulty: '完整难度', notes: '完整注意事项' });
  ctx.wiki.enqueue(ctx.id); await ctx.wiki.drain();
  assert.equal(ctx.job().status, 'synced');
  const append = ctx.calls.filter(call => call.method === 'POST' && call.url.pathname.endsWith('/children') && !call.body.index);
  assert.ok(append.length >= 2);
  for (const block of ctx.blocks.values()) for (const element of (block.text || block.heading2)?.elements || []) assert.ok(Array.from(element.text_run.content).length <= 1000);
  const unbroken = [...ctx.blocks.values()].flatMap(block => (block.text || block.heading2)?.elements || []).map(element => element.text_run.content).join('');
  assert.equal(unbroken.split('长段落🙂').length - 1, 40000);
  assert.ok(ctx.documentText().includes('长说明 Demo 9'));
});

test('export preparation creates the missing historical wiki, copies saved Demo sections and later refreshes the same document', async t => {
  const ctx = fixture(t), exports = createRequirementExports(ctx.store, ctx.wiki);
  const demo = ctx.demo({ title: '旧数据 Demo', content: '# 数据概述\n旧数据概述\n# 数据格式\n旧数据格式', costEstimate: '旧数据成本', difficulty: '旧数据难度', notes: '旧数据注意事项' });
  const selected = [{ id: ctx.id, title: '历史需求', rows: [{ deadlineDate: '', demoName: '旧数据 Demo', associatedPeople: '负责人', documentUrl: '' }] }];
  assert.equal(ctx.wiki.info(ctx.id).status, 'not_created'); assert.equal(ctx.wiki.configurationError(), '');
  const job = exports.create('preview-pm', { status: 'open' }, selected);
  assert.equal(job.status, 'pending'); assert.equal(ctx.calls.length, 0);
  await ctx.wiki.drain();
  assert.equal(exports.status(job.id, 'preview-pm').status, 'ready');
  assert.equal(exports.rows(job.id, 'preview-pm')[0].documentUrl, 'https://team.feishu.cn/wiki/Wiki1');
  for (const value of ['旧数据概述', '旧数据格式', '旧数据成本', '旧数据难度', '旧数据注意事项']) assert.ok(ctx.documentText().includes(value));
  const blockCount = ctx.blocks.size;
  ctx.store.run('UPDATE versions SET description=? WHERE id=?', JSON.stringify({ title: '旧数据 Demo', content: '# 数据概述\n更新概述\n# 数据格式\n更新格式', costEstimate: '更新成本', difficulty: '更新难度', notes: '更新注意事项' }), demo.versionId);
  const again = exports.create('preview-pm', { status: 'open' }, selected);
  await ctx.wiki.drain();
  assert.equal(exports.status(again.id, 'preview-pm').status, 'ready');
  assert.equal(ctx.nodes.length, 1); assert.equal(ctx.blocks.size, blockCount);
  for (const value of ['更新概述', '更新格式', '更新成本', '更新难度', '更新注意事项']) assert.ok(ctx.documentText().includes(value));
  assert.ok(!ctx.documentText().includes('旧数据注意事项'));
});
