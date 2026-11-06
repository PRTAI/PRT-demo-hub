import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../server/db.mjs';
import { seedPreview } from '../server/seed.mjs';

test('requirement deletion migration preserves legacy requirements and bindings and retains tombstones after restart', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-requirement-deletion-'));
  let store = openStore(root); seedPreview(store);
  t.after(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const before = store.all('SELECT id,title,publisher_id FROM requirements ORDER BY id'), bindings = store.all('SELECT * FROM asset_requirements ORDER BY asset_id,requirement_id');
  store.db.exec('ALTER TABLE requirements DROP COLUMN deleted_at');
  store.db.close(); store = openStore(root);
  assert.deepEqual(store.all('SELECT id,title,publisher_id FROM requirements ORDER BY id'), before);
  assert.deepEqual(store.all('SELECT * FROM asset_requirements ORDER BY asset_id,requirement_id'), bindings);
  assert.ok(store.all('SELECT deleted_at FROM requirements').every(row => row.deleted_at === null));
  const deletedAt = new Date().toISOString();
  store.run('UPDATE requirements SET deleted_at=? WHERE id=?', deletedAt, before[0].id);
  store.db.close(); store = openStore(root);
  assert.equal(store.one('SELECT deleted_at FROM requirements WHERE id=?', before[0].id).deleted_at, deletedAt);
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
});

test('calendar readiness migration defers only automatic cards without substantive content or documents and persists upload staging across restarts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-card-readiness-'));
  let store = openStore(root); seedPreview(store);
  t.after(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const time = new Date().toISOString();
  for (const id of ['incomplete', 'owners-only', 'with-content', 'with-document']) store.run("INSERT INTO requirements(id,title,content,category,status,publisher_id,created_at,updated_at,source) VALUES(?,?,?,'','open','preview-employee',?,?,'demo')", id, id, '初始简介', time, time);
  for (const [id, before, after] of [['owners-only', '初始简介', '初始简介'], ['with-content', '初始简介', '补充的具体需求内容']]) {
    store.run("INSERT INTO events(id,actor_id,actor_name,action,detail,created_at) VALUES(?,'preview-pm','产品经理','requirement_edit',?,?)", 'edit-' + id, JSON.stringify({ requirementId: id, before: { content: before }, after: { content: after } }), time);
  }
  const file = store.one('SELECT id FROM files');
  store.run('INSERT INTO requirement_files VALUES(?,?,?,?)', 'with-document', file.id, 'preview-pm', time);
  const before = store.all('SELECT id,title,content,source FROM requirements ORDER BY id');
  store.db.exec('ALTER TABLE requirements DROP COLUMN calendar_ready; ALTER TABLE assets DROP COLUMN requirement_pending');
  store.db.close(); store = openStore(root);
  assert.deepEqual(store.all('SELECT id,title,content,source FROM requirements ORDER BY id'), before);
  for (const id of ['incomplete', 'owners-only']) assert.equal(store.one('SELECT calendar_ready FROM requirements WHERE id=?', id).calendar_ready, 0);
  for (const id of ['with-content', 'with-document']) assert.equal(store.one('SELECT calendar_ready FROM requirements WHERE id=?', id).calendar_ready, 1);
  assert.ok(store.all("SELECT calendar_ready FROM requirements WHERE source='manual'").every(row => row.calendar_ready === 1));
  assert.ok(store.all('SELECT requirement_pending FROM assets').every(row => row.requirement_pending === 0));
  const asset = store.one('SELECT id FROM assets');
  store.run('UPDATE assets SET requirement_pending=1 WHERE id=?', asset.id);
  store.run('UPDATE requirements SET calendar_ready=1 WHERE id=?', 'incomplete');
  store.db.close(); store = openStore(root);
  assert.equal(store.one('SELECT requirement_pending FROM assets WHERE id=?', asset.id).requirement_pending, 1);
  assert.equal(store.one('SELECT calendar_ready FROM requirements WHERE id=?', 'incomplete').calendar_ready, 1);
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
});

