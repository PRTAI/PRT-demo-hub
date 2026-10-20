import { feishuDocumentLink } from '../shared/requirement-links.mjs';

export async function previewFeishuDocument(url, userToken, fetcher = fetch) {
  const link = feishuDocumentLink(url);
  if (!link) throw new Error('仅支持飞书云文档链接');
  const fallback = { url, title: '飞书云文档', excerpt: '', available: false, message: '请在飞书中打开文档。预览需要当前账号的文档访问权限及应用文档读取权限。' };
  if (!userToken) return { ...fallback, message: '请重新进行飞书登录后预览；文档链接仍可直接打开。' };
  const signal = AbortSignal.timeout(8000);
  const get = async endpoint => {
    const response = await fetcher('https://open.feishu.cn/open-apis/' + endpoint, { headers: { Authorization: `Bearer ${userToken}` }, signal, redirect: 'error' });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error('文档暂不可预览');
    return payload.data;
  };
  try {
    let token = link.token, type = link.type, title = '';
    if (type === 'wiki') {
      const result = await get('wiki/v2/spaces/get_node?token=' + encodeURIComponent(token));
      token = result.node.obj_token; type = result.node.obj_type; title = result.node.title || '';
    }
    if (type !== 'docx' || !/^[a-zA-Z0-9]+$/.test(token)) return { ...fallback, title: title || fallback.title };
    const document = await get('docx/v1/documents/' + token);
    title = document.document?.title || title;
    const content = await get('docx/v1/documents/' + token + '/raw_content');
    return { url, title: title || '飞书云文档', excerpt: String(content.content || '').slice(0, 700), available: true };
  } catch { return fallback; }
}
