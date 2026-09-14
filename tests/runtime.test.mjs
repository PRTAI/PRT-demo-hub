import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBinding, validateOrigin } from '../server/runtime.mjs';
test('container preview is explicit, loopback only, and forbidden in production', () => {
  const settings = { demoMode: true, production: false, origin: 'http://127.0.0.1:8080', host: '0.0.0.0', containerPreview: true, inContainer: true };
  assert.doesNotThrow(() => validateBinding(settings));
  assert.throws(() => validateBinding({ ...settings, production: true }), /Production/);
  assert.throws(() => validateBinding({ ...settings, inContainer: false }), /loopback/);
  assert.throws(() => validateBinding({ ...settings, containerPreview: false }), /loopback/);
  assert.throws(() => validateBinding({ ...settings, origin: 'https://external.example' }), /loopback/);
  assert.throws(() => validateOrigin('https://example.com/'), /origin/);
  assert.throws(() => validateOrigin('https://user:secret@example.com'), /origin/);
  assert.doesNotThrow(() => validateBinding({ ...settings, demoMode: false, production: true, containerPreview: false, origin: 'https://internal.example' }));
});
