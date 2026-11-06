import { validateSourceSnapshot, corePath } from './ops-source.mjs';

export async function pushCoreToGithub(snapshot, { token, repository = 'PRTAI/PRT-demo-hub', branch = 'feature/deepseek', baseBranch = 'main', fetch: call = fetch } = {}) {
  validateSourceSnapshot(snapshot);
  if (!token) throw new Error('未配置 OPS_GITHUB_TOKEN，备份已保留，GitHub 提交等待配置后重试');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w][\w/.-]*$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch === baseBranch) throw new Error('GitHub 仓库或运维分支配置无效，运维分支不能与主分支相同');
  const root = `https://api.github.com/repos/${repository}`;
  async function api(route, body, { missing = false } = {}) {
    const response = await call(root + route, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'PRT-DeepSeek-Ops', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${response.status}：请检查仓库权限、分支保护及网络；未强制覆盖远程代码`);
    return response.json();
  }
  const refRoute = '/git/ref/heads/' + encodeURIComponent(branch);
  let ref = await api(refRoute, null, { missing: true });
  if (!ref) {
    const base = await api('/git/ref/heads/' + encodeURIComponent(baseBranch));
    ref = await api('/git/refs', { ref: 'refs/heads/' + branch, sha: base.object.sha });
  }
  const parent = await api('/git/commits/' + ref.object.sha);
  const marker = `PRT deployed source: ${snapshot.hash}`;
  if (parent.message.includes(marker)) return { sha: parent.sha, branch, repository, unchanged: true };
  const existing = await api('/git/trees/' + parent.tree.sha + '?recursive=1');
  if (existing.truncated) throw new Error('GitHub 源码树不完整，停止提交');
  const paths = new Set(snapshot.files.map(file => file.path)), tree = [];
  for (const file of snapshot.files) {
    const blob = await api('/git/blobs', { encoding: 'base64', content: file.content });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const item of existing.tree) if (item.type === 'blob' && corePath(item.path) && !paths.has(item.path)) tree.push({ path: item.path, mode: item.mode, type: 'blob', sha: null });
  const created = await api('/git/trees', { base_tree: parent.tree.sha, tree });
  if (created.sha === parent.tree.sha) return { sha: parent.sha, branch, repository, unchanged: true };
  const commit = await api('/git/commits', { message: `chore(ops): archive deployed platform source\n\n${marker}`, tree: created.sha, parents: [ref.object.sha], author: { name: 'DeepSeek 运维', email: 'deepseek-ops@users.noreply.github.com' } });
  // A fast-forward update fails on concurrent writes; never use force push.
  const response = await call(root + '/git/refs/heads/' + encodeURIComponent(branch), { method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'PRT-DeepSeek-Ops' }, body: JSON.stringify({ sha: commit.sha, force: false }) });
  if (!response.ok) throw new Error(`GitHub ${response.status}：分支已变化或受保护，请检查后重试；未强制推送`);
  return { sha: commit.sha, branch, repository, unchanged: false };
}
