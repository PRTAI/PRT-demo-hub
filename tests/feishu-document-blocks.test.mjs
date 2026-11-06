import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownBlocks } from '../server/feishu-document-blocks.mjs';
import { personalRequirementSnapshot } from '../server/requirement-personal-document.mjs';

const text = block => Object.values(block).flatMap(value => value?.elements || []).map(element => element.text_run.content).join('');
test('the requirement snapshot follows the agreed template with native headings, code and real attachment placeholders', () => {
  const description = { title: 'Demo A', summary: '可追溯的样例', content: '# 数据概述\n字段与文件对应\n# 数据格式\n```text\n样本/\n└── data.csv # 样本数据\n```\n字段说明', dataVolume: '5000 条/两周', costEstimate: '¥500', difficulty: '低', notes: '-' };
  const snapshot = personalRequirementSnapshot({ title: '需求名称', status: 'open', category: '爬虫', publisher: { name: '发布人' }, publishDate: '2026-10-28', deadlineDate: '2026-11-10', updatedAt: '2026-10-28T08:07:03.566Z', content: '需求正文', shareUrl: 'http://data.prt-ai.cn:8001/?view=requirements&requirement=Req1', documents: [{ id: 'ReqFile', name: '需求.docx', size: 3 }], businessOwners: [{ name: '商务甲' }], developmentOwners: [{ name: '研发甲' }], demos: [{ owner: { name: '研发甲' }, shareUrl: 'http://data.prt-ai.cn:8001/?demo=Demo1', latest: { description, number: 1, status: 'draft', files: [{ id: 'DemoFile', name: '样例.zip', size: 4 }] } }] });
  assert.equal(snapshot.title, '需求名称');
  assert.deepEqual(snapshot.blocks.filter(block => block.heading1).map(text), ['需求信息', '需求内容', '负责人', '需求文档', '数据简介', '数据说明', '数据量级', '成本预估', '难度说明', '注意事项', 'Demo']);
  assert.deepEqual(snapshot.blocks.filter(block => block.heading2).map(text), ['数据概述', '数据格式', 'Demo A']);
  assert.ok(snapshot.blocks.some(block => block.code && text(block).includes('└── data.csv')));
  assert.ok(!JSON.stringify(snapshot.blocks).includes('```')); assert.ok(!JSON.stringify(snapshot.blocks).includes('comment_ids'));
  assert.ok(snapshot.blocks.some(block => text(block).includes('2026-10-28 16:07:03')));
  assert.deepEqual(snapshot.attachments.map(file => file.name), ['需求.docx', '样例.zip']);
  for (const file of snapshot.attachments) assert.deepEqual(snapshot.blocks[file.position], { block_type: 23, file: { token: '' } });
  assert.ok(!JSON.stringify(snapshot.blocks).includes('/download'));
});

test('Markdown formatting uses safe native inline links and preserves long Unicode code without read-only comment metadata', () => {
  const code = '目录😀/\n'.repeat(1800), blocks = markdownBlocks('## 子标题\n- **关键字段** `id`\n1. [平台](https://example.test/data)\n[恶意](javascript:alert)\n```text\n' + code + '```');
  assert.equal(blocks[0].block_type, 5); assert.equal(blocks[1].block_type, 12); assert.equal(blocks[2].block_type, 13);
  assert.ok(blocks[1].bullet.elements.some(element => element.text_run.text_element_style?.bold));
  assert.ok(blocks[1].bullet.elements.some(element => element.text_run.text_element_style?.inline_code));
  assert.equal(blocks[2].ordered.elements[0].text_run.text_element_style.link.url, 'https://example.test/data');
  assert.ok(!JSON.stringify(blocks).includes('"url":"javascript:'));
  assert.equal(blocks.filter(block => block.code).map(text).join(''), code.trimEnd());
  for (const block of blocks) for (const value of Object.values(block)) for (const element of value?.elements || []) assert.ok(Array.from(element.text_run.content).length <= 1000);
});
