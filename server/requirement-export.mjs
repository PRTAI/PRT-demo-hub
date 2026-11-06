import ExcelJS from 'exceljs';
import { feishuDocumentLink } from '../shared/requirement-links.mjs';
import { uid, now, parse } from './db.mjs';
import { platformLink } from '../shared/platform-links.mjs';
import { textLinks } from '../shared/requirement-links.mjs';
import { splitRequirementOwners } from '../shared/requirement-owners.mjs';

export const requirementExportColumns = ['标题', '需求说明', '需求文档', '商务负责人', '研发负责人', '进度', '截止日期', '样例'];

export function requirementExportRows(requirement, people, demos, { origin, documents = [] } = {}) {
  const groups = splitRequirementOwners(people), names = users => [...new Map(users.map(user => [user.id || user.name, user.name])).values()].join('、');
  const requirementUrl = platformLink(origin, { requirementId: requirement.id });
  const content = requirement.content?.trim() || '', links = textLinks(content);
  return [{
    title: requirement.title, requirementUrl, content, contentUrl: links.length === 1 && links[0] === content ? links[0] : '',
    documentNames: documents.map(file => file.name).join('\n'), documentsUrl: documents.length ? requirementUrl : '',
    businessOwners: names(groups.businessOwners), developmentOwners: names(groups.developmentOwners),
    status: ({ open: '进行中', needs_update: '待更新', delivered: '已交付', closed: '已关闭' })[requirement.status] || requirement.status,
    deadlineDate: requirement.deadline_date || '', sampleNames: demos.map(demo => demo.latest?.description?.title || '未命名 Demo').join('\n'),
    sampleUrl: demos.length === 1 ? platformLink(origin, { requirementId: requirement.id, demoId: demos[0].id }) : demos.length ? requirementUrl : ''
  }];
}

