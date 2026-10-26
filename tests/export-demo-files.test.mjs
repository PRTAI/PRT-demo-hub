import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/db.mjs';
import { seedPreview } from '../server/seed.mjs';
import { exportDemoFiles } from '../scripts/export-demo-files.mjs';

test('Demo export restores original names, separates versions and Demos and handles Windows name collisions without modifying source', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-export-test-')), store = openStore(path.join(root, 'data'));
  t.after(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  seedPreview(store);
  const versions = store.all('SELECT * FROM versions ORDER BY id');
  for (const version of versions) store.run('UPDATE versions SET description=? WHERE id=?', JSON.stringify({ title: '导出测试' }), version.id);
  const file = store.one('SELECT f.* FROM files f JOIN version_files vf ON vf.file_id=f.id WHERE vf.version_id=?', versions[0].id);
  const extra = store.one('SELECT * FROM files WHERE id<>? LIMIT 1', file.id);
  store.run('UPDATE files SET original_name=? WHERE id=?', '数据.csv', file.id);
  store.run('UPDATE files SET original_name=? WHERE id=?', '数据.csv', extra.id);
  store.run('INSERT INTO version_files VALUES(?,?)', versions[0].id, extra.id);
  const unsafe = store.one('SELECT * FROM files WHERE id NOT IN (?,?) LIMIT 1', file.id, extra.id);
  store.run('UPDATE files SET original_name=? WHERE id=?', '../../CON.txt', unsafe.id);
  store.run('INSERT INTO versions(id,asset_id,number,status,description,creator_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', 'export-version', versions[0].asset_id, 2, 'published', JSON.stringify({ title: '导出测试' }), versions[0].creator_id, versions[0].created_at, versions[0].updated_at);
  store.run('INSERT INTO version_files VALUES(?,?)', 'export-version', file.id);
  const before = store.all('SELECT * FROM files'), target = path.join(root, 'export');
  const result = await exportDemoFiles(store.root, target);
  assert.equal(result.files, 10); assert.equal(result.demos, 8);
  const duplicates = result.entries.filter(item => item.versionId === versions[0].id);
  assert.deepEqual(new Set(duplicates.map(item => path.basename(item.exportedPath))), new Set(['数据.csv', '数据 (2).csv']));
  assert.ok(result.entries.some(item => item.version === 2 && item.exportedPath.includes('/V2/数据.csv')));
  assert.equal(new Set(result.entries.map(item => item.exportedPath.toLowerCase())).size, result.files);
  for (const entry of result.entries) {
    assert.ok(path.resolve(target, entry.exportedPath).startsWith(target + path.sep));
    assert.deepEqual(fs.readFileSync(path.join(target, entry.exportedPath)), fs.readFileSync(path.join(store.root, 'files', entry.fileId)));
    assert.ok(!entry.exportedPath.includes('../'));
  }
  assert.deepEqual(store.all('SELECT * FROM files'), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'export-manifest.json'))).files, 10);
  await assert.rejects(exportDemoFiles(store.root, target), /already exists/);
  await assert.rejects(exportDemoFiles(store.root, path.join(store.root, 'export')), /outside/);
});

test('Demo export detects corrupted files and does not mark an incomplete export as completed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-export-failure-')), store = openStore(path.join(root, 'data'));
  t.after(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  seedPreview(store);
  const file = store.one('SELECT id FROM files LIMIT 1');
  fs.writeFileSync(path.join(store.root, 'files', file.id), 'corrupt');
  const target = path.join(root, 'export');
  await assert.rejects(exportDemoFiles(store.root, target), /integrity check failed/);
  assert.equal(fs.existsSync(path.join(target, 'export-manifest.json')), false);
});
