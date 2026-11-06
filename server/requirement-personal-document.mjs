import { createHash } from 'node:crypto';
import { uid, now, parse } from './db.mjs';
import { feishuDocumentLink } from '../shared/requirement-links.mjs';
import { safeFeishuAppLink } from '../shared/feishu-links.mjs';
import { heading, paragraph, field, markdownBlocks } from './feishu-document-blocks.mjs';
import { uploadDocumentAttachments } from './feishu-document-attachments.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const statusLabels = { open: '进行中', needs_update: '待更新', delivered: '已交付', closed: '已关闭', draft: '草稿', pending: '待审核', returned: '已退回', published: '已发布', offline: '已下架' };
const hash = value => createHash('sha256').update(value).digest('hex');
const displayedTime = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || '未设置' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date).replaceAll('/', '-');
};

// Follow the agreed template. File descriptors stay in the job snapshot, not in public text.
export function personalRequirementSnapshot(requirement) {
  const names = users => users?.map(user => user.name).join('、') || '未指定', attachments = [];
  const blocks = [
    heading('需求信息'), field('状态', statusLabels[requirement.status] || requirement.status),
    field('业务分类', requirement.category || '未分类'), field('发布人', requirement.publisher.name),
    field('发布日期', requirement.publishDate), field('截止日期', requirement.deadlineDate || '未设置'),
    field('更新时间', displayedTime(requirement.updatedAt)), field('平台链接', requirement.shareUrl, requirement.shareUrl)
  ];
  const calendarUrl = requirement.status === 'closed' ? '' : safeFeishuAppLink(requirement.calendar?.appLink);
  if (calendarUrl) blocks.push(field('日程链接', '打开需求日程', calendarUrl));
  blocks.push(heading('需求内容'), ...markdownBlocks(requirement.content), heading('负责人'),
    field('商务负责人', names(requirement.businessOwners)), field('研发负责人', names(requirement.developmentOwners)), heading('需求文档'));
  function files(items) {
    if (!items.length) { blocks.push(paragraph('暂无附件')); return; }
    for (const file of items) {
      blocks.push(paragraph(file.name));
      attachments.push({ position: blocks.length, id: file.id, name: file.name, size: file.size, checksum: file.checksum || '' });
      blocks.push({ block_type: 23, file: { token: '' } });
    }
  }
  files(requirement.documents);
  const demos = requirement.demos.filter(asset => asset.latest);
  for (const [key, label] of [['summary', '数据简介'], ['content', '数据说明'], ['dataVolume', '数据量级'], ['costEstimate', '成本预估'], ['difficulty', '难度说明'], ['notes', '注意事项']]) {
    blocks.push(heading(label));
    if (!demos.length) blocks.push(paragraph('未填写'));
    for (const asset of demos) {
      if (demos.length > 1) blocks.push(heading(asset.latest.description.title || '未命名 Demo', 2));
      blocks.push(...markdownBlocks(asset.latest.description[key], demos.length > 1 ? 3 : 2));
    }
  }
  blocks.push(heading('Demo'));
  if (!demos.length) blocks.push(paragraph('暂无可见 Demo'));
  for (const asset of demos) {
    blocks.push(heading(asset.latest.description.title || '未命名 Demo', 2),
      paragraph(`归属人：${asset.owner.name} · V${asset.latest.number} · ${statusLabels[asset.latest.status] || asset.latest.status}`),
      field('平台 Demo', '打开 Demo 详情', asset.shareUrl));
    files(asset.latest.files || []);
  }
  return { title: requirement.title, blocks, attachments };
}

