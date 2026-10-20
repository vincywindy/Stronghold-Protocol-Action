import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { initStore, current, writeJson, readJson } from '../plugin-manager/storage.mjs';
import { installSelection, childEnvironment } from '../plugin-manager/installer.mjs';
import { downloadPlugin } from '../plugin-manager/download.mjs';
import { readCatalog } from '../scripts/plugin-catalog.mjs';
import { createManagerServer } from '../plugin-manager/server.mjs';
import { releaseEntries, extractEntries } from '../plugin-manager/archive.mjs';
import { releasePlan, stageGameUpdate, initGame, gameState } from '../plugin-manager/game-update.mjs';
import { Supervisor } from '../plugin-manager/supervisor.mjs';
import { commitGame, pruneHistory } from '../plugin-manager/lifecycle.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-manager-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sample = () => ({ schemaVersion: 1, sources: { demo: { repository: 'example/demo', ref: 'main', revision: 'a'.repeat(40) } },
  plugins: [{ source: 'demo', id: 'alpha', name: 'Alpha', version: '1.0.0', adapter: 'native', path: 'plugins/alpha', license: 'MIT' }] });
async function fakeDownload(plugin, source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  writeJson(path.join(destination, 'plugin.json'), { id: plugin.id, version: plugin.version });
  return destination;
}
const importer = async () => ({ wrote: true, problems: [] });

test('manager starts empty, persists installs, updates and removes with atomic failure handling', async t => {
  const data = temporary(t);
  initStore(data);
  assert.deepEqual(current(data).installed, []);
  const options = { data, app: data, catalog: sample(), download: fakeDownload, importer, keys: ['demo/alpha'] };
  await installSelection(options);
  const first = current(data);
  assert.equal(first.installed[0].status, 'copied');
  assert.ok(fs.existsSync(path.join(first.dir, 'plugins/alpha/plugin.json')));
  assert.equal(initStore(data).id, first.id);
  writeJson(path.join(first.dir, 'plugins/config.json'), { rooms: false });
  options.catalog.plugins[0].version = '2.0.0';
  await assert.rejects(installSelection({ ...options, update: true, download: async () => { throw new Error('network failure'); } }), /network failure/);
  assert.equal(current(data).id, first.id);
  await installSelection({ ...options, update: true });
  assert.equal(current(data).installed[0].version, '2.0.0');
  assert.deepEqual(readJson(path.join(current(data).dir, 'plugins/config.json')), { rooms: false });
  await installSelection({ ...options, keys: [] });
  assert.deepEqual(current(data).installed, []);
  assert.ok(!fs.existsSync(path.join(current(data).dir, 'plugins/alpha')));
});

test('malicious keys, unavailable sources and cross-source product collisions never change active files', async t => {
  const data = temporary(t), initial = initStore(data), catalog = sample();
  const options = { data, app: data, catalog, download: fakeDownload, importer };
  await assert.rejects(installSelection({ ...options, keys: ['../../etc/passwd'] }), /Unknown plugin/);
  catalog.sources.other = catalog.sources.demo;
  catalog.plugins.push({ ...catalog.plugins[0], source: 'other' });
  await assert.rejects(installSelection({ ...options, keys: ['demo/alpha', 'other/alpha'] }), /collision/);
  assert.equal(current(data).id, initial.id);
});

test('pointer save failure restores the old game; cleanup retains pending and running generations', async t => {
  const data = temporary(t), image = path.join(data, 'image');
  writeJson(path.join(image, 'package.json'), { version: '1.0.0' });
  const game = await initGame(data, image), plugins = initStore(data);
  const switches = [];
  const candidate = { ...game, version: '2.0.0' };
  await assert.rejects(commitGame({ data, candidate, plugins,
    supervisor: { switchTo: async value => { switches.push(value.version); } },
    save: () => { throw new Error('disk full'); },
  }), /disk full/);
  assert.deepEqual(switches, ['2.0.0', '1.0.0']);
  assert.equal(gameState(data).version, '1.0.0');
  const options = { data, app: data, catalog: sample(), download: fakeDownload, importer, keys: ['demo/alpha'] };
  await installSelection(options);
  const obsolete = current(data);
  await installSelection(options);
  const previous = current(data);
  await installSelection(options);
  const active = current(data);
  pruneHistory(data, { game, plugins });
  assert.ok(fs.existsSync(plugins.dir)); // The running game still holds this directory.
  assert.ok(fs.existsSync(previous.dir));
  assert.ok(fs.existsSync(active.dir));
  assert.ok(!fs.existsSync(obsolete.dir));
});

