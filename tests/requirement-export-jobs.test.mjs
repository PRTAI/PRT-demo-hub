import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, uid } from '../server/db.mjs';
import { seedPreview } from '../server/seed.mjs';
import { createPersonalRequirementDocuments } from '../server/requirement-personal-document.mjs';
import { createRequirementExports } from '../server/requirement-export.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-export-jobs-'));
  const ctx = { store: openStore(root), calls: [], documents: [], controls: {} };
  seedPreview(ctx.store);
  ctx.reopen = () => {
    ctx.personal = createPersonalRequirementDocuments(ctx.store, { demoMode: false, personalDocumentFetch: async (input, options) => {
      const url = new URL(input), body = JSON.parse(options.body);
      ctx.calls.push({ url, body, token: options.headers.Authorization });
      assert.ok(url.pathname.startsWith('/open-apis/docx/v1/documents'));
      ctx.controls.onCall?.(url, body);
      if (url.pathname.endsWith('/documents')) {
        assert.deepEqual(Object.keys(body), ['title']);
        const document = { document_id: 'Personal' + (ctx.documents.length + 1), title: body.title };
        ctx.documents.push(document);
        if (ctx.controls.loseCreate) throw new Error('lost response');
        return { ok: true, json: async () => ({ code: 0, data: { document } }) };
      }
      if (ctx.controls.failDocument && url.pathname.includes('/' + ctx.controls.failDocument + '/')) return { ok: false, status: 400, json: async () => ({ code: 123 }) };
      return { ok: true, json: async () => ({ code: 0, data: {} }) };
    } });
    ctx.exports = createRequirementExports(ctx.store, ctx.personal);
  };
  ctx.reopen();
  t.after(async () => { await ctx.exports.drain(); await ctx.personal.drain(); ctx.store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  ctx.item = (title = '需求快照') => {
    const id = uid();
    ctx.store.run('INSERT INTO requirements(id,title,content,category,status,publisher_id,revision,created_at,updated_at,planned_date,deadline_date) SELECT ?,?,content,category,status,publisher_id,0,created_at,updated_at,planned_date,deadline_date FROM requirements LIMIT 1', id, title);
    return { id, title, rows: [{ title, deadlineDate: '2028-01-02', sampleNames: 'Demo ' + title }], snapshot: { title: title + ' · 需求导出', blocks: [{ block_type: 2, text: { elements: [{ text_run: { content: '冻结内容 ' + title } }] } }] } };
  };
  ctx.selected = [ctx.item('甲'), ctx.item('乙')];
  ctx.restart = () => { ctx.store.db.close(); ctx.store = openStore(root); ctx.reopen(); };
  return ctx;
}
const token = () => 'synthetic-user-token';

test('personal batches freeze scope, rows and document bodies before consent and persist completion across restart', async t => {
  const ctx = fixture(t), filters = { q: '负责人', status: 'open', assigned: '1' }, selected = ctx.selected[0];
  const job = ctx.exports.create('preview-pm', filters, [selected]);
  assert.equal(job.status, 'authorization_required'); assert.equal(job.total, 1); assert.equal(ctx.calls.length, 0);
  selected.rows[0].title = '后续修改'; selected.snapshot.blocks[0].text.elements[0].text_run.content = '后续修改';
  assert.equal(ctx.exports.retry(job.id, 'preview-pm', token).status, 'pending');
  await ctx.exports.drain();
  const ready = ctx.exports.status(job.id, 'preview-pm');
  assert.equal(ready.status, 'ready'); assert.equal(ready.completed, 1);
  assert.ok(ctx.calls.some(call => JSON.stringify(call.body).includes('冻结内容 甲')));
  assert.ok(!ctx.calls.some(call => JSON.stringify(call.body).includes('后续修改')));
  ctx.restart();
  assert.equal(ctx.exports.status(job.id, 'preview-pm').status, 'ready');
  assert.deepEqual(ctx.exports.status(job.id, 'preview-pm').filters, filters);
  assert.equal(ctx.exports.rows(job.id, 'preview-pm')[0].title, '甲');
  assert.match(ctx.exports.rows(job.id, 'preview-pm')[0].documentUrl, /^https:\/\/www.feishu.cn\/docx\/Personal1$/);
  for (const method of ['status', 'rows', 'retry']) assert.equal(ctx.exports[method](job.id, 'preview-manager', token), null);
});

test('personal batches retry only incomplete items, resume the same document and keep stable block request tokens', async t => {
  const ctx = fixture(t); ctx.controls.failDocument = 'Personal2';
  const job = ctx.exports.create('preview-pm', {}, ctx.selected, token);
  await ctx.exports.drain();
  let progress = ctx.exports.status(job.id, 'preview-pm');
  assert.equal(progress.status, 'failed'); assert.equal(progress.completed, 1); assert.equal(progress.failed, 1);
  assert.equal(progress.errors[0].requirementId, ctx.selected[1].id);
  const firstCalls = ctx.calls.filter(call => call.url.pathname.includes('/Personal1/')).length;
  ctx.controls.failDocument = '';
  ctx.exports.retry(job.id, 'preview-pm', token); ctx.exports.retry(job.id, 'preview-pm', token);
  await ctx.exports.drain(); progress = ctx.exports.status(job.id, 'preview-pm');
  assert.equal(progress.status, 'ready'); assert.equal(ctx.documents.length, 2);
  assert.equal(ctx.calls.filter(call => call.url.pathname.includes('/Personal1/')).length, firstCalls);
  const attempts = ctx.calls.filter(call => call.url.pathname.includes('/Personal2/'));
  assert.equal(attempts.length, 2); assert.equal(attempts[0].url.search, attempts[1].url.search);
  assert.deepEqual(attempts[0].body, attempts[1].body);
});

test('large personal batches serialize documents, deduplicate concurrent batches and reuse single exports with identical snapshots', async t => {
  const ctx = fixture(t), selected = Array.from({ length: 66 }, (_, index) => ctx.item('批量 ' + index));
  ctx.personal.start(selected[0].id, 'preview-pm', selected[0].snapshot, token());
  const job = ctx.exports.create('preview-pm', {}, selected, token), repeated = ctx.exports.create('preview-pm', {}, selected, token);
  await ctx.exports.drain();
  assert.equal(ctx.exports.status(job.id, 'preview-pm').completed, 66);
  assert.equal(ctx.exports.status(repeated.id, 'preview-pm').status, 'ready');
  assert.equal(ctx.documents.length, 66);
  for (let index = 1; index < ctx.calls.length; index++) if (ctx.calls[index].url.pathname.endsWith('/documents')) assert.ok(ctx.calls[index - 1].url.pathname.endsWith('/children'));
  const reused = ctx.personal.start(selected[1].id, 'preview-pm', selected[1].snapshot, token());
  assert.equal(reused.status, 'ready'); assert.equal(ctx.documents.length, 66);
  assert.equal(ctx.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='requirement_wiki'"), undefined);
});

test('expired authorization pauses remaining batch items and a restart resumes the frozen snapshot after consent', async t => {
  const ctx = fixture(t); let authorized = true;
  ctx.controls.onCall = url => { if (url.pathname.endsWith('/children')) authorized = false; };
  const job = ctx.exports.create('preview-pm', {}, ctx.selected, () => authorized ? token() : null);
  await ctx.exports.drain();
  let progress = ctx.exports.status(job.id, 'preview-pm');
  assert.equal(progress.status, 'authorization_required'); assert.equal(progress.completed, 1); assert.equal(ctx.documents.length, 1);
  ctx.restart(); ctx.controls.onCall = null;
  assert.equal(ctx.exports.status(job.id, 'preview-pm').authorizationRequired, true);
  ctx.exports.retry(job.id, 'preview-pm', token); await ctx.exports.drain();
  assert.equal(ctx.exports.status(job.id, 'preview-pm').status, 'ready'); assert.equal(ctx.documents.length, 2);
  const revoked = ctx.exports.create('preview-pm', {}, [ctx.item('停用账号')], token);
  ctx.store.run("UPDATE users SET enabled=0 WHERE id='preview-pm'"); await ctx.exports.drain();
  progress = ctx.exports.status(revoked.id, 'preview-pm');
  assert.equal(progress.status, 'failed'); assert.match(progress.errors[0].error, /项目经理权限/); assert.equal(ctx.documents.length, 2);
});

test('ambiguous creation remains blocked on retry instead of creating duplicates', async t => {
  const ctx = fixture(t); ctx.controls.loseCreate = true;
  const job = ctx.exports.create('preview-pm', {}, [ctx.selected[0]], token); await ctx.exports.drain();
  assert.equal(ctx.exports.status(job.id, 'preview-pm').status, 'failed');
  ctx.controls.loseCreate = false; ctx.exports.retry(job.id, 'preview-pm', token); await ctx.exports.drain();
  assert.equal(ctx.documents.length, 1); assert.equal(ctx.exports.status(job.id, 'preview-pm').failed, 1);
});

test('preview and empty batches do not write external documents; pruning keeps personal documents and rejects legacy wiki jobs', async t => {
  const ctx = fixture(t), preview = createRequirementExports(ctx.store, ctx.personal, { demoMode: true });
  const job = preview.create('preview-pm', {}, ctx.selected);
  assert.equal(job.status, 'ready'); assert.equal(job.preview, true); assert.equal(ctx.calls.length, 0);
  const real = ctx.exports.create('preview-pm', {}, [ctx.selected[0]], token); await ctx.exports.drain();
  ctx.store.run("UPDATE requirement_exports SET destination='legacy' WHERE id=?", job.id);
  assert.equal(ctx.exports.status(job.id, 'preview-pm'), null);
  ctx.store.run("UPDATE requirement_exports SET created_at='2000-01-01T00:00:00.000Z'");
  const empty = ctx.exports.create('preview-pm', {}, []);
  assert.equal(empty.status, 'ready'); assert.equal(empty.total, 0);
  assert.equal(ctx.exports.status(real.id, 'preview-pm'), null);
  assert.equal(ctx.store.one('SELECT COUNT(*) AS count FROM requirement_personal_documents').count, 1);
});

test('legacy export tables migrate without losing snapshots or claiming wiki documents belong to personal cloud', async t => {
  const ctx = fixture(t), preview = createRequirementExports(ctx.store, ctx.personal, { demoMode: true });
  const old = preview.create('preview-pm', {}, [ctx.selected[0]]);
  const before = ctx.store.one('SELECT rows FROM requirement_export_items WHERE export_id=?', old.id).rows;
  for (const column of ['destination', 'authorization_required']) ctx.store.db.exec('ALTER TABLE requirement_exports DROP COLUMN ' + column);
  for (const column of ['snapshot', 'personal_document_id', 'state', 'error']) ctx.store.db.exec('ALTER TABLE requirement_export_items DROP COLUMN ' + column);
  ctx.exports = createRequirementExports(ctx.store, ctx.personal);
  assert.equal(ctx.exports.status(old.id, 'preview-pm'), null);
  assert.equal(ctx.store.one('SELECT rows FROM requirement_export_items WHERE export_id=?', old.id).rows, before);
  assert.equal(ctx.store.one('SELECT destination FROM requirement_exports WHERE id=?', old.id).destination, 'legacy');
  const fresh = ctx.exports.create('preview-pm', {}, [ctx.selected[0]], token);
  await ctx.exports.drain();
  assert.equal(ctx.exports.status(fresh.id, 'preview-pm').status, 'ready');
  assert.deepEqual(ctx.store.all('PRAGMA foreign_key_check'), []);
});

test('pending single and batch snapshots never substitute newer or older content with a different fingerprint', async t => {
  const ctx = fixture(t), item = ctx.selected[0];
  const earlier = ctx.personal.start(item.id, 'preview-pm', item.snapshot, token());
  const changed = structuredClone(item.snapshot); changed.blocks[0].text.elements[0].text_run.content = '第二份快照正文';
  const later = ctx.personal.start(item.id, 'preview-pm', changed, token());
  assert.notEqual(earlier.id, later.id);
  assert.equal(ctx.personal.start(item.id, 'preview-pm', item.snapshot, token()).id, earlier.id);
  await ctx.personal.drain();
  assert.equal(ctx.documents.length, 2);
  assert.ok(ctx.calls.some(call => JSON.stringify(call.body).includes('第二份快照正文')));
  assert.equal(ctx.personal.get(earlier.id, 'preview-pm').status, 'ready');
  assert.equal(ctx.personal.get(later.id, 'preview-manager'), null);
});

test('batch export skips deleted requirements before processing and excludes them from persisted Excel rows', async t => {
  const ctx = fixture(t), removed = ctx.selected[0];
  const job = ctx.exports.create('preview-pm', {}, ctx.selected);
  ctx.store.run('UPDATE requirements SET deleted_at=? WHERE id=?', new Date().toISOString(), removed.id);
  ctx.exports.retry(job.id, 'preview-pm', token); await ctx.exports.drain();
  assert.equal(ctx.exports.status(job.id, 'preview-pm').status, 'ready');
  assert.equal(ctx.documents.length, 1); assert.equal(ctx.documents[0].title, ctx.selected[1].snapshot.title);
  assert.deepEqual(ctx.exports.rows(job.id, 'preview-pm').map(row => row.title), ['乙']);
  ctx.restart(); assert.deepEqual(ctx.exports.rows(job.id, 'preview-pm').map(row => row.title), ['乙']);
});

test('deletion during an export cancels its last response and lets the remaining requirements finish', async t => {
  const ctx = fixture(t), removed = ctx.selected[0];
  ctx.controls.onCall = url => {
    if (url.pathname.includes('/Personal1/') && url.pathname.endsWith('/children')) ctx.store.run('UPDATE requirements SET deleted_at=? WHERE id=?', new Date().toISOString(), removed.id);
  };
  const job = ctx.exports.create('preview-pm', {}, ctx.selected, token); await ctx.exports.drain();
  assert.equal(ctx.exports.status(job.id, 'preview-pm').status, 'ready');
  assert.equal(ctx.store.one('SELECT state FROM requirement_export_items WHERE export_id=? AND requirement_id=?', job.id, removed.id).state, 'deleted');
  const document = ctx.store.one('SELECT * FROM requirement_personal_documents WHERE requirement_id=?', removed.id);
  assert.equal(document.status, 'failed'); assert.match(document.error, /需求已删除/);
  assert.ok(document.document_id); assert.equal(ctx.documents.length, 2);
  assert.deepEqual(ctx.exports.rows(job.id, 'preview-pm').map(row => row.title), ['乙']);
});
