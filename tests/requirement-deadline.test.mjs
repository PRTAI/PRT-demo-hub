import test from 'node:test';
import assert from 'node:assert/strict';
import { requirementDeadlineState } from '../shared/requirement-schedule.mjs';

test('deadline alerts use the end of the deadline day in China and a strict 24-hour threshold', () => {
  const state = time => requirementDeadlineState('2026-10-24', 'open', Date.parse(time));
  assert.equal(state('2026-10-23T23:59:59+08:00'), 'normal');
  assert.equal(state('2026-10-24T00:00:00+08:00'), 'normal');
  assert.equal(state('2026-10-24T00:00:01+08:00'), 'urgent');
  assert.equal(state('2026-10-24T23:59:59+08:00'), 'urgent');
  assert.equal(state('2026-10-25T00:00:00+08:00'), 'overdue');
  assert.equal(state('2026-10-24T16:00:00Z'), 'overdue');
});

test('closed and delivered requirements retain normal deadline labels and missing dates have no alert', () => {
  const currentTime = Date.parse('2026-10-25T00:00:00+08:00');
  for (const status of ['open', 'needs_update']) assert.equal(requirementDeadlineState('2026-10-24', status, currentTime), 'overdue');
  for (const status of ['closed', 'delivered']) assert.equal(requirementDeadlineState('2026-10-24', status, currentTime), 'normal');
  for (const value of ['', undefined, '2026-02-30']) assert.equal(requirementDeadlineState(value, 'open', currentTime), 'none');
  assert.equal(requirementDeadlineState('2028-02-29', 'open', Date.parse('2028-02-29T12:00:00+08:00')), 'urgent');
});