test('old requirement schema migrates all relations and supports four statuses without foreign key damage', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-status-migration-'));
  let store = openStore(root); seedPreview(store);
  const before = store.all('SELECT * FROM requirements'), bindings = store.all('SELECT * FROM asset_requirements'), assignees = store.all('SELECT * FROM requirement_assignees');
  const file = store.one('SELECT id,uploader_id,created_at FROM files LIMIT 1');
  store.run('INSERT INTO requirement_files VALUES(?,?,?,?)', before[0].id, file.id, file.uploader_id, file.created_at);
  store.db.close();
  const legacy = new DatabaseSync(path.join(root, 'platform.sqlite'));
  legacy.exec(`PRAGMA foreign_keys=OFF; BEGIN;
    CREATE TABLE requirements_legacy (id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,category TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('open','closed')),publisher_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO requirements_legacy SELECT id,title,content,category,status,publisher_id,revision,created_at,updated_at FROM requirements; DROP TABLE requirements;
    ALTER TABLE requirements_legacy RENAME TO requirements; COMMIT;`);
  legacy.close();
  store = openStore(root);
  t.after(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(store.all('SELECT * FROM requirements'), before);
  assert.deepEqual(store.all('SELECT * FROM asset_requirements'), bindings);
  assert.deepEqual(store.all('SELECT * FROM requirement_assignees'), assignees);
  assert.equal(store.one('SELECT COUNT(*) AS count FROM requirement_files').count, 1);
  for (const status of ['needs_update', 'delivered', 'closed', 'open']) store.run('UPDATE requirements SET status=? WHERE id=?', status, before[0].id);
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  assert.equal(store.one("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='requirements_updated'").count, 1);
});

test('legacy owners migrate into durable responsibility groups without losing assignments or existing dates', testContext => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-owner-migration-'));
  let store = openStore(root); seedPreview(store);
  const requirement = store.one('SELECT id FROM requirements');
  store.run('UPDATE users SET roles=? WHERE id=?', JSON.stringify(['business', 'employee']), 'preview-colleague');
  for (const id of ['preview-business', 'preview-admin', 'preview-unassigned']) store.run('INSERT OR IGNORE INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)', requirement.id, id, 'preview-pm', '2028-02-28T00:00:00Z');
  store.run('UPDATE requirements SET planned_date=? WHERE id=?', '2028-02-28', requirement.id);
  const before = store.all('SELECT requirement_id,user_id,assigned_by,created_at FROM requirement_assignees ORDER BY requirement_id,user_id');
  store.db.close();
  const legacy = new DatabaseSync(path.join(root, 'platform.sqlite'));
  legacy.exec(`PRAGMA foreign_keys=OFF; BEGIN;
    CREATE TABLE requirement_assignees_legacy(requirement_id TEXT NOT NULL REFERENCES requirements(id),user_id TEXT NOT NULL REFERENCES users(id),assigned_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(requirement_id,user_id));
    INSERT INTO requirement_assignees_legacy SELECT requirement_id,user_id,assigned_by,created_at FROM requirement_assignees;
    DROP TABLE requirement_assignees; ALTER TABLE requirement_assignees_legacy RENAME TO requirement_assignees;
    ALTER TABLE requirements DROP COLUMN deadline_date; COMMIT;`);
  legacy.close(); store = openStore(root);
  testContext.after(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(store.all('SELECT requirement_id,user_id,assigned_by,created_at FROM requirement_assignees ORDER BY requirement_id,user_id'), before);
  for (const [id, group] of [['preview-business', 'business'], ['preview-colleague', 'both'], ['preview-employee', 'development'], ['preview-admin', 'development'], ['preview-unassigned', 'development']]) assert.equal(store.one('SELECT responsibility FROM requirement_assignees WHERE requirement_id=? AND user_id=?', requirement.id, id).responsibility, group);
  assert.equal(store.one('SELECT planned_date FROM requirements WHERE id=?', requirement.id).planned_date, '2028-02-28');
  assert.equal(store.one('SELECT deadline_date FROM requirements WHERE id=?', requirement.id).deadline_date, '');
  store.run('UPDATE users SET roles=? WHERE id=?', JSON.stringify(['employee']), 'preview-business');
  store.db.close(); store = openStore(root);
  assert.equal(store.one('SELECT responsibility FROM requirement_assignees WHERE requirement_id=? AND user_id=?', requirement.id, 'preview-business').responsibility, 'business');
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
});

test('existing requirements migrate as manual and automatic provenance persists after reopening', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-requirement-source-'));
  let store = openStore(root); seedPreview(store);
  t.after(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const before = store.all('SELECT id,title,publisher_id FROM requirements'), bindings = store.all('SELECT * FROM asset_requirements');
  store.db.exec('ALTER TABLE requirements DROP COLUMN source');
  store.db.close(); store = openStore(root);
  assert.deepEqual(store.all('SELECT id,title,publisher_id FROM requirements'), before);
  assert.ok(store.all('SELECT source FROM requirements').every(row => row.source === 'manual'));
  assert.deepEqual(store.all('SELECT * FROM asset_requirements'), bindings);
  store.run("UPDATE requirements SET source='demo' WHERE id=?", before[0].id);
  store.db.close(); store = openStore(root);
  assert.equal(store.one('SELECT source FROM requirements WHERE id=?', before[0].id).source, 'demo');
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
});
