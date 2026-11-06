import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { materializeSource, validateSourceSnapshot } from '../server/ops-source.mjs';

export function applyOpsSource(snapshot, destination) {
  validateSourceSnapshot(snapshot);
  if (fs.existsSync(destination)) throw new Error('请指定一个不存在的新目录，避免覆盖当前部署源码和 .env');
  materializeSource(snapshot, destination);
  return { directory: path.resolve(destination), sourceHash: snapshot.hash, files: snapshot.files.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/apply-ops-source.mjs SNAPSHOT.json NEW_DIRECTORY');
  console.log(JSON.stringify(applyOpsSource(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3])));
}
