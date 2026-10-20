import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCatalog, validateCatalog, selectPlugins, selectBuildSources, forgeImportStatus, copyTree } from '../scripts/plugin-catalog.mjs';
import { spawnSync } from 'node:child_process';
import { generatedFiles } from '../scripts/generate-plugin-workflows.mjs';
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

test('one build form has an unchecked checkbox per repository, independent of plugin count', () => {
  const catalog = readCatalog();
  catalog.plugins.push({ ...catalog.plugins[0], id: 'future-plugin', name: "Author's future plugin" });
  const files = generatedFiles(catalog);
  assert.deepEqual([...files.keys()].filter(p => p.endsWith('.yml')), ['.github/workflows/docker.yml']);
  const body = files.get('.github/workflows/docker.yml');
  const dispatch = body.split('  workflow_dispatch:\n')[1].split('  workflow_call:')[0];
  assert.equal([...dispatch.matchAll(/^      \w+:/gm)].length, 5);
  assert.ok(!dispatch.includes('type: choice'));
  for (const source of Object.keys(catalog.sources)) {
    const checkbox = dispatch.split(`      plugins_${source}:\n`)[1].split(/^      \w+:/m)[0];
    assert.ok(checkbox.includes('type: boolean\n        default: false'));

  }
  assert.equal(generatedFiles(catalog, body).get('.github/workflows/docker.yml'), body);
  const original = fs.readFileSync('.github/workflows/docker.yml', 'utf8').replaceAll('\r\n', '\n');
  assert.equal(body.split('      # END GENERATED PLUGIN INPUTS')[1], original.split('      # END GENERATED PLUGIN INPUTS')[1]);
  assert.equal(body, original);
  catalog.sources.community = { ...catalog.sources.forge, repository: 'example/community' };
  assert.ok(generatedFiles(catalog).get('.github/workflows/docker.yml').includes('      plugins_community:'));
  for (let i = 0; i < 20; i++) catalog.sources[`source${i}`] = catalog.sources.forge;
  assert.throws(() => generatedFiles(catalog), /25 inputs/);
});

test('automatic builds enable all catalog sources while manual builds keep explicit choices', () => {
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', WORKFLOW_INPUTS: JSON.stringify({ plugins_forge: true, plugins_lele: true }) };
  assert.deepEqual(selectBuildSources(env), ['forge', 'lele']);
  assert.deepEqual(selectBuildSources({ GITHUB_EVENT_NAME: 'workflow_dispatch' }), []);
  const catalog = readCatalog();
  catalog.sources.community = { ...catalog.sources.forge, repository: 'example/community' };
  for (const mode of [{ AUTOMATED_BUILD: 'true' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'schedule' }]) {
    // New registered sources join automatic builds without editing either workflow's source list.
    assert.deepEqual(selectBuildSources({ ...env, WORKFLOW_INPUTS: '{}', ...mode }, catalog), ['community', 'forge', 'lele']);
  }
  assert.deepEqual(selectBuildSources({ ...env, GITHUB_EVENT_NAME: 'pull_request' }), []);
  assert.throws(() => selectBuildSources({ ...env, WORKFLOW_INPUTS: '{' }));
});

test('repository selection enforces explicit isolated tags before producing selection output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plugin-input-test-'));
  try {
    const output = path.join(dir, 'output');
    const env = { ...process.env, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'example/build', FETCH_ASSETS: '1',
      GITHUB_EVENT_NAME: 'workflow_dispatch', AUTOMATED_BUILD: 'false', SELECTED_PLUGINS: '',
      GITHUB_REF: 'refs/heads/main', DEFAULT_BRANCH: 'main',
      WORKFLOW_INPUTS: JSON.stringify({ plugins_forge: true, plugins_lele: true }) };
    for (const tag of ['', 'latest', 'latest-lite', 'sha-test', 'v1.2.3']) {
      const result = spawnSync(process.execPath, ['scripts/validate-plugin-inputs.mjs'], { env: { ...env, IMAGE_TAG: tag }, encoding: 'utf8' });
      assert.notEqual(result.status, 0, tag);
      assert.match(result.stderr, /explicit image_tag|Invalid image_tag/);
      assert.ok(!fs.existsSync(output));
    }
    const result = spawnSync(process.execPath, ['scripts/validate-plugin-inputs.mjs'], { env: { ...env, IMAGE_TAG: 'friends' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), 'selection=forge,lele\n');
    for (const [id, mode] of Object.entries({
      push: { GITHUB_EVENT_NAME: 'push' }, schedule: { GITHUB_EVENT_NAME: 'schedule' },
      poll: { AUTOMATED_BUILD: 'true' },
    })) {
      const autoOutput = path.join(dir, id);
      const automatic = spawnSync(process.execPath, ['scripts/validate-plugin-inputs.mjs'], {
        env: { ...env, ...mode, WORKFLOW_INPUTS: '{}', IMAGE_TAG: '', GITHUB_OUTPUT: autoOutput }, encoding: 'utf8',
      });
      assert.equal(automatic.status, 0, automatic.stderr);
      assert.equal(fs.readFileSync(autoOutput, 'utf8'), 'selection=forge,lele\n');
    }
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
