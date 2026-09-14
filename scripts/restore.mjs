import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function restoreBackup(source, destination) {
  const root = path.resolve(source), target = path.resolve(destination);
  if (!fs.existsSync(path.join(root, 'manifest.json'))) throw new Error('No completed backup manifest found');
  if (fs.existsSync(target)) throw new Error('Restore requires a new, non-existing destination directory');
  const db = new DatabaseSync(path.join(root, 'platform.sqlite'), { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Database integrity check failed');
    const files = db.prepare('SELECT id,size,checksum FROM files').all();
    for (const file of files) {
      if (!/^[a-f0-9-]{36}$/.test(file.id)) throw new Error('Invalid file identifier');
      const input = path.join(root, 'files', file.id), digest = createHash('sha256');
      for await (const chunk of fs.createReadStream(input)) digest.update(chunk);
      if (fs.statSync(input).size !== file.size || digest.digest('hex') !== file.checksum) throw new Error('File integrity check failed');
    }
    fs.mkdirSync(path.join(target, 'files'), { recursive: true }); fs.mkdirSync(path.join(target, 'tmp'));
    fs.copyFileSync(path.join(root, 'platform.sqlite'), path.join(target, 'platform.sqlite'));
    for (const file of files) fs.copyFileSync(path.join(root, 'files', file.id), path.join(target, 'files', file.id));
    return { files: files.length };
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/restore.mjs BACKUP_DIR NEW_DATA_DIR');
  console.log(await restoreBackup(process.argv[2], process.argv[3]));
}
