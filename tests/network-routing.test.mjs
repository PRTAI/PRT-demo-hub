import test from 'node:test';
import assert from 'node:assert/strict';
import { routeToIntranet } from '../src/network-routing.mjs';

const config = { instance: 'test-instance', publicOrigin: 'http://data.prt-ai.cn:8001', intranetOrigin: 'http://192.168.110.25:8001' };
const response = body => ({ ok: true, json: async () => body });
function location(origin = config.publicOrigin) { return { origin, protocol: new URL(origin).protocol, pathname: '/', search: '?view=my-requirements&requirement=test', hash: '#details', replace(url) { this.destination = url; } }; }

test('reachable intranet redirects the entire page before upload and preserves navigation', async () => {
  const page = location(), calls = [];
  const routed = await routeToIntranet(page, async (url, options) => { calls.push({ url, options }); return response(config); });
  assert.equal(routed, true);
  assert.equal(page.destination, config.intranetOrigin + '/?view=my-requirements&requirement=test#details');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, config.intranetOrigin + '/api/network');
  assert.equal(calls[1].options.credentials, 'omit');
});

test('external clients, different instances and existing intranet pages never redirect', async () => {
  for (const mode of ['unreachable', 'different', 'internal', 'unconfigured']) {
    const page = location(mode === 'internal' ? config.intranetOrigin : undefined); let calls = 0;
    assert.equal(await routeToIntranet(page, async () => { calls++; if (calls === 1) return response(mode === 'unconfigured' ? {} : config); if (mode === 'unreachable') throw new Error('network'); return response({ ...config, instance: 'another-app' }); }), false);
    assert.equal(page.destination, undefined);
  }
});

test('network routing refuses mixed content and invalid redirect origins', async () => {
  const page = location('https://data.prt-ai.cn');
  assert.equal(await routeToIntranet(page, async () => response({ ...config, publicOrigin: page.origin })), false);
  assert.equal(page.destination, undefined);
  const other = location();
  assert.equal(await routeToIntranet(other, async () => response({ ...config, intranetOrigin: 'https://user:secret@example.org' })), false);
});
