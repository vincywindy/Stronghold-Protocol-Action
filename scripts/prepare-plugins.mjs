import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readCatalog, selectPlugins, copyTree, safePath, forgeImportStatus, displayName } from './plugin-catalog.mjs';

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 32 * 1024 * 1024, timeout: 1800000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.error || result.stderr || result.stdout || result.status}`);
  return result.stdout?.trim();
}
const node = (root, script, args = [], capture = false) => run(process.execPath, [script, ...args], root, capture);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function resolveForgeEntry(plugin, index) {
  const matches = index.mods?.filter(row => row.id === plugin.id) || [];
  if (matches.length !== 1) throw new Error(`Forge index must contain exactly one selected plugin: ${plugin.id}`);
  const entry = matches[0];
  safePath(entry.path);
  if (!entry.path.endsWith('.zip') || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.version !== 'string') throw new Error(`Invalid Forge download metadata: ${plugin.id}`);
  return { ...plugin, path: entry.path, sha256: entry.sha256, version: entry.version };
}

export async function preparePlugins(root, selection, { fetchAssets = '0', sourceCache } = {}) {
  root = path.resolve(root);
  if (!['0', '1'].includes(fetchAssets)) throw new Error('FETCH_ASSETS must be 0 or 1');
  const catalog = readCatalog();
  let selected = selectPlugins(selection, catalog);
  if (!selected.length) throw new Error('prepare-plugins requires at least one plugin');
  const revision = run('git', ['rev-parse', 'HEAD'], root, true);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-build-plugins-'));
  const reportsDir = path.join(root, 'plugin-build-reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const diagnostics = [];
  function attempt(label, action) {
    try { return { ok: true, value: action() }; }
    catch (error) { diagnostics.push({ step: label, error: error.message }); console.warn(`${label}: ${error.message}`); return { ok: false }; }
  }
  try {
    const repos = new Map(), revisions = new Map();
    for (const id of new Set(selected.map(p => p.source))) {
      const source = catalog.sources[id];
      let dir;
      if (sourceCache) {
        dir = path.resolve(sourceCache, id);
        if (run('git', ['status', '--porcelain', '--untracked-files=normal'], dir, true)) throw new Error(`Source cache must be clean: ${id}`);
      } else {
        dir = path.join(temp, id);
        fs.mkdirSync(dir);
        run('git', ['init', '-q'], dir);
        run('git', ['remote', 'add', 'origin', `https://github.com/${source.repository}.git`], dir);
        // Resolve the tracked ref once. Both architecture builders receive this exact prepared payload.
        run('git', ['fetch', '--depth=1', 'origin', source.ref], dir);
        run('git', ['-c', 'core.autocrlf=false', 'checkout', '--detach', 'FETCH_HEAD'], dir);
      }
      repos.set(id, dir);
      revisions.set(id, run('git', ['rev-parse', 'HEAD'], dir, true));
    }
    selected = selected.map(p => p.adapter === 'forge'
      ? resolveForgeEntry(p, JSON.parse(fs.readFileSync(path.join(repos.get(p.source), 'mods/index.json')))) : p);
    const records = selected.map(p => ({ key: `${p.source}/${p.id}`, name: displayName(p, catalog), version: p.version,
      repository: catalog.sources[p.source].repository, revision: revisions.get(p.source), adapter: p.adapter, status: 'bundled-only',
      bundlePath: `plugin-sources/${p.source}/${p.id}/${p.adapter === 'forge' ? 'source.zip' : 'plugin'}` }));
    // Retrieval and integrity failures remain fatal: every selected package must be present in a successful image.
    for (const [i, plugin] of selected.entries()) {
      const source = path.join(repos.get(plugin.source), plugin.path);
      if (plugin.adapter === 'forge') {
        if (hash(source) !== plugin.sha256) throw new Error(`Forge archive hash mismatch: ${plugin.id}`);
        records[i].sha256 = plugin.sha256;
      } else {
        const manifest = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json')));
        if (manifest.id !== plugin.id) throw new Error(`Plugin identity mismatch: ${plugin.id}`);
        records[i].version = manifest.version;
      }
      copyTree(source, path.join(root, records[i].bundlePath));
      const provenance = path.join(path.dirname(source), 'PROVENANCE.md');
      if (fs.existsSync(provenance)) copyTree(provenance, path.join(root, 'plugin-sources', plugin.source, plugin.id, 'PROVENANCE.md'));
    }
    const lele = selected.filter(p => p.adapter === 'lele');
    let leleHost = false;
    let baseline;
    if (lele.length) {
      const kit = repos.get(lele[0].source);
      for (const name of ['patches', 'scripts', 'mods', 'notices', 'upstream.lock.json', 'LICENSE', 'README.md']) {
        if (fs.existsSync(path.join(kit, name))) copyTree(path.join(kit, name), path.join(root, 'plugin-sources/lele/host', name));
      }
      baseline = path.join(temp, 'baseline');
      copyTree(path.join(root, 'data'), path.join(baseline, 'data'));
      leleHost = attempt('Lele host patch', () => {
        const lock = JSON.parse(fs.readFileSync(path.join(kit, 'upstream.lock.json')));
        if (lock.revision !== revision) throw new Error(`Host patch targets ${lock.revision}; game is ${revision}. Keeping original packages for later adaptation.`);
        const patch = path.join(kit, 'patches/modpack-code.patch');
        run('git', ['apply', '--check', patch], root, true);
        run('git', ['apply', patch], root, true);
        copyTree(path.join(kit, 'mods/assets/public/art'), path.join(root, 'public/art'));
      }).ok;
    }
    const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    if (process.platform === 'win32') node(root, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), npmArgs);
    else run('npm', npmArgs, root);
    node(root, 'tools/vendor.mjs');
    if (fetchAssets === '1' && !fs.existsSync(path.join(root, 'public/assets'))) node(root, 'tools/fetch-assets.mjs');
    if (leleHost) {
      const kit = repos.get(lele[0].source);
      // If the extension downloader fails, retain the complete original manifest instead of a half-written one.
      copyTree(path.join(root, 'data/assets.json'), path.join(baseline, 'data/assets.json'));
      const artResult = fetchAssets === '1' ? attempt('Lele optional art', () => {
        for (const [script, args] of [
          ['mods/rhine/generate-data.mjs', [root, baseline]], ['mods/rhine/generate-rounds.mjs', [root]],
          ['mods/rhine/refresh-data.mjs', [root]], ['mods/rhine/aphris/generate-data.mjs', [root]],
          ['mods/party/generate-data.mjs', [root]], ['mods/recruits/generate-data.mjs', [root]],
        ]) node(root, path.join(kit, script), args);
        // The author's pipeline temporarily generates extra rosters solely to fetch their art.
        node(root, 'tools/fetch-assets.mjs', ['--refresh-index', '--allow-shrink']);
        node(root, path.join(kit, 'scripts/check-required-assets.mjs'), [root]);
        for (const name of ['rhine-assets', 'kazdel-assets', 'custom-assets', 'recruits-assets', 'relic-icons']) node(root, `tools/fetch-${name}.mjs`);
      }) : { ok: true };
      if (!artResult.ok) copyTree(path.join(baseline, 'data/assets.json'), path.join(root, 'data/assets.json'));
      // Always restore the original gameplay baseline, even when optional plugin art is unavailable.
      node(root, path.join(kit, 'scripts/finalize-plugin-host.mjs'), [root, baseline]);
    }
    const installed = new Set();
    for (const [i, plugin] of selected.entries()) {
      const source = path.join(repos.get(plugin.source), plugin.path);
      const outcome = attempt(`${plugin.source}/${plugin.id}`, () => {
        if (plugin.adapter === 'forge') {
          const output = node(root, 'tools/plugin.mjs', ['import-forge', source, '--json', '--offline'], true);
          const report = JSON.parse(output);
          fs.writeFileSync(path.join(reportsDir, `${plugin.source}-${plugin.id}.json`), JSON.stringify(report, null, 2));
          records[i].status = forgeImportStatus(report);
          if (report.wrote) for (const product of report.products) installed.add(product.id);
        } else {
          const dest = path.join(root, 'plugins', plugin.id);
          if (fs.existsSync(dest)) throw new Error(`Plugin collision: ${plugin.id}`);
          copyTree(source, dest);
          installed.add(plugin.id);
          records[i].status = 'copied';
          // A failed check is diagnostic, not a compatibility admission gate.
          const check = attempt(`${plugin.id} check`, () => node(root, 'tools/plugin.mjs', ['check', plugin.id, '--json'], true));
          if (check.ok) {
            fs.writeFileSync(path.join(reportsDir, `${plugin.source}-${plugin.id}.json`), check.value);
            attempt(`${plugin.id} pack`, () => node(root, 'tools/plugin.mjs', ['pack', plugin.id], true));
          }
        }
      });
      if (!outcome.ok && records[i].status !== 'copied') records[i].status = 'bundled-only';
    }
    const inventory = { schemaVersion: 1, upstreamRevision: revision, fetchAssets, leleHost,
      plugins: records, installed: [...installed].sort(), diagnostics };
    fs.writeFileSync(path.join(root, 'plugin-build.json'), JSON.stringify(inventory, null, 2) + '\n');
    fs.writeFileSync(path.join(reportsDir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2) + '\n');
    // Docker excludes host art by default. Only this explicitly prepared payload may re-enter the image.
    const art = path.join(root, '.plugin-art');
    fs.mkdirSync(path.join(art, 'public'), { recursive: true });
    for (const dir of ['assets', 'fonts']) {
      const source = path.join(root, 'public', dir);
      if (fs.existsSync(source)) fs.renameSync(source, path.join(art, 'public', dir));
    }
    for (const name of ['assets.json', 'local-assets.json', 'local-fx.json']) {
      const source = path.join(root, 'data', name);
      if (fs.existsSync(source)) copyTree(source, path.join(art, 'data', name));
    }
    return inventory;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await preparePlugins(process.argv[2] || 'upstream', process.env.SELECTED_PLUGINS || '', {
    fetchAssets: process.env.FETCH_ASSETS || '0', sourceCache: process.env.PLUGIN_SOURCE_CACHE,
  });
}
