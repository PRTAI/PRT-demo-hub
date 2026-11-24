import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/db.mjs';
import { seedPreview } from '../server/seed.mjs';
import { createDailyBackup, dailyBackupInWorker } from '../server/daily-backup.mjs';
import { createDailyBackupScheduler } from '../server/daily-backup-scheduler.mjs';
import { restoreBackup } from '../scripts/restore.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-daily-backup-'));
  const store = openStore(path.join(root, 'data')); seedPreview(store);
  t.after(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const sourceDir = path.join(root, 'source'), configDir = path.join(root, 'config');
  fs.mkdirSync(path.join(sourceDir, 'public'), { recursive: true }); fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(sourceDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(sourceDir, 'public', 'opening.mp4'), Buffer.alloc(3 * 1024 * 1024, 42));
  fs.writeFileSync(path.join(configDir, '.env'), 'SYNTHETIC_SECRET=local-only');
  return { root, store, sourceDir, configDir, dataDir: store.root, backupDir: path.join(root, 'backups') };
}

test('full daily backup includes database, every stored file, large media, configuration and extra data and is restorable', async t => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.dataDir, 'files', 'unregistered-object'), 'retained original');
  fs.mkdirSync(path.join(ctx.dataDir, 'extra')); fs.writeFileSync(path.join(ctx.dataDir, 'extra', 'state.json'), '{"saved":true}');
  const workspaceDir = path.join(ctx.root, 'workspace'); fs.mkdirSync(workspaceDir); fs.writeFileSync(path.join(workspaceDir, 'unreleased-change.mjs'), 'export const unreleased = true;');
  fs.symlinkSync(path.join(ctx.root, 'unavailable-node_modules'), path.join(workspaceDir, 'node_modules'), 'dir');
  const first = await dailyBackupInWorker({ dataDir: ctx.dataDir, backupDir: ctx.backupDir, sourceDir: ctx.sourceDir, configDir: ctx.configDir, workspaceDir });
  assert.ok(first.files > 0); assert.equal(first.extraFiles, 1); assert.equal(first.includesDeploymentConfig, true);
  assert.equal(fs.readFileSync(path.join(first.path, 'deployment/.env'), 'utf8'), 'SYNTHETIC_SECRET=local-only');
  assert.equal(fs.statSync(path.join(first.path, 'source/public/opening.mp4')).size, 3 * 1024 * 1024);
  assert.equal(fs.readFileSync(path.join(first.path, 'ops-workspace/unreleased-change.mjs'), 'utf8'), 'export const unreleased = true;');
  assert.equal(fs.existsSync(path.join(first.path, 'ops-workspace/node_modules')), false);
  const target = path.join(ctx.root, 'restored');
  await restoreBackup(first.path, target);
  assert.equal(fs.readFileSync(path.join(target, 'files/unregistered-object'), 'utf8'), 'retained original');
  assert.equal(fs.readFileSync(path.join(target, 'extra/state.json'), 'utf8'), '{"saved":true}');
  const restored = openStore(target);
  try { assert.equal(restored.one('SELECT COUNT(*) AS n FROM assets').n, ctx.store.one('SELECT COUNT(*) AS n FROM assets').n); assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []); }
  finally { restored.db.close(); }
  fs.writeFileSync(path.join(first.path, 'deployment/.env'), 'tampered');
  await assert.rejects(restoreBackup(first.path, path.join(ctx.root, 'bad-restore')), /integrity/);
  assert.equal(fs.existsSync(path.join(ctx.root, 'bad-restore')), false);
});

test('a failed backup preserves latest; interrupted rotation is recovered; a successful replacement keeps only latest', async t => {
  const ctx = fixture(t);
  const first = await createDailyBackup(ctx);
  const original = fs.readFileSync(path.join(first.path, 'manifest.json'), 'utf8');
  const file = ctx.store.one('SELECT id FROM files LIMIT 1');
  const input = path.join(ctx.dataDir, 'files', file.id), bytes = fs.readFileSync(input);
  fs.writeFileSync(input, 'damaged');
  await assert.rejects(createDailyBackup(ctx), /integrity/);
  assert.equal(fs.readFileSync(path.join(first.path, 'manifest.json'), 'utf8'), original);
  fs.writeFileSync(input, bytes);
  fs.renameSync(first.path, path.join(ctx.backupDir, 'previous'));
  fs.mkdirSync(path.join(ctx.backupDir, 'pending-00000000-0000-4000-8000-000000000001'));
  await createDailyBackup(ctx);
  assert.deepEqual(fs.readdirSync(ctx.backupDir), ['latest']);
});

test('daily scheduler runs every Shanghai midnight without deployments, ops or GitHub and catches up missed days once', async t => {
  const ctx = fixture(t); let clock = Date.parse('2026-11-22T15:59:00Z'), calls = 0;
  const config = { opsEnabled: false, dailyBackupDir: ctx.backupDir, dailyBackupClock: () => clock, dailyBackup: async () => { calls++; return { path: '/daily/latest', at: new Date(clock).toISOString(), files: calls }; } };
  let scheduler = createDailyBackupScheduler(ctx.store, config);
  await Promise.all([scheduler.tick(), scheduler.tick()]); assert.equal(calls, 1);
  assert.equal(scheduler.status().nextAt, Date.parse('2026-11-22T16:00:00Z'));
  clock = Date.parse('2026-11-22T16:00:00Z'); await scheduler.tick(); assert.equal(calls, 2);
  await scheduler.tick(); assert.equal(calls, 2);
  clock = Date.parse('2026-11-23T16:00:00Z'); await scheduler.tick(); assert.equal(calls, 3);
  clock = Date.parse('2026-11-26T20:00:00Z');
  scheduler = createDailyBackupScheduler(ctx.store, config); assert.equal(scheduler.status().stale, true);
  await scheduler.tick(); await scheduler.tick(); assert.equal(calls, 4); assert.equal(scheduler.status().stale, false);
  await createDailyBackupScheduler(ctx.store, { ...config, demoMode: true }).tick(); assert.equal(calls, 4);
  await createDailyBackupScheduler(ctx.store, { ...config, dailyBackupEnabled: false }).tick(); assert.equal(calls, 4);
});

test('daily backup retries beyond six failures without discarding its last successful result', async t => {
  const ctx = fixture(t); let clock = Date.parse('2026-11-22T15:00:00Z'), fail = false, calls = 0;
  const scheduler = createDailyBackupScheduler(ctx.store, { dailyBackupClock: () => clock, dailyBackup: async () => { calls++; if (fail) throw new Error('disk full'); return { path: '/latest', at: new Date(clock).toISOString() }; } });
  await scheduler.tick(); const first = scheduler.status().lastSuccess;
  fail = true; clock = Date.parse('2026-11-22T16:00:00Z');
  for (let i = 0; i < 8; i++) { await scheduler.tick(); assert.deepEqual(scheduler.status().lastSuccess, first); clock += 10 * 60000; }
  assert.equal(calls, 9);
  fail = false; await scheduler.tick(); assert.equal(calls, 10); assert.equal(scheduler.status().status, 'complete');
});
