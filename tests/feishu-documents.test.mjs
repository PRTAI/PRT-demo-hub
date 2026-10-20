import test from 'node:test';
import assert from 'node:assert/strict';
import { feishuDocumentLink, textLinks } from '../shared/requirement-links.mjs';
import { previewFeishuDocument } from '../server/feishu-documents.mjs';

test('requirement links strip punctuation and only recognize genuine Feishu document hosts', () => {
  assert.deepEqual(textLinks('查看 https://team.feishu.cn/wiki/TestToken。\n重复 https://team.feishu.cn/wiki/TestToken，参考 https://example.com/info。'), ['https://team.feishu.cn/wiki/TestToken', 'https://example.com/info']);
  assert.equal(feishuDocumentLink('https://team.feishu.cn/wiki/TestToken?from=copy').token, 'TestToken');
  for (const url of ['http://team.feishu.cn/wiki/Test', 'https://feishu.cn.evil.org/docx/Test', 'https://user:secret@team.feishu.cn/docx/Test', 'https://team.feishu.cn:8080/docx/Test', 'https://127.0.0.1/docx/Test', 'https://team.feishu.cn/docx/../../secret']) assert.equal(feishuDocumentLink(url), null);
});

test('Feishu preview uses the current user token and fixed official endpoints for wiki and document excerpt', async () => {
  const calls = [];
  const result = await previewFeishuDocument('https://team.feishu.cn/wiki/WikiToken', 'user-token', async (url, options) => {
    calls.push(url); assert.equal(options.headers.Authorization, 'Bearer user-token'); assert.equal(options.redirect, 'error');
    const data = url.includes('get_node') ? { node: { obj_type: 'docx', obj_token: 'DocToken', title: '需求背景' } } : url.endsWith('/raw_content') ? { content: '合成需求内容'.repeat(200) } : { document: { title: '验收要求' } };
    return { ok: true, json: async () => ({ code: 0, data }) };
  });
  assert.equal(result.available, true); assert.equal(result.title, '验收要求'); assert.equal(result.excerpt.length, 700);
  assert.equal(calls.length, 3); assert.ok(calls.every(url => url.startsWith('https://open.feishu.cn/open-apis/')));
});

test('unavailable authorization and API errors return a link card without leaking API content or tokens', async () => {
  const url = 'https://team.feishu.cn/docx/DocToken';
  assert.equal((await previewFeishuDocument(url, null, () => { throw new Error('must not call'); })).available, false);
  const result = await previewFeishuDocument(url, 'secret-token', async () => ({ ok: false, json: async () => ({ code: 999, msg: 'secret-token confidential' }) }));
  assert.equal(result.available, false); assert.equal(result.excerpt, ''); assert.ok(!JSON.stringify(result).includes('secret-token'));
  await assert.rejects(previewFeishuDocument('http://127.0.0.1/internal', 'token'), /仅支持/);
});
