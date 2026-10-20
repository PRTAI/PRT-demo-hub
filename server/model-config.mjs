export function optionalMaxTokens(value, name) {
  if (value == null || typeof value === 'string' && !value.trim()) return undefined;
  const tokens = Number(value);
  if (!Number.isInteger(tokens) || tokens < 1024 || tokens > 32768) throw new Error(`${name} 必须留空或为 1024～32768 之间的整数，并符合模型限制`);
  return tokens;
}

export function readModelConfig(environment = process.env) {
  const apiKey = environment.DEEPSEEK_API_KEY?.trim() || '';
  const baseUrl = environment.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com';
  const model = environment.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro';
  const thinking = environment.DEEPSEEK_ENABLE_THINKING?.trim() || 'false';
  if (!['true', 'false'].includes(thinking)) throw new Error('DEEPSEEK_ENABLE_THINKING 必须为 true 或 false');
  return {
    llmApiKey: apiKey, llmBaseUrl: baseUrl, llmModel: model, llmEnableThinking: thinking === 'true',
    llmMaxTokens: optionalMaxTokens(environment.RAG_LLM_MAX_TOKENS, 'RAG_LLM_MAX_TOKENS'),
    llmRequestTimeoutMs: environment.RAG_LLM_REQUEST_TIMEOUT_MS || 90000,
    descriptionAgentKey: apiKey, descriptionAgentUrl: baseUrl, descriptionAgentModel: model,
    descriptionAgentTransport: 'api', descriptionAgentApiFormat: 'openai', descriptionAgentEnableThinking: thinking === 'true',
    descriptionAgentMaxTokens: optionalMaxTokens(environment.DESCRIPTION_AGENT_MAX_TOKENS, 'DESCRIPTION_AGENT_MAX_TOKENS'),
    descriptionAgentTimeoutMs: environment.DESCRIPTION_AGENT_TIMEOUT_MS || 180000,
    descriptionAgentRequestTimeoutMs: environment.DESCRIPTION_AGENT_REQUEST_TIMEOUT_MS || 90000
  };
}
