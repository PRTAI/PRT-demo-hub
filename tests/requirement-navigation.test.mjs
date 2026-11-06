import test from 'node:test';
import assert from 'node:assert/strict';
import { readRequirementList, saveRequirementList, requirementReturnTop } from '../src/requirement-navigation.mjs';

test('returning to requirements preserves filters, page and card position separately per account and list', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const state = { query: '负责人甲', status: 'needs_update', page: 3, anchor: { id: 'req-one', y: 1530, offset: 270 } };
  saveRequirementList(storage, 'user-one-all', state);
  assert.deepEqual(readRequirementList(storage, 'user-one-all'), state);
  assert.equal(readRequirementList(storage, 'user-two-all').page, 1); assert.equal(readRequirementList(storage, 'user-one-mine').anchor, null);
  // The refreshed card moved down by 130px; restore its screen position, not the obsolete scroll offset.
  assert.equal(requirementReturnTop(state.anchor, { getBoundingClientRect: () => ({ top: 400 }) }, 1530), 1660);
  assert.equal(requirementReturnTop(state.anchor, null, 0), 1530); // Removed/filtered card: preserve nearby list position.
  assert.equal(requirementReturnTop(state.anchor, { getBoundingClientRect: () => ({ top: 10 }) }, 0), 0);
});

test('corrupt or unavailable session storage cannot prevent opening the requirements page', () => {
  assert.equal(readRequirementList({ getItem: () => '{bad json' }, 'key').page, 1);
  assert.equal(readRequirementList({ getItem: () => JSON.stringify({ query: '', status: 'all', page: -1 }) }, 'key').page, 1);
  assert.equal(readRequirementList({ getItem: () => { throw new Error('denied'); } }, 'key').anchor, null);
  assert.doesNotThrow(() => saveRequirementList({ setItem: () => { throw new Error('full'); } }, 'key', {}));
});
