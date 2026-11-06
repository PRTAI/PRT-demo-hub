import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { uploadDocumentAttachments } from '../server/feishu-document-attachments.mjs';

function fixture(t, bytes = Buffer.from('original sample bytes')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-feishu-attachment-')), id = randomUUID();
  fs.mkdirSync(path.join(root, 'files')); fs.writeFileSync(path.join(root, 'files', id), bytes);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = { id, position: 2, name: '任务/原始样例.csv', size: bytes.length, checksum: 'saved-checksum' };
  return { root, file, bytes, snapshot: { attachments: [file] }, states: { 2: { blockId: 'FileBlock1' } }, store: { root, one: () => ({ size: file.size, checksum: file.checksum }) }, job: { document_id: 'Doc1' } };
}

test('native attachment upload streams the original name/bytes and retries replace on the same block without uploading again', async t => {
  const ctx = fixture(t), calls = [], saved = []; let failReplace = true;
  const request = async (resource, body, method) => {
    calls.push({ resource, body, method });
    if (body instanceof FormData) {
      assert.equal(body.get('file_name'), ctx.file.name); assert.equal(body.get('file').name, ctx.file.name);
      assert.deepEqual(Buffer.from(await body.get('file').arrayBuffer()), ctx.bytes);
      assert.equal(body.get('parent_type'), 'docx_file'); assert.equal(body.get('parent_node'), 'FileBlock1');
      assert.deepEqual(JSON.parse(body.get('extra')), { drive_route_token: 'Doc1' });
      return { file_token: 'Media1' };
    }
    assert.equal(method, 'PATCH'); assert.equal(resource, 'docx/v1/documents/Doc1/blocks/FileBlock1?document_revision_id=-1');
    assert.deepEqual(body, { replace_file: { token: 'Media1' } });
    if (failReplace) { failReplace = false; throw new Error('temporary replace failure'); }
    return {};
  };
  const run = () => uploadDocumentAttachments(ctx.store, ctx.job, ctx.snapshot, ctx.states, request, () => saved.push(structuredClone(ctx.states)));
  await assert.rejects(run(), /temporary/);
  assert.equal(saved.at(-1)[2].fileToken, 'Media1'); assert.ok(!saved.at(-1)[2].done);
  await run(); assert.equal(ctx.states[2].done, true);
  assert.equal(calls.filter(call => call.body instanceof FormData).length, 1);
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 2);
  await run(); assert.equal(calls.length, 3);
});

test('large attachments resume at the failed part, preserve every byte and finish before replacing the file block', async t => {
  const ctx = fixture(t, Buffer.from('0123456789abc')), parts = [], calls = [], persisted = []; let failPart = true;
  const request = async (resource, body) => {
    calls.push(resource);
    if (resource.endsWith('/upload_prepare')) return { upload_id: 'Upload1', block_size: 4, block_num: 4 };
    if (resource.endsWith('/upload_part')) {
      const seq = Number(body.get('seq'));
      if (seq === 2 && failPart) { failPart = false; throw new Error('network interruption'); }
      assert.equal(body.get('upload_id'), 'Upload1'); assert.equal(Number(body.get('size')), body.get('file').size);
      parts[seq] = Buffer.from(await body.get('file').arrayBuffer()); return {};
    }
    if (resource.endsWith('/upload_finish')) { assert.deepEqual(body, { upload_id: 'Upload1', block_num: 4 }); assert.deepEqual(Buffer.concat(parts), ctx.bytes); return { file_token: 'LargeMedia1' }; }
    assert.deepEqual(body, { replace_file: { token: 'LargeMedia1' } }); return {};
  };
  const run = () => uploadDocumentAttachments(ctx.store, ctx.job, ctx.snapshot, ctx.states, request, () => persisted.push(structuredClone(ctx.states)), { singleUploadBytes: 5 });
  await assert.rejects(run(), /network interruption/);
  assert.equal(persisted.at(-1)[2].nextPart, 2); assert.ok(!calls.some(resource => resource.includes('/blocks/')));
  // Simulate restoring only the persisted state after a service restart.
  ctx.states = persisted.at(-1); await run();
  assert.equal(ctx.states[2].done, true);
  assert.equal(calls.filter(resource => resource.endsWith('/upload_prepare')).length, 1);
  assert.equal(calls.filter(resource => resource.endsWith('/upload_part')).length, 5);
  assert.equal(calls.filter(resource => resource.endsWith('/upload_finish')).length, 1);
});

test('missing or changed source bytes fail explicitly, while a legitimate zero-byte file is submitted unchanged', async t => {
  const ctx = fixture(t), source = path.join(ctx.root, 'files', ctx.file.id); let called = false;
  const run = () => uploadDocumentAttachments(ctx.store, ctx.job, ctx.snapshot, ctx.states, async () => { called = true; return {}; }, () => {});
  fs.writeFileSync(source, 'changed size'); await assert.rejects(run(), /不完整/); assert.equal(called, false);
  fs.rmSync(source); await assert.rejects(run(), /缺失/); assert.equal(called, false);
  const empty = fixture(t, Buffer.alloc(0));
  await uploadDocumentAttachments(empty.store, empty.job, empty.snapshot, empty.states, async (resource, body) => {
    if (body instanceof FormData) { assert.equal(body.get('file').size, 0); assert.equal(body.get('size'), '0'); return { file_token: 'EmptyMedia' }; }
    return {};
  }, () => {});
  assert.equal(empty.states[2].done, true);
});
