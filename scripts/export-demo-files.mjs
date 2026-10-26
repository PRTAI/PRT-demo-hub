import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function safeName(value, limit = 120) {
  let name = String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!name || /^\.+$/.test(name)) name = '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  const extension = path.extname(name).slice(0, 20);
  if (name.length > limit) name = name.slice(0, limit - extension.length) + extension;
  return name.replace(/[. ]+$/g, '') || '未命名';
}

function uniqueName(original, used, limit = 120) {
  const name = safeName(original, limit), extension = path.extname(name), stem = name.slice(0, name.length - extension.length);
  let candidate = name;
  for (let index = 2; used.has(candidate.toLowerCase()); index++) candidate = `${stem} (${index})${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

export async function exportDemoFiles(source, destination) {
  const root = fs.realpathSync(source), target = path.resolve(destination);
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonicalTarget = path.join(fs.realpathSync(ancestor), path.relative(ancestor, target));
  if (canonicalTarget === root || canonicalTarget.startsWith(root + path.sep)) throw new Error('Export destination must be outside the data directory');
  if (fs.existsSync(target)) throw new Error('Export destination already exists; choose a new directory');
  const db = new DatabaseSync(path.join(root, 'platform.sqlite'), { readOnly: true });
  let files;
  try {
    files = db.prepare(`SELECT a.id AS asset_id,v.id AS version_id,v.number,v.description,f.id AS file_id,f.original_name,f.size,f.checksum
      FROM assets a JOIN versions v ON v.asset_id=a.id JOIN version_files vf ON vf.version_id=v.id JOIN files f ON f.id=vf.file_id
      ORDER BY a.created_at,a.id,v.number DESC,f.created_at,f.id`).all();
  } finally { db.close(); }
  fs.mkdirSync(target, { recursive: true });
  const demos = new Map(), demoNames = new Set(['export-manifest.json']), versionNames = new Map(), manifest = [];
  for (const file of files) {
    if (!/^[a-f0-9-]{36}$/.test(file.file_id)) throw new Error('Invalid stored file identifier');
    if (!demos.has(file.asset_id)) {
      let title;
      try { title = JSON.parse(file.description).title; } catch { title = ''; }
      demos.set(file.asset_id, uniqueName(title || '未命名 Demo', demoNames, 80));
    }
    const directory = path.join(demos.get(file.asset_id), `V${file.number}`);
    if (!versionNames.has(file.version_id)) versionNames.set(file.version_id, new Set());
    const name = uniqueName(file.original_name, versionNames.get(file.version_id));
    fs.mkdirSync(path.join(target, directory), { recursive: true });
    const output = path.join(target, directory, name);
    fs.copyFileSync(path.join(root, 'files', file.file_id), output, fs.constants.COPYFILE_EXCL);
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(output)) digest.update(chunk);
    if (fs.statSync(output).size !== file.size || digest.digest('hex') !== file.checksum) throw new Error(`Export integrity check failed: ${directory}/${name}`);
    manifest.push({ demoId: file.asset_id, versionId: file.version_id, version: file.number, fileId: file.file_id, originalName: file.original_name, exportedPath: [...directory.split(path.sep), name].join('/'), size: file.size, checksum: file.checksum });
  }
  const result = { at: new Date().toISOString(), demos: demos.size, files: manifest.length, entries: manifest };
  fs.writeFileSync(path.join(target, 'export-manifest.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/export-demo-files.mjs NEW_EXPORT_DIRECTORY');
  const result = await exportDemoFiles(process.env.DATA_DIR || './data', process.argv[2]);
  console.log(`Export completed and verified: ${process.argv[2]} (${result.demos} Demos, ${result.files} files)`);
}
