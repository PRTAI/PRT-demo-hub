import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequirementWiki } from '../scripts/check-requirement-wiki.mjs';
import { wikiApiError, createWikiApi } from '../server/feishu-wiki-api.mjs';

test('wiki API permission errors name each operation without returning raw provider messages or secrets', () => {
  for (const [resource, method, label] of [
    ['auth/v3/tenant_access_token/internal', 'POST', '获取应用访问凭证'],
    ['wiki/v2/spaces/get_node?token=private', 'GET', '读取 sample 知识库节点'],
    ['wiki/v2/spaces/Space/nodes', 'GET', '读取知识库目录'],
    ['wiki/v2/spaces/Space/nodes', 'POST', '创建知识库文档'],
    ['wiki/v2/spaces/Space/nodes/Node/update_title', 'POST', '更新知识库文档标题'],
    ['docx/v1/documents/Doc/blocks/Doc/children', 'POST', '写入新版文档内容'],
    ['drive/v1/permissions/Node/members', 'GET', '读取文档协作者'],
    ['drive/v1/permissions/Node/members', 'POST', '管理文档协作者']
  ]) {
    const error = wikiApiError(resource, method, { code: 99991672, msg: 'Bearer secret-private', error: { permission_violations: [{ subject: 'docx:document' }, { subject: 'docx:document' }, { subject: 'secret-private' }] } }, 403);
    assert.ok(error.message.includes(label)); assert.match(error.message, /docx:document/);
    assert.ok(!error.message.includes('secret-private')); assert.ok(!error.message.includes('token=private'));
    assert.equal(error.retryable, false);
  }
  const transient = wikiApiError('wiki/v2/spaces/get_node', 'GET', { code: 99991400, msg: 'sensitive' }, 429);
  assert.match(transient.message, /99991400/); assert.equal(transient.retryable, true);
  assert.doesNotThrow(() => wikiApiError('wiki/', 'GET', { code: 99991672, error: { permission_violations: {} } }, 403));
});

test('wiki self-check uses application credentials for read-only probes and never creates documents or changes permissions', async () => {
  const calls = [], reports = [];
  const config = { appId: 'cli_test', appSecret: 'secret-private', requirementWikiSampleUrl: 'https://team.feishu.cn/wiki/Sample', wikiFetch: async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    assert.equal(url.origin, 'https://open.feishu.cn'); assert.equal(options.redirect, 'error');
    if (url.pathname.includes('tenant_access_token')) {
      assert.equal(options.method, 'POST'); assert.equal(JSON.parse(options.body).app_secret, 'secret-private');
      return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'token-private' }) };
    }
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, 'Bearer token-private');
    return { ok: true, json: async () => ({ code: 0, data: url.pathname.endsWith('get_node') ? { node: { space_id: 'Space', node_token: 'Sample', parent_node_token: 'Parent', obj_type: 'docx', obj_token: 'Doc' } } : {} }) };
  } };
  await checkRequirementWiki(config, line => reports.push(line));
  assert.equal(calls.length, 5); assert.ok(calls.some(call => call.url.searchParams.get('parent_node_token') === 'Parent'));
  assert.ok(calls.some(call => call.url.pathname.endsWith('/members')));
  assert.ok(reports.at(-1).includes('仍需')); assert.ok(!reports.join('\n').includes('private'));
  const count = calls.length;
  await assert.rejects(checkRequirementWiki({ ...config, requirementWikiSampleUrl: 'https://team.feishu.cn/docx/Doc' }), /FEISHU_REQUIREMENT_WIKI_SAMPLE_URL/);
  assert.equal(calls.length, count);
  await assert.rejects(createWikiApi({ ...config, appSecret: '' })('wiki/v2/spaces/get_node'), /未配置飞书应用凭据/);
});
