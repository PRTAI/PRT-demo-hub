export function textLinks(text) {
  return [...new Set((String(text || '').match(/https?:\/\/[^\s<>"'\u3000，。；、！？）】》]+/g) || []).map(value => value.replace(/[。；，、！？）】》.,;!?)\]]+$/u, '')).filter(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  }))];
}

export function feishuDocumentLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/(wiki|docx|docs)\/([a-zA-Z0-9]+)\/?$/);
    return match ? { type: match[1], token: match[2], url: url.href, host: url.hostname } : null;
  } catch { return null; }
}
