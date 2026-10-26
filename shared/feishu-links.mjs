export function safeFeishuAppLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && /(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname) ? url.href : '';
  } catch { return ''; }
}
