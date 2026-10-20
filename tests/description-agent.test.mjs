import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDescriptionAgent, descriptionAgentConnection } from '../server/description-agent.mjs';

const markdown = '# 数据概述\n\n这是一份测试数据。\n\n# 数据格式\n\n```text\ndata.csv  # 数据文件\n```';
const defaults = { descriptionAgentKey: 'test-key', descriptionAgentUrl: 'https://agent.test', descriptionAgentModel: 'test-model' };
const success = () => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ markdown }) }] }));
const agent = (options = {}, root = os.tmpdir()) => createDescriptionAgent({ ...defaults, ...options }, { root });

test('description API normalizes root, versioned and full endpoint URLs', async () => {
  for (const base of ['https://agent.test', 'https://agent.test/v1', 'https://agent.test/v1/', 'https://agent.test/v1/messages/']) {
    const generate = agent({ descriptionAgentUrl: base, descriptionAgentFetch: async (url, options) => {
      assert.equal(url, 'https://agent.test/v1/messages');
      assert.equal(options.headers['x-api-key'], 'test-key');
      assert.equal(options.headers.authorization, 'Bearer test-key');
      assert.equal(JSON.parse(options.body).model, 'test-model');
      assert.equal(Object.hasOwn(JSON.parse(options.body), 'max_tokens'), false);
      return success();
    } });
    assert.deepEqual(await generate([]), { markdown });
  }
});

test('description API sends the selected chat completions protocol to its correct endpoint', async () => {
  for (const base of ['https://agent.test/compatible-mode', 'https://agent.test/compatible-mode/v1/', 'https://agent.test/compatible-mode/v1/chat/completions']) {
    const generate = agent({ descriptionAgentUrl: base, descriptionAgentApiFormat: 'openai', descriptionAgentFetch: async (url, options) => {
      assert.equal(url, 'https://agent.test/compatible-mode/v1/chat/completions');
      assert.equal(options.headers['x-api-key'], undefined);
      return new Response(JSON.stringify({ choices: [{ message: { content: markdown } }] }));
    } });
    assert.deepEqual(await generate([]), { markdown });
  }
});

test('description API detects Aliyun chat endpoints without overriding Anthropic paths or explicit protocols', () => {
  for (const base of ['https://dashscope.aliyuncs.com', 'https://dashscope.aliyuncs.com/v1', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', 'https://workspace.cn-beijing.maas.aliyuncs.com', 'https://coding.dashscope.aliyuncs.com/v1']) {
    const connection = descriptionAgentConnection({ descriptionAgentUrl: base });
    assert.equal(connection.format, 'openai');
    assert.ok(connection.endpoint.endsWith('/v1/chat/completions'));
    if (!base.includes('coding.')) assert.ok(connection.endpoint.includes('/compatible-mode/v1/'));
  }
  assert.deepEqual(descriptionAgentConnection({ descriptionAgentUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' }), { format: 'anthropic', endpoint: 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages' });
  assert.equal(descriptionAgentConnection({ descriptionAgentUrl: 'https://agent.test/v1/chat/completions' }).format, 'openai');
  assert.equal(descriptionAgentConnection({ descriptionAgentUrl: 'https://agent.test' }).format, 'anthropic');
  assert.equal(descriptionAgentConnection({ descriptionAgentUrl: 'https://dashscope.aliyuncs.com', descriptionAgentApiFormat: 'anthropic' }).format, 'anthropic');
});

test('Qwen requests carry an explicit thinking option only when configured for chat completions', async () => {
  for (const thinking of [undefined, '', false, 'false', true, 'true']) {
    const generate = agent({ descriptionAgentUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', descriptionAgentModel: 'qwen-plus', descriptionAgentEnableThinking: thinking, descriptionAgentFetch: async (url, options) => {
      assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
      const body = JSON.parse(options.body);
      if (thinking === undefined || thinking === '') assert.equal(Object.hasOwn(body, 'enable_thinking'), false);
      else assert.equal(body.enable_thinking, thinking === true || thinking === 'true');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ markdown }) } }] }));
    } });
    assert.deepEqual(await generate([]), { markdown });
  }
  const generate = agent({ descriptionAgentEnableThinking: 'false', descriptionAgentFetch: async (_url, options) => {
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'enable_thinking'), false);
    assert.deepEqual(JSON.parse(options.body).thinking, { type: 'disabled' });
    return success();
  } });
  await generate([]);
});

test('DeepSeek official endpoints default to chat completions and use the native thinking toggle', async () => {
  for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions']) {
    const connection = descriptionAgentConnection({ descriptionAgentUrl: base });
    assert.equal(connection.format, 'openai');
    assert.equal(connection.endpoint, base.includes('/v1') ? 'https://api.deepseek.com/v1/chat/completions' : 'https://api.deepseek.com/chat/completions');
  }
  assert.deepEqual(descriptionAgentConnection({ descriptionAgentUrl: 'https://api.deepseek.com/anthropic' }), { format: 'anthropic', endpoint: 'https://api.deepseek.com/anthropic/v1/messages' });
  for (const thinking of [undefined, '', false, 'false', true, 'true']) {
    const generate = agent({ descriptionAgentUrl: 'https://api.deepseek.com', descriptionAgentModel: 'deepseek-flash', descriptionAgentEnableThinking: thinking, descriptionAgentFetch: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(options.headers.authorization, 'Bearer test-key');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'deepseek-flash');
      assert.equal(Object.hasOwn(body, 'enable_thinking'), false);
      if (thinking === undefined || thinking === '') assert.equal(Object.hasOwn(body, 'thinking'), false);
      else assert.deepEqual(body.thinking, { type: thinking === true || thinking === 'true' ? 'enabled' : 'disabled' });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ markdown }) }, finish_reason: 'stop' }] }));
    } });
    assert.deepEqual(await generate([]), { markdown });
  }
});