export function createPersonalRequirementDocuments(store, config) {
  const { one, run } = store, active = new Map(), call = config.personalDocumentFetch || fetch;
  let liveDocuments;
  store.db.exec(`CREATE TABLE IF NOT EXISTS requirement_personal_documents (
    id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES requirements(id), user_id TEXT NOT NULL REFERENCES users(id),
    fingerprint TEXT NOT NULL, snapshot TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    document_id TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', next_block INTEGER NOT NULL DEFAULT 0,
    creating INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', authorization_required INTEGER NOT NULL DEFAULT 0,
    destination_url TEXT NOT NULL DEFAULT '', space_id TEXT NOT NULL DEFAULT '', node_token TEXT NOT NULL DEFAULT '', creation_uncertain INTEGER NOT NULL DEFAULT 0, attachment_state TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(requirement_id,user_id,fingerprint)
  );`);
  const columns = store.all('PRAGMA table_info(requirement_personal_documents)').map(column => column.name);
  for (const column of ['destination_url', 'space_id', 'node_token']) if (!columns.includes(column)) store.db.exec(`ALTER TABLE requirement_personal_documents ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  if (!columns.includes('attachment_state')) store.db.exec("ALTER TABLE requirement_personal_documents ADD COLUMN attachment_state TEXT NOT NULL DEFAULT '{}'");
  if (!columns.includes('creation_uncertain')) store.db.exec('ALTER TABLE requirement_personal_documents ADD COLUMN creation_uncertain INTEGER NOT NULL DEFAULT 0');
  if (!columns.includes('block_ids')) store.db.exec("ALTER TABLE requirement_personal_documents ADD COLUMN block_ids TEXT NOT NULL DEFAULT '[]'");
  run(`UPDATE requirement_personal_documents SET status=CASE WHEN creating=1 THEN 'uncertain' ELSE 'failed' END,
    creation_uncertain=CASE WHEN creating=1 THEN 1 ELSE creation_uncertain END,
    error=CASE WHEN creating=1 THEN '服务重启中断了文档创建，请先检查目标位置，知识库导出可重试查找已创建文档' ELSE '服务重启中断了导出，请重新授权后重试，已记录的文档会继续写入' END
    WHERE status='pending'`);
  const userAllowed = id => {
    const user = one('SELECT * FROM users WHERE id=?', id);
    return user?.enabled && !user.deleted_at && parse(user.roles, []).includes('pm');
  };
  function destination(value = config.requirementExportWikiParentUrl || '') {
    if (!value) return '';
    const link = feishuDocumentLink(value);
    if (link?.type !== 'wiki') throw new Error('FEISHU_REQUIREMENT_EXPORT_WIKI_PARENT_URL 必须是有效的飞书知识库节点链接');
    return new URL('/wiki/' + link.token, link.url).href;
  }
  const location = value => ({ destination: value ? 'wiki' : 'personal', destinationUrl: value });
  const fingerprintFor = (snapshot, destinationUrl) => hash(JSON.stringify(destinationUrl ? { snapshot, destinationUrl } : snapshot));
  const view = row => row ? { id: row.id, status: row.status, title: parse(row.snapshot).title, url: row.status === 'ready' ? row.url : '', error: row.error, authorizationRequired: !!row.authorization_required, completedBlocks: row.next_block, totalBlocks: parse(row.snapshot).blocks.length, totalAttachments: parse(row.snapshot).attachments?.length || 0, completedAttachments: Object.values(parse(row.attachment_state, {})).filter(item => item.done).length, ...location(row.destination_url) } : { status: 'not_created', ...location(destination()) };
  const latest = (requirementId, userId, snapshot) => {
    const destinationUrl = destination();
    const live = snapshot && liveDocuments?.current(requirementId, userId, snapshot, destinationUrl);
    if (live) return live;
    // An older task can finish after a newer one. Match the live content, never
    // treat whichever job last wrote its progress as the current export.
    if (snapshot) {
      const current = one('SELECT * FROM requirement_personal_documents WHERE requirement_id=? AND user_id=? AND destination_url=? AND fingerprint=?', requirementId, userId, destinationUrl, fingerprintFor(snapshot, destinationUrl));
      if (current) return view(current);
    }
    const previous = one('SELECT * FROM requirement_personal_documents WHERE requirement_id=? AND user_id=? AND destination_url=? ORDER BY created_at DESC,rowid DESC LIMIT 1', requirementId, userId, destinationUrl);
    return snapshot && previous ? { status: 'outdated', ...location(destinationUrl) } : view(previous);
  };
  const get = (id, userId) => { const row = one('SELECT * FROM requirement_personal_documents WHERE id=? AND user_id=?', id, userId); return row ? view(row) : null; };
  async function execute(id, token) {
    function checkRequirement() {
      if (!one('SELECT 1 FROM requirements r JOIN requirement_personal_documents d ON d.requirement_id=r.id WHERE d.id=? AND r.deleted_at IS NULL', id)) throw new Error('需求已删除，导出已停止');
    }
    async function request(resource, body, method = 'POST', timeout = 15000) {
      for (let attempt = 0; attempt < 3; attempt++) {
        checkRequirement();
        if (!userAllowed(one('SELECT user_id FROM requirement_personal_documents WHERE id=?', id).user_id)) throw new Error('当前账号已停用或不再具有项目经理权限，导出已停止');
        let response, payload;
        const multipart = body instanceof FormData;
        try {
          response = await call('https://open.feishu.cn/open-apis/' + resource, { method, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { ...(multipart ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` }, ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}) });
          try { payload = await response.json(); }
          catch (error) { if (response.ok && resource === 'drive/v1/medias/upload_part') payload = {}; else throw error; }
        } catch { const error = new Error('飞书接口网络异常或超时，请稍后重试'); error.uncertain = true; throw error; }
        if (!response.ok || payload?.code !== 0 && !(resource === 'drive/v1/medias/upload_part' && payload?.code === undefined)) {
          if (attempt < 2 && (response.status === 429 || payload?.code === 99991400)) { await delay(500 * (attempt + 1)); continue; }
          const error = new Error(`飞书文档导出失败（${payload?.code || response.status}），请检查用户身份的文档、附件上传及知识库权限，以及当前账号对目标位置的新增和编辑权限；发布应用版本后重新授权`);
          error.authorizationRequired = response.status === 401 || response.status === 403 || [99991663, 99991668, 99991671, 99991672, 99991677, 99991679, 99991680, 99991681].includes(payload?.code);
          error.uncertain = response.status >= 500;
          throw error;
        }
        return payload?.data || {};
      }
    }
    try {
      let job = one('SELECT * FROM requirement_personal_documents WHERE id=?', id), snapshot = parse(job.snapshot);
      const attachmentStates = parse(job.attachment_state, {}), blockIds = parse(job.block_ids, []);
      const persistAttachments = () => run('UPDATE requirement_personal_documents SET attachment_state=?,updated_at=? WHERE id=?', JSON.stringify(attachmentStates), now(), id);
      if (!job.document_id && job.destination_url) {
        const target = feishuDocumentLink(job.destination_url);
        if (!job.space_id) {
          const { node } = await request('wiki/v2/spaces/get_node?' + new URLSearchParams({ token: target.token, obj_type: 'wiki' }), null, 'GET');
          if (!/^[a-zA-Z0-9]+$/.test(node?.space_id || '') || node.node_token !== target.token) throw new Error('飞书未返回有效的目标知识库节点，请确认链接及当前账号的访问权限');
          run('UPDATE requirement_personal_documents SET space_id=? WHERE id=?', node.space_id, id);
          job.space_id = node.space_id;
        }
        const root = `wiki/v2/spaces/${job.space_id}/nodes`, temporaryTitle = 'PRT导出-' + id;
        let page = '', node;
        do {
          const listed = await request(root + '?' + new URLSearchParams({ parent_node_token: target.token, page_size: '50', ...(page ? { page_token: page } : {}) }), null, 'GET');
          node = listed.items?.find(item => item.title === temporaryTitle && item.obj_type === 'docx' && item.node_type === 'origin');
          if (node) break;
          if (listed.has_more && (!listed.page_token || listed.page_token === page)) throw new Error('飞书目标目录分页异常，请稍后重试');
          page = listed.has_more ? listed.page_token : '';
        } while (page);
        if (!node) {
          if (job.creation_uncertain) throw new Error('前次创建结果未确认，目标目录中尚未找到对应文档。请先检查目录可见权限，平台不会自动重复新建');
          run('UPDATE requirement_personal_documents SET creating=1 WHERE id=?', id);
          node = (await request(root, { obj_type: 'docx', node_type: 'origin', title: temporaryTitle, parent_node_token: target.token })).node;
        }
        if (!/^[a-zA-Z0-9]+$/.test(node?.obj_token || '') || !/^[a-zA-Z0-9]+$/.test(node?.node_token || '')) { const error = new Error('飞书未返回有效的知识库文档 ID'); error.uncertain = true; throw error; }
        run('UPDATE requirement_personal_documents SET document_id=?,node_token=?,url=?,creating=0,creation_uncertain=0,updated_at=? WHERE id=?', node.obj_token, node.node_token, new URL('/wiki/' + node.node_token, job.destination_url).href, now(), id);
        job = one('SELECT * FROM requirement_personal_documents WHERE id=?', id);
      } else if (!job.document_id) {
        run('UPDATE requirement_personal_documents SET creating=1 WHERE id=?', id);
        // Omitting folder_token with a user token creates in that user's own cloud space.
        const result = await request('docx/v1/documents', { title: snapshot.title });
        const documentId = result.document?.document_id;
        if (!/^[a-zA-Z0-9]+$/.test(documentId || '')) { const error = new Error('飞书未返回有效文档 ID，请先检查个人云文档中是否已创建'); error.uncertain = true; throw error; }
        const host = feishuDocumentLink(config.requirementWikiSampleUrl)?.url;
        const url = (host ? new URL(host).origin : 'https://www.feishu.cn') + '/docx/' + documentId;
        run('UPDATE requirement_personal_documents SET document_id=?,url=?,creating=0,updated_at=? WHERE id=?', documentId, url, now(), id);
        job = one('SELECT * FROM requirement_personal_documents WHERE id=?', id);
      }
      for (let index = job.next_block; index < snapshot.blocks.length; index += 40) {
        const children = snapshot.blocks.slice(index, index + 40), query = new URLSearchParams({ document_revision_id: '-1', client_token: hash(id + ':' + index).slice(0, 32) });
        const result = await request(`docx/v1/documents/${job.document_id}/blocks/${job.document_id}/children?${query}`, { children });
        blockIds.push(...(result.children || []).map(block => block.block_id));
        for (const file of snapshot.attachments || []) if (file.position >= index && file.position < index + children.length) {
          // Feishu wraps newly-created File blocks in a View block. Upload to the
          // nested File ID, never to the returned outer View ID (see Docx FAQ).
          const block = result.children?.[file.position - index];
          const blockId = block?.block_type === 33 ? block.children?.[0] : block?.block_type === 23 ? block.block_id : '';
          if (!/^[a-zA-Z0-9_-]+$/.test(blockId || '')) throw new Error('飞书未返回完整附件块，请重试继续写入');
          attachmentStates[file.position] = { blockId };
        }
        run('UPDATE requirement_personal_documents SET next_block=?,attachment_state=?,block_ids=?,updated_at=? WHERE id=?', index + children.length, JSON.stringify(attachmentStates), JSON.stringify(blockIds), now(), id);
      }
      await uploadDocumentAttachments(store, job, snapshot, attachmentStates, request, persistAttachments);
      if (job.node_token) await request(`wiki/v2/spaces/${job.space_id}/nodes/${job.node_token}/update_title`, { title: snapshot.title });
      checkRequirement();
      run("UPDATE requirement_personal_documents SET status='ready',error='',authorization_required=0,updated_at=? WHERE id=?", now(), id);
      liveDocuments?.adopt(one('SELECT rowid AS sequence,* FROM requirement_personal_documents WHERE id=?', id));
    } catch (error) {
      const job = one('SELECT * FROM requirement_personal_documents WHERE id=?', id), uncertain = job.creation_uncertain || job.creating && error.uncertain;
      run('UPDATE requirement_personal_documents SET status=?,creating=0,creation_uncertain=?,error=?,authorization_required=?,updated_at=? WHERE id=?', uncertain ? 'uncertain' : 'failed', uncertain ? 1 : 0, uncertain ? job.destination_url ? '知识库文档创建结果未确认，请检查目录可见权限后重试；平台将先查找本任务文档，找不到时不会重复新建' : '文档创建结果未确认，请先在个人云文档查找同名文档，避免重复创建。' : error.message, error.authorizationRequired ? 1 : 0, now(), id);
    }
  }
  function start(requirementId, userId, snapshot, token, destinationUrl = destination()) {
    if (config.demoMode) throw new Error('演示环境不创建个人飞书文档，请在正式环境使用项目经理飞书账号导出');
    if (!userAllowed(userId)) throw new Error('仅项目经理可以导出个人需求文档');
    if (!one('SELECT 1 FROM requirements WHERE id=? AND deleted_at IS NULL', requirementId)) throw new Error('需求已删除，导出已停止');
    destinationUrl = destination(destinationUrl);
    const live = liveDocuments?.current(requirementId, userId, snapshot, destinationUrl);
    if (live) return live;
    const fingerprint = fingerprintFor(snapshot, destinationUrl);
    let job = one('SELECT * FROM requirement_personal_documents WHERE requirement_id=? AND user_id=? AND fingerprint=?', requirementId, userId, fingerprint);
    if (job?.status === 'ready' || job?.status === 'uncertain' && !job.destination_url || job && active.has(job.id)) return view(job);
    if (!job) {
      const id = uid(), time = now();
      run('INSERT INTO requirement_personal_documents(id,requirement_id,user_id,fingerprint,snapshot,created_at,updated_at,destination_url) VALUES(?,?,?,?,?,?,?,?)', id, requirementId, userId, fingerprint, JSON.stringify(snapshot), time, time, destinationUrl);
      job = one('SELECT * FROM requirement_personal_documents WHERE id=?', id);
    } else run("UPDATE requirement_personal_documents SET status='pending',error='',authorization_required=0,updated_at=? WHERE id=?", now(), job.id);
    const pendingView = view({ ...job, status: 'pending', error: '', authorization_required: 0 });
    const promise = Promise.resolve().then(() => execute(job.id, token)).finally(() => active.delete(job.id));
    active.set(job.id, promise);
    return pendingView;
  }
  return { start, latest, get, destination, useLiveDocuments(value) { liveDocuments = value; }, async wait(id) { await active.get(id); }, async drain() { while (active.size) await Promise.all([...active.values()]); } };
}
