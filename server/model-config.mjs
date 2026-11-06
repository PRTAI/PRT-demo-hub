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
  const opsEffort = environment.OPS_REASONING_EFFORT?.trim() || 'max';
  if (!['true', 'false'].includes(thinking)) throw new Error('DEEPSEEK_ENABLE_THINKING 必须为 true 或 false');
  if (!['low', 'high', 'max'].includes(opsEffort)) throw new Error('OPS_REASONING_EFFORT 必须为 low、high 或 max');
  return {
    llmApiKey: apiKey, llmBaseUrl: baseUrl, llmModel: model, llmEnableThinking: thinking === 'true',
    llmMaxTokens: optionalMaxTokens(environment.RAG_LLM_MAX_TOKENS, 'RAG_LLM_MAX_TOKENS'),
    llmRequestTimeoutMs: environment.RAG_LLM_REQUEST_TIMEOUT_MS || 90000,
    descriptionAgentKey: apiKey, descriptionAgentUrl: baseUrl, descriptionAgentModel: model,
    descriptionAgentTransport: 'api', descriptionAgentApiFormat: 'openai', descriptionAgentEnableThinking: thinking === 'true',
    descriptionAgentMaxTokens: optionalMaxTokens(environment.DESCRIPTION_AGENT_MAX_TOKENS, 'DESCRIPTION_AGENT_MAX_TOKENS'),
    descriptionAgentTimeoutMs: environment.DESCRIPTION_AGENT_TIMEOUT_MS || 180000,
    descriptionAgentRequestTimeoutMs: environment.DESCRIPTION_AGENT_REQUEST_TIMEOUT_MS || 90000,
    opsEnabled: environment.OPS_ENABLED === 'true',
    opsWorkerUrl: environment.OPS_WORKER_URL || '', opsWorkerToken: environment.OPS_WORKER_TOKEN || '',
    opsSourceDir: environment.OPS_SOURCE_DIR || '', opsBackupDir: environment.OPS_BACKUP_DIR || '',
    opsGithubToken: environment.OPS_GITHUB_TOKEN || '', opsGithubRepository: environment.OPS_GITHUB_REPOSITORY || 'PRTAI/PRT-demo-hub',
    opsGithubBranch: environment.OPS_GITHUB_BRANCH || 'feature/deepseek', opsGithubBaseBranch: environment.OPS_GITHUB_BASE_BRANCH || 'main',
    opsReasoningEffort: opsEffort,
    opsMaxTokens: optionalMaxTokens(environment.OPS_MAX_TOKENS, 'OPS_MAX_TOKENS'),
    opsAgentTimeoutMs: environment.OPS_AGENT_TIMEOUT_MS || 1800000,
    opsRequestTimeoutMs: environment.OPS_REQUEST_TIMEOUT_MS || 300000
  };
}
