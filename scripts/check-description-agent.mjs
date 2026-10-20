import { createDescriptionAgent, descriptionAgentConnection } from '../server/description-agent.mjs';
import { readModelConfig } from '../server/model-config.mjs';
import { createRagSearch } from '../server/rag.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root;
try {
  const config = readModelConfig();
  if (!config.descriptionAgentKey) throw new Error('缺少配置：DEEPSEEK_API_KEY。Docker 需在 .env 填写并重建容器；原生运行请通过 --env-file=.env.host 加载部署配置');
  const connection = descriptionAgentConnection(config);
  console.log(`模型：${config.descriptionAgentModel}`);
  console.log(`调用方式：${config.descriptionAgentTransport}；HTTP 协议：${connection.format}`);
  console.log(`HTTP 地址：${connection.endpoint}`);
  console.log(`思考模式：${config.descriptionAgentEnableThinking}`);
  console.log(`输出额度：${config.descriptionAgentMaxTokens === undefined ? '未设置（不发送 max_tokens，使用模型服务默认值）' : `${config.descriptionAgentMaxTokens} tokens`}`);
  console.log('使用内置的 2 行合成 CSV 验证生成接口。');
  root = fs.mkdtempSync(path.join(os.tmpdir(), '.prt-description-check-'));
  fs.mkdirSync(path.join(root, 'files'));
  const sample = 'id,category,value\n1,sample,10\n2,sample,20\n';
  fs.writeFileSync(path.join(root, 'files', 'sample'), sample);
  const startedAt = Date.now();
  const result = await createDescriptionAgent(config, { root })([{ id: 'sample', name: 'sample.csv', size: Buffer.byteLength(sample) }]);
  console.log(`自检成功，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒，生成 ${result.markdown.length} 字符。`);
  console.log(result.markdown);
  if (process.argv.includes('--all')) {
    console.log(`智能检索输出额度：${config.llmMaxTokens === undefined ? '未设置（不发送 max_tokens，使用模型服务默认值）' : `${config.llmMaxTokens} tokens`}`);
    console.log('正在使用合成 Demo 验证智能检索及工具调用。');
    const row = { id: 'sample-demo', owner_name: '自检样例', status: 'published', updated_at: new Date().toISOString(), description: JSON.stringify({ title: '销售分析样例', category: '通用数据', summary: '用于自检的两行合成销售数据', content: result.markdown }) };
    let toolUsed = false;
    const search = createRagSearch({ all: () => [row] }, config, { visible: () => true, descriptionFor: (_user, _asset, description) => description, summary: () => ({ id: row.id }) });
    const searchResult = await search({}, { question: '请检索用于销售分析的样例 Demo，列出匹配结果并引用来源。' }, event => { if (event.key?.startsWith('retrieve-')) toolUsed = true; });
    if (!searchResult.modelUsed) throw new Error(`智能检索自检失败：${searchResult.modelError}`);
    if (!toolUsed || !searchResult.sources.length) throw new Error('智能检索未完成工具调用或未引用合成样例，请重试自检');
    console.log(`智能检索自检成功，模型 ${config.llmModel}，已调用检索工具并返回 ${searchResult.sources.length} 个来源。`);
  }
} catch (error) {
  console.error(`自检失败：${error.message}`);
  process.exitCode = 1;
} finally {
  if (root) fs.rmSync(root, { recursive: true, force: true });
}
