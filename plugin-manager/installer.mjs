import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { copyTree, selectPlugins, forgeImportStatus } from '../scripts/plugin-catalog.mjs';
import { current, generationPath, activate } from './storage.mjs';
import { downloadPlugin } from './download.mjs';
import { downloadHostBundle, prepareRuntime, LELE_REPOSITORY } from './lele-host.mjs';

const execute = promisify(execFile);
export function childEnvironment(env = process.env) {
  const result = { ...env };
  // Manager credentials and API tokens are not part of the game/plugin execution environment.
  delete result.PLUGIN_MANAGER_PASSWORD;
  delete result.GITHUB_TOKEN;
  delete result.GAME_UPDATE_URL;
  delete result.GAME_RELEASE_API;
  return result;
}
export async function runImporter(app, adapter, source, output) {
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('./install-worker.mjs', import.meta.url)), app, adapter, source, output],
    { env: childEnvironment(), timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}
export async function installSelection({ data, app, catalog, keys, update = false, download = downloadPlugin,
  importer = runImporter, downloadHost = downloadHostBundle, prepare = prepareRuntime, log = () => {} }) {
  if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) throw new Error('Expected plugin key array');
  const previous = current(data), unique = [...new Set(keys)].sort();
  // A removed upstream entry may remain installed, but cannot be newly downloaded or updated.
  for (const key of unique) if (!previous.installed.some(p => p.key === key) || update) selectPlugins(key, catalog);
  const id = randomUUID(), dir = generationPath(data, id), pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const policy = path.join(previous.dir, 'plugins/config.json');
  if (fs.existsSync(policy)) copyTree(policy, path.join(pluginsDir, 'config.json'));
  const installed = [], owners = new Map();
  const reserve = (product, key) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(product) || product.startsWith('.')) throw new Error(`Invalid installed plugin ID: ${product}`);
    if (owners.has(product.toLowerCase())) throw new Error(`Plugin ID collision: ${product} (${owners.get(product.toLowerCase())} / ${key})`);
    owners.set(product.toLowerCase(), key);
  };
  try {
    const lele = unique.map(key => {
      const old = previous.installed.find(p => p.key === key);
      if (old && !update) return old;
      const plugin = selectPlugins(key, catalog)[0];
      return { ...plugin, revision: catalog.sources[plugin.source].revision };
    }).filter(p => p.adapter === 'lele');
    let host, runtime = { dir: app };
    if (lele.length) {
      const revisions = [...new Set(lele.map(p => p.revision))];
      if (revisions.length !== 1) throw new Error('Lele 插件来自不同提交，请点击“更新已选插件”统一插件与宿主补丁版本');
      const bundle = path.join(dir, 'host-bundle');
      if (previous.host?.revision === revisions[0]) {
        copyTree(path.join(previous.dir, 'host-bundle'), bundle);
        host = previous.host;
      } else {
        log(`下载 Lele 宿主兼容层 @ ${revisions[0].slice(0, 12)}`);
        host = await downloadHost({ repository: LELE_REPOSITORY, revision: revisions[0] }, bundle);
      }
      runtime = await prepare({ dir: app }, { dir, installed: lele, host }, { log });
    }
    for (const key of unique) {
      const old = previous.installed.find(item => item.key === key);
      const payload = path.join(dir, 'packages', ...key.split('/'));
      if (old && !update) {
        for (const product of old.products) {
          reserve(product, key);
          copyTree(path.join(previous.dir, 'plugins', product), path.join(pluginsDir, product));
        }
        copyTree(path.join(previous.dir, 'packages', ...key.split('/')), payload);
        if (old.adapter === 'lele') {
          // Recheck legacy installs against the adapted host, replacing the old "unsupported" warning.
          const diagnostics = [];
          for (const product of old.products) {
            const report = await importer(runtime.dir, old.adapter, path.join(pluginsDir, product), pluginsDir);
            if (report.problems?.length || report.wrote === false) throw new Error(`Lele 插件检查失败：${key} ${JSON.stringify(report.problems || [])}`);
            diagnostics.push(...(report.warnings || []));
          }
          installed.push({ ...old, diagnostics, hostRevision: host.revision });
        } else installed.push(old);
        continue;
      }
      const plugin = selectPlugins(key, catalog)[0], source = catalog.sources[plugin.source];
      log(`下载 ${key} @ ${source.revision.slice(0, 12)}`);
      const downloaded = await download(plugin, source, payload);
      const record = { key, version: plugin.version, revision: source.revision, adapter: plugin.adapter, products: [], status: 'bundled-only', diagnostics: [] };
      if (plugin.sha256) record.sha256 = plugin.sha256;
      if (plugin.adapter === 'forge') {
        // Import in a private staging directory; failures cannot damage the active generation.
        const output = path.join(dir, '.import');
        fs.mkdirSync(output, { recursive: true });
        let copying = false;
        try {
          const report = await importer(runtime.dir, 'forge', downloaded, output);
          fs.writeFileSync(path.join(payload, 'import-report.json'), JSON.stringify(report, null, 2));
          record.status = forgeImportStatus(report);
          record.diagnostics = report.issues || report.skipped || [];
          copying = true;
          if (report.wrote) for (const name of fs.readdirSync(output)) {
            reserve(name, key);
            copyTree(path.join(output, name), path.join(pluginsDir, name));
            record.products.push(name);
          }
        } catch (error) {
          // Keep the original package discoverable for future importer updates.
          if (copying) throw error;
          record.diagnostics.push(error.message);
        } finally { fs.rmSync(output, { recursive: true, force: true }); }
      } else {
        reserve(plugin.id, key);
        const target = path.join(pluginsDir, plugin.id);
        copyTree(downloaded, target);
        record.products = [plugin.id];
        record.status = 'copied';
        try {
          const report = await importer(runtime.dir, plugin.adapter, target, pluginsDir);
          if (plugin.adapter === 'lele' && (report.problems?.length || report.wrote === false)) {
            throw new Error(`Lele 插件检查失败：${key} ${JSON.stringify(report.problems || [])}`);
          }
          record.diagnostics.push(...(report.problems || []), ...(report.warnings || []));
        } catch (error) {
          if (plugin.adapter === 'lele') throw error;
          record.diagnostics.push(error.message);
        }
        if (plugin.adapter === 'lele') record.hostRevision = host.revision;
      }
      installed.push(record);
      log(`${key}: ${record.status}`);
    }
    const manifest = { id, previousId: previous.id, installed, ...(host ? { host } : {}), createdAt: new Date().toISOString() };
    activate(data, manifest);
    return manifest;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
