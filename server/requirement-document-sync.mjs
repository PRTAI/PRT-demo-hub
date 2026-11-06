import { createHash } from 'node:crypto';
import { uid, now, parse } from './db.mjs';
import { uploadDocumentAttachments } from './feishu-document-attachments.mjs';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = value => /^[a-zA-Z0-9_-]+$/.test(value || '');
const elements = block => Object.values(block || {}).find(value => Array.isArray(value?.elements))?.elements;
const text = block => (elements(block) || []).map(element => element.text_run?.content || '').join('');

// The successful export is the document target. Synchronization never resolves
// sample, creates another document, or asks the application to impersonate its owner.
export function createRequirementDocumentSync(store, config, { snapshotFor, tokenFor }) {
  const { one, all, run } = store;
  const call = config.personalDocumentFetch || fetch;
  let running;
  store.db.exec(`CREATE TABLE IF NOT EXISTS requirement_document_sync (
    requirement_id TEXT PRIMARY KEY REFERENCES requirements(id), export_id TEXT NOT NULL REFERENCES requirement_personal_documents(id),
    source_sequence INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'synced', snapshot TEXT NOT NULL, block_ids TEXT NOT NULL DEFAULT '[]',
    attachment_state TEXT NOT NULL DEFAULT '{}', operation_id TEXT NOT NULL DEFAULT '', pending_snapshot TEXT NOT NULL DEFAULT '',
    pending_ids TEXT NOT NULL DEFAULT '[]', pending_attachments TEXT NOT NULL DEFAULT '{}', next_block INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL, synced_at TEXT
  );`);
  const target = id => one(`SELECT s.*,d.user_id,d.document_id,d.url,d.destination_url,d.space_id,d.node_token,u.name AS owner_name
    FROM requirement_document_sync s JOIN requirement_personal_documents d ON d.id=s.export_id JOIN users u ON u.id=d.user_id WHERE s.requirement_id=?`, id);
  function enqueue(id) {
    if (!one('SELECT 1 FROM requirements WHERE id=? AND deleted_at IS NULL', id)) return;
    run("UPDATE requirement_document_sync SET generation=generation+1,status='pending',attempts=0,next_at=0,error='',updated_at=? WHERE requirement_id=?", now(), id);
  }
  function adopt(document) {
    if (document.status !== 'ready' || !document.document_id || !document.url) return;
    if (!one('SELECT 1 FROM requirements WHERE id=? AND deleted_at IS NULL', document.requirement_id)) return;
    const existing = target(document.requirement_id);
    if (existing && existing.source_sequence >= document.sequence) return;
    const time = now();
    run(`INSERT INTO requirement_document_sync(requirement_id,export_id,source_sequence,snapshot,block_ids,attachment_state,updated_at,synced_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(requirement_id) DO UPDATE SET export_id=excluded.export_id,source_sequence=excluded.source_sequence,generation=generation+1,
      status='synced',snapshot=excluded.snapshot,block_ids=excluded.block_ids,attachment_state=excluded.attachment_state,
      operation_id='',pending_snapshot='',pending_ids='[]',pending_attachments='{}',next_block=0,attempts=0,next_at=0,error='',updated_at=excluded.updated_at,synced_at=excluded.synced_at`,
    document.requirement_id, document.id, document.sequence, document.snapshot, document.block_ids, document.attachment_state, time, time);
    enqueue(document.requirement_id);
  }
  function info(id) {
    const row = target(id);
    return row ? { mode: 'export', status: row.status, url: row.url, error: row.error, syncedAt: row.synced_at, ownerId: row.user_id, ownerName: row.owner_name,
      authorizationRequired: row.status === 'authorization_required', authorizationUrl: '/api/auth/feishu?' + new URLSearchParams({ requirement: id, document_export: '1' }) }
      : { mode: 'export', status: 'not_created', url: '', error: '', syncedAt: null };
  }
  function current(requirementId, userId, snapshot, destinationUrl) {
    const row = target(requirementId);
    if (row?.status !== 'synced' || row.user_id !== userId || row.destination_url !== destinationUrl || fingerprint(parse(row.snapshot)) !== fingerprint(snapshot)) return null;
    return { id: row.export_id, status: 'ready', title: snapshot.title, url: row.url, error: '', authorizationRequired: false,
      completedBlocks: snapshot.blocks.length, totalBlocks: snapshot.blocks.length, completedAttachments: snapshot.attachments?.length || 0, totalAttachments: snapshot.attachments?.length || 0,
      destination: destinationUrl ? 'wiki' : 'personal', destinationUrl };
  }
  async function sync(job) {
    const desired = snapshotFor(job.requirement_id, job.user_id), previous = parse(job.snapshot), oldIds = parse(job.block_ids, []);
    const live = () => target(job.requirement_id)?.export_id === job.export_id && !!one('SELECT 1 FROM requirements WHERE id=? AND deleted_at IS NULL', job.requirement_id);
    const save = (sql, ...args) => live() && run(sql + ' WHERE requirement_id=? AND export_id=?', ...args, job.requirement_id, job.export_id);
    const finish = (snapshot, ids, states) => save(`UPDATE requirement_document_sync SET snapshot=?,block_ids=?,attachment_state=?,operation_id='',pending_snapshot='',pending_ids='[]',pending_attachments='{}',next_block=0,
      status=CASE WHEN generation=? THEN 'synced' ELSE 'pending' END,attempts=0,next_at=0,error='',synced_at=?,updated_at=?`, JSON.stringify(snapshot), JSON.stringify(ids), JSON.stringify(states), fingerprint(snapshot) === fingerprint(desired) ? job.generation : -1, now(), now());
    // Changes to a deprecated sample setting cannot invalidate an already exported document.
    if (!job.pending_snapshot && fingerprint(desired) === fingerprint(previous)) { finish(desired, oldIds, parse(job.attachment_state)); return; }
    const owner = one('SELECT * FROM users WHERE id=?', job.user_id);
    if (!owner?.enabled || owner.deleted_at || !parse(owner.roles, []).includes('pm')) {
      const error = new Error('文档创建者已停用或不再具有项目经理权限，请由项目经理重新导出以建立新的同步目标'); error.authorizationRequired = true; throw error;
    }
    async function request(resource, body, method = 'POST', timeout = 15000) {
      if (!live()) throw new Error('同步目标已变更，已停止写入旧文档');
      const token = tokenFor(job.user_id);
      if (!token) { const error = new Error(`请文档创建者 ${job.owner_name} 重新授权飞书文档后重试同步；也可由当前项目经理重新导出建立新的同步目标`); error.authorizationRequired = true; throw error; }
      const multipart = body instanceof FormData;
      let response, payload;
      try {
        response = await call('https://open.feishu.cn/open-apis/' + resource, { method, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { Authorization: 'Bearer ' + token, ...(multipart ? {} : { 'Content-Type': 'application/json' }) }, ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}) });
        try { payload = await response.json(); } catch { if (response.ok && resource === 'drive/v1/medias/upload_part') payload = { code: 0 }; else throw new Error(); }
      } catch { throw new Error('飞书文档同步网络异常或超时，请稍后重试'); }
      if (!live()) throw new Error('需求已删除或同步目标已变更，已停止写入旧文档');
      if (!response.ok || payload.code !== 0) {
        const code = Number.isInteger(payload.code) ? payload.code : response.status;
        const error = new Error(`飞书文档同步失败（${code}），当前使用文档创建者的用户授权。请检查其文档编辑权限或重新授权后重试`);
        error.authorizationRequired = [401, 403].includes(response.status) || [99991663, 99991668, 99991671, 99991672, 99991677, 99991679, 99991680, 99991681].includes(code);
        throw error;
      }
      return payload.data || {};
    }
    const root = `docx/v1/documents/${job.document_id}/blocks/${job.document_id}`;
    async function children(revision = '-1') {
      const result = []; let page = '';
      do {
        const data = await request(root + '/children?' + new URLSearchParams({ document_revision_id: String(revision), page_size: '500', ...(page ? { page_token: page } : {}) }), null, 'GET');
        result.push(...(data.items || []));
        if (data.has_more && (!data.page_token || data.page_token === page)) throw new Error('飞书文档区块分页异常，请重试同步');
        page = data.has_more ? data.page_token : '';
      } while (page);
      return result;
    }
    if (!oldIds.length) {
      // Older exports did not record root block IDs. Adopt only the exact original
      // template prefix; never claim arbitrary user-created or inserted blocks.
      const blocks = await children(), states = parse(job.attachment_state);
      const matches = blocks.length >= previous.blocks.length && previous.blocks.every((block, index) => {
        const actual = blocks[index];
        if (block.block_type === 23) return actual?.block_type === 33 ? actual.children?.[0] === states[index]?.blockId : actual?.block_type === 23 && actual.block_id === states[index]?.blockId;
        return actual?.block_type === block.block_type && text(actual) === text(block);
      });
      if (!matches) throw new Error('旧导出文档的原始区块已被移动或修改，无法安全确认同步区域。请重新导出一次，后续会同步这份新文档');
      oldIds.push(...blocks.slice(0, previous.blocks.length).map(block => block.block_id));
      if (oldIds.some(id => !validId(id))) throw new Error('飞书未返回有效区块 ID，请重试');
      save('UPDATE requirement_document_sync SET block_ids=?', JSON.stringify(oldIds));
    }
    if (oldIds.some(id => !validId(id))) throw new Error('旧导出文档未完整记录同步区块，请重新导出一次建立同步区域');
    // Once this document becomes live, its initial immutable export snapshot is
    // no longer a valid cache hit. Live content has its own fingerprint above.
    run('UPDATE requirement_personal_documents SET fingerprint=? WHERE id=?', fingerprint({ liveDocument: job.export_id }), job.export_id);
    // Status/date and most description edits only patch text. Retain the real
    // attachment blocks and their bytes rather than uploading large files again.
    const inPlace = !job.pending_snapshot && oldIds.length === desired.blocks.length && previous.blocks.length === desired.blocks.length
      && JSON.stringify(previous.attachments) === JSON.stringify(desired.attachments)
      && desired.blocks.every((block, index) => block.block_type === previous.blocks[index].block_type
        && (JSON.stringify(block) === JSON.stringify(previous.blocks[index]) || elements(block) && elements(previous.blocks[index])));
    if (inPlace) {
      for (const [index, block] of desired.blocks.entries()) if (JSON.stringify(block) !== JSON.stringify(previous.blocks[index])) await request(`docx/v1/documents/${job.document_id}/blocks/${oldIds[index]}?document_revision_id=-1`, { update_text_elements: { elements: elements(block) } }, 'PATCH');
      await rename(desired);
      finish(desired, oldIds, parse(job.attachment_state)); return;
    }
    if (!job.pending_snapshot) {
      job.pending_snapshot = JSON.stringify(desired); job.operation_id = uid();
      save("UPDATE requirement_document_sync SET pending_snapshot=?,operation_id=?,pending_ids='[]',pending_attachments='{}',next_block=0", job.pending_snapshot, job.operation_id);
    }
    const pending = parse(job.pending_snapshot), ids = parse(job.pending_ids, []), states = parse(job.pending_attachments);
    const persist = () => save('UPDATE requirement_document_sync SET pending_attachments=?', JSON.stringify(states));
    for (let index = job.next_block; index < pending.blocks.length; index += 40) {
      const batch = pending.blocks.slice(index, index + 40), clientToken = fingerprint([job.export_id, job.operation_id, index]).slice(0, 32);
      const data = await request(root + '/children?' + new URLSearchParams({ document_revision_id: '-1', client_token: clientToken }), { children: batch, index });
      if (data.children?.length !== batch.length || data.children.some(block => !validId(block.block_id))) throw new Error('飞书未返回完整同步区块，请重试继续写入');
      ids.push(...data.children.map(block => block.block_id));
      for (const file of pending.attachments || []) if (file.position >= index && file.position < index + batch.length) {
        const block = data.children[file.position - index], blockId = block.block_type === 33 ? block.children?.[0] : block.block_id;
        if (!validId(blockId)) throw new Error('飞书未返回有效附件区块，请重试');
        const oldFile = previous.attachments?.find(item => item.id === file.id && item.size === file.size && item.checksum === file.checksum);
        const reusable = oldFile && parse(job.attachment_state)[oldFile.position]?.fileToken;
        states[file.position] = { blockId, ...(reusable ? { fileToken: reusable } : {}) };
      }
      save('UPDATE requirement_document_sync SET pending_ids=?,pending_attachments=?,next_block=?', JSON.stringify(ids), JSON.stringify(states), index + batch.length);
    }
    await uploadDocumentAttachments(store, job, pending, states, request, persist);
    // Remove only recorded app blocks, leaving any manually inserted blocks in
    // place. A lost delete response is recovered by listing IDs again.
    const obsolete = new Set(oldIds);
    while (true) {
      const meta = await request('docx/v1/documents/' + job.document_id, null, 'GET'), revision = meta.document?.revision_id;
      if (!Number.isInteger(revision) || revision < 0) throw new Error('飞书未返回当前文档版本，已停止清理旧区块以保留人工内容');
      const blocks = await children(revision);
      let end = blocks.length;
      while (end && !obsolete.has(blocks[end - 1].block_id)) end--;
      if (!end) break;
      let start = end - 1;
      while (start && obsolete.has(blocks[start - 1].block_id)) start--;
      await request(root + '/children/batch_delete?' + new URLSearchParams({ document_revision_id: String(revision) }), { start_index: start, end_index: end }, 'DELETE');
    }
    await rename(pending);
    finish(pending, ids, states);
    async function rename(snapshot) {
      if (snapshot.title === previous.title) return;
      if (job.node_token) await request(`wiki/v2/spaces/${job.space_id}/nodes/${job.node_token}/update_title`, { title: snapshot.title });
      else await request(root + '?document_revision_id=-1', { update_text_elements: { elements: [{ text_run: { content: snapshot.title } }] } }, 'PATCH');
    }
  }
  async function processJobs() {
    for (const row of all("SELECT requirement_id FROM requirement_document_sync WHERE status='pending' AND next_at<=? ORDER BY updated_at LIMIT 10", Date.now())) {
      const job = target(row.requirement_id);
      try { await sync(job); }
      catch (error) {
        const attempts = job.attempts + 1;
        run(`UPDATE requirement_document_sync SET status=?,attempts=?,next_at=?,error=?,updated_at=? WHERE requirement_id=? AND export_id=? AND generation=?`,
          error.authorizationRequired ? 'authorization_required' : attempts >= 5 ? 'failed' : 'pending', attempts, Date.now() + Math.min(300000, 15000 * 2 ** attempts), error.message, now(), job.requirement_id, job.export_id, job.generation);
      }
    }
  }
  function drain() {
    if (config.demoMode) return Promise.resolve();
    if (!running) running = processJobs().finally(() => { running = null; });
    return running;
  }
  const service = { adopt, enqueue, info, current, drain, hasTarget: id => !!target(id), retry(id) { if (!target(id)) return false; enqueue(id); return true; } };
  // Backfill target metadata only. Existing Feishu documents and content remain intact.
  for (const row of all("SELECT rowid AS sequence,* FROM requirement_personal_documents WHERE status='ready' ORDER BY rowid DESC")) if (!target(row.requirement_id)) adopt(row);
  return service;
}
