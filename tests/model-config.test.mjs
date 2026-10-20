import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelConfig } from '../server/model-config.mjs';
import { descriptionAgentConnection } from '../server/description-agent.mjs';

test('both model features share official DeepSeek Pro settings and ignore old provider settings', () => {
  const config = readModelConfig({ DEEPSEEK_API_KEY: 'official-test-key', DASHSCOPE_API_KEY: 'old-key', DASHSCOPE_BASE_URL: 'https://old.test', RAG_LLM_MODEL: 'qwen-plus', DESCRIPTION_AGENT_API_KEY: 'old-key', DESCRIPTION_AGENT_BASE_URL: 'https://old.test', DESCRIPTION_AGENT_MODEL: 'old-model', DESCRIPTION_AGENT_ENABLE_THINKING: 'true', DESCRIPTION_AGENT_TRANSPORT: 'cli' });
  assert.equal(config.llmApiKey, 'official-test-key');
  assert.equal(config.descriptionAgentKey, config.llmApiKey);
  assert.equal(config.llmBaseUrl, 'https://api.deepseek.com');
  assert.equal(config.descriptionAgentUrl, config.llmBaseUrl);
  assert.equal(config.llmModel, 'deepseek-v4-pro');
  assert.equal(config.descriptionAgentModel, config.llmModel);
  assert.equal(config.llmEnableThinking, false);
  assert.equal(config.descriptionAgentEnableThinking, false);
  assert.equal(config.descriptionAgentTransport, 'api');
  assert.equal(config.llmMaxTokens, undefined);
  assert.equal(config.descriptionAgentMaxTokens, undefined);
  assert.deepEqual(descriptionAgentConnection(config), { format: 'openai', endpoint: 'https://api.deepseek.com/chat/completions' });
  assert.equal(readModelConfig({ DESCRIPTION_AGENT_API_KEY: 'old-key' }).descriptionAgentKey, '');
});

test('shared DeepSeek configuration trims values and validates the thinking switch', () => {
  const config = readModelConfig({ DEEPSEEK_API_KEY: ' key ', DEEPSEEK_BASE_URL: ' https://api.deepseek.com/v1 ', DEEPSEEK_MODEL: ' deepseek-v4-pro ', DEEPSEEK_ENABLE_THINKING: 'true' });
  assert.equal(config.descriptionAgentKey, 'key');
  assert.equal(config.llmEnableThinking, true);
  assert.equal(config.descriptionAgentEnableThinking, true);
  assert.equal(descriptionAgentConnection(config).endpoint, 'https://api.deepseek.com/v1/chat/completions');
  assert.throws(() => readModelConfig({ DEEPSEEK_ENABLE_THINKING: 'invalid' }), /DEEPSEEK_ENABLE_THINKING/);
});

test('token limits default to unset and only explicit valid environment values set a cap', () => {
  for (const value of [undefined, null, '', '   ']) {
    const config = readModelConfig({ RAG_LLM_MAX_TOKENS: value, DESCRIPTION_AGENT_MAX_TOKENS: value });
    assert.equal(config.llmMaxTokens, undefined);
    assert.equal(config.descriptionAgentMaxTokens, undefined);
  }
  const configured = readModelConfig({ RAG_LLM_MAX_TOKENS: ' 4096 ', DESCRIPTION_AGENT_MAX_TOKENS: ' 16384 ' });
  assert.equal(configured.llmMaxTokens, 4096);
  assert.equal(configured.descriptionAgentMaxTokens, 16384);
  for (const name of ['RAG_LLM_MAX_TOKENS', 'DESCRIPTION_AGENT_MAX_TOKENS']) {
    for (const value of ['0', '-1', '1000', '32769', '8192.5', 'invalid']) assert.throws(() => readModelConfig({ [name]: value }), new RegExp(name));
  }
});
