import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadHostBundle, prepareRuntime, readHostPatch, LELE_REPOSITORY } from '../plugin-manager/lele-host.mjs';
import { installSelection } from '../plugin-manager/installer.mjs';
import { initStore, current, writeJson, readJson } from '../plugin-manager/storage.mjs';
import { Supervisor } from '../plugin-manager/supervisor.mjs';

const blob = b => createHash('sha1').update(`blob ${Buffer.byteLength(b)}\0`).update(b).digest('hex');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lele-host-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const before = 'export const host = 0;\n', after = 'export const host = 1;\n';
const patch = (rel = 'server/host.js') => `diff --git a/${rel} b/${rel}
index ${blob(before)}..${blob(after)} 100644
--- a/${rel}
+++ b/${rel}
@@ -1 +1 @@
-${before.trim()}
+${after.trim()}
`;
function fixtures() {
  const files = {
    'upstream.lock.json': JSON.stringify({ upstream: 'https://github.com/sganggs/Stronghold-Protocol.git',
      revision: 'b'.repeat(40), plugin_host: { api: 1, version: '0.3.1', features: ['rounds', 'damage'] } }),
    'patches/modpack-code.patch': patch(),
    'mods/assets/public/art/lele/icon.svg': '<svg/>',
    'notices/SOURCES.md': 'Source authors',
  };
  const tree = Object.entries(files).map(([name, content]) => ({ path: name, mode: '100644', type: 'blob', sha: blob(content) }));
  return { files, tree, json: async () => ({ tree }), bytes: async url => Buffer.from(files[new URL(url).pathname.split('/').slice(4).join('/')]) };
}
const source = { repository: LELE_REPOSITORY, revision: 'a'.repeat(40) };
async function setup(t) {
  const root = temp(t), app = path.join(root, 'game'), plugins = { dir: path.join(root, 'generation'), installed: [{ adapter: 'lele' }] };
  writeJson(path.join(app, 'package.json'), { version: '0.3.1' });
  writeJson(path.join(app, 'data/config.json'), { economy: { original: true } });
  fs.mkdirSync(path.join(app, 'server'), { recursive: true });
  fs.writeFileSync(path.join(app, 'server/host.js'), before);
  fs.mkdirSync(path.join(app, 'public/assets'), { recursive: true });
  fs.writeFileSync(path.join(app, 'public/assets/original.txt'), 'art');
  plugins.host = await downloadHostBundle(source, path.join(plugins.dir, 'host-bundle'), fixtures());
  return { app, plugins, game: { id: 'game', dir: app, version: '0.3.1' }, root };
}

test('Lele host uses an isolated, verified derivative and removal returns the pristine game', async t => {
  const { app, game, plugins } = await setup(t);
  const runtime = await prepareRuntime(game, plugins);
  assert.notEqual(runtime.dir, app);
  assert.equal(fs.readFileSync(path.join(runtime.dir, 'server/host.js'), 'utf8'), after);
  assert.equal(fs.readFileSync(path.join(app, 'server/host.js'), 'utf8'), before);
  assert.deepEqual(readJson(path.join(app, 'data/config.json')), { economy: { original: true } });
  assert.deepEqual(readJson(path.join(runtime.dir, 'data/config.json')).economy.leleHost,
    { api: 1, enabled: {}, packages: { rounds: {}, damage: {} } });
  assert.equal(fs.readFileSync(path.join(runtime.dir, 'public/assets/original.txt'), 'utf8'), 'art');
  assert.ok(fs.existsSync(path.join(runtime.dir, 'public/art/lele/icon.svg')));
  assert.ok(fs.existsSync(path.join(runtime.dir, 'lele-host-notices/notices/SOURCES.md')));
  assert.equal((await prepareRuntime(game, plugins)).dir, runtime.dir);
  assert.equal(await prepareRuntime(game, { ...plugins, installed: [] }), game);
});

test('changed game versions, changed same-version code and corrupted bundles fail closed', async t => {
  const { app, game, plugins } = await setup(t);
  writeJson(path.join(app, 'package.json'), { version: '0.4.0' });
  await assert.rejects(prepareRuntime(game, plugins), /仅适配 0.3.1/);
  writeJson(path.join(app, 'package.json'), { version: '0.3.1' });
  fs.writeFileSync(path.join(app, 'server/host.js'), 'changed game');
  await assert.rejects(prepareRuntime(game, plugins), /基线不匹配/);
  fs.writeFileSync(path.join(app, 'server/host.js'), before);
  fs.appendFileSync(path.join(plugins.dir, 'host-bundle/patches/modpack-code.patch'), 'corruption');
  await assert.rejects(prepareRuntime(game, plugins), /integrity/);
  await assert.rejects(prepareRuntime(game, { ...plugins, host: undefined }), /重新“应用选择”/);
});

