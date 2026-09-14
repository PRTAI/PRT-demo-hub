import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequestId } from '../src/request-id.mjs';

test('upload request IDs work on LAN HTTP without crypto.randomUUID', () => {
  const httpCrypto = { getRandomValues: values => webcrypto.getRandomValues(values) };
  const ids = Array.from({ length: 100 }, () => createRequestId(httpCrypto));
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(createRequestId(webcrypto), /^[0-9a-f-]{36}$/);
});
