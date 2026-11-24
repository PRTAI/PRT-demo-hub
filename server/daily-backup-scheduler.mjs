import path from 'node:path';
import { parse } from './db.mjs';
import { dailyBackupInWorker } from './daily-backup.mjs';
import { nextShanghaiMidnight } from './ops-maintenance.mjs';

export function createDailyBackupScheduler(store, config) {
  const enabled = config.dailyBackupEnabled !== false && !config.demoMode;
  const clock = config.dailyBackupClock || Date.now, backup = config.dailyBackup || dailyBackupInWorker;
  const directory = config.dailyBackupDir || path.join(config.backupDir || process.env.BACKUP_DIR || './backups', 'daily');
  let active = null;
  const read = () => parse(store.one("SELECT value FROM metadata WHERE key='daily_backup'")?.value, {});
  const write = value => store.run("INSERT INTO metadata(key,value) VALUES('daily_backup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
  function status() {
    const saved = read();
    return { enabled, timezone: 'Asia/Shanghai', directory, ...saved, stale: !saved.lastSuccess || clock() - Date.parse(saved.lastSuccess.at) > 26 * 3600000 };
  }
  async function execute() {
    if (!enabled) return;
    const saved = read();
    // Initial activation creates a baseline immediately. An overdue midnight is
    // caught up once after restart, without replaying days of identical copies.
    if (saved.nextAt > clock() || saved.retryAt > clock()) return;
    const startedAt = new Date(clock()).toISOString();
    write({ ...saved, status: 'running', startedAt, error: '' });
    try {
      const result = await backup({ dataDir: store.root, backupDir: directory, sourceDir: config.dailyBackupSourceDir || config.opsSourceDir || process.cwd(), configDir: config.dailyBackupConfigDir || '', workspaceDir: config.dailyBackupWorkspaceDir || '' });
      write({ status: 'complete', startedAt, lastSuccess: result, nextAt: nextShanghaiMidnight(clock()), retryAt: 0, error: '' });
      console.log('Daily full backup verified:', result.path, result.files, 'files');
    } catch (error) {
      // Filesystem errors only; do not include file contents or credentials.
      const message = String(error.code || error.message).slice(0, 600);
      write({ ...saved, status: 'failed', startedAt, error: message, retryAt: clock() + 10 * 60000 });
      console.error('Daily full backup failed:', message);
    }
  }
  function tick() { if (!active) active = execute().finally(() => { active = null; }); return active; }
  return { status, tick, start() { if (!enabled) return async () => {}; const timer = setInterval(() => tick().catch(error => console.error('Daily backup scheduler:', error.name)), 30000); timer.unref(); tick().catch(error => console.error('Daily backup scheduler:', error.name)); return async () => { clearInterval(timer); await active; }; }, async drain() { await active; } };
}
