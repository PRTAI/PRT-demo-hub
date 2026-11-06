import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createBackup } from '../scripts/backup.mjs';
import { materializeSource, validateSourceSnapshot } from './ops-source.mjs';

export async function createLatestOpsBackup({ dataDir, backupDir, snapshot }) {
  validateSourceSnapshot(snapshot);
  const root = path.resolve(backupDir), latest = path.join(root, 'latest'), previous = path.join(root, 'previous');
  const data = fs.realpathSync(dataDir);
  if (root === data || root.startsWith(data + path.sep)) throw new Error('运维备份不能放在数据目录内');
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(latest) && fs.existsSync(previous)) fs.renameSync(previous, latest);
  const staging = path.join(root, 'pending-' + randomUUID());
  try {
    const result = await createBackup(dataDir, staging);
    materializeSource(snapshot, path.join(staging, 'source'));
    fs.writeFileSync(path.join(staging, 'source-manifest.json'), JSON.stringify({ hash: snapshot.hash, files: snapshot.files.map(({ path, sha256 }) => ({ path, sha256 })) }, null, 2));
    // Previous is removed only after a complete, verified replacement exists.
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true });
    if (fs.existsSync(latest)) fs.renameSync(latest, previous);
    try { fs.renameSync(staging, latest); }
    catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, latest); throw error; }
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true });
    return { ...result, path: latest, sourceHash: snapshot.hash };
  } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
}
export function backupInWorker(options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ops-backup.mjs', import.meta.url), { workerData: options, env: {} });
    worker.once('message', result => result.error ? reject(new Error(result.error)) : resolve(result));
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error('运维备份线程异常退出')); });
  });
}
if (!isMainThread) createLatestOpsBackup(workerData).then(result => parentPort.postMessage(result), error => parentPort.postMessage({ error: error.message }));
