import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createBackup } from '../scripts/backup.mjs';

const sourceDirectories = new Set(['server', 'shared', 'src', 'scripts', 'tests', 'docs', 'public', 'config', 'dist']);
const rootFile = name => /^(?:package(?:-lock)?\.json|index\.html|vite\.config\.mjs|Dockerfile(?:\.ops)?|README\.md|\.gitignore|\.dockerignore|compose[\w.-]*\.ya?ml|\.env(?:[\w.-]*)?)$/.test(name);

async function copyVerifiedTree(input, output, inventory, prefix) {
  if (prefix.startsWith('ops-workspace/') && prefix.split('/').includes('node_modules')) return;
  const stat = fs.lstatSync(input);
  if (stat.isSymbolicLink()) throw new Error('完整备份拒绝符号链接：' + prefix);
  if (stat.isDirectory()) {
    fs.mkdirSync(output, { recursive: true });
    for (const name of fs.readdirSync(input)) await copyVerifiedTree(path.join(input, name), path.join(output, name), inventory, prefix + '/' + name);
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(input, output);
    const hash = async file => { const digest = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) digest.update(chunk); return digest.digest('hex'); };
    const checksum = await hash(output);
    if (fs.statSync(output).size !== stat.size || await hash(input) !== checksum) throw new Error('完整备份文件校验失败：' + prefix);
    inventory.push({ path: prefix, size: stat.size, checksum });
  } else throw new Error('完整备份遇到不支持的文件：' + prefix);
}

export async function createDailyBackup({ dataDir, backupDir, sourceDir, configDir = '', workspaceDir = '' }) {
  const data = fs.realpathSync(dataDir), root = path.resolve(backupDir);
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  if (realRoot === data || realRoot.startsWith(data + path.sep)) throw new Error('每日备份不能位于平台数据目录内');
  if (!fs.existsSync(path.join(sourceDir, 'package.json'))) throw new Error('每日备份缺少部署源码');
  if (configDir && !fs.existsSync(path.join(configDir, '.env'))) throw new Error('每日备份缺少部署配置 .env');
  const latest = path.join(root, 'latest'), previous = path.join(root, 'previous');
  // Recover a process interruption between the two directory renames.
  if (!fs.existsSync(latest) && fs.existsSync(previous)) fs.renameSync(previous, latest);
  for (const name of fs.readdirSync(root)) if (/^pending-[a-f0-9-]{36}$/.test(name)) fs.rmSync(path.join(root, name), { recursive: true });
  const staging = path.join(root, 'pending-' + randomUUID());
  let promoted = false;
  try {
    const result = await createBackup(data, staging, { includeUnregisteredFiles: true });
    const inventory = [];
    for (const name of fs.readdirSync(sourceDir)) if (sourceDirectories.has(name) || rootFile(name)) {
      await copyVerifiedTree(path.join(sourceDir, name), path.join(staging, 'source', name), inventory, 'source/' + name);
    }
    if (configDir) for (const name of fs.readdirSync(configDir)) if (name === 'config' || rootFile(name)) {
      await copyVerifiedTree(path.join(configDir, name), path.join(staging, 'deployment', name), inventory, 'deployment/' + name);
    }
    // Preserve additional persistent application data, without copying in-flight
    // uploads or SQLite WAL files over the consistent online database snapshot.
    for (const name of fs.readdirSync(data)) if (!['files', 'tmp', 'platform.sqlite', 'platform.sqlite-wal', 'platform.sqlite-shm', 'platform.sqlite-journal'].includes(name)) {
      await copyVerifiedTree(path.join(data, name), path.join(staging, 'extra-data', name), inventory, 'extra-data/' + name);
    }
    if (workspaceDir) await copyVerifiedTree(workspaceDir, path.join(staging, 'ops-workspace'), inventory, 'ops-workspace');
    const manifest = { ...result, at: new Date().toISOString(), kind: 'daily-full', timezone: 'Asia/Shanghai', inventory, extraBytes: (result.extraFiles || []).reduce((sum, file) => sum + file.size, 0), includesDeploymentConfig: !!configDir };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true });
    if (fs.existsSync(latest)) fs.renameSync(latest, previous);
    try { fs.renameSync(staging, latest); promoted = true; }
    catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, latest); throw error; }
    // Cleanup errors do not turn a successfully published backup into a failure.
    try { if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true }); }
    catch (error) { console.error('Daily backup previous cleanup:', error.code); }
    return { at: manifest.at, files: result.files, bytes: result.bytes, extraFiles: result.extraFiles.length, extraBytes: manifest.extraBytes, sourceFiles: inventory.length, path: latest, includesDeploymentConfig: !!configDir };
  } catch (error) {
    if (!promoted) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function dailyBackupInWorker(options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./daily-backup.mjs', import.meta.url), { workerData: options, env: {} });
    let received = false;
    worker.once('message', result => { received = true; result.error ? reject(new Error(result.error)) : resolve(result); });
    worker.once('error', reject);
    worker.once('exit', code => { if (!received) reject(new Error('每日备份线程退出，未返回完成结果（' + code + '）')); });
  });
}
if (!isMainThread) createDailyBackup(workerData).then(result => parentPort.postMessage(result), error => parentPort.postMessage({ error: error.message }));
