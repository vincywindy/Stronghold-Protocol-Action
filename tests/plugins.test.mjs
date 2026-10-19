import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCatalog, validateCatalog, selectPlugins, forgeImportStatus, copyTree } from '../scripts/plugin-catalog.mjs';
import { generatedFiles } from '../scripts/generate-plugin-workflows.mjs';
import { resolveForgeEntry } from '../scripts/prepare-plugins.mjs';
import { refreshCatalog } from '../scripts/refresh-plugin-catalog.mjs';

test('catalog resolves only explicitly selected plugins and deduplicates cross-page inputs', () => {
  assert.deepEqual(selectPlugins(''), []);
  assert.deepEqual(selectPlugins('forge/theme-night, lele/lele-rounds\nforge/theme-night').map(p => p.id), ['theme-night', 'lele-rounds']);
  assert.throws(() => selectPlugins('forge/no-such-plugin'), /Unknown plugin/);
  assert.equal(selectPlugins('forge/chat-bubble')[0].id, 'chat-bubble');
  const catalog = readCatalog();
  assert.equal(selectPlugins(catalog.plugins.map(p => `${p.source}/${p.id}`).join(',')).length, catalog.plugins.length);
});

test('catalog requires retrievable source identities and confined paths', () => {
  const catalog = readCatalog();
  for (const change of [
    c => { c.sources.forge.revision = 'main'; },
    c => { c.plugins[0].path = '../../secrets'; },
    c => { c.plugins[0].sha256 = 'abc'; },
    c => { c.plugins.push(c.plugins[0]); },
  ]) {
    const copy = structuredClone(catalog); change(copy);
    assert.throws(() => validateCatalog(copy));
  }
});

test('unsupported and partial imports are recorded without excluding their original packages', () => {
  const report = { ok: true, wrote: true, products: [{ id: 'demo' }], skipped: [] };
  assert.equal(forgeImportStatus(report), 'imported');
  assert.equal(forgeImportStatus({ ...report, partial: true }), 'partial');
  assert.equal(forgeImportStatus({ ...report, needsManualAdaptation: true }), 'partial');
  assert.equal(forgeImportStatus({ ...report, products: [] }), 'bundled-only');
  assert.equal(forgeImportStatus({ ...report, ok: false }), 'bundled-only');
  assert.equal(forgeImportStatus({ ...report, wrote: false }), 'bundled-only');
});

test('a newer Forge index updates the selected package version/path/hash, never its identity', () => {
  const plugin = selectPlugins('forge/theme-night')[0];
  const entry = { id: plugin.id, version: '2.0.0', path: 'mods/theme-night/2.0.0/mod.zip', sha256: 'a'.repeat(64) };
  assert.equal(resolveForgeEntry(plugin, { mods: [entry] }).version, '2.0.0');
  assert.throws(() => resolveForgeEntry(plugin, { mods: [] }));
  assert.throws(() => resolveForgeEntry(plugin, { mods: [entry, entry] }));
  assert.throws(() => resolveForgeEntry(plugin, { mods: [{ ...entry, path: '../outside.zip' }] }));
  assert.throws(() => resolveForgeEntry(plugin, { mods: [{ ...entry, sha256: '' }] }));
});

test('discovery retains all published entries without a compatibility filter and is atomic on failure', async () => {
  const catalog = readCatalog();
  const request = async url => {
    if (url.includes('/commits/')) return { sha: 'b'.repeat(40) };
    if (url.endsWith('/mods/index.json')) return { mods: [{ id: 'future-plugin', name: 'Future', version: '9.0.0', path: 'mods/future-plugin/mod.zip', sha256: 'a'.repeat(64) }] };
    if (url.includes('/git/trees/')) return { tree: [{ path: 'plugins/lele-future/plugin.json' }] };
    return { id: 'lele-future', name: 'Future Lele', version: '9.0.0', license: 'MIT' };
  };
  const updated = await refreshCatalog(catalog, request);
  assert.deepEqual(updated.plugins.map(p => p.id), ['future-plugin', 'lele-future']);
  assert.equal(catalog.sources.forge.revision, readCatalog().sources.forge.revision);
  await assert.rejects(refreshCatalog(catalog, async () => { throw new Error('network failure'); }), /network failure/);
});

test('checkbox generation paginates under GitHub limit and every plugin defaults off', () => {
  const catalog = readCatalog(), files = generatedFiles(catalog);
  for (const [name, body] of files) {
    if (!name.endsWith('.yml')) continue;
    const bools = [...body.matchAll(/type: boolean\n        default: (\w+)/g)].map(m => m[1]);
    assert.equal(bools[0], 'true'); // Asset option; every remaining boolean is a plugin.
    assert.ok(bools.slice(1).every(v => v === 'false'));
    assert.ok([...body.split('\npermissions:')[0].matchAll(/^      [a-z_]+[a-z0-9_]*:/gm)].length <= 25);
    assert.ok(!body.includes('automatic: true'));
  }
  const prototype = catalog.plugins.find(p => p.source === 'forge');
  catalog.plugins = Array.from({ length: 43 }, (_, n) => ({ ...prototype, id: `demo-${n}` }));
  assert.equal([...generatedFiles(catalog).keys()].filter(p => p.endsWith('.yml')).length, 3);
});

test('plugin copy rejects filesystem links instead of importing outside files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plugin-copy-test-'));
  try {
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'secret'), 'not a plugin');
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'link'), 'junction');
    assert.throws(() => copyTree(path.join(root, 'link'), path.join(root, 'dest')), /Symbolic link/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
