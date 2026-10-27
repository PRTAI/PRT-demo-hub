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

export function createRequirementExports(store, wiki, { demoMode = false } = {}) {
  const { one, all, run, tx } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS requirement_exports (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), filters TEXT NOT NULL,
    preview INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS requirement_exports_user ON requirement_exports(user_id,created_at);
  CREATE TABLE IF NOT EXISTS requirement_export_items (
    export_id TEXT NOT NULL REFERENCES requirement_exports(id) ON DELETE CASCADE,
    requirement_id TEXT NOT NULL REFERENCES requirements(id), position INTEGER NOT NULL,
    title TEXT NOT NULL, rows TEXT NOT NULL, generation INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0, url TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(export_id,requirement_id)
  );`);
  const owned = (id, userId) => one('SELECT * FROM requirement_exports WHERE id=? AND user_id=?', id, userId);
  function status(id, userId) {
    const job = owned(id, userId);
    if (!job) return null;
    if (all('SELECT rows FROM requirement_export_items WHERE export_id=?', id).some(item => parse(item.rows, []).some(row => !Object.hasOwn(row, 'title')))) return null;
    const items = all(`SELECT i.*,w.status AS wiki_status,w.error,w.url AS wiki_url,w.generation AS wiki_generation
      FROM requirement_export_items i LEFT JOIN requirement_wiki w ON w.requirement_id=i.requirement_id
      WHERE i.export_id=? ORDER BY i.position`, id);
    let completed = 0, failed = 0;
    const errors = [];
    for (const item of items) {
      const url = feishuDocumentLink(item.wiki_url)?.url || '';
      if (!item.completed && (job.preview || item.wiki_status === 'synced' && item.wiki_generation >= item.generation && url)) {
        run('UPDATE requirement_export_items SET completed=1,url=? WHERE export_id=? AND requirement_id=?', url, id, item.requirement_id);
        item.completed = 1;
      }
      if (item.completed) completed++;
      else if (!item.wiki_status || item.wiki_status === 'failed' || item.wiki_status === 'synced') {
        failed++;
        if (errors.length < 20) errors.push({ requirementId: item.requirement_id, title: item.title, error: item.error || '飞书文档尚未正确同步，请重试' });
      }
    }
    const pending = items.length - completed - failed;
    return { id, status: pending ? 'pending' : failed ? 'failed' : 'ready', total: items.length, completed, pending, failed, errors, filters: parse(job.filters), preview: !!job.preview, createdAt: job.created_at };
  }
  function create(userId, filters, items) {
    const id = uid();
    tx(() => {
      // Export snapshots are temporary; the wiki records and uploaded files remain permanent.
      run('DELETE FROM requirement_exports WHERE created_at<?', new Date(Date.now() - 7 * 86400000).toISOString());
      run('INSERT INTO requirement_exports(id,user_id,filters,preview,created_at) VALUES(?,?,?,?,?)', id, userId, JSON.stringify(filters), demoMode ? 1 : 0, now());
      items.forEach((item, position) => run('INSERT INTO requirement_export_items(export_id,requirement_id,position,title,rows,generation) VALUES(?,?,?,?,?,?)', id, item.id, position, item.title, JSON.stringify(item.rows), demoMode ? 0 : wiki.prepareExport(item.id)));
    });
    return status(id, userId);
  }
  function retry(id, userId) {
    if (!status(id, userId)) return null;
    tx(() => {
      for (const item of all(`SELECT i.requirement_id,w.status FROM requirement_export_items i
        LEFT JOIN requirement_wiki w ON w.requirement_id=i.requirement_id WHERE i.export_id=? AND i.completed=0`, id)) {
        if (item.status !== 'pending') run('UPDATE requirement_export_items SET generation=? WHERE export_id=? AND requirement_id=?', wiki.prepareExport(item.requirement_id), id, item.requirement_id);
      }
    });
    return status(id, userId);
  }
  function rows(id, userId) {
    if (!owned(id, userId)) return null;
    return all('SELECT rows,url FROM requirement_export_items WHERE export_id=? ORDER BY position', id).flatMap(item => parse(item.rows, []).map(row => ({ ...row, documentUrl: item.url })));
  }
  return { create, status, retry, rows };
}
