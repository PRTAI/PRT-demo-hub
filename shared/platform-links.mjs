const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function platformPath({ requirementId = '', demoId = '' } = {}) {
  const query = new URLSearchParams();
  if (uuid.test(requirementId)) { query.set('view', 'requirements'); query.set('requirement', requirementId); }
  if (uuid.test(demoId)) query.set('demo', demoId);
  return query.size ? '/?' + query : '/';
}

export function platformLink(origin, target) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('平台访问地址必须是有效的 HTTP 或 HTTPS 地址');
  return new URL(platformPath(target), url.origin).href;
}
