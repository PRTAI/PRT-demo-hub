import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, uid } from '../server/db.mjs';
import { seedPreview } from '../server/seed.mjs';
import { createRequirementWiki } from '../server/requirement-wiki.mjs';
import { createRequirementExports } from '../server/requirement-export.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-export-jobs-'));
  const ctx = { store: openStore(root) };
  seedPreview(ctx.store);
  ctx.reopen = () => {
    ctx.wiki = createRequirementWiki(ctx.store, { demoMode: true });
    ctx.exports = createRequirementExports(ctx.store, ctx.wiki);
  };
  ctx.reopen();
  t.after(() => { ctx.store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  ctx.selected = ctx.store.all('SELECT * FROM requirements LIMIT 2').map((requirement, index) => ({ id: requirement.id, title: requirement.title, rows: [{ deadlineDate: '2028-01-02', demoName: 'Demo ' + index, associatedPeople: '负责人', documentUrl: '' }] }));
  // Ensure two distinct historical requirements even if preview fixtures later contain only one.
  if (ctx.selected.length < 2) {
    const id = uid();
    ctx.store.run('INSERT INTO requirements SELECT ?,title,content,category,status,publisher_id,0,created_at,updated_at,planned_date,deadline_date FROM requirements LIMIT 1', id);
    ctx.selected.push({ ...ctx.selected[0], id, rows: [{ ...ctx.selected[0].rows[0], demoName: 'Demo 1' }] });
  }
  ctx.ready = id => {
    const url = 'https://team.feishu.cn/wiki/Doc' + id.replaceAll('-', '');
    ctx.store.run("UPDATE requirement_wiki SET status='synced',url=? WHERE requirement_id=?", url, id);
    return url;
  };
  ctx.restart = () => { ctx.store.db.close(); ctx.store = openStore(root); ctx.reopen(); };
  return ctx;
}

test('export preparation queues only selected history, reuses pending jobs and persists exact rows and completed URLs across restarts', t => {
  const ctx = fixture(t), filters = { q: '负责人', status: 'open', assigned: '1' };
  const untouched = ctx.selected[1].id;
  const job = ctx.exports.create('preview-pm', filters, [ctx.selected[0]]);
  assert.equal(job.status, 'pending'); assert.equal(job.total, 1); assert.equal(job.completed, 0);
  assert.equal(ctx.wiki.info(untouched).status, 'not_created');
  const generation = ctx.store.one('SELECT generation FROM requirement_wiki WHERE requirement_id=?', ctx.selected[0].id).generation;
  ctx.exports.create('preview-pm', filters, [ctx.selected[0]]);
  assert.equal(ctx.store.one('SELECT generation FROM requirement_wiki WHERE requirement_id=?', ctx.selected[0].id).generation, generation);
  const url = ctx.ready(ctx.selected[0].id);
  assert.equal(ctx.exports.status(job.id, 'preview-pm').status, 'ready');
  ctx.selected[0].rows[0].demoName = '修改后的名称不能更改之前的导出快照';
  ctx.wiki.enqueue(ctx.selected[0].id);
  ctx.restart();
  assert.equal(ctx.exports.status(job.id, 'preview-pm').status, 'ready');
  assert.deepEqual(ctx.exports.status(job.id, 'preview-pm').filters, filters);
  assert.equal(ctx.exports.rows(job.id, 'preview-pm')[0].demoName, 'Demo 0');
  assert.equal(ctx.exports.rows(job.id, 'preview-pm')[0].documentUrl, url);
  assert.equal(ctx.exports.status(job.id, 'preview-manager'), null);
  assert.equal(ctx.exports.rows(job.id, 'preview-manager'), null);
  assert.equal(ctx.exports.retry(job.id, 'preview-manager'), null);
});

test('export waits for required document generations, reports failures and retries only incomplete failed items', t => {
  const ctx = fixture(t), job = ctx.exports.create('preview-pm', {}, ctx.selected);
  const [first, second] = ctx.selected;
  ctx.ready(first.id);
  ctx.store.run("UPDATE requirement_wiki SET status='failed',attempts=5,error='飞书权限不足' WHERE requirement_id=?", second.id);
  const firstGeneration = ctx.store.one('SELECT generation FROM requirement_wiki WHERE requirement_id=?', first.id).generation;
  // Retrying before a progress read must still recognize successful items.
  const retried = ctx.exports.retry(job.id, 'preview-pm');
  assert.equal(retried.status, 'pending'); assert.equal(retried.completed, 1); assert.equal(retried.pending, 1);
  assert.equal(ctx.store.one('SELECT generation FROM requirement_wiki WHERE requirement_id=?', first.id).generation, firstGeneration);
  assert.equal(ctx.store.one('SELECT attempts FROM requirement_wiki WHERE requirement_id=?', second.id).attempts, 0);
  ctx.store.run("UPDATE requirement_wiki SET status='failed',error='飞书权限仍不足' WHERE requirement_id=?", second.id);
  const failed = ctx.exports.status(job.id, 'preview-pm');
  assert.equal(failed.status, 'failed'); assert.equal(failed.failed, 1);
  assert.deepEqual(failed.errors, [{ requirementId: second.id, title: second.title, error: '飞书权限仍不足' }]);
  ctx.exports.retry(job.id, 'preview-pm'); ctx.ready(second.id);
  assert.equal(ctx.exports.status(job.id, 'preview-pm').status, 'ready');
  assert.ok(ctx.exports.rows(job.id, 'preview-pm').every(row => row.documentUrl.startsWith('https://team.feishu.cn/wiki/')));
});

test('preview and empty exports complete without scheduling external writes, while expired snapshots are cleaned without deleting wiki records', t => {
  const ctx = fixture(t), preview = createRequirementExports(ctx.store, ctx.wiki, { demoMode: true });
  const job = preview.create('preview-pm', {}, ctx.selected);
  assert.equal(job.status, 'ready'); assert.equal(job.preview, true); assert.equal(job.completed, ctx.selected.length);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_wiki').count, 0);
  const realJob = ctx.exports.create('preview-pm', {}, [ctx.selected[0]]);
  ctx.store.run("UPDATE requirement_exports SET created_at='2000-01-01T00:00:00.000Z'");
  const empty = ctx.exports.create('preview-pm', {}, []);
  assert.equal(empty.status, 'ready'); assert.equal(empty.total, 0);
  assert.equal(ctx.exports.status(realJob.id, 'preview-pm'), null);
  assert.equal(ctx.wiki.info(ctx.selected[0].id).status, 'pending');
});
