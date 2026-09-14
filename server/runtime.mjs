import fs from 'node:fs';

export function validateOrigin(origin) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== origin) throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path or trailing slash');
  return url;
}
export function validateBinding({ demoMode, production, origin, host, containerPreview = false, inContainer = fs.existsSync('/.dockerenv') }) {
  const url = validateOrigin(origin);
  const loopbacks = ['127.0.0.1', 'localhost', '::1', '[::1]'];
  if (production && (demoMode || containerPreview)) throw new Error('Production refuses preview mode');
  if (demoMode && !loopbacks.includes(url.hostname)) throw new Error('Preview APP_ORIGIN must use loopback');
  // Container-local 0.0.0.0 is required for port publishing. compose.yaml binds
  // its host port to 127.0.0.1; production has an entirely separate config/volume.
  if (demoMode && !loopbacks.includes(host) && !(containerPreview && inContainer && host === '0.0.0.0')) throw new Error('Preview mode may bind only to loopback or the explicit local container preview');
}
