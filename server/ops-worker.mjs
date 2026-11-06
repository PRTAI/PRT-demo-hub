import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { corePath, sourceFile, sourceSnapshot, materializeSource, sha256 } from './ops-source.mjs';

export function runCheck(root, kind, { signal, timeout = 600000 } = {}) {
  const args = kind === 'build' ? ['node_modules/vite/bin/vite.js', 'build'] : kind === 'test' ? ['--test', '--test-concurrency=1', ...fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'tests/' + name)] : null;
  if (!args) throw new Error('仅支持 test 或 build');
  return new Promise((resolve, reject) => {
    // User-authored tests execute only in the isolated worker, without platform or model credentials.
    const child = spawn(process.execPath, args, { cwd: root, detached: process.platform !== 'win32', env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stopped = false;
    const append = chunk => { output = (output + chunk.toString()).slice(-22000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const kill = () => { stopped = true; try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, timeout); signal?.addEventListener('abort', kill, { once: true });
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', kill); reject(error); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', kill); resolve({ kind, success: code === 0 && !stopped, exitCode: code, stopped, output }); });
    if (signal?.aborted) kill();
  });
}

export function createOpsWorker({ root, token, check = runCheck }) {
  if (Buffer.byteLength(token || '') < 32) throw new Error('OPS_WORKER_TOKEN 至少 32 字节');
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '3mb' }));
  app.use((req, res, next) => {
    const supplied = Buffer.from((req.get('authorization') || '').replace(/^Bearer /, '')), expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(401).json({ error: '运维工作器身份验证失败' });
    next();
  });
  let busy = false;
  app.get('/health', (req, res) => res.json({ ok: true, busy }));
  app.post('/tool', async (req, res) => {
    if (busy) return res.status(409).json({ error: '运维工作区正在执行另一项任务' });
    busy = true;
    const abort = new AbortController(); res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const { name, args = {} } = req.body;
      let result;
      if (name === 'list_source') result = sourceSnapshot(root).files.map(file => ({ path: file.path, sha256: file.sha256 }));
      else if (name === 'read_source') {
        const bytes = fs.readFileSync(sourceFile(root, args.path));
        if (bytes.length > 512000) throw new Error('文件超过 500 KB，请使用搜索定位内容');
        result = { path: args.path, sha256: sha256(bytes), content: bytes.toString('utf8') };
      } else if (name === 'search_source') {
        if (typeof args.query !== 'string' || !args.query || args.query.length > 200) throw new Error('搜索词长度为 1～200 字符');
        result = [];
        for (const file of sourceSnapshot(root).files) {
          if (args.prefix && !file.path.startsWith(args.prefix)) continue;
          const lines = Buffer.from(file.content, 'base64').toString('utf8').split('\n');
          for (let i = 0; i < lines.length && result.length < 120; i++) if (lines[i].includes(args.query)) result.push({ path: file.path, line: i + 1, content: lines[i].slice(0, 1000) });
          if (result.length >= 120) break;
        }
      } else if (name === 'write_source' || name === 'delete_source') {
        const target = sourceFile(root, args.path, { create: true }), exists = fs.existsSync(target);
        const before = exists ? sha256(fs.readFileSync(target)) : null;
        if ((args.expectedSha256 ?? null) !== before) throw new Error('文件已变化，请重新读取 SHA256 后修改');
        if (name === 'delete_source') { if (!exists) throw new Error('文件不存在'); fs.unlinkSync(target); result = { path: args.path, deleted: true }; }
        else {
          if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 512000) throw new Error('单次写入最多 500 KB');
          fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, args.content);
          result = { path: args.path, sha256: sha256(args.content), saved: true };
        }
      } else if (name === 'run_checks') result = await check(root, args.kind, { signal: abort.signal });
      else if (name === 'snapshot') result = sourceSnapshot(root);
      else throw new Error('未知的运维工具');
      res.json({ result });
    } catch (error) { res.status(400).json({ error: error.message }); }
    finally { busy = false; }
  });
  return app;
}

export function initializeOpsWorkspace(seed, base) {
  const snapshot = sourceSnapshot(seed), root = path.join(base, snapshot.hash);
  if (!fs.existsSync(path.join(root, '.ready'))) {
    materializeSource(snapshot, root);
    if (!fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync('/opt/ops/node_modules', path.join(root, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(root, '.ready'), snapshot.hash);
  }
  const old = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name) && entry.name !== snapshot.hash).map(entry => ({ path: path.join(base, entry.name), time: fs.statSync(path.join(base, entry.name)).mtimeMs })).sort((a, b) => b.time - a.time);
  for (const entry of old.slice(1)) fs.rmSync(entry.path, { recursive: true, force: true });
  return root;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = initializeOpsWorkspace(process.env.OPS_SOURCE_DIR || '/opt/source', process.env.OPS_WORKSPACE_DIR || '/workspace');
  const server = createOpsWorker({ root, token: process.env.OPS_WORKER_TOKEN }).listen(Number(process.env.PORT || 3200), '0.0.0.0');
  server.requestTimeout = 15 * 60000;
}
