import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { catalogPath, readCatalog, validateCatalog } from './plugin-catalog.mjs';

async function json(url) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN && new URL(url).hostname === 'api.github.com') headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export async function refreshCatalog(catalog = readCatalog(), request = json) {
  const next = structuredClone(catalog);
  for (const [id, source] of Object.entries(next.sources)) {
    const commit = await request(`https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`);
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error(`No resolved source SHA: ${id}`);
    source.revision = commit.sha;
    const raw = `https://raw.githubusercontent.com/${source.repository}/${commit.sha}`;
    const previous = next.plugins.filter(p => p.source === id);
    let plugins;
    if (previous.some(p => p.adapter === 'forge')) {
      const index = await request(`${raw}/mods/index.json`);
      if (!Array.isArray(index.mods) || !index.mods.length) throw new Error('Forge index is empty or malformed');
      plugins = index.mods.map(row => ({ source: id, id: row.id, name: row.name, version: row.version,
        license: previous.find(p => p.id === row.id)?.license || 'NOASSERTION', adapter: 'forge', path: row.path, sha256: row.sha256 }));
    } else {
      const tree = await request(`https://api.github.com/repos/${source.repository}/git/trees/${commit.sha}?recursive=1`);
      if (tree.truncated || !Array.isArray(tree.tree)) throw new Error(`Incomplete repository tree: ${id}`);
      plugins = [];
      for (const entry of tree.tree.filter(p => /^plugins\/[a-z0-9][a-z0-9-]+\/plugin\.json$/.test(p.path))) {
        const manifest = await request(`${raw}/${entry.path}`);
        const pluginId = entry.path.split('/')[1];
        if (manifest.id !== pluginId) throw new Error(`Manifest ID differs from folder: ${entry.path}`);
        plugins.push({ source: id, id: pluginId, name: typeof manifest.name === 'string' ? manifest.name : manifest.name.zh || manifest.name.en,
          version: manifest.version, license: manifest.license || 'NOASSERTION',
          adapter: source.repository === 'llleeeqi/Stronghold-Protocol-Lele-Mods' ? 'lele' : 'native', path: `plugins/${pluginId}` });
      }
      if (!plugins.length) throw new Error(`No plugin manifests found: ${id}`);
    }
    // Discovery does not evaluate compatibility. Save all sources together only after every lookup succeeds.
    next.plugins = [...next.plugins.filter(p => p.source !== id), ...plugins];
  }
  next.plugins.sort((a, b) => `${a.source}/${a.id}`.localeCompare(`${b.source}/${b.id}`, 'en'));
  return validateCatalog(next);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.writeFileSync(catalogPath, JSON.stringify(await refreshCatalog(), null, 2) + '\n');
  console.log('Updated catalog. Run node scripts/generate-plugin-workflows.mjs and review the diff.');
}