test('description API omits the output cap when unset or blank', async () => {
  for (const budget of [undefined, null, '', '   ']) {
    const generate = agent({ descriptionAgentUrl: 'https://api.deepseek.com', descriptionAgentMaxTokens: budget, descriptionAgentFetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(Object.hasOwn(body, 'max_tokens'), false);
      assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
      return new Response(JSON.stringify({ choices: [{ message: { content: markdown }, finish_reason: 'stop' }] }));
    } });
    assert.deepEqual(await generate([]), { markdown });
  }
});

test('description API applies the configured output budget and rejects invalid budgets before requesting', async () => {
  const generate = agent({ descriptionAgentMaxTokens: '16384', descriptionAgentFetch: async (_url, options) => {
    assert.equal(JSON.parse(options.body).max_tokens, 16384);
    return success();
  } });
  await generate([]);
  for (const budget of [0, -1, 1000, 32769, 8192.5, 'invalid']) {
    let requested = false;
    await assert.rejects(agent({ descriptionAgentMaxTokens: budget, descriptionAgentFetch: async () => { requested = true; return success(); } })([]), /DESCRIPTION_AGENT_MAX_TOKENS/);
    assert.equal(requested, false);
  }
});

test('description API retries transient service and network failures once', async () => {
  for (const failure of [() => new Response('{}', { status: 503 }), () => new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }), () => { throw new TypeError('fetch failed'); }]) {
    let calls = 0;
    const generate = agent({ descriptionAgentFetch: async () => { calls++; return calls === 1 ? failure() : success(); } });
    assert.deepEqual(await generate([]), { markdown });
    assert.equal(calls, 2);
  }
});

test('description API does not retry authentication errors or exceed the retry limit', async () => {
  for (const status of [401, 403, 404, 400, 503]) {
    let calls = 0;
    const generate = agent({ descriptionAgentFetch: async () => { calls++; return new Response('{}', { status }); } });
    await assert.rejects(generate([]), new RegExp(`HTTP ${status}`));
    assert.equal(calls, status === 503 ? 2 : 1);
  }
});

test('description API respects Retry-After when it exceeds the remaining job deadline', async () => {
  let calls = 0;
  const generate = agent({ descriptionAgentTimeoutMs: 500, descriptionAgentFetch: async () => {
    calls++; return new Response('{}', { status: 429, headers: { 'Retry-After': '120' } });
  } });
  await assert.rejects(generate([]), /HTTP 429/);
  assert.equal(calls, 1);
});

test('request timeout includes a stalled response body and aborts both attempts', async () => {
  const signals = [];
  const generate = agent({ descriptionAgentRequestTimeoutMs: 20, descriptionAgentTimeoutMs: 2000, descriptionAgentFetch: async (_url, options) => {
    signals.push(options.signal);
    return { ok: true, json: () => new Promise(() => {}) };
  } });
  await assert.rejects(generate([]), /模型响应超时/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
});

test('total deadline aborts an unresponsive request and an injected runner', async () => {
  let requestSignal, runnerSignal;
  const generate = agent({ descriptionAgentTimeoutMs: 50, descriptionAgentFetch: (_url, options) => {
    requestSignal = options.signal; return new Promise(() => {});
  } });
  await assert.rejects(generate([]), /数据说明生成超时/);
  assert.equal(requestSignal.aborted, true);
  const run = agent({ descriptionAgentTimeoutMs: 50, descriptionAgentRunner: ({ signal }) => {
    runnerSignal = signal; return new Promise(() => {});
  } });
  await assert.rejects(run([]), /数据说明生成超时/);
  assert.equal(runnerSignal.aborted, true);
});

test('description API rejects truncated or incomplete content', async () => {
  for (const payload of [{ content: [{ type: 'text', text: markdown }], stop_reason: 'max_tokens' }, { choices: [{ message: { content: markdown }, finish_reason: 'length' }] }, { content: [{ type: 'text', text: '不完整的说明' }] }]) {
    const generate = agent({ descriptionAgentFetch: async () => new Response(JSON.stringify(payload)) });
    await assert.rejects(generate([]), /被截断|返回内容不完整/);
  }
});

test('description truncation errors distinguish provider defaults from an explicit output cap', async () => {
  for (const budget of [undefined, 8192]) {
    const generate = agent({ descriptionAgentMaxTokens: budget, descriptionAgentFetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: markdown }, finish_reason: 'length' }] })) });
    await assert.rejects(generate([]), error => {
      assert.match(error.message, budget === undefined ? /模型服务默认值/ : /max_tokens=8192/);
      assert.match(error.message, /本次结果未保存/);
      assert.ok(!error.message.includes('undefined'));
      return true;
    });
  }
});

test('inventory has a shared size budget and samples large text files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '.prt-description-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'files'));
  const files = Array.from({ length: 20 }, (_, index) => {
    const content = 'id,value\n' + '1,example\n'.repeat(index === 0 ? 120000 : 500);
    fs.writeFileSync(path.join(root, 'files', `file-${index}`), content);
    return { id: `file-${index}`, name: `data-${index}.csv`, size: Buffer.byteLength(content) };
  });
  let prompt = '';
  const generate = agent({ descriptionAgentRunner: async input => { prompt = input.prompt; return { markdown }; } }, root);
  await generate(files);
  assert.match(prompt, /文件片段 data-0.csv/);
  assert.match(prompt, /id,value/);
  assert.match(prompt, /上传文件：data-19.csv/);
  assert.ok(prompt.length < 32000);
});
