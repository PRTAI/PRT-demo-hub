import ExcelJS from 'exceljs';
import { feishuDocumentLink } from '../shared/requirement-links.mjs';
import { uid, now, parse } from './db.mjs';

export const requirementExportColumns = ['截止日期', 'demo名称', '关联人员', 'demo的飞书文档超链接'];

export function requirementExportRows(requirement, people, demos, wikiUrl = '') {
  const associatedPeople = people.map(person => person.name).join('、');
  const documentUrl = feishuDocumentLink(wikiUrl)?.url || '';
  if (!demos.length) return [{ deadlineDate: requirement.deadline_date, demoName: '', associatedPeople, documentUrl }];
  return demos.map(demo => {
    const description = demo.latest?.description || {};
    return { deadlineDate: requirement.deadline_date, demoName: description.title || '未命名 Demo', associatedPeople, documentUrl };
  });
}

export async function requirementWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('需求 Demo', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = requirementExportColumns.map((header, index) => ({ header, width: [16, 38, 48, 26][index] }));
  const header = sheet.getRow(1);
  header.height = 30;
  header.eachCell(cell => {
    cell.font = { name: '微软雅黑', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF456B52' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  for (const item of rows) {
    const row = sheet.addRow([
      item.deadlineDate ? new Date(`${item.deadlineDate}T00:00:00.000Z`) : null,
      item.demoName,
      item.associatedPeople,
      item.documentUrl ? { text: '打开飞书文档', hyperlink: item.documentUrl } : ''
    ]);
    row.height = Math.min(409, Math.max(36, Math.ceil(item.demoName.length / 24) * 18, Math.ceil(item.associatedPeople.length / 30) * 18));
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { name: '微软雅黑', size: 11, color: { argb: 'FF31483A' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (row.number % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F6F1' } };
    });
    row.getCell(1).numFmt = 'yyyy-mm-dd';
    if (item.documentUrl) row.getCell(4).font = { name: '微软雅黑', size: 11, color: { argb: 'FF0563C1' }, underline: true };
  }
  sheet.autoFilter = { from: 'A1', to: `D${sheet.rowCount}` };
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
