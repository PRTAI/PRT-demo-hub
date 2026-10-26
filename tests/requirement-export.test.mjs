import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { requirementExportRows, requirementWorkbook, requirementExportColumns } from '../server/requirement-export.mjs';

test('requirement export uses the dedicated requirement wiki URL for every Demo and ignores links in Demo content', () => {
  const requirement = { deadline_date: '2028-02-29', content: 'https://team.feishu.cn/docx/RequirementOnly' };
  const people = [{ name: '商务甲' }, { name: '研发乙' }];
  const first = 'https://team.feishu.cn/docx/DemoOne?from=export&lang=zh', second = 'https://team.feishu.cn/wiki/DemoTwo';
  const demos = [
    { latest: { description: { title: '=1+1', content: `[文档](${first})\n${second}\n${first}\nhttps://evil.example/docx/Token\nhttps://team.feishu.cn.evil.example/docx/Token\nhttp://team.feishu.cn/docx/Token` } } },
    { latest: { description: { title: '没有文档的 Demo', content: '本地文件' } } }
  ];
  const wiki = 'https://team.feishu.cn/wiki/RequirementDoc';
  const rows = requirementExportRows(requirement, people, demos, wiki);
  assert.deepEqual(rows.map(row => row.documentUrl), [wiki, wiki]);
  assert.deepEqual(rows.map(row => row.demoName), ['=1+1', '没有文档的 Demo']);
  assert.ok(rows.every(row => row.deadlineDate === '2028-02-29' && row.associatedPeople === '商务甲、研发乙'));
  assert.deepEqual(requirementExportRows({ deadline_date: '' }, [], []), [{ deadlineDate: '', demoName: '', associatedPeople: '', documentUrl: '' }]);
  assert.equal(requirementExportRows(requirement, people, [], wiki)[0].documentUrl, wiki);
  assert.equal(requirementExportRows(requirement, people, demos, 'https://evil.example/wiki/Token')[0].documentUrl, '');
  assert.equal(requirementExportRows(requirement, people, demos)[0].documentUrl, '');
});

test('Excel export writes exactly four ordered columns, typed dates, safe text and native clickable hyperlinks', async () => {
  const url = 'https://team.feishu.cn/docx/DemoOne?from=export&lang=zh';
  const buffer = await requirementWorkbook([
    { deadlineDate: '2028-02-29', demoName: '=HYPERLINK("https://evil.example")', associatedPeople: '+张三、@李四', documentUrl: url },
    { deadlineDate: '', demoName: 'Demo B', associatedPeople: '', documentUrl: '' }
  ]);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.columnCount, 4); assert.equal(sheet.rowCount, 3);
  assert.deepEqual(sheet.getRow(1).values.slice(1), requirementExportColumns);
  assert.equal(sheet.getCell('A2').value.toISOString(), '2028-02-29T00:00:00.000Z');
  assert.equal(sheet.getCell('A2').numFmt, 'yyyy-mm-dd');
  assert.equal(sheet.getCell('B2').value, '=HYPERLINK("https://evil.example")');
  assert.equal(sheet.getCell('B2').formula, undefined);
  assert.equal(sheet.getCell('C2').value, '+张三、@李四');
  assert.equal(sheet.getCell('D2').hyperlink, url);
  assert.equal(sheet.getCell('D2').text, '打开飞书文档');
  assert.equal(sheet.getCell('A3').value, null); assert.equal(sheet.getCell('D3').text, '');
  assert.equal(sheet.views[0].ySplit, 1); assert.equal(sheet.autoFilter, 'A1:D3');
  const empty = new ExcelJS.Workbook(); await empty.xlsx.load(await requirementWorkbook([]));
  assert.equal(empty.worksheets[0].rowCount, 1);
});
