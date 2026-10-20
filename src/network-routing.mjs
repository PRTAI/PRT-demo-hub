export async function routeToIntranet(location, fetcher = fetch) {
  try {
    const response = await fetcher('/api/network', { signal: AbortSignal.timeout(2000), credentials: 'omit' });
    if (!response.ok) return false;
    const config = await response.json();
    if (!config.intranetOrigin || location.origin !== config.publicOrigin || location.origin === config.intranetOrigin) return false;
    const target = new URL(config.intranetOrigin);
    if (target.origin !== config.intranetOrigin || !['https:', 'http:'].includes(target.protocol) || target.username || target.password) return false;
    if (location.protocol === 'https:' && target.protocol === 'http:') return false;
    const probe = await fetcher(target.origin + '/api/network', { signal: AbortSignal.timeout(1500), credentials: 'omit', mode: 'cors' });
    if (!probe.ok || (await probe.json()).instance !== config.instance) return false;
    location.replace(target.origin + location.pathname + location.search + location.hash);
    return true;
  } catch { return false; }
}
