import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function createBackup(source, destination) {
  const root = path.resolve(source), target = path.resolve(destination);
  if (target === root || target.startsWith(root + path.sep)) throw new Error('Backup must be outside the data directory');
  if (fs.existsSync(target)) throw new Error('Backup destination already exists; choose a new directory');
  fs.mkdirSync(path.join(target, 'files'), { recursive: true });
  const live = new DatabaseSync(path.join(root, 'platform.sqlite'));
  let snapshot;
  try {
    await backup(live, path.join(target, 'platform.sqlite'));
    snapshot = new DatabaseSync(path.join(target, 'platform.sqlite'));
    snapshot.exec('DELETE FROM sessions; DELETE FROM oauth_states;');
    const files = snapshot.prepare('SELECT id,size,checksum FROM files').all();
    for (const file of files) {
      if (!/^[a-f0-9-]{36}$/.test(file.id)) throw new Error('Invalid stored file identifier');
      // Files are immutable and retained after reference removal, so the snapshot
      // remains consistent while the running service accepts new uploads.
      const input = path.join(root, 'files', file.id), output = path.join(target, 'files', file.id);
      fs.copyFileSync(input, output);
      const digest = createHash('sha256'); for await (const chunk of fs.createReadStream(output)) digest.update(chunk);
      if (fs.statSync(output).size !== file.size || digest.digest('hex') !== file.checksum) throw new Error('Backup integrity check failed');
    }
    snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE)'); snapshot.close(); snapshot = null;
    const result = { at: new Date().toISOString(), files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), format: 1 };
    fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(result, null, 2));
    live.prepare("INSERT INTO metadata(key,value) VALUES('last_backup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(result));
    return result;
  } finally { snapshot?.close(); live.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const target = process.argv[2] || path.join('backups', new Date().toISOString().replace(/[:.]/g, '-'));
  const result = await createBackup(process.env.DATA_DIR || './data', target); console.log(`Backup verified: ${target} (${result.files} files)`);
}
