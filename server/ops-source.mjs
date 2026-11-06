import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const directories = new Set(['server', 'shared', 'src', 'tests', 'scripts', 'docs', 'public']);
const rootFiles = new Set(['package.json', 'package-lock.json', 'index.html', 'vite.config.mjs', 'Dockerfile', 'Dockerfile.ops', 'README.md', '.gitignore', '.dockerignore']);
const excluded = /(?:^|\/)(?:node_modules|dist|data|backups|coverage|\.git|\.cache|\.env[^/]*)(?:\/|$)|\.(?:sqlite(?:-[^/]*)?|db|log|pem|key|p12|pfx|zip|tar|gz)$/i;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function corePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.includes(':') || path.posix.normalize(name) !== name || name.startsWith('/') || name.split('/').some(part => part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.startsWith('.') && !rootFiles.has(part)) || excluded.test(name)) return false;
  return name.includes('/') ? directories.has(name.split('/')[0]) : rootFiles.has(name) || /^compose[\w.-]*\.ya?ml$/.test(name);
}
export function sourceFile(root, name, { create = false } = {}) {
  if (!corePath(name)) throw new Error('只能操作核心源码，禁止访问配置密钥、数据、备份及目录外文件');
  const base = fs.realpathSync(root), target = path.join(base, name);
  let current = base;
  const parts = name.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let entry;
    try { entry = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entry?.isSymbolicLink()) throw new Error('源码路径不能包含符号链接');
    if (!entry && !create) throw new Error('源码文件不存在');
  }
  return target;
}
export function sourceSnapshot(root) {
  const files = [];
  function visit(directory, prefix = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = prefix + item.name;
      if (item.isSymbolicLink()) { if (corePath(name)) throw new Error('核心源码不能包含符号链接'); continue; }
      if (item.isDirectory()) { if (corePath(name + '/placeholder')) visit(path.join(directory, item.name), name + '/'); }
      else if (item.isFile() && corePath(name)) {
        const bytes = fs.readFileSync(sourceFile(root, name));
        if (bytes.length > 2 * 1024 * 1024) throw new Error(`核心源码文件超过 2 MB：${name}`);
        files.push({ path: name, content: bytes.toString('base64'), sha256: sha256(bytes) });
      }
    }
  }
  visit(root);
  if (!files.some(file => file.path === 'package.json')) throw new Error('核心源码缺少 package.json');
  if (files.reduce((size, file) => size + file.content.length, 0) > 24 * 1024 * 1024) throw new Error('核心源码快照超过 24 MB');
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { hash: sha256(files.map(file => `${file.path}:${file.sha256}`).join('\n')), files };
}
export function validateSourceSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.files) || snapshot.files.length > 5000) throw new Error('无效的源码快照');
  const seen = new Set();
  for (const file of snapshot.files) {
    if (!corePath(file.path) || seen.has(file.path) || typeof file.content !== 'string') throw new Error('源码快照包含非法路径');
    seen.add(file.path);
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length > 2 * 1024 * 1024 || sha256(bytes) !== file.sha256) throw new Error('源码快照校验失败');
    const content = bytes.toString('utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[a-zA-Z0-9]{24,})\b/.test(content)) throw new Error(`源码疑似包含密钥，已停止归档：${file.path}`);
  }
  const sorted = [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!seen.has('package.json') || sha256(sorted.map(file => `${file.path}:${file.sha256}`).join('\n')) !== snapshot.hash) throw new Error('源码快照摘要不匹配');
  return snapshot;
}
export function materializeSource(snapshot, root) {
  validateSourceSnapshot(snapshot);
  fs.mkdirSync(root, { recursive: true });
  for (const file of snapshot.files) {
    const target = sourceFile(root, file.path, { create: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(file.content, 'base64'));
  }
}
