import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { feishuDocumentLink } from '../shared/requirement-links.mjs';
import { createWikiApi } from '../server/feishu-wiki-api.mjs';

export async function checkRequirementWiki(config, report = console.log) {
  const sample = feishuDocumentLink(config.requirementWikiSampleUrl);
  if (sample?.type !== 'wiki') throw new Error('未配置有效的 FEISHU_REQUIREMENT_WIKI_SAMPLE_URL，请填写 sample 的飞书知识库链接');
  report('使用应用身份进行只读检查，不创建文档、不修改协作者。');
  const request = createWikiApi(config);
  const { node } = await request('wiki/v2/spaces/get_node?' + new URLSearchParams({ token: sample.token, obj_type: 'wiki' }));
  if (!node?.space_id || !node.node_token) throw new Error('飞书 sample 未返回知识库目录信息');
  report('通过：读取 sample 知识库节点');
  await request(`wiki/v2/spaces/${encodeURIComponent(node.space_id)}/nodes?` + new URLSearchParams({ page_size: '1', ...(node.parent_node_token ? { parent_node_token: node.parent_node_token } : {}) }));
  report('通过：读取 sample 同级目录');
  if (node.obj_type === 'docx' && node.obj_token) {
    await request(`docx/v1/documents/${encodeURIComponent(node.obj_token)}`);
    report('通过：读取 sample 新版文档');
  }
  await request(`drive/v1/permissions/${encodeURIComponent(node.node_token)}/members?type=wiki&perm_type=single_page`);
  report('通过：读取 sample 文档协作者');
  report('只读自检通过。创建节点、写入内容及增删协作者权限仍需在需求详情同步一条测试需求验证。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await checkRequirementWiki({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, requirementWikiSampleUrl: process.env.FEISHU_REQUIREMENT_WIKI_SAMPLE_URL });
  } catch (error) {
    console.error(`自检失败：${/^(飞书|未配置)/.test(error.message) ? error.message : '飞书网络请求失败，请检查服务器到 open.feishu.cn 的连接'}`);
    process.exitCode = 1;
  }
}
