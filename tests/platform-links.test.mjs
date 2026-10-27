import test from 'node:test';
import assert from 'node:assert/strict';
import { platformLink, platformPath } from '../shared/platform-links.mjs';

test('share links use the configured address, preserve requirement and Demo targets and reject untrusted redirect input', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(platformPath({ requirementId: id, demoId: id }), `/?view=requirements&requirement=${id}&demo=${id}`);
  assert.equal(platformLink('http://data.prt-ai.cn:8001/other?ignored=1', { demoId: id }), `http://data.prt-ai.cn:8001/?demo=${id}`);
  assert.equal(platformPath({ requirementId: 'https://attacker.example', demoId: '//attacker.example' }), '/');
  assert.equal(platformPath({ requirementId: ['one', 'two'] }), '/');
  for (const origin of ['javascript:alert(1)', 'https://user:password@example.org', 'file:///tmp']) assert.throws(() => platformLink(origin, { demoId: id }));
});
