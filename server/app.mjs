import express from 'express';
import { createNotifications } from './notifications.mjs';
import { servePreview } from './preview.mjs';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openStore, uid, now, parse } from './db.mjs';
import { setupAuth, publicUser } from './auth.mjs';
import { seedPreview } from './seed.mjs';
import { queryCatalog } from './catalog.mjs';
import { validateOrigin } from './runtime.mjs';
import { createRagSearch } from './rag.mjs';
import { createDescriptionAgent } from './description-agent.mjs';
import { createBackup } from '../scripts/backup.mjs';

const roles = ['employee', 'supervisor', 'pm', 'business', 'admin'];
const working = ['draft', 'pending', 'returned'];
const descriptionSchema = z.object({ title: z.string().max(120).default(''), summary: z.string().max(500).default(''), category: z.string().max(80).default(''), tags: z.array(z.string().max(30)).max(12).default([]), content: z.string().max(20000).default(''), usage: z.string().max(20000).default(''), costEstimate: z.string().max(5000).default(''), difficulty: z.string().max(5000).default(''), notes: z.string().max(10000).default(''), changes: z.string().max(5000).default(''), schemaVersion: z.literal(1).default(1) });
const revisionSchema = z.object({ revision: z.number().int().nonnegative() });
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

export function createApp(options = {}) {
  const config = { production: process.env.NODE_ENV === 'production', demoMode: process.env.DEMO_MODE === 'true', origin: process.env.APP_ORIGIN || 'http://127.0.0.1:3100', dataDir: process.env.DATA_DIR || './data', appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, tenantKey: process.env.FEISHU_TENANT_KEY, bootstrapIds: (process.env.BOOTSTRAP_ADMIN_OPEN_IDS || '').split(',').filter(Boolean), llmApiKey: process.env.DASHSCOPE_API_KEY || '', llmModel: process.env.RAG_LLM_MODEL || 'qwen-plus', llmBaseUrl: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1', descriptionAgentKey: process.env.DESCRIPTION_AGENT_API_KEY || '', descriptionAgentUrl: process.env.DESCRIPTION_AGENT_BASE_URL || '', descriptionAgentModel: process.env.DESCRIPTION_AGENT_MODEL || '', descriptionAgentCommand: process.env.DESCRIPTION_AGENT_COMMAND || 'claude', ...options };
  if (config.production && config.demoMode) throw new Error('Production refuses DEMO_MODE');
  if (config.production && !config.origin.startsWith('https://')) throw new Error('Production APP_ORIGIN must use HTTPS');
  validateOrigin(config.origin);
  const store = openStore(config.dataDir), { one, all, run, tx } = store;
  const mode = one("SELECT value FROM metadata WHERE key='mode'");
  if (mode && mode.value !== (config.demoMode ? 'preview' : 'production')) { store.db.close(); throw new Error('Preview and production must use separate data directories'); }
  run("INSERT OR IGNORE INTO metadata VALUES('mode',?)", config.demoMode ? 'preview' : 'production');
  if (config.demoMode) seedPreview(store);
  const notifications = createNotifications(store, config);
  const app = express(); app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: config.production ? [] : null } } }));
  app.use(express.json({ limit: '256kb' })); app.use(cookieParser());
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const auth = setupAuth(app, store, config);
  app.get('/api/health', (req, res) => { one('SELECT 1'); fs.accessSync(path.join(store.root, 'files'), fs.constants.R_OK | fs.constants.W_OK); res.json({ ok: true, version: '1.1.0' }); });
  app.use('/api', (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '请先登录' });
    if (!req.user.enabled) return res.status(403).json({ error: '账号已停用' });
    if (!parse(req.user.roles, []).length) return res.status(403).json({ error: '等待管理员分配角色' });
    next();
  });
  const has = (user, role) => parse(user.roles, []).includes(role);
  const permission = (user, asset) => one('SELECT level FROM asset_permissions WHERE asset_id=? AND user_id=?', asset.id, user.id)?.level || null;
  const reviewed = (user, asset) => has(user, 'supervisor') && !!one('SELECT id FROM versions WHERE asset_id=? AND reviewer_id=? LIMIT 1', asset.id, user.id);
  const manage = (user, asset) => has(user, 'pm') || asset.owner_id === user.id && has(user, 'supervisor') || permission(user, asset) === 'manage' || reviewed(user, asset);
  const own = (user, asset) => asset.owner_id === user.id && (has(user, 'employee') || has(user, 'supervisor'));
  const editAccess = (user, asset) => own(user, asset) || manage(user, asset) || permission(user, asset) === 'upload';
  const visible = (user, asset) => has(user, 'pm') || has(user, 'business') || own(user, asset) || manage(user, asset) || !!permission(user, asset);
  const businessRestricted = (user, asset) => has(user, 'business') && !has(user, 'pm') && !own(user, asset) && !manage(user, asset);
  const descriptionFor = (user, asset, description) => businessRestricted(user, asset) ? (({ title, summary, category, tags, content, difficulty, schemaVersion }) => ({ title, summary, category, tags, content, difficulty, schemaVersion })) (description) : description;
  const assetFor = (user, id) => { const asset = one('SELECT * FROM assets WHERE id=?', id); if (!asset || !visible(user, asset)) fail(404, 'Demo 不存在或无访问权限'); return asset; };
  const versionFor = (user, id) => { const version = one('SELECT * FROM versions WHERE id=?', id); if (!version) fail(404, '版本不存在'); return { version, asset: assetFor(user, version.asset_id) }; };
  const checkRevision = (version, revision) => { if (!Number.isInteger(revision) || version.revision !== revision) fail(409, '内容已被更新，请重新加载后再操作'); };
  const editable = (user, asset, version) => {
    if (!working.includes(version.status)) fail(409, '已发布或下架的版本不可修改，请创建新版本');
    if (!(manage(user, asset) || (editAccess(user, asset) && version.status !== 'pending'))) fail(403, '当前版本不可编辑，请先撤回提交');
  };
  const filesFor = id => all('SELECT f.id,f.original_name AS name,f.size,f.checksum,f.created_at AS createdAt,u.name AS uploader FROM files f JOIN version_files vf ON f.id=vf.file_id JOIN users u ON f.uploader_id=u.id WHERE vf.version_id=? ORDER BY f.created_at,f.id', id);
  const descriptionAgent = createDescriptionAgent(config, store);
  const versionData = (version, includeFiles = true, viewer = null, asset = null) => ({ id: version.id, number: version.number, status: version.status, description: viewer && asset ? descriptionFor(viewer, asset, parse(version.description)) : parse(version.description), revision: version.revision, submissionCount: version.submission_count, createdAt: version.created_at, updatedAt: version.updated_at, publishedAt: version.published_at, files: includeFiles ? filesFor(version.id) : [] });
  const event = (user, action, assetId = null, versionId = null, detail = {}) => run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', uid(), assetId, versionId, user.id, user.name, action, JSON.stringify(detail), now());
  const touch = id => run('UPDATE assets SET updated_at=?,revision=revision+1 WHERE id=?', now(), id);
  const settings = () => ({ ...parse(one('SELECT value FROM settings WHERE id=1').value), revision: one('SELECT revision FROM settings WHERE id=1').revision });
  const summary = (user, asset, includeFiles = true) => {
    const versions = all('SELECT * FROM versions WHERE asset_id=? ORDER BY number DESC', asset.id);
    const latest = versions[0];
    return { id: asset.id, owner: publicUser(one('SELECT * FROM users WHERE id=?', asset.owner_id)), creator: publicUser(one('SELECT * FROM users WHERE id=?', asset.creator_id)), currentVersionId: asset.current_version_id, currentVersion: versions.find(v => v.id === asset.current_version_id)?.number || null, revision: asset.revision, createdAt: asset.created_at, updatedAt: asset.updated_at, latest: latest ? versionData(latest, includeFiles, user, asset) : null, versionCount: versions.length, canManage: manage(user, asset), canEdit: editAccess(user, asset), canGrant: has(user,'pm') || (has(user,'supervisor') && manage(user,asset)), accessLevel: permission(user,asset), businessRestricted: businessRestricted(user, asset) };
  };
  app.get('/api/catalog', (req, res) => {
    const { assets, ...catalog } = queryCatalog(store, req.user, req.query);
    res.json({ ...catalog, items: assets.map(a => summary(req.user, a, false)) });
  });
  app.get('/api/config', (req, res) => res.json(settings()));
  app.get('/api/reviewers', (req,res) => res.json(all('SELECT * FROM users WHERE enabled=1').filter(user=>has(user,'supervisor')).map(publicUser)));
  app.get('/api/notification-candidates', (req,res) => res.json(all('SELECT * FROM users WHERE enabled=1 ORDER BY name').filter(user=>parse(user.roles,[]).length).map(publicUser)));
  app.post('/api/versions/:id/description/generate', (req, res) => {
    const { version, asset } = versionFor(req.user, req.params.id); editable(req.user, asset, version); checkRevision(version, revisionSchema.parse(req.body).revision);
    const files = filesFor(version.id); if (!files.length) fail(400, '请先上传并保存至少一个 Demo 文件');
    const current = one("SELECT * FROM description_jobs WHERE version_id=? AND requester_id=? AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1", version.id, req.user.id);
    if (current) return res.status(202).json({ id: current.id, status: current.status });
    const job = { id: uid(), versionId: version.id, requesterId: req.user.id, baseRevision: version.revision, createdAt: now() };
    run("INSERT INTO description_jobs(id,version_id,requester_id,status,base_revision,created_at) VALUES(?,?,?,'pending',?,?)", job.id, job.versionId, job.requesterId, job.baseRevision, job.createdAt);
    setImmediate(async () => {
      try {
        run("UPDATE description_jobs SET status='running' WHERE id=? AND status='pending'", job.id);
        const result = await descriptionAgent(files);
        run("UPDATE description_jobs SET status='complete',result=?,completed_at=? WHERE id=?", JSON.stringify(result), now(), job.id);
        const requester = one('SELECT * FROM users WHERE id=?', job.requesterId), latestVersion = one('SELECT * FROM versions WHERE id=?', job.versionId);
        if (requester && latestVersion) notifications.enqueueDirect('description_generated', latestVersion, requester, Date.now(), { jobId: job.id });
      } catch (error) { run("UPDATE description_jobs SET status='failed',error=?,completed_at=? WHERE id=?", error.message?.slice(0,1000) || '生成失败', now(), job.id); }
    });
    res.status(202).json({ id: job.id, status: 'pending' });
  });
  app.get('/api/description/jobs/:id', (req, res) => {
    const job = one('SELECT * FROM description_jobs WHERE id=?', req.params.id); if (!job || job.requester_id !== req.user.id) fail(404, '生成任务不存在');
    res.json({ id: job.id, status: job.status, result: job.status === 'complete' ? parse(job.result) : null, error: job.status === 'failed' ? job.error : '', baseRevision: job.base_revision, createdAt: job.created_at, completedAt: job.completed_at });
  });
  app.get('/api/versions/:id/description/jobs/latest', (req, res) => {
    versionFor(req.user, req.params.id);
    const job = one("SELECT * FROM description_jobs WHERE version_id=? AND requester_id=? AND status='complete' ORDER BY completed_at DESC LIMIT 1", req.params.id, req.user.id);
    res.json(job ? { id: job.id, status: job.status, result: parse(job.result), baseRevision: job.base_revision, createdAt: job.created_at, completedAt: job.completed_at } : null);
  });
  app.post('/api/description/jobs/:id/review', (req, res) => {
    const action = z.object({ action: z.enum(['accepted','dismissed']) }).parse(req.body).action, job = one('SELECT * FROM description_jobs WHERE id=?', req.params.id);
    if (!job || job.requester_id !== req.user.id) fail(404, '生成任务不存在');
    if (job.status !== 'complete') fail(409, '生成结果当前不可处理');
    run('UPDATE description_jobs SET status=? WHERE id=?', action, job.id); res.json({ ok: true });
  });
  app.get('/api/assets', (req, res) => res.json(all('SELECT * FROM assets ORDER BY updated_at DESC').filter(a => visible(req.user, a)).map(a => summary(req.user, a))));
  app.get('/api/assets/:id', (req, res) => {
    const asset = assetFor(req.user, req.params.id);
    const restricted = businessRestricted(req.user, asset);
    res.json({ ...summary(req.user, asset), versions: all('SELECT * FROM versions WHERE asset_id=? ORDER BY number DESC', asset.id).map(v => ({...versionData(v, true, req.user, asset),reviewer:v.reviewer_id?publicUser(one('SELECT * FROM users WHERE id=?',v.reviewer_id)):null})), permissions: (has(req.user,'pm') || manage(req.user,asset)) ? all('SELECT p.user_id AS userId,p.level,u.name FROM asset_permissions p JOIN users u ON u.id=p.user_id WHERE p.asset_id=? ORDER BY u.name',asset.id) : [], events: restricted ? [] : all('SELECT * FROM events WHERE asset_id=? ORDER BY created_at DESC,rowid DESC LIMIT 250', asset.id).map(e => ({ ...e, detail: parse(e.detail) })), submissions: restricted ? [] : all('SELECT s.id,s.version_id,s.round,s.snapshot,s.created_at,u.name AS submitter FROM submissions s JOIN versions v ON v.id=s.version_id JOIN users u ON u.id=s.submitter_id WHERE v.asset_id=? ORDER BY s.created_at DESC', asset.id).map(s => ({ ...s, snapshot: parse(s.snapshot) })) });
  });
  app.get('/api/assets/:id/grant-candidates',(req,res)=>{const asset=assetFor(req.user,req.params.id);if(!(has(req.user,'pm')||(has(req.user,'supervisor')&&manage(req.user,asset)))) fail(403,'无授权权限');res.json(all('SELECT * FROM users WHERE enabled=1 ORDER BY name').filter(u=>u.id!==asset.owner_id&&parse(u.roles,[]).length).map(publicUser));});
  app.put('/api/assets/:id/permissions/:userId',(req,res)=>{const asset=assetFor(req.user,req.params.id);if(!(has(req.user,'pm')||(has(req.user,'supervisor')&&manage(req.user,asset)))) fail(403,'无授权权限');const level=z.enum(['readonly','upload','manage']).parse(req.body.level),target=one('SELECT * FROM users WHERE id=? AND enabled=1',req.params.userId);if(!target||target.id===asset.owner_id) fail(400,'请选择有效成员');run('INSERT INTO asset_permissions(asset_id,user_id,level,granted_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(asset_id,user_id) DO UPDATE SET level=excluded.level,granted_by=excluded.granted_by,created_at=excluded.created_at',asset.id,target.id,level,req.user.id,now());event(req.user,'permission_grant',asset.id,null,{userId:target.id,name:target.name,level});res.json({ok:true});});
  app.delete('/api/assets/:id/permissions/:userId',(req,res)=>{const asset=assetFor(req.user,req.params.id);if(!(has(req.user,'pm')||(has(req.user,'supervisor')&&manage(req.user,asset)))) fail(403,'无授权权限');run('DELETE FROM asset_permissions WHERE asset_id=? AND user_id=?',asset.id,req.params.userId);event(req.user,'permission_revoke',asset.id,null,{userId:req.params.userId});res.json({ok:true});});
  app.post('/api/assets', (req, res) => {
    if (!has(req.user, 'employee') && !has(req.user, 'supervisor')) fail(403, '当前角色不能创建 Demo');
    const description = descriptionSchema.parse(req.body.description || {});
    const requestId = req.body.requestId ? z.uuid().parse(req.body.requestId) : null;
    const id = uid(), versionId = uid(), time = now();
    const result = tx(() => {
      if (requestId) {
        const cached = one('SELECT * FROM idempotency WHERE user_id=? AND request_id=?', req.user.id, requestId);
        if (cached) { if (cached.payload !== JSON.stringify(description)) fail(409, '此请求已保存，请重新打开已创建的 Demo'); return parse(cached.result); }
      }
      run('INSERT INTO assets(id,owner_id,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)', id, req.user.id, req.user.id, time, time);
      run('INSERT INTO versions(id,asset_id,number,status,description,creator_id,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?)', versionId, id, 'draft', JSON.stringify(description), req.user.id, time, time);
      event(req.user, 'create', id, versionId);
      if (requestId) run('INSERT INTO idempotency VALUES(?,?,?,?)', req.user.id, requestId, JSON.stringify(description), JSON.stringify({ id, versionId }));
      return { id, versionId };
    }); res.status(201).json(result);
  });
  app.post('/api/assets/:id/versions', (req, res) => {
    const result = tx(() => {
      const asset = assetFor(req.user, req.params.id);
      if (!editAccess(req.user, asset)) fail(403, '无修改权限');
      checkRevision(asset, revisionSchema.parse(req.body).revision);
      if (one("SELECT id FROM versions WHERE asset_id=? AND status IN ('draft','pending','returned')", asset.id)) fail(409, '已有未完成版本，请先处理');
      const base = one('SELECT * FROM versions WHERE id=? AND asset_id=?', req.body.baseVersionId || '', asset.id);
      if (!base) fail(400, '请选择基础版本');
      if (base.status !== 'published') fail(409, '只能复制正常已发布的版本；下架文件不能复用');
      const id = uid(), time = now(), description = { ...parse(base.description), changes: '' };
      run('INSERT INTO versions(id,asset_id,number,status,description,creator_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, asset.id, asset.next_number, 'draft', JSON.stringify(description), req.user.id, time, time);
      run('INSERT INTO version_files SELECT ?,file_id FROM version_files WHERE version_id=?', id, base.id);
      run('UPDATE assets SET next_number=next_number+1 WHERE id=?', asset.id); touch(asset.id);
      event(req.user, 'new_version', asset.id, id, { baseVersion: base.number, number: asset.next_number });
      return { versionId: id };
    }); res.status(201).json(result);
  });
  app.put('/api/versions/:id', (req, res) => {
    const { revision } = revisionSchema.parse(req.body), description = descriptionSchema.parse(req.body.description);
    tx(() => {
      const { asset, version } = versionFor(req.user, req.params.id); editable(req.user, asset, version); checkRevision(version, revision);
      run('UPDATE versions SET description=?,revision=revision+1,updated_at=? WHERE id=?', JSON.stringify(description), now(), version.id); touch(asset.id);
      event(req.user, 'edit', asset.id, version.id, { before: parse(version.description), after: description });
    }); res.json({ ok: true });
  });
  app.delete('/api/versions/:id', (req, res) => {
    tx(() => {
      const { asset, version } = versionFor(req.user, req.params.id); editable(req.user, asset, version); checkRevision(version, revisionSchema.parse(req.body).revision);
      if (version.status !== 'draft' || version.submission_count) fail(409, '只能删除从未提交的草稿');
      const snapshot = versionData(version);
      run('DELETE FROM versions WHERE id=?', version.id); event(req.user, 'delete_draft', asset.id, version.id, { version: snapshot });
      if (!one('SELECT id FROM versions WHERE asset_id=?', asset.id)) run('DELETE FROM assets WHERE id=?', asset.id); else touch(asset.id);
    }); res.json({ ok: true });
  });
  const validatePublish = version => {
    const d = parse(version.description), conf = settings();
    for (const [key, label] of [['title', '名称'], ['summary', '简介'], ['category', '分类'], ['content', '数据说明'], ['costEstimate', '成本预估'], ['difficulty', '难度说明']]) if (!d[key]?.trim()) fail(400, `请填写${label}`);
    if (!conf.categories.includes(d.category)) fail(400, '请选择当前有效的业务分类');
    if (version.number > 1 && !d.changes?.trim()) fail(400, '请填写本次变更说明');
    const files = filesFor(version.id);
    if (!files.length) fail(400, '请至少上传一个完整文件');
    if (files.length > conf.maxFiles || files.reduce((s, f) => s + f.size, 0) > conf.maxVersionMB * 1048576 || files.some(f => f.size > conf.maxFileMB * 1048576)) fail(400, '文件超过当前上传限制，请调整文件或联系管理员');
    for (const f of files) { const target = path.join(store.root, 'files', f.id); if (!fs.existsSync(target) || fs.statSync(target).size !== f.size) fail(409, '文件缺失或不完整，请重新上传'); }
  };
  app.post('/api/versions/:id/actions', (req, res) => {
    const { revision, action, reason, supervisorId, ccUserIds } = revisionSchema.extend({ action: z.enum(['submit', 'withdraw', 'reject', 'publish', 'unpublish', 'restore', 'set_default']), reason: z.string().max(5000).default(''), supervisorId:z.string().optional(), ccUserIds:z.array(z.string()).max(100).default([]) }).parse(req.body);
    tx(() => {
      const { asset, version } = versionFor(req.user, req.params.id); checkRevision(version, revision);
      let status = version.status, round = version.submission_count;
      if (action === 'submit') {
        if (!own(req.user, asset) || manage(req.user, asset)) fail(403, '仅归属员工可提交，主管可直接发布');
        if (!['draft', 'returned'].includes(status)) fail(409, '当前状态不能提交');
        const supervisor = one('SELECT * FROM users WHERE id=?', supervisorId || req.user.supervisor_id || '');
        if (!supervisor?.enabled || !has(supervisor, 'supervisor') || supervisor.id===req.user.id) fail(400, '请选择有效的审核主管');
        validatePublish(version); round++; status = 'pending';
        run('UPDATE versions SET reviewer_id=? WHERE id=?',supervisor.id,version.id);
        run('INSERT INTO submissions VALUES(?,?,?,?,?,?)', uid(), version.id, round, req.user.id, JSON.stringify({ ...versionData(version), submitter: req.user.name, supervisor: supervisor.name }), now());
      } else if (action === 'withdraw') {
        if (!own(req.user, asset) || status !== 'pending') fail(403, '当前版本无法撤回'); status = 'draft';
      } else {
        if (!manage(req.user, asset)) fail(403, '只有负责主管可以执行此操作');
        if (['reject', 'unpublish', 'restore'].includes(action) && !reason.trim()) fail(400, '请填写处理原因');
        if (action === 'reject') { if (status !== 'pending') fail(409, '只能退回待审核版本'); status = 'returned'; }
        if (action === 'publish') { if (!working.includes(status)) fail(409, '当前版本不可重复发布'); validatePublish(version); status = 'published'; for(const userId of [...new Set(ccUserIds)]) { const recipient=one('SELECT * FROM users WHERE id=? AND enabled=1',userId); if(!recipient||!parse(recipient.roles,[]).length) fail(400,'抄送人员中包含无效账号'); if(recipient.id!==req.user.id) run('INSERT OR IGNORE INTO version_cc VALUES(?,?,?,?)',version.id,recipient.id,req.user.id,now()); } }
        if (action === 'unpublish') { if (status !== 'published') fail(409, '只能下架已发布版本'); status = 'offline'; if (asset.current_version_id === version.id) run('UPDATE assets SET current_version_id=NULL WHERE id=?', asset.id); }
        if (action === 'restore') { if (status !== 'offline') fail(409, '只能恢复已下架版本'); validatePublish(version); status = 'published'; }
        if (action === 'set_default') { if (status !== 'published') fail(409, '只有正常发布版本可设为默认'); }
        if (['publish', 'restore', 'set_default'].includes(action)) run('UPDATE assets SET current_version_id=? WHERE id=?', version.id, asset.id);
      }
      run('UPDATE versions SET status=?,submission_count=?,revision=revision+1,updated_at=?,published_at=? WHERE id=?', status, round, now(), ['publish', 'restore'].includes(action) ? now() : version.published_at, version.id);
      notifications.enqueue(action, asset, version, req.user, round, { reason, from: version.status, to: status });
      touch(asset.id); event(req.user, action, asset.id, version.id, { reason, from: version.status, to: status, round, direct: action === 'publish' && version.status !== 'pending', snapshot: ['publish', 'restore'].includes(action) ? versionData(one('SELECT * FROM versions WHERE id=?', version.id)) : undefined });
    }); res.json({ ok: true });
  });
  app.post('/api/versions/:id/files', async (req, res, next) => {
    let uploaded;
    try {
      let context = versionFor(req.user, req.params.id); editable(req.user, context.asset, context.version);
      const revision = Number(req.get('x-revision')); checkRevision(context.version, revision);
      const conf = settings();
      const upload = multer({ storage: multer.diskStorage({ destination: path.join(store.root, 'tmp'), filename: (r, f, cb) => cb(null, uid()) }), limits: { fileSize: conf.maxFileMB * 1048576, files: 1, fields: 0, parts: 2 } }).single('file');
      await new Promise((resolve, reject) => upload(req, res, err => err ? reject(err) : resolve()));
      uploaded = req.file;
      if (!uploaded || uploaded.size === 0) fail(400, '请选择非空文件');
      const checksum = createHash('sha256');
      for await (const chunk of fs.createReadStream(uploaded.path)) checksum.update(chunk);
      const fileId = uid();
      const decoded = Buffer.from(uploaded.originalname, 'latin1').toString('utf8');
      const original = decoded.includes('\uFFFD') ? uploaded.originalname : decoded;
      const name = path.win32.basename(path.posix.basename(original)).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 240) || '文件';
      tx(() => {
        const user = auth.getUser(req);
        if (!user?.enabled || !parse(user.roles, []).length) fail(403, '当前账号已失去访问权限');
        context = versionFor(user, req.params.id); editable(user, context.asset, context.version); checkRevision(context.version, revision);
        const files = filesFor(context.version.id), limits = settings();
        if (files.length >= limits.maxFiles || uploaded.size > limits.maxFileMB * 1048576 || files.reduce((s, f) => s + f.size, 0) + uploaded.size > limits.maxVersionMB * 1048576) fail(400, '文件数量或总大小超过限制');
        fs.renameSync(uploaded.path, path.join(store.root, 'files', fileId)); uploaded.finalPath = path.join(store.root, 'files', fileId);
        run('INSERT INTO files VALUES(?,?,?,?,?,?)', fileId, name, uploaded.size, checksum.digest('hex'), user.id, now());
        run('INSERT INTO version_files VALUES(?,?)', context.version.id, fileId);
        run('UPDATE versions SET revision=revision+1,updated_at=? WHERE id=?', now(), context.version.id); touch(context.asset.id);
        event(user, 'upload', context.asset.id, context.version.id, { fileId, name, size: uploaded.size });
      });
      uploaded.committed = true; res.status(201).json({ id: fileId, revision: revision + 1 });
    } catch (e) { next(e); }
    finally { if (uploaded) { if (fs.existsSync(uploaded.path)) fs.unlinkSync(uploaded.path); if (uploaded.finalPath && !uploaded.committed && fs.existsSync(uploaded.finalPath)) fs.unlinkSync(uploaded.finalPath); } }
  });
  app.delete('/api/versions/:id/files/:fileId', (req, res) => {
    tx(() => {
      const { asset, version } = versionFor(req.user, req.params.id); editable(req.user, asset, version); checkRevision(version, revisionSchema.parse(req.body).revision);
      const file = filesFor(version.id).find(f => f.id === req.params.fileId); if (!file) fail(404, '文件不存在');
      run('DELETE FROM version_files WHERE version_id=? AND file_id=?', version.id, file.id);
      run('UPDATE versions SET revision=revision+1,updated_at=? WHERE id=?', now(), version.id); touch(asset.id); event(req.user, 'remove_file', asset.id, version.id, { file });
    }); res.json({ ok: true });
  });
  app.get('/api/versions/:id/files/:fileId/download', (req, res, next) => {
    const { asset, version } = versionFor(req.user, req.params.id);
    if (version.status === 'offline') fail(403, '此版本已下架，停止下载');
    const file = filesFor(version.id).find(f => f.id === req.params.fileId); if (!file) fail(404, '文件不存在');
    const target = path.join(store.root, 'files', file.id); if (!fs.existsSync(target)) fail(404, '文件缺失，请联系管理员恢复');
    res.type('application/octet-stream');
    // Only the authorized UUID is served; a private storage directory may itself
    // start with a dot (e.g. .preview-data), which send otherwise rejects.
    res.download(target, file.name, { dotfiles: 'allow', cacheControl: false }, err => { if (err) { if (!res.headersSent) { res.removeHeader('Content-Disposition'); res.type('application/json'); next(err); } } else event(req.user, 'download', asset.id, version.id, { name: file.name, fileId: file.id, version: version.number }); });
  });
  app.get('/api/versions/:id/files/:fileId/preview', async (req, res, next) => {
    try {
      const { version } = versionFor(req.user, req.params.id);
      if (version.status === 'offline') fail(403, '此版本已下架，停止预览');
      const file = filesFor(version.id).find(f => f.id === req.params.fileId);
      if (!file) fail(404, '文件不存在');
      const target = path.resolve(store.root, 'files', file.id);
      if (!fs.existsSync(target)) fail(404, '文件缺失');
      await servePreview(req, res, file, target);
    } catch (err) { next(err); }
  });
  const ragSearch = createRagSearch(store, config, { visible, summary, descriptionFor });
  app.post('/api/search/rag', async (req, res) => res.json(await ragSearch(req.user, req.body)));
  app.post('/api/search/rag/stream', async (req, res, next) => {
    res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    const emit = value => res.write(JSON.stringify(value) + '\n');
    try { const result = await ragSearch(req.user, req.body, emit); emit({ type: 'result', ...result }); res.end(); }
    catch (error) { if (!res.headersSent) return next(error); emit({ type: 'error', error: error.message || '检索失败' }); res.end(); }
  });
  const admin = (req, res, next) => { if (!has(req.user, 'admin')) fail(403, '需要管理员权限'); next(); };
  app.get('/api/admin/notifications', admin, (req, res) => res.json(notifications.list()));
  app.post('/api/admin/notifications/:id/retry', admin, (req, res) => {
    run("UPDATE notifications SET status='pending',attempts=0,next_at=0 WHERE id=? AND status='failed'", req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/admin/users', admin, (req, res) => res.json(all('SELECT * FROM users ORDER BY created_at').map(publicUser)));
  app.put('/api/admin/users/:id', admin, (req, res) => {
    const input = revisionSchema.extend({ roles: z.array(z.enum(roles)).max(5), supervisorId: z.string().nullable(), enabled: z.boolean() }).parse(req.body);
    tx(() => {
      const target = one('SELECT * FROM users WHERE id=?', req.params.id); if (!target) fail(404, '用户不存在'); checkRevision(target, input.revision);
      if (target.id === req.user.id && (!input.enabled || !input.roles.includes('admin'))) fail(400, '不能停用自己或移除自己的管理员权限');
      if (input.supervisorId) { const s = one('SELECT * FROM users WHERE id=?', input.supervisorId); if (input.supervisorId === target.id || !s?.enabled || !has(s, 'supervisor')) fail(400, '请选择有效主管，不能选择本人'); }
      if ((!input.enabled || !input.roles.includes('supervisor')) && one('SELECT id FROM users WHERE supervisor_id=?', target.id)) fail(400, '请先将该主管负责的员工转交其他主管');
      if ((!input.enabled || !input.roles.some(r => ['employee', 'supervisor'].includes(r))) && one('SELECT id FROM assets WHERE owner_id=?', target.id)) fail(400, '请先交接该用户的 Demo，再停用或移除业务角色');
      run('UPDATE users SET roles=?,supervisor_id=?,enabled=?,revision=revision+1 WHERE id=?', JSON.stringify([...new Set(input.roles)]), input.supervisorId, Number(input.enabled), target.id);
      event(req.user, 'user_update', null, null, { user: target.name, before: publicUser(target), after: input });
    }); res.json({ ok: true });
  });
  app.get('/api/admin/assets', admin, (req, res) => res.json(all('SELECT a.id,a.owner_id,a.revision,v.description FROM assets a LEFT JOIN versions v ON v.id=(SELECT id FROM versions WHERE asset_id=a.id ORDER BY number DESC LIMIT 1)').map(a => ({ id: a.id, ownerId: a.owner_id, revision: a.revision, title: parse(a.description).title || '未命名 Demo' }))));
  app.post('/api/admin/assets/:id/transfer', admin, (req, res) => {
    const input = revisionSchema.extend({ ownerId: z.string(), reason: z.string().trim().min(1).max(2000) }).parse(req.body);
    tx(() => {
      const asset = one('SELECT * FROM assets WHERE id=?', req.params.id), owner = one('SELECT * FROM users WHERE id=?', input.ownerId);
      if (!asset) fail(404, '资产不存在'); checkRevision(asset, input.revision);
      if (!owner?.enabled || !parse(owner.roles, []).some(r => ['employee', 'supervisor'].includes(r))) fail(400, '新归属人须为已启用的员工或主管');
      if (!has(owner, 'supervisor') && !one('SELECT id FROM users WHERE id=? AND enabled=1', owner.supervisor_id || '')) fail(400, '新归属员工尚未分配有效主管');
      run('UPDATE assets SET owner_id=? WHERE id=?', owner.id, asset.id); touch(asset.id); event(req.user, 'transfer', asset.id, null, { from: one('SELECT name FROM users WHERE id=?', asset.owner_id)?.name, to: owner.name, reason: input.reason });
    }); res.json({ ok: true });
  });
  app.post('/api/admin/assets/transfer-batch', admin, (req, res) => {
    const input = z.object({ assets: z.array(z.object({ id: z.string(), revision: z.number().int().nonnegative() })).min(1).max(100), ownerId: z.string(), reason: z.string().trim().min(1).max(2000) }).parse(req.body);
    tx(() => {
      const owner = one('SELECT * FROM users WHERE id=?', input.ownerId);
      if (!owner?.enabled || !parse(owner.roles, []).some(r => ['employee', 'supervisor'].includes(r))) fail(400, '新归属人须为已启用的员工或主管');
      if (!has(owner, 'supervisor') && !one('SELECT id FROM users WHERE id=? AND enabled=1', owner.supervisor_id || '')) fail(400, '新归属员工尚未分配有效主管');
      const selected = input.assets.map(item => {
        const asset = one('SELECT * FROM assets WHERE id=?', item.id);
        if (!asset) fail(404, '部分资产不存在，请刷新后重试');
        checkRevision(asset, item.revision);
        return asset;
      });
      for (const asset of selected) {
        if (asset.owner_id === owner.id) continue;
        const from = one('SELECT name FROM users WHERE id=?', asset.owner_id)?.name;
        run('UPDATE assets SET owner_id=? WHERE id=?', owner.id, asset.id); touch(asset.id);
        event(req.user, 'transfer', asset.id, null, { from, to: owner.name, reason: input.reason, batchSize: selected.length });
      }
    }); res.json({ ok: true, count: input.assets.length });
  });
  app.put('/api/admin/settings', admin, (req, res) => {
    const input = revisionSchema.extend({ categories: z.array(z.string().trim().min(1).max(80)).min(1).max(100), maxFileMB: z.number().int().min(1).max(10240), maxVersionMB: z.number().int().min(1).max(51200), maxFiles: z.number().int().min(1).max(100) }).parse(req.body);
    if (input.maxVersionMB < input.maxFileMB) fail(400, '单版本总大小不能小于单文件限制');
    tx(() => { const current = settings(); checkRevision(current, input.revision); const { revision, ...value } = input; value.categories = [...new Set(value.categories)]; run('UPDATE settings SET value=?,revision=revision+1 WHERE id=1', JSON.stringify(value)); event(req.user, 'settings_update', null, null, { before: current, after: value }); }); res.json({ ok: true });
  });
  let backupTask = null;
  app.post('/api/admin/backups', admin, (req, res) => {
    if (backupTask?.status === 'running') return res.status(409).json({ error: '已有备份正在进行，请稍后查看结果' });
    const directory = config.backupDir || process.env.BACKUP_DIR || (config.demoMode ? '.preview-backups' : 'backups');
    const task = { id: uid(), status: 'running', startedAt: now() }; backupTask = task;
    event(req.user, 'backup_start', null, null, { taskId: task.id });
    createBackup(store.root, path.resolve(directory, `backup-${task.id}`)).then(result => {
      task.status = 'complete'; task.result = result; event(req.user, 'backup_complete', null, null, { taskId: task.id, ...result });
    }).catch(err => {
      task.status = 'failed'; task.error = '备份失败，请检查磁盘空间及备份目录权限';
      event(req.user, 'backup_failed', null, null, { taskId: task.id }); console.error('Backup failed:', err.code || err.message);
    });
    res.status(202).json(task);
  });
  app.get('/api/admin/health', admin, (req, res) => {
    const disk = fs.statfsSync(store.root); res.json({ freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize, usedFileBytes: one('SELECT COALESCE(SUM(size),0) AS total FROM files').total, backup: parse(one("SELECT value FROM metadata WHERE key='last_backup'")?.value, null), backupTask,
      version: '1.1.0', uptime: Math.floor(process.uptime()), mode: config.demoMode ? 'preview' : 'production',
      feishu: { appId: !!config.appId, appSecret: !!config.appSecret, tenantKey: !!config.tenantKey, callback: config.origin + '/api/auth/callback' },
      descriptionAgent: { key: !!config.descriptionAgentKey, url: !!config.descriptionAgentUrl, model: config.descriptionAgentModel || '' } });
  });
  app.get('/api/admin/events', admin, (req, res) => res.json(all('SELECT * FROM events WHERE asset_id IS NULL ORDER BY created_at DESC LIMIT 100').map(e => ({ ...e, detail: parse(e.detail) }))));
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  const dist = path.resolve('dist');
  if (fs.existsSync(dist)) { app.use(express.static(dist, { index: false })); app.get('/{*path}', (req, res) => res.sendFile(path.join(dist, 'index.html'))); }
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof z.ZodError) return res.status(400).json({ error: '表单格式不正确：' + err.issues.map(i => i.path.join('.') + ' ' + i.message).join('；') });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? '文件超过大小限制' : '上传格式或数量不符合限制' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(`[${now()}] ${req.method} request failed`, err.code || err.name, err.message);
    res.status(500).json({ error: '操作失败，请稍后重试；如持续出现请联系管理员' });
  });
  return { app, store, config, notifications };
}
