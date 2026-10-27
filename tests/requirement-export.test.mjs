import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { requirementExportRows, requirementWorkbook, requirementExportColumns } from '../server/requirement-export.mjs';

const id = '00000000-0000-4000-8000-000000000001', demoId = '00000000-0000-4000-8000-000000000002';
const origin = 'https://demo.example.internal';
const requirement = { id, title: 'P1:医疗数据', content: 'https://example.org/requirements', status: 'needs_update', deadline_date: '2028-02-29' };
const people = [{ id: 'business', name: '商务甲', responsibility: 'business' }, { id: 'engineer', name: '研发乙', responsibility: 'development' }, { id: 'both', name: '双角色', responsibility: 'both' }];

test('template export uses one row per requirement, separate owners and stable platform links for documents and multiple samples', () => {
  const demos = [{ id: demoId, latest: { description: { title: '=1+1', content: 'https://team.feishu.cn/wiki/IgnoreThis' } } }, { id, latest: { description: { title: '第二份 Demo' } } }];
  const rows = requirementExportRows(requirement, people, demos, { origin, documents: [{ name: '需求一.pdf' }, { name: '需求二.docx' }] });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.title, requirement.title); assert.equal(row.content, requirement.content); assert.equal(row.contentUrl, requirement.content);
  assert.equal(row.businessOwners, '商务甲、双角色'); assert.equal(row.developmentOwners, '研发乙、双角色');
  assert.equal(row.status, '待更新'); assert.equal(row.deadlineDate, '2028-02-29');
  assert.equal(row.documentNames, '需求一.pdf\n需求二.docx'); assert.equal(row.sampleNames, '=1+1\n第二份 Demo');
  assert.equal(row.documentsUrl, `${origin}/?view=requirements&requirement=${id}`);
  assert.equal(row.sampleUrl, row.requirementUrl);
  const single = requirementExportRows(requirement, [], [demos[0]], { origin })[0];
  assert.equal(new URL(single.sampleUrl).searchParams.get('demo'), demoId);
  assert.equal(new URL(single.sampleUrl).searchParams.get('requirement'), id);
  const empty = requirementExportRows({ ...requirement, content: '', deadline_date: '' }, [], [], { origin })[0];
  assert.equal(empty.sampleUrl, ''); assert.equal(empty.documentsUrl, ''); assert.equal(empty.content, '');
  assert.equal(requirementExportRows({ ...requirement, content: '说明中含 https://example.org/requirements 但不只链接' }, [], [], { origin })[0].contentUrl, '');
});

test('Excel export matches the eight-column template with typed dates, placeholders, safe text and native hyperlinks', async () => {
  const row = requirementExportRows({ ...requirement, title: '=HYPERLINK("https://evil.example")' }, people, [{ id: demoId, latest: { description: { title: '+原始 Demo' } } }], { origin, documents: [{ name: '需求.pdf' }] })[0];
  const blank = requirementExportRows({ ...requirement, title: '无附件需求', content: '', deadline_date: '' }, [], [], { origin })[0];
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await requirementWorkbook([row, blank]));
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.columnCount, 8); assert.equal(sheet.rowCount, 3);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['标题', '需求说明', '需求文档', '商务负责人', '研发负责人', '进度', '截止日期', '样例']);
  assert.deepEqual(sheet.getRow(1).values.slice(1), requirementExportColumns);
  assert.equal(sheet.getCell('A2').text, row.title); assert.equal(sheet.getCell('A2').formula, undefined); assert.equal(sheet.getCell('A2').hyperlink, row.requirementUrl);
  assert.equal(sheet.getCell('B2').hyperlink, requirement.content); assert.equal(sheet.getCell('C2').hyperlink, row.documentsUrl);
  assert.equal(sheet.getCell('D2').text, '商务甲、双角色'); assert.equal(sheet.getCell('E2').text, '研发乙、双角色'); assert.equal(sheet.getCell('F2').text, '待更新');
  assert.equal(sheet.getCell('G2').value.toISOString(), '2028-02-29T00:00:00.000Z'); assert.equal(sheet.getCell('G2').numFmt, 'yyyy-mm-dd');
  assert.equal(sheet.getCell('H2').hyperlink, row.sampleUrl); assert.equal(sheet.getCell('H2').text, '+原始 Demo');
  for (const column of ['B', 'C', 'D', 'E', 'G', 'H']) assert.equal(sheet.getCell(column + '3').text, '/');
  assert.equal(sheet.views[0].ySplit, 1); assert.equal(sheet.autoFilter, 'A1:H3');
});