export async function requirementWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('需求中心', { views: [{ state: 'frozen', ySplit: 1 }] });
  const widths = [30, 54, 36, 22, 26, 14, 16, 36];
  sheet.columns = requirementExportColumns.map((header, index) => ({ header, width: widths[index] }));
  const header = sheet.getRow(1);
  header.height = 30;
  header.eachCell(cell => {
    cell.font = { name: '微软雅黑', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF456B52' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  for (const item of rows) {
    const linked = (value, url, tooltip) => url ? { text: value || '/', hyperlink: url, tooltip } : value || '/';
    const row = sheet.addRow([
      linked(item.title, item.requirementUrl, '打开需求详情'),
      linked(item.content, item.contentUrl, '打开需求说明链接'),
      linked(item.documentNames, item.documentsUrl, '打开需求详情，查看和下载需求文档'),
      item.businessOwners || '/', item.developmentOwners || '/', item.status || '/',
      item.deadlineDate ? new Date(`${item.deadlineDate}T00:00:00.000Z`) : '/',
      linked(item.sampleNames, item.sampleUrl, '打开关联样例；多份样例可在需求详情中查看')
    ]);
    row.height = Math.min(409, Math.max(40, ...row.values.slice(1).map((value, index) => {
      const content = String(value?.text || (value instanceof Date ? '' : value) || '');
      return content.split('\n').reduce((lines, line) => lines + Math.max(1, Math.ceil(Array.from(line).length / Math.floor(widths[index] / 2))), 0) * 18 + 12;
    })));
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { name: '微软雅黑', size: 11, color: { argb: 'FF31483A' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (row.number % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F6F1' } };
    });
    row.getCell(7).numFmt = 'yyyy-mm-dd';
    row.eachCell(cell => { if (cell.hyperlink) cell.font = { name: '微软雅黑', size: 11, color: { argb: 'FF0563C1' }, underline: true }; });
  }
  sheet.autoFilter = { from: 'A1', to: `H${sheet.rowCount}` };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function createRequirementExports(store, personalDocuments, { demoMode = false } = {}) {
  const { one, all, run, tx } = store, active = new Map(), userQueues = new Map();
  store.db.exec(`CREATE TABLE IF NOT EXISTS requirement_exports (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), filters TEXT NOT NULL,
    preview INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    destination TEXT NOT NULL DEFAULT 'legacy', authorization_required INTEGER NOT NULL DEFAULT 0, destination_url TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS requirement_exports_user ON requirement_exports(user_id,created_at);
  CREATE TABLE IF NOT EXISTS requirement_export_items (
    export_id TEXT NOT NULL REFERENCES requirement_exports(id) ON DELETE CASCADE,
    requirement_id TEXT NOT NULL REFERENCES requirements(id), position INTEGER NOT NULL,
    title TEXT NOT NULL, rows TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0, url TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL DEFAULT '{}', personal_document_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(export_id,requirement_id)
  );`);
  // Keep old snapshots identifiable; wiki exports must never masquerade as personal exports.
  for (const [table, columns] of Object.entries({
    requirement_exports: { destination: "TEXT NOT NULL DEFAULT 'legacy'", authorization_required: 'INTEGER NOT NULL DEFAULT 0', destination_url: "TEXT NOT NULL DEFAULT ''" },
    requirement_export_items: { snapshot: "TEXT NOT NULL DEFAULT '{}'", personal_document_id: "TEXT NOT NULL DEFAULT ''", state: "TEXT NOT NULL DEFAULT 'queued'", error: "TEXT NOT NULL DEFAULT ''" }
  })) {
    const existing = all('PRAGMA table_info(' + table + ')').map(column => column.name);
    for (const [column, definition] of Object.entries(columns)) if (!existing.includes(column)) store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  // User tokens are deliberately not persisted. Resume unfinished batches after fresh consent.
  run(`UPDATE requirement_exports SET authorization_required=1 WHERE destination='personal' AND preview=0
    AND EXISTS(SELECT 1 FROM requirement_export_items i WHERE i.export_id=requirement_exports.id AND i.completed=0)`);
  const owned = (id, userId) => one("SELECT * FROM requirement_exports WHERE id=? AND user_id=? AND destination='personal'", id, userId);
  const userAllowed = userId => {
    const user = one('SELECT * FROM users WHERE id=?', userId);
    return user?.enabled && !user.deleted_at && parse(user.roles, []).includes('pm');
  };
  function status(id, userId) {
    const job = owned(id, userId);
    if (!job) return null;
    const items = all('SELECT * FROM requirement_export_items WHERE export_id=? ORDER BY position', id);
    let completed = 0, failed = 0;
    const errors = [];
    for (const item of items) {
      if (item.completed) completed++;
      else if (['failed', 'uncertain'].includes(item.state) || !active.has(id) && !job.authorization_required) {
        failed++;
        if (errors.length < 20) errors.push({ requirementId: item.requirement_id, title: item.title, error: item.error || '导出已中断，请重试未完成项' });
      }
    }
    const pending = items.length - completed - failed, authorizationRequired = !!job.authorization_required && completed < items.length;
    return { id, status: completed === items.length ? 'ready' : authorizationRequired ? 'authorization_required' : active.has(id) ? 'pending' : 'failed', total: items.length, completed, pending, failed, errors, authorizationRequired, filters: parse(job.filters), preview: !!job.preview, createdAt: job.created_at, destination: job.destination_url ? 'wiki' : 'personal', destinationUrl: job.destination_url };
  }
  async function execute(id, userId, getToken) {
    try {
      const destinationUrl = owned(id, userId).destination_url;
      for (const item of all('SELECT * FROM requirement_export_items WHERE export_id=? AND completed=0 ORDER BY position', id)) {
        if (!one('SELECT 1 FROM requirements WHERE id=? AND deleted_at IS NULL', item.requirement_id)) {
          run("UPDATE requirement_export_items SET completed=1,state='deleted',error='需求已删除',url='' WHERE export_id=? AND requirement_id=?", id, item.requirement_id);
          continue;
        }
        if (!userAllowed(userId)) throw new Error('当前账号已停用或不再具有项目经理权限，导出已停止');
        const token = getToken?.(destinationUrl);
        if (!token) { run('UPDATE requirement_exports SET authorization_required=1 WHERE id=?', id); break; }
        run("UPDATE requirement_export_items SET state='pending',error='' WHERE export_id=? AND requirement_id=?", id, item.requirement_id);
        const document = personalDocuments.start(item.requirement_id, userId, parse(item.snapshot), token, destinationUrl);
        run('UPDATE requirement_export_items SET personal_document_id=? WHERE export_id=? AND requirement_id=?', document.id, id, item.requirement_id);
        await personalDocuments.wait(document.id);
        if (!one('SELECT 1 FROM requirements WHERE id=? AND deleted_at IS NULL', item.requirement_id)) {
          run("UPDATE requirement_export_items SET completed=1,state='deleted',error='需求已删除',url='' WHERE export_id=? AND requirement_id=?", id, item.requirement_id);
          continue;
        }
        const result = personalDocuments.get(document.id, userId), url = feishuDocumentLink(result?.url)?.url || '';
        const ready = result?.status === 'ready' && !!url;
        run('UPDATE requirement_export_items SET state=?,completed=?,url=?,error=? WHERE export_id=? AND requirement_id=?', ready ? 'ready' : result?.status === 'uncertain' ? 'uncertain' : 'failed', ready ? 1 : 0, ready ? url : '', ready ? '' : result?.error || '飞书个人文档未完成，请重试', id, item.requirement_id);
        if (result?.authorizationRequired) { run('UPDATE requirement_exports SET authorization_required=1 WHERE id=?', id); break; }
      }
    } catch (error) {
      run("UPDATE requirement_export_items SET state='failed',error=? WHERE export_id=? AND completed=0 AND state IN ('pending','queued')", error.message, id);
    }
  }
  function schedule(id, userId, getToken) {
    if (active.has(id)) return;
    const previous = userQueues.get(userId) || Promise.resolve();
    // Serialize a PM's batches and each batch's documents, instead of flooding Feishu.
    const promise = previous.then(() => execute(id, userId, getToken)).finally(() => {
      active.delete(id);
      if (userQueues.get(userId) === promise) userQueues.delete(userId);
    });
    active.set(id, promise); userQueues.set(userId, promise);
  }
  function create(userId, filters, items, getToken) {
    const id = uid(), destinationUrl = personalDocuments.destination();
    tx(() => {
      // Only temporary export snapshots expire; documents and uploaded files remain.
      run(`DELETE FROM requirement_exports WHERE created_at<? AND NOT EXISTS(
        SELECT 1 FROM requirement_export_items i WHERE i.export_id=requirement_exports.id AND i.state='pending')`, new Date(Date.now() - 7 * 86400000).toISOString());
      run("INSERT INTO requirement_exports(id,user_id,filters,preview,created_at,destination,authorization_required,destination_url) VALUES(?,?,?,?,?,'personal',?,?)", id, userId, JSON.stringify(filters), demoMode ? 1 : 0, now(), !demoMode && items.length && !getToken?.(destinationUrl) ? 1 : 0, destinationUrl);
      items.forEach((item, position) => run('INSERT INTO requirement_export_items(export_id,requirement_id,position,title,rows,generation,snapshot,completed,state) VALUES(?,?,?,?,?,0,?,?,?)', id, item.id, position, item.title, JSON.stringify(item.rows), JSON.stringify(item.snapshot || {}), demoMode ? 1 : 0, demoMode ? 'ready' : 'queued'));
    });
    if (!demoMode && items.length && getToken?.(destinationUrl)) schedule(id, userId, getToken);
    return status(id, userId);
  }
  function retry(id, userId, getToken) {
    const job = status(id, userId);
    if (!job || job.status === 'ready' || active.has(id)) return job;
    const token = getToken?.(job.destinationUrl);
    run('UPDATE requirement_exports SET authorization_required=? WHERE id=?', token ? 0 : 1, id);
    if (token) {
      run("UPDATE requirement_export_items SET state='queued',error='' WHERE export_id=? AND completed=0", id);
      schedule(id, userId, getToken);
    }
    return status(id, userId);
  }
  function rows(id, userId) {
    if (!owned(id, userId)) return null;
    return all('SELECT i.rows,i.url FROM requirement_export_items i JOIN requirements r ON r.id=i.requirement_id WHERE i.export_id=? AND r.deleted_at IS NULL ORDER BY i.position', id).flatMap(item => parse(item.rows, []).map(row => ({ ...row, documentUrl: item.url })));
  }
  return { create, status, retry, rows, async drain() { while (active.size) await Promise.all([...active.values()]); } };
}
