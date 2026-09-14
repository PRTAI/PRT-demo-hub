import { spawn } from 'node:child_process';
const env = { ...process.env, NODE_ENV: 'development', DEMO_MODE: 'true', DATA_DIR: '.preview-data', HOST: '127.0.0.1', PORT: '3100', APP_ORIGIN: 'http://127.0.0.1:5173' };
const children = [spawn(process.execPath, ['--watch', 'server/index.mjs'], { env, stdio: 'inherit' }), spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { env, stdio: 'inherit' })];
let closing = false;
function stop(code = 0) { if (closing) return; closing = true; children.forEach(c => c.kill()); process.exit(code); }
children.forEach(c => c.on('exit', code => stop(code || 0)));
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