test('host patch refuses path escapes, dependency overwrites, symlinks and malformed identities', async t => {
  for (const rel of ['../outside', 'server/../../outside', 'node_modules/a.js', 'plugins/config.json', 'public/assets/art.js']) {
    assert.throws(() => readHostPatch(Buffer.from(patch(rel))), /Unsafe|Unsupported|cannot replace/);
  }
  assert.throws(() => readHostPatch(Buffer.from(patch().replace('100644', '120000'))), /identities/);
  assert.throws(() => readHostPatch(Buffer.from(patch().replace('+++ b/server/host.js', '+++ b/server/other.js'))), /Mismatched/);
  assert.throws(() => readHostPatch(Buffer.from(patch() + patch())), /Duplicate/);
  const { app, game, plugins, root } = await setup(t);
  const external = path.join(root, 'outside');
  fs.renameSync(path.join(app, 'server'), external);
  fs.symlinkSync(external, path.join(app, 'server'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareRuntime(game, plugins), /link/);
  assert.equal(fs.readFileSync(path.join(external, 'host.js'), 'utf8'), before);
});

test('bundle downloads enforce repository pinning, Git identities and regular files', async t => {
  const root = temp(t);
  await assert.rejects(downloadHostBundle({ ...source, repository: 'other/repo' }, root), /Unsupported/);
  const bad = fixtures();
  bad.tree[0].sha = '0'.repeat(40);
  await assert.rejects(downloadHostBundle(source, root, bad), /integrity/);
  const link = fixtures();
  link.tree[0].mode = '120000';
  await assert.rejects(downloadHostBundle(source, root, link), /Unsafe/);
});

test('failed patch application leaves no ready derivative and preserves original data', async t => {
  const { app, game, plugins } = await setup(t);
  await assert.rejects(prepareRuntime(game, plugins, { apply: async () => { throw new Error('patch conflict'); } }), /conflict/);
  assert.deepEqual(fs.readdirSync(path.join(plugins.dir, 'hosts')), []);
  assert.equal(fs.readFileSync(path.join(app, 'public/assets/original.txt'), 'utf8'), 'art');
});

test('patch preparation failure never stops the running game', async () => {
  const supervisor = new Supervisor({ prepare: async () => { throw new Error('incompatible host'); } });
  let stops = 0;
  supervisor.stop = async () => { stops++; };
  await assert.rejects(supervisor.switchTo({}, {}), /incompatible host/);
  assert.equal(stops, 0);
});

test('Lele and native installs are atomic, support legacy repair and retain host provenance', async t => {
  const { app, root } = await setup(t);
  const data = path.join(root, 'data');
  initStore(data);
  const catalog = { schemaVersion: 1, sources: { lele: { ...source, ref: 'main' }, demo: { ...source, ref: 'main' } },
    plugins: [
      { source: 'lele', id: 'lele-rounds', version: '1.0.0', adapter: 'lele', path: 'plugins/lele-rounds' },
      { source: 'demo', id: 'alpha', version: '1.0.0', adapter: 'native', path: 'plugins/alpha' },
    ] };
  let checks = 0, downloads = 0;
  const options = { data, app, catalog, keys: ['lele/lele-rounds', 'demo/alpha'],
    downloadHost: (s, dest) => { downloads++; return downloadHostBundle(s, dest, fixtures()); },
    download: async (plugin, s, dest) => { writeJson(path.join(dest, 'plugin.json'), { id: plugin.id }); return dest; },
    importer: async (runtime, adapter) => {
      assert.equal(readJson(path.join(runtime, 'data/config.json')).economy.leleHost.api, 1);
      checks++; return { wrote: true, problems: [] };
    } };
  await installSelection(options);
  const first = current(data);
  assert.equal(first.host.revision, source.revision);
  assert.equal(first.installed.length, 2);
  assert.equal(checks, 2);
  await installSelection(options);
  assert.equal(downloads, 1);
  assert.equal(checks, 3);
  const second = current(data);
  await assert.rejects(installSelection({ ...options, importer: async () => ({ wrote: false, problems: ['invalid content'] }) }), /检查失败/);
  assert.equal(current(data).id, second.id);
  catalog.sources.lele.revision = 'c'.repeat(40);
  catalog.plugins.push({ source: 'lele', id: 'lele-damage', version: '1.0.0', adapter: 'lele', path: 'plugins/lele-damage' });
  await assert.rejects(installSelection({ ...options, keys: [...options.keys, 'lele/lele-damage'] }), /不同提交/);
  // Existing pre-manager-patch installations are repaired by applying their current selection again.
  const old = readJson(path.join(second.dir, 'manifest.json'));
  delete old.host;
  old.installed.find(p => p.adapter === 'lele').diagnostics = ['old unsupported host warning'];
  writeJson(path.join(second.dir, 'manifest.json'), old);
  await installSelection(options);
  assert.equal(downloads, 2);
  assert.deepEqual(current(data).installed.find(p => p.adapter === 'lele').diagnostics, []);
  await installSelection({ ...options, keys: ['demo/alpha'] });
  assert.equal(current(data).host, undefined);
  assert.ok(!fs.existsSync(path.join(current(data).dir, 'host-bundle')));
});
