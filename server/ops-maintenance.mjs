import path from 'node:path';
import { uid, now, parse } from './db.mjs';
import { sourceSnapshot } from './ops-source.mjs';
import { backupInWorker } from './ops-backup.mjs';
import { pushCoreToGithub } from './ops-github.mjs';

export const OPS_ACCOUNT_ID = 'system-deepseek-ops';
export function initializeOps(store) {
  if (!store.all('PRAGMA table_info(users)').some(column => column.name === 'account_type')) store.db.exec("ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'human'");
  store.run("INSERT OR IGNORE INTO users(id,open_id,name,roles,created_at,account_type) VALUES(?,'virtual:deepseek-ops','DeepSeek 运维','[\"ops\"]',?,'virtual')", OPS_ACCOUNT_ID, now());
  store.db.exec(`CREATE TABLE IF NOT EXISTS ops_deployments (
    id TEXT PRIMARY KEY, source_hash TEXT NOT NULL, deployed_at TEXT NOT NULL, due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', backup TEXT NOT NULL DEFAULT '', github TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
  );`);
}
export function nextShanghaiMidnight(time) {
  const offset = 8 * 3600000;
  return (Math.floor((time + offset) / 86400000) + 1) * 86400000 - offset;
}
export function recordOpsDeployment(store, sourceHash, time = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('部署源码摘要无效');
  return store.tx(() => {
    const previous = store.one('SELECT * FROM ops_deployments ORDER BY rowid DESC LIMIT 1');
    if (previous?.source_hash === sourceHash) return previous;
    const id = uid();
    store.run('INSERT INTO ops_deployments(id,source_hash,deployed_at,due_at) VALUES(?,?,?,?)', id, sourceHash, new Date(time).toISOString(), nextShanghaiMidnight(time));
    return store.one('SELECT * FROM ops_deployments WHERE id=?', id);
  });
}
export function createOpsMaintenance(store, config) {
  initializeOps(store);
  const sourceRoot = config.opsSourceDir || process.cwd(), clock = config.opsClock || Date.now;
  const backup = config.opsBackup || backupInWorker, github = config.opsGithub || pushCoreToGithub;
  let active = null;
  // A restart resumes an interrupted job. Last verified local backup stays intact.
  store.run("UPDATE ops_deployments SET status='failed',next_at=0,error='服务重启中断任务，等待重试' WHERE status='running'");
  const virtualEnabled = () => { const user = store.one('SELECT * FROM users WHERE id=?', OPS_ACCOUNT_ID); return user?.enabled && !user.deleted_at && parse(user.roles, []).includes('ops'); };
  const status = () => ({ enabled: !!config.opsEnabled, timezone: 'Asia/Shanghai', backupDirectory: config.opsBackupDir || path.join(config.backupDir || process.env.BACKUP_DIR || './backups', 'ops'), repository: config.opsGithubRepository || 'PRTAI/PRT-demo-hub', branch: config.opsGithubBranch || 'feature/deepseek', githubConfigured: !!config.opsGithubToken, virtualEnabled: !!virtualEnabled(), deployments: store.all('SELECT * FROM ops_deployments ORDER BY deployed_at DESC,rowid DESC LIMIT 12').map(row => ({ ...row, backup: parse(row.backup, null), github: parse(row.github, null) })) });
  function record() { if (!config.opsEnabled || config.demoMode) return null; return recordOpsDeployment(store, sourceSnapshot(sourceRoot).hash, clock()); }
  async function execute(force = false) {
    if ((!config.opsEnabled || config.demoMode || !virtualEnabled()) && !force) return;
    const pending = store.all("SELECT * FROM ops_deployments WHERE status IN ('pending','failed') AND due_at<=? AND next_at<=? AND attempts<6 ORDER BY deployed_at DESC,rowid DESC", clock(), clock());
    if (!pending.length) return;
    const snapshot = sourceSnapshot(sourceRoot);
    // If several deployments are due, archive only the currently running code.
    const job = pending.find(row => row.source_hash === snapshot.hash);
    if (!job) return;
    store.run("UPDATE ops_deployments SET status='running',attempts=attempts+1,error='' WHERE id=?", job.id);
    try {
      let saved = parse(job.backup, null);
      if (!saved) {
        saved = await backup({ dataDir: store.root, backupDir: status().backupDirectory, snapshot });
        store.run('UPDATE ops_deployments SET backup=? WHERE id=?', JSON.stringify(saved), job.id);
      }
      const result = await github(snapshot, { token: config.opsGithubToken, repository: status().repository, branch: status().branch, baseBranch: config.opsGithubBaseBranch || 'main', fetch: config.opsGithubFetch });
      store.tx(() => {
        store.run("UPDATE ops_deployments SET status='complete',github=?,error='' WHERE id=?", JSON.stringify(result), job.id);
        store.run("UPDATE ops_deployments SET status='superseded',error='已合并到较新部署的备份与提交' WHERE id<>? AND deployed_at<=? AND due_at<=? AND status IN ('pending','failed')", job.id, job.deployed_at, clock());
        store.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', uid(), null, null, OPS_ACCOUNT_ID, 'DeepSeek 运维', 'ops_maintenance_complete', JSON.stringify({ deploymentId: job.id, sourceHash: snapshot.hash, backup: saved.path, commit: result.sha, branch: result.branch }), now());
      });
    } catch (error) {
      // Do not persist raw network responses or tokens.
      const message = String(error.message).replaceAll(config.opsGithubToken || '\0', '[已隐藏]').slice(0, 1200);
      store.run("UPDATE ops_deployments SET status='failed',error=?,next_at=? WHERE id=?", message, clock() + 10 * 60000, job.id);
    }
  }
  function tick() { if (!active) active = execute().finally(() => { active = null; }); return active; }
  return { status, record, tick, retry(id) { const job = store.one('SELECT * FROM ops_deployments WHERE id=?', id); if (!job || job.status !== 'failed') return false; store.run('UPDATE ops_deployments SET attempts=0,next_at=0 WHERE id=?', id); return true; }, start() { const timer = setInterval(() => tick().catch(error => console.error('Ops maintenance:', error.name)), 30000); timer.unref(); tick().catch(error => console.error('Ops maintenance:', error.name)); return async () => { clearInterval(timer); await active; }; }, async drain() { await active; } };
}
