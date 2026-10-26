import { createHash } from 'node:crypto';
import { now, parse } from './db.mjs';
import { feishuDocumentLink } from '../shared/requirement-links.mjs';

const text = (content, url) => ({ text_run: { content, ...(url ? { text_element_style: { link: { url } } } : {}) } });
const key = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const paragraph = elements => ({ block_type: 2, text: { elements } });
// Keep individual text runs and blocks small enough for the Docx API, including long descriptions.
function paragraphs(value) {
  const characters = Array.from(value), blocks = [];
  for (let start = 0; start < characters.length; start += 4000) {
    const elements = [];
    for (let offset = start; offset < Math.min(start + 4000, characters.length); offset += 1000) elements.push(text(characters.slice(offset, Math.min(offset + 1000, start + 4000)).join('')));
    blocks.push(paragraph(elements));
  }
  return blocks;
}

export function createRequirementWiki(store, config) {
  const { one, all, run } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS requirement_wiki (
    requirement_id TEXT PRIMARY KEY REFERENCES requirements(id),
    space_id TEXT NOT NULL DEFAULT '', parent_token TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '',
    node_token TEXT NOT NULL DEFAULT '', document_id TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
    summary_block TEXT NOT NULL DEFAULT '', files_block TEXT NOT NULL DEFAULT '',
    initial_content TEXT NOT NULL DEFAULT '', synced_content TEXT NOT NULL DEFAULT '',
    managed_permissions TEXT NOT NULL DEFAULT '{}', generation INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, synced_at TEXT
  ); CREATE INDEX IF NOT EXISTS requirement_wiki_pending ON requirement_wiki(status,next_at);
  CREATE TABLE IF NOT EXISTS requirement_wiki_demo_content (
    requirement_id TEXT PRIMARY KEY REFERENCES requirements(id),
    block_ids TEXT NOT NULL DEFAULT '[]', synced_content TEXT NOT NULL DEFAULT '[]', pending_content TEXT NOT NULL DEFAULT ''
  );`);
  function enqueue(id) {
    run(`INSERT INTO requirement_wiki(requirement_id,updated_at) VALUES(?,?) ON CONFLICT(requirement_id)
      DO UPDATE SET generation=generation+1,status='pending',attempts=0,next_at=0,error='',updated_at=excluded.updated_at`, id, now());
  }
  // Existing requirements are created only on an explicit sync; upgrading does not flood the wiki.
  function enqueueExisting(id) { if (one('SELECT 1 FROM requirement_wiki WHERE requirement_id=?', id)) enqueue(id); }
  function prepareExport(id) {
    const job = one('SELECT status FROM requirement_wiki WHERE requirement_id=?', id);
    if (job?.status === 'pending') run('UPDATE requirement_wiki SET next_at=0 WHERE requirement_id=?', id);
    else enqueue(id);
    return one('SELECT generation FROM requirement_wiki WHERE requirement_id=?', id).generation;
  }
  function configurationError() {
    if (!config.appId || !config.appSecret) return '未配置飞书应用凭据，请管理员配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET';
    if (feishuDocumentLink(config.requirementWikiSampleUrl)?.type !== 'wiki') return '未配置有效的 FEISHU_REQUIREMENT_WIKI_SAMPLE_URL，请填写 sample 的飞书知识库链接';
    return '';
  }
  function enqueueForAsset(id) {
    for (const row of all('SELECT ar.requirement_id FROM asset_requirements ar JOIN requirement_wiki w ON w.requirement_id=ar.requirement_id WHERE ar.asset_id=?', id)) enqueue(row.requirement_id);
  }
  function enqueueForUser(id) {
    for (const row of all('SELECT r.id FROM requirements r JOIN requirement_wiki w ON w.requirement_id=r.id WHERE r.publisher_id=? OR EXISTS(SELECT 1 FROM requirement_assignees ra WHERE ra.requirement_id=r.id AND ra.user_id=?)', id, id)) enqueue(row.id);
  }
  function info(id) {
    const row = one('SELECT status,error,url,synced_at FROM requirement_wiki WHERE requirement_id=?', id);
    return row ? { status: row.status, error: row.error, url: feishuDocumentLink(row.url)?.url || '', syncedAt: row.synced_at } : { status: 'not_created', error: '', url: '', syncedAt: null };
  }
  function retry(id) {
    const row = one('SELECT status FROM requirement_wiki WHERE requirement_id=?', id);
    if (row?.status === 'pending') return false;
    enqueue(id); return true;
  }
  const list = () => all('SELECT w.requirement_id,r.title FROM requirement_wiki w JOIN requirements r ON r.id=w.requirement_id ORDER BY w.updated_at DESC LIMIT 100').map(row => ({ ...row, ...info(row.requirement_id) }));
  const people = id => all(`SELECT u.* FROM users u WHERE u.enabled=1 AND u.deleted_at IS NULL AND
    (u.id=(SELECT publisher_id FROM requirements WHERE id=?) OR EXISTS(SELECT 1 FROM requirement_assignees ra WHERE ra.requirement_id=? AND ra.user_id=u.id)) ORDER BY u.id`, id, id).filter(user => !user.open_id.startsWith('preview:'));
  const call = config.wikiFetch || fetch;
  let token = '', expires = 0, running = null;
  async function tokenFor() {
    if (token && expires > Date.now()) return token;
    if (!config.appId || !config.appSecret) throw new Error('未配置飞书应用凭据');
    const response = await call('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }) });
    const data = await response.json();
    if (!response.ok || data.code !== 0 || !data.tenant_access_token) throw new Error(`飞书文档应用鉴权失败 (${data.code || response.status})`);
    token = data.tenant_access_token; expires = Date.now() + Math.max(0, (data.expire || 7200) - 120) * 1000;
    return token;
  }
  async function request(resource, method = 'GET', body) {
    const bearer = await tokenFor();
    const response = await call('https://open.feishu.cn/open-apis/' + resource, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      token = '';
      throw new Error(`飞书需求文档同步失败 (${data.code || response.status})，请检查知识库节点、新版文档和协作者权限，并发布应用版本`);
    }
    return data.data || {};
  }
  async function destination(job) {
    if (job.space_id) return job;
    const sample = feishuDocumentLink(config.requirementWikiSampleUrl);
    if (sample?.type !== 'wiki') throw new Error('未配置有效的 FEISHU_REQUIREMENT_WIKI_SAMPLE_URL，请填写 sample 的飞书知识库链接');
    const data = await request('wiki/v2/spaces/get_node?' + new URLSearchParams({ token: sample.token, obj_type: 'wiki' }));
    const node = data.node;
    if (!node?.space_id || !node.node_token) throw new Error('飞书 sample 未返回知识库目录信息');
    run('UPDATE requirement_wiki SET space_id=?,parent_token=?,host=? WHERE requirement_id=?', node.space_id, node.parent_node_token || '', new URL(sample.url).origin, job.requirement_id);
    return one('SELECT * FROM requirement_wiki WHERE requirement_id=?', job.requirement_id);
  }
  async function nodeFor(job) {
    if (job.node_token) return job;
    job = await destination(job);
    // A stable temporary title allows recovery if creating a node succeeded but its response was lost.
    const temporaryTitle = `PRT需求-${job.requirement_id}`, root = `wiki/v2/spaces/${encodeURIComponent(job.space_id)}/nodes`;
    let page = '', node;
    do {
      const data = await request(root + '?' + new URLSearchParams({ page_size: '50', ...(job.parent_token ? { parent_node_token: job.parent_token } : {}), ...(page ? { page_token: page } : {}) }));
      node = data.items?.find(item => item.title === temporaryTitle && item.obj_type === 'docx' && item.node_type === 'origin');
      if (node) break;
      if (data.has_more && (!data.page_token || data.page_token === page)) throw new Error('飞书知识库目录分页异常，请稍后重试');
      page = data.has_more ? data.page_token : '';
    } while (page);
    if (!node) node = (await request(root, 'POST', { obj_type: 'docx', node_type: 'origin', title: temporaryTitle, ...(job.parent_token ? { parent_node_token: job.parent_token } : {}) })).node;
    if (!/^[a-zA-Z0-9]+$/.test(node?.node_token || '') || !/^[a-zA-Z0-9]+$/.test(node?.obj_token || '')) throw new Error('飞书创建需求文档未返回有效文档 ID');
    const url = job.host + '/wiki/' + node.node_token;
    run('UPDATE requirement_wiki SET node_token=?,document_id=?,url=? WHERE requirement_id=?', node.node_token, node.obj_token, url, job.requirement_id);
    return one('SELECT * FROM requirement_wiki WHERE requirement_id=?', job.requirement_id);
  }
  function initialContent(requirement) {
    const origin = new URL(config.publicOrigin || config.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('未配置有效的平台访问地址');
    const files = all('SELECT f.id,f.original_name FROM files f JOIN requirement_files rf ON rf.file_id=f.id WHERE rf.requirement_id=? ORDER BY rf.created_at,rf.file_id', requirement.id);
    const elements = files.flatMap((file, index) => [...(index ? [text('\n')] : []), text(file.original_name, new URL(`/api/requirements/${requirement.id}/documents/${file.id}/download`, origin).href)]);
    return { title: requirement.title, summary: [text(requirement.title)], files: elements.length ? elements : [text('尚未上传需求文档；上传后由平台同步下载链接。')] };
  }
  async function contentFor(job, requirement) {
    const root = `docx/v1/documents/${encodeURIComponent(job.document_id)}/blocks`, content = initialContent(requirement);
    if (!job.summary_block || !job.files_block) {
      // Persist the first request body with its client token so a restart replays the same creation.
      if (!job.initial_content) {
        job.initial_content = JSON.stringify(content);
        run('UPDATE requirement_wiki SET initial_content=? WHERE requirement_id=?', job.initial_content, requirement.id);
      }
      const initial = parse(job.initial_content);
      const data = await request(`${root}/${encodeURIComponent(job.document_id)}/children?` + new URLSearchParams({ document_revision_id: '-1', client_token: key(`init:${requirement.id}`) }), 'POST', { index: 0, children: [
        { block_type: 4, heading2: { elements: [text('需求简述')] } }, { block_type: 2, text: { elements: initial.summary } },
        { block_type: 4, heading2: { elements: [text('需求文档')] } }, { block_type: 2, text: { elements: initial.files } }
      ] });
      if (!data.children?.[1]?.block_id || !data.children?.[3]?.block_id) throw new Error('飞书初始化文档未返回完整区块 ID');
      job.summary_block = data.children[1].block_id; job.files_block = data.children[3].block_id;
      job.synced_content = job.initial_content;
      run('UPDATE requirement_wiki SET summary_block=?,files_block=?,synced_content=? WHERE requirement_id=?', job.summary_block, job.files_block, job.synced_content, requirement.id);
    }
    const previous = parse(job.synced_content);
    // Only these two application-owned text blocks are updated; user-added Demo content is untouched.
    for (const [field, id] of [['summary', job.summary_block], ['files', job.files_block]]) {
      if (JSON.stringify(previous[field]) !== JSON.stringify(content[field])) await request(`${root}/${encodeURIComponent(id)}?document_revision_id=-1`, 'PATCH', { update_text_elements: { elements: content[field] } });
    }
    if (previous.title !== content.title || !job.synced_at) await request(`wiki/v2/spaces/${encodeURIComponent(job.space_id)}/nodes/${encodeURIComponent(job.node_token)}/update_title`, 'POST', { title: content.title });
    run('UPDATE requirement_wiki SET synced_content=? WHERE requirement_id=?', JSON.stringify(content), requirement.id);
  }
  function demoContent(id) {
    const demos = all(`SELECT a.id,u.name AS owner,v.number,v.status,v.description,
      (SELECT COUNT(*) FROM version_files vf WHERE vf.version_id=v.id) AS file_count
      FROM assets a JOIN asset_requirements ar ON ar.asset_id=a.id JOIN users u ON u.id=a.owner_id
      JOIN versions v ON v.id=(SELECT latest.id FROM versions latest WHERE latest.asset_id=a.id AND latest.status!='offline'
        AND EXISTS(SELECT 1 FROM version_files vf WHERE vf.version_id=latest.id) ORDER BY latest.number DESC LIMIT 1)
      WHERE ar.requirement_id=? ORDER BY a.created_at,a.id`, id);
    const status = { draft: '草稿', pending: '待审核', returned: '已退回', published: '已发布' };
    return demos.flatMap(demo => {
      const description = parse(demo.description), url = new URL('/?' + new URLSearchParams({ demo: demo.id }), config.publicOrigin || config.origin).href;
      // Copy the saved description fields directly; no extra model call or regeneration is needed.
      return [
        ...paragraphs(`${description.title || '未命名 Demo'}\n归属人：${demo.owner}\n版本：V${demo.number} · ${status[demo.status] || demo.status} · ${demo.file_count} 个文件`),
        paragraph([text('在平台查看 Demo（文件下载需相应权限）', url)]),
        ...(description.summary ? paragraphs('简介\n' + description.summary) : []),
        ...(description.content ? paragraphs('数据说明\n' + description.content) : []),
        ...(description.costEstimate ? paragraphs('成本预估\n' + description.costEstimate) : []),
        ...(description.difficulty ? paragraphs('难度说明\n' + description.difficulty) : []),
        ...(description.notes ? paragraphs('注意事项\n' + description.notes) : [])
      ];
    });
  }
  async function demosFor(job) {
    let saved = one('SELECT * FROM requirement_wiki_demo_content WHERE requirement_id=?', job.requirement_id);
    const body = demoContent(job.requirement_id);
    // The initial requirement document still contains only the two requirement sections.
    if (!saved && !body.length) return;
    if (!saved) {
      run('INSERT INTO requirement_wiki_demo_content(requirement_id) VALUES(?)', job.requirement_id);
      saved = one('SELECT * FROM requirement_wiki_demo_content WHERE requirement_id=?', job.requirement_id);
    }
    const desired = [{ block_type: 4, heading2: { elements: [text('Demo 内容（平台自动同步）')] } }, ...(
      body.length ? body : [paragraph([text('暂无包含文件的关联 Demo。上传文件后自动同步；解除绑定、删除文件或下架后自动更新。')])]
    )];
    const ids = parse(saved.block_ids, []), previous = parse(saved.synced_content, []);
    const root = `docx/v1/documents/${encodeURIComponent(job.document_id)}/blocks`;
    // Persist each append body before sending; retries after a lost response reuse the same token and body.
    while (saved.pending_content || ids.length < desired.length) {
      if (!saved.pending_content) {
        saved.pending_content = JSON.stringify(desired.slice(ids.length, ids.length + 50));
        run('UPDATE requirement_wiki_demo_content SET pending_content=? WHERE requirement_id=?', saved.pending_content, job.requirement_id);
      }
      const pending = parse(saved.pending_content, []);
      const data = await request(`${root}/${encodeURIComponent(job.document_id)}/children?` + new URLSearchParams({ document_revision_id: '-1', client_token: key(`demos:${job.requirement_id}:${ids.length}`) }), 'POST', { children: pending });
      if (data.children?.length !== pending.length || data.children.some(block => !block.block_id)) throw new Error('飞书同步 Demo 内容未返回完整区块 ID');
      ids.push(...data.children.map(block => block.block_id)); previous.push(...pending);
      run('UPDATE requirement_wiki_demo_content SET block_ids=?,synced_content=?,pending_content=\'\' WHERE requirement_id=?', JSON.stringify(ids), JSON.stringify(previous), job.requirement_id);
      saved.pending_content = '';
    }
    // Clear surplus app-owned paragraphs in place, so no user-added blocks need to be moved or deleted.
    for (let index = 1; index < ids.length; index++) {
      const block = desired[index] || paragraph([text(' ')]);
      if (JSON.stringify(previous[index]) === JSON.stringify(block)) continue;
      await request(`${root}/${encodeURIComponent(ids[index])}?document_revision_id=-1`, 'PATCH', { update_text_elements: { elements: block.text.elements } });
      previous[index] = block;
    }
    run('UPDATE requirement_wiki_demo_content SET synced_content=? WHERE requirement_id=?', JSON.stringify(previous), job.requirement_id);
  }
  async function permissionsFor(job) {
    const root = `drive/v1/permissions/${encodeURIComponent(job.node_token)}/members`, suffix = '?type=wiki';
    const data = await request(root + suffix + '&perm_type=single_page');
    const existing = new Map((data.items || []).filter(member => member.member_type === 'openid').map(member => [member.member_id, member]));
    const desired = new Set(people(job.requirement_id).map(user => user.open_id)), managed = parse(job.managed_permissions);
    const save = () => run('UPDATE requirement_wiki SET managed_permissions=? WHERE requirement_id=?', JSON.stringify(managed), job.requirement_id);
    for (const [id, previous] of Object.entries(managed)) if (!desired.has(id)) {
      if (existing.has(id)) {
        if (previous) await request(root + '/' + encodeURIComponent(id) + suffix + '&need_notification=false', 'PUT', { member_type: 'openid', type: 'user', perm_type: 'single_page', perm: previous });
        else await request(root + '/' + encodeURIComponent(id) + suffix + '&member_type=openid', 'DELETE', { type: 'user', perm_type: 'single_page' });
      }
      delete managed[id]; save();
    }
    for (const id of desired) {
      const member = existing.get(id);
      if (member && ['edit', 'full_access'].includes(member.perm)) continue;
      if (!(id in managed)) { managed[id] = member?.perm || null; save(); }
      const body = { member_type: 'openid', member_id: id, type: 'user', perm_type: 'single_page', perm: 'edit' };
      if (member) await request(root + '/' + encodeURIComponent(id) + suffix + '&need_notification=true', 'PUT', body);
      else await request(root + suffix + '&need_notification=true', 'POST', body);
    }
  }
  async function sync(job) {
    const requirement = one('SELECT * FROM requirements WHERE id=?', job.requirement_id);
    if (!requirement) return;
    const linked = await nodeFor(job);
    await contentFor(linked, requirement);
    await demosFor(linked);
    await permissionsFor(one('SELECT * FROM requirement_wiki WHERE requirement_id=?', requirement.id));
    run("UPDATE requirement_wiki SET status='synced',attempts=0,error='',synced_at=? WHERE requirement_id=? AND generation=?", now(), requirement.id, job.generation);
  }
  async function processJobs() {
    for (const job of all("SELECT * FROM requirement_wiki WHERE status='pending' AND next_at<=? ORDER BY updated_at,requirement_id LIMIT 5", Date.now())) {
      try { await sync(job); }
      catch (error) {
        const attempts = job.attempts + 1;
        const message = /^(飞书|未配置)/.test(error.message) ? error.message : '飞书需求文档网络请求失败，请稍后重试';
        run('UPDATE requirement_wiki SET status=?,attempts=?,next_at=?,error=? WHERE requirement_id=? AND generation=?', attempts >= 5 ? 'failed' : 'pending', attempts, Date.now() + Math.min(300000, 15000 * 2 ** attempts), message, job.requirement_id, job.generation);
      }
    }
  }
  function drain() {
    if (config.demoMode) return Promise.resolve();
    if (!running) running = processJobs().finally(() => { running = null; });
    return running;
  }
  return { enqueue, enqueueExisting, enqueueForAsset, enqueueForUser, prepareExport, configurationError, info, list, retry, drain, start() { const timer = setInterval(() => drain().catch(() => console.error('Requirement document worker failed')), 5000); timer.unref(); return () => { clearInterval(timer); return running; }; } };
}
