import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export const parse = (v, fallback = {}) => { try { return JSON.parse(v); } catch { return fallback; } };

export function openStore(directory) {
  const root = path.resolve(directory);
  for (const dir of [root, path.join(root, 'files'), path.join(root, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(root, 'platform.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, open_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, avatar TEXT DEFAULT '',
      roles TEXT NOT NULL DEFAULT '[]', supervisor_id TEXT REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), creator_id TEXT NOT NULL REFERENCES users(id),
      current_version_id TEXT, next_number INTEGER NOT NULL DEFAULT 2, revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), number INTEGER NOT NULL, status TEXT NOT NULL,
      description TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, submission_count INTEGER NOT NULL DEFAULT 0,
      creator_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT,
      UNIQUE(asset_id, number)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_working_version ON versions(asset_id) WHERE status IN ('draft','pending','returned');
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, original_name TEXT NOT NULL, size INTEGER NOT NULL, checksum TEXT NOT NULL,
      uploader_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS version_files (version_id TEXT REFERENCES versions(id) ON DELETE CASCADE, file_id TEXT REFERENCES files(id), PRIMARY KEY(version_id,file_id));
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES versions(id), round INTEGER NOT NULL,
      submitter_id TEXT NOT NULL REFERENCES users(id), snapshot TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, asset_id TEXT, version_id TEXT, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
      action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_asset ON events(asset_id, created_at);
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency (user_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id,request_id));
    CREATE TABLE IF NOT EXISTS description_jobs (
      id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES versions(id), requester_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL, base_revision INTEGER NOT NULL, result TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS description_jobs_version ON description_jobs(version_id,created_at);
    CREATE TABLE IF NOT EXISTS asset_permissions (
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
      level TEXT NOT NULL CHECK(level IN ('readonly','upload','manage')), granted_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, PRIMARY KEY(asset_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS version_cc (
      version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
      added_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, PRIMARY KEY(version_id,user_id)
    );
  `);
  if (!db.prepare('PRAGMA table_info(versions)').all().some(column => column.name === 'reviewer_id')) db.exec('ALTER TABLE versions ADD COLUMN reviewer_id TEXT REFERENCES users(id)');
  const permissionSql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='asset_permissions'").get()?.sql || '';
  if (!permissionSql.includes("'upload'")) db.exec(`PRAGMA foreign_keys=OFF; ALTER TABLE asset_permissions RENAME TO asset_permissions_old;
    CREATE TABLE asset_permissions (asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),level TEXT NOT NULL CHECK(level IN ('readonly','upload','manage')),granted_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(asset_id,user_id));
    INSERT INTO asset_permissions SELECT * FROM asset_permissions_old; DROP TABLE asset_permissions_old; PRAGMA foreign_keys=ON;`);
  db.exec("UPDATE versions SET reviewer_id=(SELECT u.supervisor_id FROM assets a JOIN users u ON u.id=a.owner_id WHERE a.id=versions.asset_id) WHERE reviewer_id IS NULL AND submission_count>0");
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  run('INSERT OR IGNORE INTO settings(id,value) VALUES(1,?)', JSON.stringify({ categories: ['零售与消费', '金融服务', '工业制造', '医疗健康', '通用数据'], maxFileMB: 512, maxVersionMB: 2048, maxFiles: 20 }));
  return { db, root, one, all, run, tx };
}
