import { openStore } from '../server/db.mjs';
import { readModelConfig } from '../server/model-config.mjs';
import { initializeOps, recordOpsDeployment } from '../server/ops-maintenance.mjs';
import { sourceSnapshot } from '../server/ops-source.mjs';

const config = readModelConfig();
if (!config.opsEnabled) throw new Error('尚未启用运维自动归档');
const store = openStore(process.env.DATA_DIR || './data');
try {
  initializeOps(store);
  const job = recordOpsDeployment(store, sourceSnapshot(config.opsSourceDir || process.cwd()).hash);
  console.log(JSON.stringify({ deployment: job.id, sourceHash: job.source_hash, dueAt: new Date(job.due_at).toISOString(), timezone: 'Asia/Shanghai' }));
} finally { store.db.close(); }
