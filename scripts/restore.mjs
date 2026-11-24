import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function restoreBackup(source, destination) {
  const root = path.resolve(source), target = path.resolve(destination);
  if (!fs.existsSync(path.join(root, 'manifest.json'))) throw new Error('No completed backup manifest found');
  if (fs.existsSync(target)) throw new Error('Restore requires a new, non-existing destination directory');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const verify = async (input, size, checksum) => {
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(input)) digest.update(chunk);
    if (fs.statSync(input).size !== size || digest.digest('hex') !== checksum) throw new Error('File integrity check failed');
  };
  const checkedPath = relative => {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.includes(':') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid backup path');
    let input = root;
    for (const part of relative.split('/')) { input = path.join(input, part); if (fs.lstatSync(input).isSymbolicLink()) throw new Error('Invalid backup symlink'); }
    return input;
  };
  const db = new DatabaseSync(path.join(root, 'platform.sqlite'), { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Database integrity check failed');
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Database foreign key check failed');
    const files = db.prepare('SELECT id,size,checksum FROM files').all();
    for (const file of files) {
      if (!/^[a-f0-9-]{36}$/.test(file.id)) throw new Error('Invalid file identifier');
      const input = path.join(root, 'files', file.id), digest = createHash('sha256');
      for await (const chunk of fs.createReadStream(input)) digest.update(chunk);
      if (fs.statSync(input).size !== file.size || digest.digest('hex') !== file.checksum) throw new Error('File integrity check failed');
    }
    for (const file of manifest.extraFiles || []) {
      if (typeof file.name !== 'string' || /[\\/:]/.test(file.name) || ['.', '..'].includes(file.name) || files.some(registered => registered.id === file.name)) throw new Error('Invalid extra file identifier');
      await verify(checkedPath('files/' + file.name), file.size, file.checksum);
    }
    for (const item of manifest.inventory || []) {
      if (!/^(source|deployment|extra-data|ops-workspace)\//.test(item.path)) throw new Error('Invalid backup inventory');
      if (item.path.startsWith('extra-data/') && (['files', 'tmp'].includes(item.path.split('/')[1]) || /^platform\.sqlite(?:-|$)/.test(item.path.split('/')[1]))) throw new Error('Invalid extra data path');
      await verify(checkedPath(item.path), item.size, item.checksum);
    }
    fs.mkdirSync(path.join(target, 'files'), { recursive: true }); fs.mkdirSync(path.join(target, 'tmp'));
    fs.copyFileSync(path.join(root, 'platform.sqlite'), path.join(target, 'platform.sqlite'));
    for (const file of files) fs.copyFileSync(path.join(root, 'files', file.id), path.join(target, 'files', file.id));
    for (const file of manifest.extraFiles || []) fs.copyFileSync(path.join(root, 'files', file.name), path.join(target, 'files', file.name));
    for (const item of manifest.inventory || []) if (item.path.startsWith('extra-data/')) {
      const relative = item.path.slice('extra-data/'.length);
      if (['files', 'tmp'].includes(relative.split('/')[0]) || /^platform\.sqlite(?:-|$)/.test(relative)) throw new Error('Invalid extra data path');
      const output = path.join(target, relative);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(checkedPath(item.path), output);
    }
    return { files: files.length };
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/restore.mjs BACKUP_DIR NEW_DATA_DIR');
  console.log(await restoreBackup(process.argv[2], process.argv[3]));
}
