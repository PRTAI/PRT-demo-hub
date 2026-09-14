import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const runtime = path.join(root, '.host-runtime');
fs.mkdirSync(runtime, { recursive: true });
const lock = path.join(runtime, 'supervisor.pid');
if (fs.existsSync(lock)) {
  const oldPid = Number(fs.readFileSync(lock, 'utf8'));
  if (Number.isInteger(oldPid) && oldPid > 0) {
    try { process.kill(oldPid, 0); process.exit(0); } catch {}
  }
}
fs.writeFileSync(lock, String(process.pid));
let child, stopping = false, timer;
const logfile = path.join(runtime, 'server.log');
function log(value) {
  if (fs.existsSync(logfile) && fs.statSync(logfile).size > 10 * 1024 * 1024) {
    fs.copyFileSync(logfile, logfile + '.previous'); fs.truncateSync(logfile);
  }
  fs.appendFileSync(logfile, value);
}
function start() {
  if (stopping) return;
  log(`\n${new Date().toISOString()} Starting host server\n`);
  child = spawn(process.execPath, ['--env-file=.env.host', 'server/index.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(runtime, 'server.pid'), String(child.pid));
  child.stdout.on('data', log); child.stderr.on('data', log);
  child.on('error', e => log(`Server start failed: ${e.code}\n`));
  child.on('exit', code => { if (!stopping) { log(`Server exited (${code}); retrying in 5 seconds\n`); timer = setTimeout(start, 5000); } });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true; clearTimeout(timer); child?.kill();
  if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock);
  setTimeout(() => process.exit(0), 1000);
});
start();