test('Forge import failure retains the downloaded original and reports bundled-only', async t => {
  const data = temporary(t), catalog = readCatalog();
  initStore(data);
  await installSelection({ data, app: data, catalog, keys: ['forge/theme-night'],
    download: async (p, s, dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'source.zip'), 'zip'); return path.join(dir, 'source.zip'); },
    importer: async () => { throw new Error('not supported by this host'); } });
  assert.equal(current(data).installed[0].status, 'bundled-only');
  assert.ok(fs.existsSync(path.join(current(data).dir, 'packages/forge/theme-night/source.zip')));
});

test('downloads enforce Forge SHA, pinned sources and native file boundaries', async t => {
  const data = temporary(t), catalog = readCatalog(), plugin = catalog.plugins.find(p => p.id === 'theme-night');
  await assert.rejects(downloadPlugin(plugin, catalog.sources.forge, path.join(data, 'forge'), { bytes: async () => Buffer.from('bad') }), /SHA-256 mismatch/);
  const native = sample().plugins[0], source = sample().sources.demo;
  for (const entry of [
    { path: 'plugins/alpha/../../outside', type: 'blob', mode: '100644' },
    { path: 'plugins/alpha/link', type: 'blob', mode: '120000' },
    { path: 'plugins/alpha/submodule', type: 'commit', mode: '160000' },
  ]) await assert.rejects(downloadPlugin(native, source, path.join(data, 'native'), { json: async () => ({ tree: [entry] }) }), /Unsafe/);
});

