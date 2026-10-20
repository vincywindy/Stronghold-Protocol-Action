import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalog } from '../scripts/plugin-catalog.mjs';

export function healthTarget(env, sources) {
  const enabled = env.PLUGIN_MANAGER_ENABLED || 'auto';
  const managed = enabled !== '0' && (enabled !== 'auto' || Object.keys(sources).length > 0);
  return { managed, url: `http://127.0.0.1:${managed ? env.PLUGIN_MANAGER_PORT || 3001 : env.PORT || 3000}/healthz` };
}

export async function checkHealth(env = process.env, sources = readCatalog().sources) {
  const { managed, url } = healthTarget(env, sources);
  const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!response.ok) throw new Error(`Health HTTP ${response.status}`);
  const body = await response.json();
  if (body.ok !== true || managed && body.service !== 'plugin-manager') throw new Error('Unexpected health response');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Traefik removes every route of an unhealthy container. In managed mode the recovery UI
  // must remain reachable even when the game fails; game readiness stays in /api/state and port 3000.
  try { await checkHealth(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
