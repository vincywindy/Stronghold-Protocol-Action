import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCatalog, validateCatalog, selectPlugins, selectBuildPlugins, pluginSlots, noPlugin, pluginOption, forgeImportStatus, copyTree } from '../scripts/plugin-catalog.mjs';
import { spawnSync } from 'node:child_process';
import { generatedFiles } from '../scripts/generate-plugin-workflows.mjs';
import { resolveForgeEntry } from '../scripts/prepare-plugins.mjs';
import { refreshCatalog } from '../scripts/refresh-plugin-catalog.mjs';

test('catalog resolves only explicitly selected plugins and deduplicates cross-repository inputs', () => {
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

test('one build form contains every repository in every slot and stays within 25 inputs as catalog grows', () => {
  const catalog = readCatalog();
  catalog.plugins.push({ ...catalog.plugins[0], id: 'future-plugin', name: "Author's future plugin" });
  const files = generatedFiles(catalog);
  assert.deepEqual([...files.keys()].filter(p => p.endsWith('.yml')), ['.github/workflows/docker.yml']);
  const body = files.get('.github/workflows/docker.yml');
  const dispatch = body.split('  workflow_dispatch:\n')[1].split('  workflow_call:')[0];
  assert.equal([...dispatch.matchAll(/^      \w+:/gm)].length, 25);
  for (const slot of pluginSlots) {
    const field = dispatch.split(`      ${slot}:\n`)[1].split(/^      \w+:/m)[0];
    assert.ok(field.includes(`default: '${noPlugin}'`));
    for (const plugin of catalog.plugins) assert.ok(field.includes(pluginOption(plugin, catalog).replaceAll("'", "''")));
  }
  assert.equal(generatedFiles(catalog, body).get('.github/workflows/docker.yml'), body);
  const original = fs.readFileSync('.github/workflows/docker.yml', 'utf8').replaceAll('\r\n', '\n');
  assert.equal(body.split('      # END GENERATED PLUGIN INPUTS')[1], original.split('      # END GENERATED PLUGIN INPUTS')[1]);
});

test('unified selection mixes repositories, merges overflow, deduplicates and defaults empty', () => {
  const catalog = readCatalog();
  const option = key => pluginOption(selectPlugins(key, catalog)[0], catalog);
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', WORKFLOW_INPUTS: JSON.stringify({
    plugin_01: option('forge/theme-night'), plugin_02: option('lele/lele-rounds'),
    plugin_03: option('forge/theme-night'), plugin_04: noPlugin,
  }), SELECTED_PLUGINS: 'forge/unequip,lele/lele-rounds' };
  assert.deepEqual(selectBuildPlugins(env).map(p => `${p.source}/${p.id}`), ['forge/theme-night', 'forge/unequip', 'lele/lele-rounds']);
  assert.deepEqual(selectBuildPlugins({ GITHUB_EVENT_NAME: 'workflow_dispatch', WORKFLOW_INPUTS: JSON.stringify(Object.fromEntries(pluginSlots.map(s => [s, noPlugin]))) }), []);
  assert.deepEqual(selectBuildPlugins({ ...env, SELECTED_PLUGINS: '', AUTOMATED_BUILD: 'true' }), []);
  assert.deepEqual(selectBuildPlugins({ ...env, SELECTED_PLUGINS: '', GITHUB_EVENT_NAME: 'push' }), []);
  assert.throws(() => selectBuildPlugins({ ...env, WORKFLOW_INPUTS: '{' }));
  assert.throws(() => selectBuildPlugins({ ...env, WORKFLOW_INPUTS: '{"plugin_01":"unknown"}' }), /Unknown plugin option/);
  // Free-form input keeps arbitrary-size mixes possible beyond the 21 dropdown slots.
  assert.equal(selectBuildPlugins({ SELECTED_PLUGINS: catalog.plugins.map(p => `${p.source}/${p.id}`).join(',') }).length, catalog.plugins.length);
});

test('dropdown-only plugin builds enforce explicit isolated tags before producing selection output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plugin-input-test-'));
  try {
    const output = path.join(dir, 'output');
    const env = { ...process.env, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'example/build', FETCH_ASSETS: '1',
      GITHUB_EVENT_NAME: 'workflow_dispatch', AUTOMATED_BUILD: 'false', SELECTED_PLUGINS: '',
      GITHUB_REF: 'refs/heads/main', DEFAULT_BRANCH: 'main',
      WORKFLOW_INPUTS: JSON.stringify({ plugin_01: pluginOption(selectPlugins('lele/lele-rounds')[0], readCatalog()) }) };
    for (const tag of ['', 'latest', 'latest-lite', 'sha-test', 'v1.2.3']) {
      const result = spawnSync(process.execPath, ['scripts/validate-plugin-inputs.mjs'], { env: { ...env, IMAGE_TAG: tag }, encoding: 'utf8' });
      assert.notEqual(result.status, 0, tag);
      assert.match(result.stderr, /explicit image_tag|Invalid image_tag/);
      assert.ok(!fs.existsSync(output));
    }
    const result = spawnSync(process.execPath, ['scripts/validate-plugin-inputs.mjs'], { env: { ...env, IMAGE_TAG: 'friends' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), 'selection=lele/lele-rounds\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
