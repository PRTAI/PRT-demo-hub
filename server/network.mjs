import { randomUUID } from 'node:crypto';
import { validateOrigin } from './runtime.mjs';

export function setupNetwork(app, config, store) {
  const origins = [...new Set([config.origin, config.publicOrigin, config.intranetOrigin].filter(Boolean))];
  origins.forEach(validateOrigin);
  store.run("INSERT OR IGNORE INTO metadata(key,value) VALUES('network_instance',?)", randomUUID());
  const instance = store.one("SELECT value FROM metadata WHERE key='network_instance'").value;
  app.use('/api/network', (req, res, next) => {
    if (origins.includes(req.get('origin'))) {
      res.set('Access-Control-Allow-Origin', req.get('origin'));
      res.set('Access-Control-Allow-Private-Network', 'true');
      res.vary('Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.get('/api/network', (req, res) => res.json({ instance, publicOrigin: config.publicOrigin || config.origin, intranetOrigin: config.intranetOrigin || '' }));
}
