import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const allowed = (method, path) => method === 'GET'
  ? /^\/api\/(?:auth\/me|requirements(?:\/[^/]+(?:\/documents\/[^/]+\/download)?)?|assets(?:\/[^/]+)?|versions\/[^/]+)$/.test(path)
  : method === 'POST' && /^\/api\/(?:assets|versions\/[^/]+\/files)$/.test(path)
    || method === 'PUT' && /^\/api\/versions\/[^/]+$/.test(path);

/** Accept only same-application, signed enterprise identities; delegated tokens retain the platform's live business permissions. */
export function setupHarnessAuth(app, store, config) {
  const secret = config.harnessSharedSecret ?? process.env.HARNESS_SHARED_SECRET ?? '';
  if (secret && Buffer.byteLength(secret) < 32) throw new Error('HARNESS_SHARED_SECRET must contain at least 32 bytes');
  if (secret) store.db.exec(`
    CREATE TABLE IF NOT EXISTS harness_nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS harness_sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
  `);
  app.post('/api/harness/exchange', (req, res) => {
    if (!secret) return res.status(503).json({ error: 'Harness 接入尚未配置' });
    try {
      const { assertion } = req.body;
      if (typeof assertion !== 'string' || assertion.length > 8192) throw Error();
      const [payload, signature, extra] = assertion.split('.');
      if (!payload || !signature || extra) throw Error();
      const expected = createHmac('sha256', secret).update(payload).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const appId = config.appId || (config.demoMode ? 'prt-development' : '');
      const tenant = config.tenantKey || (config.demoMode ? 'prt-development' : '');
      if (!appId || !tenant || claims.appId !== appId || claims.tenantKey !== tenant ||
        claims.aud !== 'prt-demo-hub' || claims.iss !== 'prt-agent-server' ||
        typeof claims.openId !== 'string' || !claims.openId || claims.openId.length > 200 || typeof claims.nonce !== 'string' || !/^[\w-]{24,100}$/.test(claims.nonce) ||
        !Number.isSafeInteger(claims.exp) || claims.exp < Date.now() || claims.exp > Date.now() + 90000) throw Error();
      store.run('DELETE FROM harness_nonces WHERE expires<?', Date.now());
      if (store.one('SELECT nonce FROM harness_nonces WHERE nonce=?', claims.nonce)) throw Error();
      store.run('INSERT INTO harness_nonces VALUES(?,?)', claims.nonce, claims.exp);
      const user = store.one('SELECT * FROM users WHERE open_id=? AND enabled=1 AND deleted_at IS NULL', claims.openId);
      if (!user || !JSON.parse(user.roles).length) return res.status(403).json({ error: '此飞书账号在 Demo Hub 尚未授权或已停用，请联系平台管理员' });
      const token = randomBytes(32).toString('base64url'), seconds = 1800;
      store.run('DELETE FROM harness_sessions WHERE expires<?', Date.now());
      store.run('INSERT INTO harness_sessions VALUES(?,?,?)', digest(token), user.id, Date.now() + seconds * 1000);
      res.json({ access_token: token, expires_in: seconds, user: { id: user.id, name: user.name, roles: JSON.parse(user.roles) } });
    } catch { res.status(401).json({ error: 'Harness 身份验证失败' }); }
  });
  return {
    user(req) {
      const bearer = req.get('authorization');
      if (!secret || !bearer?.startsWith('Bearer ')) return null;
      if (!allowed(req.method, req.originalUrl.split('?')[0])) return null;
      const user = store.one('SELECT u.* FROM harness_sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.enabled=1 AND u.deleted_at IS NULL', digest(bearer.slice(7)), Date.now());
      if (user) req.harnessAuthenticated = true;
      return user;
    },
  };
}
