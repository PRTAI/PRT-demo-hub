function operation(resource, method) {
  if (resource.startsWith('auth/')) return '获取应用访问凭证';
  if (resource.startsWith('wiki/v2/spaces/get_node')) return '读取 sample 知识库节点';
  if (resource.includes('/update_title')) return '更新知识库文档标题';
  if (resource.startsWith('wiki/')) return method === 'GET' ? '读取知识库目录' : '创建知识库文档';
  if (resource.startsWith('docx/')) return method === 'GET' ? '读取新版文档' : '写入新版文档内容';
  if (resource.startsWith('drive/')) return method === 'GET' ? '读取文档协作者' : '管理文档协作者';
  return '访问飞书文档';
}

export function wikiApiError(resource, method, data, status) {
  const code = Number.isInteger(data?.code) && data.code !== 0 ? data.code : status;
  // Only return scope identifiers from structured violations, never raw API messages or credentials.
  const scopes = [...new Set((Array.isArray(data?.error?.permission_violations) ? data.error.permission_violations : [])
    .flatMap(item => typeof item?.subject === 'string' ? item.subject.match(/\b(?:wiki|docx|drive):[a-z][a-z0-9_:]{0,100}\b/g) || [] : []))].slice(0, 5);
  const denied = code === 99991672;
  const message = denied
    ? `飞书需求文档同步失败 (${code})：${operation(resource, method)}缺少应用身份 API 权限${scopes.length ? `（${scopes.join('、')}）` : ''}。请在同一飞书应用开通对应应用身份权限，发布版本并完成审批；个人云文档的用户授权不能替代。`
    : `飞书需求文档同步失败 (${code})：${operation(resource, method)}失败，请检查应用权限及知识库目录／文档的资源授权。`;
  const error = new Error(message);
  error.retryable = !denied;
  return error;
}

export function createWikiApi(config) {
  const call = config.wikiFetch || fetch;
  let token = '', expires = 0;
  async function tokenFor() {
    if (token && expires > Date.now()) return token;
    if (!config.appId || !config.appSecret) throw new Error('未配置飞书应用凭据');
    const resource = 'auth/v3/tenant_access_token/internal';
    const response = await call('https://open.feishu.cn/open-apis/' + resource, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }) });
    const data = await response.json();
    if (!response.ok || data.code !== 0) throw wikiApiError(resource, 'POST', data, response.status);
    if (!data.tenant_access_token) throw new Error('飞书文档应用鉴权未返回访问凭证');
    token = data.tenant_access_token; expires = Date.now() + Math.max(0, (data.expire || 7200) - 120) * 1000;
    return token;
  }
  return async function request(resource, method = 'GET', body) {
    const bearer = await tokenFor();
    const response = await call('https://open.feishu.cn/open-apis/' + resource, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || data.code !== 0) { token = ''; throw wikiApiError(resource, method, data, response.status); }
    return data.data || {};
  };
}
