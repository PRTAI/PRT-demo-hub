import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('base64url');
const identifier = /^[\w-]{32,128}$/;

/** Demo Hub remains the identity provider; only a signed request from the configured center can obtain a one-use PKCE code. */
export function setupHarnessSso(app, store, config, getUser) {
  const secret = config.harnessSharedSecret ?? process.env.HARNESS_SHARED_SECRET ?? '';
  if (secret) store.db.exec(`CREATE TABLE IF NOT EXISTS harness_login_codes (
    hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL, expires INTEGER NOT NULL
  )`);
  const appId = () => config.appId || (config.demoMode ? 'prt-development' : '');
  const tenant = () => config.tenantKey || (config.demoMode ? 'prt-development' : '');
  const callback = () => {
    const configured = config.harnessServerUrl ?? process.env.HARNESS_SERVER_URL ?? '';
    const url = new URL(configured);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Invalid HARNESS_SERVER_URL');
    return new URL('/auth/demohub/callback', url).href;
  };
  const decode = (assertion, audience, lifetime) => {
    if (!secret || typeof assertion !== 'string' || assertion.length > 8192) throw Error('Invalid SSO assertion');
    const [payload, signature, extra] = assertion.split('.');
    if (!payload || !signature || extra) throw Error('Invalid SSO assertion');
    const expected = createHmac('sha256', secret).update(payload).digest(), actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error('Invalid SSO signature');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!claims || claims.iss !== 'prt-agent-server' || claims.aud !== audience ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now() || claims.exp > Date.now() + lifetime ||
      typeof claims.nonce !== 'string' || !identifier.test(claims.nonce) || claims.redirectUri !== callback()) throw Error('Invalid SSO request');
    return claims;
  };
  const authorizeRequest = assertion => {
    const claims = decode(assertion, 'prt-demo-hub-login', 300000);
    if (typeof claims.state !== 'string' || !identifier.test(claims.state) ||
      typeof claims.challenge !== 'string' || !/^[\w-]{43}$/.test(claims.challenge)) throw Error('Invalid SSO PKCE');
    return claims;
  };
  app.get('/api/harness/config', (_req, res) => {
    if (!secret || !appId() || !tenant()) return res.status(503).json({ error: 'Harness 接入尚未配置' });
    res.json({ appId: appId(), tenantKey: tenant() });
  });
  app.get('/api/harness/authorize', (req, res) => {
    if (!secret || !(config.harnessServerUrl || process.env.HARNESS_SERVER_URL)) return res.status(503).json({ error: '请在 Demo Hub 配置 HARNESS_SHARED_SECRET 和 HARNESS_SERVER_URL' });
    let claims;
    try { claims = authorizeRequest(req.query.request); }
    catch { return res.status(400).json({ error: 'Harness 登录请求无效或已过期，请从 Harness 重新登录' }); }
    const user = getUser(req);
    if (!user) return res.redirect('/api/auth/feishu?' + new URLSearchParams({ harness_request: req.query.request }));
    const roles = JSON.parse(user.roles);
    if (!user.enabled || user.deleted_at || !Array.isArray(roles) || !roles.length) return res.status(403).json({ error: '当前账号在 Demo Hub 尚未授权或已停用，请联系平台管理员' });
    const code = randomBytes(32).toString('base64url');
    store.run('DELETE FROM harness_login_codes WHERE expires<=?', Date.now());
    store.run('INSERT INTO harness_login_codes VALUES(?,?,?,?,?)', hash(code), user.id, claims.challenge, claims.redirectUri, Date.now() + 60000);
    const target = new URL(claims.redirectUri); target.searchParams.set('code', code); target.searchParams.set('state', claims.state);
    res.redirect(target.href);
  });
  app.post('/api/harness/sso/exchange', (req, res) => {
    try {
      const claims = decode(req.body?.assertion, 'prt-demo-hub-login-exchange', 90000);
      if (typeof claims.code !== 'string' || !identifier.test(claims.code) || typeof claims.verifier !== 'string' || !identifier.test(claims.verifier)) throw Error('Invalid code');
      const row = store.one('SELECT * FROM harness_login_codes WHERE hash=? AND expires>?', hash(claims.code), Date.now());
      if (!row || row.redirect_uri !== claims.redirectUri || row.challenge !== hash(claims.verifier)) throw Error('Invalid code');
      const user = store.one('SELECT * FROM users WHERE id=? AND enabled=1 AND deleted_at IS NULL', row.user_id);
      const roles = user && JSON.parse(user.roles);
      if (!user || !Array.isArray(roles) || !roles.length || !appId() || !tenant()) return res.status(403).json({ error: 'Demo Hub 账号已停用或尚未授权' });
      store.run('DELETE FROM harness_login_codes WHERE hash=?', hash(claims.code));
      const identity = { iss: 'prt-demo-hub', aud: 'prt-agent-server', nonce: claims.nonce, exp: Date.now() + 60000,
        appId: appId(), roles, user: { open_id: user.open_id, name: user.name, avatar_url: user.avatar || '', tenant_key: tenant() } };
      const payload = Buffer.from(JSON.stringify(identity)).toString('base64url');
      res.json({ assertion: payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url') });
    } catch { res.status(401).json({ error: 'Demo Hub 登录授权码无效或已使用，请重新登录' }); }
  });
  return {
    returnPath(assertion) {
      authorizeRequest(assertion);
      return '/api/harness/authorize?' + new URLSearchParams({ request: assertion });
    },
  };
}
