import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRequirementDocuments, droppedRequirementDocuments } from '../src/requirement-documents.mjs';

test('requirement document choices accumulate across selections and cancellation preserves the queue', () => {
  const first = new File(['first'], '需求一.txt', { lastModified: 1 });
  const second = new File(['second'], '需求二.txt', { lastModified: 2 });
  const third = new File(['third'], '需求三.txt', { lastModified: 3 });
  const initial = appendRequirementDocuments([], [first, second]);
  const combined = appendRequirementDocuments(initial, [third]);
  assert.deepEqual(combined, [first, second, third]);
  assert.deepEqual(initial, [first, second]);
  assert.deepEqual(appendRequirementDocuments(combined, []), combined);
});

test('dragged documents join the queue, ignore directories and non-file data and fall back to FileList', () => {
  const first = new File(['first'], '需求一.pdf'), second = new File(['second'], '需求二.docx');
  const transfer = { items: [
    { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => first },
    { kind: 'file', getAsFile: () => second },
    { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => { throw new Error('A directory must not be uploaded as a file'); } },
    { kind: 'string', getAsFile: () => { throw new Error('Not a file'); } }
  ] };
  const dropped = droppedRequirementDocuments(transfer);
  assert.equal(dropped.hasDirectories, true); assert.deepEqual(appendRequirementDocuments([first], dropped.files), [first, second]);
  assert.deepEqual(droppedRequirementDocuments({ files: [first, second] }), { files: [first, second], hasDirectories: false });
  assert.deepEqual(droppedRequirementDocuments({ items: [{ kind: 'string' }] }).files, []);
});

test('repeated choices are deduplicated while a modified document or removed document can be added', () => {
  const first = new File(['first'], '需求.txt', { lastModified: 1 });
  const repeated = new File(['first'], '需求.txt', { lastModified: 1 });
  const modified = new File(['changed'], '需求.txt', { lastModified: 2 });
  assert.deepEqual(appendRequirementDocuments([first], [repeated, modified]), [first, modified]);
  assert.deepEqual(appendRequirementDocuments([], [repeated]), [repeated]);
});
