import { createHash, randomBytes } from 'node:crypto';
import { uid, now, parse } from './db.mjs';
import { platformPath } from '../shared/platform-links.mjs';
import { setupHarnessAuth } from './harness-auth.mjs';
import { setupHarnessSso } from './harness-sso.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export const publicUser = user => user ? { id: user.id, name: user.name, avatar: user.avatar, roles: parse(user.roles, []), supervisorId: user.supervisor_id, enabled: !!user.enabled, deletedAt: user.deleted_at || null, revision: user.revision } : null;

export function setupAuth(app, store, config) {
  const { one, all, run, tx } = store;
  const callFeishu = config.fetch || fetch;
  const sessionName = 'prt_session_' + hash(config.origin).slice(0, 10);
  const oauthName = 'prt_oauth_' + hash(config.origin).slice(0, 10);
  const cookies = { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/' };
  const origins = [...new Set([config.origin, config.publicOrigin, config.intranetOrigin].filter(Boolean))];
  const requestOrigin = req => origins.find(origin => new URL(origin).host === req.get('host')) || config.origin;
  const documentTokens = new Map();
  const harness = setupHarnessAuth(app, store, config);
  const getUser = req => {
    const delegated = harness.user(req);
    if (delegated) return delegated;
    const token = req.cookies[sessionName];
    return token ? one('SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', hash(token), Date.now()) : null;
  };
  const issue = (res, user, tokenInfo) => {
    const token = secret();
    run('DELETE FROM sessions WHERE expires<?', Date.now());
    run('INSERT INTO sessions VALUES(?,?,?,?)', hash(token), user.id, secret(), Date.now() + 8 * 3600000);
    if (tokenInfo?.access_token) documentTokens.set(hash(token), { token: tokenInfo.access_token, expires: Date.now() + (tokenInfo.expires_in || 7200) * 1000 });
    for (const [key, value] of documentTokens) if (value.expires <= Date.now()) documentTokens.delete(key);
    res.cookie(sessionName, token, { ...cookies, maxAge: 8 * 3600000 });
  };
  const harnessSso = setupHarnessSso(app, store, config, getUser);
  app.use('/api', (req, res, next) => {
    req.user = getUser(req);
    if (req.harnessAuthenticated) return next();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (!origins.includes(origin) || req.get('x-requested-with') !== 'PRT') return res.status(403).json({ error: '请求来源校验失败，请刷新页面后重试' });
      if (req.user && req.get('x-csrf-token') !== req.user.csrf) return res.status(403).json({ error: '会话已变化，请刷新页面后重试' });
    }
    next();
  });
  app.get('/api/auth/me', (req, res) => res.json({ user: publicUser(req.user), csrf: req.user?.csrf || '', demoMode: config.demoMode, feishuConfigured: !!(config.appId && config.appSecret && config.tenantKey) }));
  app.get('/api/auth/demo-users', (req, res) => {
    if (!config.demoMode) return res.sendStatus(404);
    res.json(all("SELECT * FROM users WHERE (open_id LIKE 'preview:%' OR id IN ('harness-preview-member','harness-preview-admin')) AND enabled=1").map(publicUser));
  });
  app.post('/api/auth/demo-login', (req, res) => {
    if (!config.demoMode) return res.sendStatus(404);
    const user = one("SELECT * FROM users WHERE id=? AND (open_id LIKE 'preview:%' OR id IN ('harness-preview-member','harness-preview-admin')) AND enabled=1", req.body.userId || '');
    if (!user) return res.status(400).json({ error: '演示账号不存在' });
    if (req.cookies[sessionName]) run('DELETE FROM sessions WHERE token=?', hash(req.cookies[sessionName]));
    issue(res, user); res.json({ ok: true });
  });
  app.post('/api/auth/logout', (req, res) => {
    if (req.cookies[sessionName]) documentTokens.delete(hash(req.cookies[sessionName]));
    if (req.cookies[sessionName]) run('DELETE FROM sessions WHERE token=?', hash(req.cookies[sessionName]));
    res.clearCookie(sessionName, cookies).json({ ok: true });
  });
  app.get('/api/auth/feishu', (req, res) => {
    if (!config.appId || !config.appSecret || !config.tenantKey) return res.redirect('/?authError=' + encodeURIComponent('尚未配置飞书应用，请联系管理员完成接入'));
    const state = secret(), verifier = secret();
    run('DELETE FROM oauth_states WHERE expires<?', Date.now());
    const origin = requestOrigin(req);
    const requirementId = typeof req.query.requirement === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.query.requirement) ? req.query.requirement : '';
    let returnPath = requirementId ? '/?' + new URLSearchParams({ view: 'requirements', requirement: requirementId }) : '/';
    if (req.query.harness_request !== undefined) {
      try { returnPath = harnessSso.returnPath(req.query.harness_request); }
      catch { return res.status(400).json({ error: 'Harness 登录请求无效，请重新登录' }); }
    }
    run('INSERT INTO oauth_states(state,verifier,expires,origin,return_path) VALUES(?,?,?,?,?)', hash(state), verifier, Date.now() + 600000, origin, returnPath);
    res.cookie(oauthName, state, { ...cookies, maxAge: 600000 });
    const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    url.search = new URLSearchParams({ client_id: config.appId, response_type: 'code', redirect_uri: origin + '/api/auth/callback', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    if (config.feishuDocumentPreview || process.env.FEISHU_DOCUMENT_PREVIEW === 'true') url.searchParams.set('scope', 'docx:document:readonly wiki:wiki:readonly');
    res.redirect(url.toString());
  });
  app.get('/api/auth/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const record = state && one('SELECT * FROM oauth_states WHERE state=? AND expires>?', hash(state), Date.now());
    if (!record || state !== req.cookies[oauthName] || typeof req.query.code !== 'string') return res.redirect('/?authError=' + encodeURIComponent('飞书登录验证失效，请重新登录'));
    run('DELETE FROM oauth_states WHERE state=?', hash(state));
    res.clearCookie(oauthName, cookies);
    try {
      const exchange = await callFeishu('https://open.feishu.cn/open-apis/authen/v2/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ grant_type: 'authorization_code', client_id: config.appId, client_secret: config.appSecret, code: req.query.code, redirect_uri: (record.origin || config.origin) + '/api/auth/callback', code_verifier: record.verifier }) });
      const token = await exchange.json();
      if (!exchange.ok || !token.access_token) throw new Error('exchange');
      const response = await callFeishu('https://open.feishu.cn/open-apis/authen/v1/user_info', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15000) });
      const info = await response.json();
      if (!response.ok || info.code !== 0 || !info.data?.open_id || info.data.tenant_key !== config.tenantKey) return res.redirect('/?authError=' + encodeURIComponent('此飞书身份不属于允许访问的企业'));
      const user = tx(() => {
        let existing = one('SELECT * FROM users WHERE open_id=?', info.data.open_id);
        if (!existing) {
          const hasAdmin = all('SELECT roles FROM users WHERE enabled=1').some(u => parse(u.roles, []).includes('admin'));
          const roles = !hasAdmin && config.bootstrapIds.includes(info.data.open_id) ? ['admin'] : [];
          run('INSERT INTO users(id,open_id,name,avatar,roles,created_at) VALUES(?,?,?,?,?,?)', uid(), info.data.open_id, info.data.name || '飞书用户', info.data.avatar_url || '', JSON.stringify(roles), now());
        } else run('UPDATE users SET name=?,avatar=? WHERE id=?', info.data.name || existing.name, info.data.avatar_url || '', existing.id);
        return one('SELECT * FROM users WHERE open_id=?', info.data.open_id);
      });
      if (!user.enabled || user.deleted_at) return res.redirect('/?authError=' + encodeURIComponent('账号已停用或删除，请联系管理员'));
      if (req.cookies[sessionName]) run('DELETE FROM sessions WHERE token=?', hash(req.cookies[sessionName]));
      issue(res, user, token); res.redirect(record.return_path || '/');
    } catch { res.redirect('/?authError=' + encodeURIComponent('飞书身份获取失败，请稍后重试或联系管理员检查配置')); }
  });
  return { getUser, documentToken(req) { const record = documentTokens.get(hash(req.cookies[sessionName] || '')); return record && record.expires > Date.now() ? record.token : null; } };
}
