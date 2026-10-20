import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const catalogPath = fileURLToPath(new URL('../plugins/catalog.json', import.meta.url));
export const shaPattern = /^[a-f0-9]{40}$/;
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.')) || value.includes(':')) throw new Error(`Unsafe relative path: ${value}`);
  return value;
}
export function validateCatalog(catalog) {
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins) || !catalog.sources) throw new Error('Invalid plugin catalog');
  const ids = new Set();
  for (const [id, source] of Object.entries(catalog.sources)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !/^[\w.-]+\/[\w.-]+$/.test(source.repository) || !shaPattern.test(source.revision)
      || typeof source.ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(source.ref) || source.ref.includes('..')) throw new Error(`Invalid source: ${id}`);
  }
  for (const plugin of catalog.plugins) {
    const source = catalog.sources[plugin.source];
    if (!source || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(plugin.id) || ids.has(`${plugin.source}/${plugin.id}`)) throw new Error(`Invalid/duplicate plugin: ${plugin.id}`);
    ids.add(`${plugin.source}/${plugin.id}`);
    if (![plugin.name, plugin.version, plugin.license].every(v => typeof v === 'string' && v.length > 0 && !/[\r\n]/.test(v))
      || !['forge', 'lele', 'native'].includes(plugin.adapter)) throw new Error(`Incomplete plugin: ${plugin.id}`);
    safePath(plugin.path);
    if (plugin.adapter === 'forge' && !/^[a-f0-9]{64}$/.test(plugin.sha256)) throw new Error(`Missing ZIP SHA-256: ${plugin.id}`);
    if (plugin.adapter === 'lele' && source.repository !== 'llleeeqi/Stronghold-Protocol-Lele-Mods') throw new Error('Lele host adapter only supports its declared repository');
  }
  return catalog;
}
export function readCatalog() { return validateCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8'))); }
export function selectPlugins(input = '', catalog = readCatalog()) {
  if (typeof input !== 'string') throw new Error('plugins must be a comma/whitespace separated string');
  const keys = [...new Set(input.split(/[\s,]+/).filter(Boolean))].sort();
  return keys.map(key => {
    const plugin = catalog.plugins.find(p => `${p.source}/${p.id}` === key);
    if (!plugin) throw new Error(`Unknown plugin: ${key}`);
    return plugin;
  });
}
export function displayName(plugin, catalog) { return `${catalog.sources[plugin.source].repository.split('/')[1]} + ${plugin.name}`; }
export function selectBuildSources(env, catalog = readCatalog()) {
  // Source permissions are selected only by humans; polls never inherit management choices.
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.AUTOMATED_BUILD === 'true') return [];
  const inputs = JSON.parse(env.WORKFLOW_INPUTS || '{}');
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('Invalid workflow inputs');
  return Object.keys(catalog.sources).filter(source => {
    const enabled = inputs[`plugins_${source}`];
    if (enabled === undefined || enabled === false || enabled === 'false') return false;
    if (enabled !== true && enabled !== 'true') throw new Error(`Invalid repository checkbox: plugins_${source}`);
    return true;
  }).sort();
}
export function forgeImportStatus(report) {
  // Discovery admits retrievable packages; unsupported conversion remains visible for future updates.
  if (!report.ok || !report.wrote || !report.products?.length) return 'bundled-only';
  if (report.partial || report.needsManualAdaptation || report.skipped?.some(row => !/^The file is in the pack/.test(row.en || ''))) return 'partial';
  return 'imported';
}
export function copyTree(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic link not permitted in plugin payload: ${from}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyTree(path.join(from, name), path.join(to, name));
  } else if (stat.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  else throw new Error(`Unsupported plugin file: ${from}`);
}
