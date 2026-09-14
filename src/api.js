let csrf = '';
export const setCsrf = value => { csrf = value; };
export class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
function failure(message, status) {
  if (status === 401) window.dispatchEvent(new Event('prt-session-expired'));
  return new ApiError(message, status);
}
export async function api(url, options = {}) {
  const response = await fetch('/api' + url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'PRT', 'X-CSRF-Token': csrf, ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw failure(data.error || '请求失败，请稍后重试', response.status);
  return data;
}
export async function streamApi(url, body, onEvent) {
  const response = await fetch('/api' + url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'PRT', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw failure(data.error || '请求失败，请稍后重试', response.status); }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done }); const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) if (line.trim()) onEvent(JSON.parse(line)); if (done) break; }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}
export function uploadFile(versionId, file, revision, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open('POST', `/api/versions/${versionId}/files`);
    request.setRequestHeader('X-Requested-With', 'PRT'); request.setRequestHeader('X-CSRF-Token', csrf); request.setRequestHeader('X-Revision', String(revision));
    request.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    request.onerror = () => reject(new Error('网络中断，文件上传失败，请重试'));
    request.onload = () => { let body; try { body = JSON.parse(request.responseText); } catch { body = {}; } if (request.status >= 200 && request.status < 300) resolve(body); else reject(failure(body.error || '文件上传失败', request.status)); };
    const data = new FormData(); data.append('file', file); request.send(data);
  });
}
