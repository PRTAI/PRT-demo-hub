import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRequirementDocuments } from '../src/requirement-documents.mjs';

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

test('repeated choices are deduplicated while a modified document or removed document can be added', () => {
  const first = new File(['first'], '需求.txt', { lastModified: 1 });
  const repeated = new File(['first'], '需求.txt', { lastModified: 1 });
  const modified = new File(['changed'], '需求.txt', { lastModified: 2 });
  assert.deepEqual(appendRequirementDocuments([first], [repeated, modified]), [first, modified]);
  assert.deepEqual(appendRequirementDocuments([], [repeated]), [repeated]);
});