test('manager auth and CSRF protect mutations with and without a password', async t => {
  const data = temporary(t);
  for (const password of ['', 'secret']) {
    let calls = 0;
    const server = createManagerServer({ image: data, password, api: { state: () => ({ installed: [] }), start: () => { calls++; return { status: 'running' }; } } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const headers = password ? { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` } : {};
      if (password) assert.equal((await fetch(`${url}/api/state`)).status, 401);
      const state = await (await fetch(`${url}/api/state`, { headers })).json();
      const post = extra => fetch(`${url}/api/restart`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...extra }, body: '{}' });
      assert.equal((await post({})).status, 403);
      assert.equal((await post({ 'X-Manager-Token': state.csrf, Origin: 'https://evil.example' })).status, 403);
      assert.equal((await post({ 'X-Manager-Token': state.csrf, Origin: url })).status, 202);
      assert.equal(calls, 1);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});

// A minimal stored ZIP fixture; production integrity is checked against MANIFEST/UPDATE hashes.
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, content] of entries) {
    const n = Buffer.from(name), b = Buffer.from(content), l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50); l.writeUInt32LE(b.length, 18); l.writeUInt32LE(b.length, 22); l.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt32LE(b.length, 20); c.writeUInt32LE(b.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(l, n, b); central.push(c, n); offset += l.length + n.length + b.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
test('release ZIP rejects traversal, duplicate entries and configuration overwrite', t => {
  const data = temporary(t);
  for (const rel of ['../outside', 'C:/outside', 'plugins/config.json', '.env']) {
    assert.throws(() => releaseEntries(zip([['MANIFEST.json', '{}'], [rel, 'bad']])), /Unsafe|configuration/);
  }
  assert.throws(() => releaseEntries(zip([['MANIFEST.json', '{}'], ['MANIFEST.json', '{}']])), /Duplicate/);
  const entries = releaseEntries(zip([['Stronghold-Protocol/MANIFEST.json', '{}'], ['Stronghold-Protocol/server/index.js', 'ok'],
    ['Stronghold-Protocol/plugins/AGENTS.md', 'release documentation']]));
  extractEntries(entries, data);
  assert.equal(fs.readFileSync(path.join(data, 'server/index.js'), 'utf8'), 'ok');
});

test('Release URL defaults to upstream, supports configured API and fixed ZIP precedence', async () => {
  let requested;
  const request = async url => { requested = url; return { tag_name: 'v1.2.3', assets: [{ name: 'Stronghold-Protocol-v1.2.3-update.zip', browser_download_url: 'https://example.com/update.zip' }] }; };
  assert.equal((await releasePlan({}, request)).version, '1.2.3');
  assert.match(requested, /sganggs\/Stronghold-Protocol/);
  await releasePlan({ GAME_RELEASE_API: 'https://mirror.example/latest' }, request);
  assert.equal(requested, 'https://mirror.example/latest');
  assert.equal((await releasePlan({ GAME_UPDATE_URL: 'https://mirror.example/fixed.zip' }, () => { throw new Error('not called'); })).assets[0].url, 'https://mirror.example/fixed.zip');
});
const validation = {
  parseManifest: text => { const m = JSON.parse(text); return { app: m.app, files: new Map(Object.entries(m.files)) }; },
  parseUpdate: text => { const m = JSON.parse(text); return { ...m, files: new Map(Object.entries(m.files)) }; },
  verifyFiles(root, files) { const missing = [], mismatched = []; for (const [rel, meta] of files) { const f = path.join(root, rel); if (!fs.existsSync(f)) missing.push(rel); else if (hash(fs.readFileSync(f)) !== meta.sha256) mismatched.push(rel); } return { missing, mismatched }; },
  affectsRuntime: () => true,
  applyPendingUpdate: () => ({ state: 'applied' }),
};
test('unsupported incremental base falls back to lite, preserves art, and never activates unverified game', async t => {
  const data = temporary(t), image = path.join(data, 'image');
  fs.mkdirSync(path.join(image, 'public/assets'), { recursive: true });
  writeJson(path.join(image, 'package.json'), { version: '1.0.0' });
  fs.writeFileSync(path.join(image, 'public/assets/art.png'), 'original art');
  writeJson(path.join(image, 'data/assets.json'), { original: true });
  const original = await initGame(data, image);
  const pkg = JSON.stringify({ version: '1.2.0', engines: { node: '>=22' } });
  const code = 'export const version = 2;';
  const files = { 'package.json': { size: Buffer.byteLength(pkg), sha256: hash(pkg) }, 'server/index.js': { size: code.length, sha256: hash(code) } };
  const manifest = JSON.stringify({ app: '1.2.0', files });
  const lite = zip([['MANIFEST.json', manifest], ['package.json', pkg], ['server/index.js', code],
    ['data/assets.json', '{"original":false}']]);
  const update = zip([['MANIFEST.json', manifest], ['UPDATE.json', JSON.stringify({ app: '1.2.0', from: ['0.9.0'], files })]]);
  const candidate = await stageGameUpdate({ data, image, validation, plan: { version: '1.2.0', assets: [{ kind: 'update', url: 'update' }, { kind: 'lite', url: 'lite' }] }, request: async url => url === 'update' ? update : lite });
  assert.equal(candidate.version, '1.2.0');
  assert.equal(fs.readFileSync(path.join(candidate.dir, 'public/assets/art.png'), 'utf8'), 'original art');
  assert.deepEqual(readJson(path.join(candidate.dir, 'data/assets.json')), { original: true });
  assert.equal(gameState(data).id, original.id);
  await assert.rejects(stageGameUpdate({ data, image, validation, plan: { assets: [{ kind: 'lite', url: 'bad', sha256: '0'.repeat(64) }] }, request: async () => lite }), /SHA-256/);
  assert.equal(gameState(data).id, original.id);
});

async function freePort() {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
test('supervisor restarts game and restores prior version when candidate crashes; strips manager secrets', async t => {
  const dir = temporary(t), app = path.join(dir, 'good'), bad = path.join(dir, 'bad');
  fs.mkdirSync(path.join(app, 'server/http'), { recursive: true });
  writeJson(path.join(app, 'package.json'), { type: 'module' });
  fs.writeFileSync(path.join(app, 'server/index.js'), `import http from 'node:http'; export async function startServer(opts) { const server = http.createServer((req,res)=>res.end(JSON.stringify({ok:true,plugins:opts.pluginsDir}))); server.listen(Number(process.env.PORT),'127.0.0.1'); return server; }`);
  fs.writeFileSync(path.join(app, 'server/http/boot.js'), `export async function runMain(start) {const server=await start({}); process.on('SIGTERM',()=>server.close(()=>process.exit(0)));}`);
  fs.mkdirSync(path.join(bad, 'server/http'), { recursive: true });
  writeJson(path.join(bad, 'package.json'), { type: 'module' });
  fs.writeFileSync(path.join(bad, 'server/index.js'), `throw new Error('broken release');`);
  const port = await freePort(), supervisor = new Supervisor({ env: { ...process.env, PORT: String(port) }, log: () => {}, healthTimeout: 3000 });
  const plugins = { id: 'plugins', dir };
  try {
    await supervisor.start({ dir: app, version: '1.0.0' }, plugins);
    const pid = supervisor.child.pid;
    await supervisor.switchTo({ dir: app, version: '1.0.0' }, plugins);
    assert.notEqual(supervisor.child.pid, pid);
    await assert.rejects(supervisor.switchTo({ dir: bad, version: '2.0.0' }, plugins), /exited/);
    assert.equal(supervisor.status().version, '1.0.0');
    assert.equal(supervisor.status().alive, true);
  } finally { await supervisor.stop(); }
  assert.deepEqual(childEnvironment({ PLUGIN_MANAGER_PASSWORD: 'secret', GITHUB_TOKEN: 'token', PORT: '3000' }), { PORT: '3000' });
});
