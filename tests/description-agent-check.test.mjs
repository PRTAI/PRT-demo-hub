import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/check-description-agent.mjs', import.meta.url));

for (const limited of [false, true]) test(`model self-check exercises both model features with ${limited ? 'configured' : 'unset'} token limits and hides its API key`, async t => {
  let requestPath = '', requestBody, authorization = '';
  const requests = [];
  const markdown = '# 数据概述\n\n两行合成样例，用于自检。\n\n# 数据格式\n\n```text\nsample.csv  # 样例数据\n```';
  const server = createServer(async (request, response) => {
    requestPath = request.url; authorization = request.headers.authorization;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(requestBody);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const message = requestBody.messages[0].role === 'user' ? { role: 'assistant', content: JSON.stringify({ markdown }) } : requestBody.messages.some(item => item.role === 'tool') ? { role: 'assistant', content: '销售分析样例 [1]。' } : { role: 'assistant', content: null, tool_calls: [{ id: 'self-check-search', type: 'function', function: { name: 'search_demos', arguments: JSON.stringify({ query: '销售分析' }) } }] };
    response.end(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { stdout, stderr } = await execute(process.execPath, [script, '--all'], {
    timeout: 5000,
    env: { ...process.env, DEEPSEEK_API_KEY: 'self-check-test-secret', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}/compatible-mode/v1`, DEEPSEEK_MODEL: 'deepseek-v4-pro', DEEPSEEK_ENABLE_THINKING: 'false', DESCRIPTION_AGENT_MAX_TOKENS: limited ? '8192' : '', RAG_LLM_MAX_TOKENS: limited ? '4096' : '' }
  });
  assert.equal(requestPath, '/compatible-mode/v1/chat/completions');
  assert.equal(authorization, 'Bearer self-check-test-secret');
  assert.equal(requestBody.model, 'deepseek-v4-pro');
  assert.equal(requests[0].enable_thinking, false);
  assert.match(requests[0].messages[0].content, /1,sample,10/);
  assert.equal(requests.length, 3);
  if (limited) assert.deepEqual(requests.map(body => body.max_tokens), [8192, 4096, 4096]);
  else assert.ok(requests.every(body => !Object.hasOwn(body, 'max_tokens')));
  assert.ok(requests.every(body => body.model === 'deepseek-v4-pro'));
  assert.deepEqual(requests[1].thinking, { type: 'disabled' });
  assert.ok(requests[2].messages.some(message => message.role === 'tool'));
  assert.match(stdout, /自检成功/); assert.match(stdout, /deepseek-v4-pro/); assert.match(stdout, /思考模式：false/);
  assert.match(stdout, /智能检索自检成功/);
  assert.match(stdout, limited ? /输出额度：8192 tokens/ : /输出额度：未设置（不发送 max_tokens，使用模型服务默认值）/);
  assert.match(stdout, limited ? /智能检索输出额度：4096 tokens/ : /智能检索输出额度：未设置/);
  assert.equal((stdout + stderr).includes('self-check-test-secret'), false);
});

test('description self-check identifies missing deployment configuration', async () => {
  await assert.rejects(execute(process.execPath, [script], {
    timeout: 5000,
    env: { ...process.env, DEEPSEEK_API_KEY: '', DESCRIPTION_AGENT_API_KEY: 'legacy-key-must-not-be-used', DASHSCOPE_API_KEY: 'legacy-key-must-not-be-used' }
  }), error => error.code === 1 && /缺少配置：DEEPSEEK_API_KEY/.test(error.stderr) && /--env-file=.env.host/.test(error.stderr));
});
