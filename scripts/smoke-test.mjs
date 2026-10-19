import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const base = process.env.SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
async function get(path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response;
}

// Allow cold startup on CI, but a permanently broken image must fail the release.
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    assert.equal((await (await get('/healthz')).json()).ok, true);
    ready = true;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
assert.ok(ready, 'Server did not become healthy');
if (process.env.EXPECT_PLUGINS) {
  const inventory = JSON.parse(readFileSync('plugin-build.json', 'utf8'));
  assert.deepEqual(inventory.plugins.map(p => p.key).sort(), process.env.EXPECT_PLUGINS.split(',').sort(), 'Image plugin selection differs from the requested build');
  // Selection means bundling, not a promise that the current game can load the third-party package.
  for (const plugin of inventory.plugins) {
    assert.ok(existsSync(plugin.bundlePath), `Selected package was omitted from image: ${plugin.key}`);
    if (plugin.sha256) assert.equal(createHash('sha256').update(readFileSync(plugin.bundlePath)).digest('hex'), plugin.sha256);
    else assert.ok(existsSync(`${plugin.bundlePath}/plugin.json`), `Missing original manifest: ${plugin.key}`);
  }
  for (const id of inventory.installed) {
    assert.ok(existsSync(`plugins/${id}/plugin.json`), `Installed plugin omitted from image: ${id}`);
  }
}
assert.match(await (await get('/')).text(), /<html/i);
for (const path of ['/vendor/pixi.min.js', '/vendor/preact.module.js', '/data/config.json']) {
  assert.ok((await (await get(path)).arrayBuffer()).byteLength > 0, `${path} is empty`);
}

if (process.env.EXPECT_LOCAL_ASSETS === '1') {
  // HTTP health can pass with silent art/audio fallbacks. Check every bundled manifest
  // against the final filesystem too, so a COPY/ignore regression cannot publish missing art.
  const publicRoot = resolve('public') + sep;
  const files = new Set();
  function collect(value) {
    if (typeof value === 'string' && /^\/(assets|fonts)\//.test(value)) {
      const file = resolve('public', `.${decodeURIComponent(value)}`);
      assert.ok(file.startsWith(publicRoot), `Asset path escapes public/: ${value}`);
      files.add(file);
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) collect(child);
    }
  }
  for (const file of ['data/assets.json', 'data/local-assets.json', 'data/local-fx.json']) {
    // Battle FX were added after the older releases this recipe still supports.
    if (file === 'data/local-fx.json' && !existsSync(file)) continue;
    collect(JSON.parse(readFileSync(file, 'utf8')));
  }
  assert.ok(files.size > 0, 'Release asset manifests contain no file references');
  for (const file of files) {
    const info = statSync(file);
    assert.ok(info.isFile() && info.size > 0, `Missing or empty release asset: ${file}`);
  }
  console.log(`Release asset integrity passed: ${files.size} referenced files`);
  const manifest = await (await get('/data/local-assets.json')).json();
  const atlas = manifest.groups?.['map/autochess']?.TX_autochessi_D?.path;
  assert.ok(atlas?.startsWith('/assets/local/'), '3D board atlas missing from local manifest');
  // A healthy server can still serve 2D fallbacks if Docker omitted the local art directory.
  for (const path of [atlas, '/vendor/three.module.js',
    '/assets/local/map/autochess/tiles.json', '/assets/local/mesh/map_autochess_bkg/prefab.json']) {
    assert.ok((await (await get(path)).arrayBuffer()).byteLength > 0, `${path} is empty`);
  }
  console.log('Local art test passed: manifest, 3D atlas, mesh prefab, tile table, three.js');
}

// HTTP health alone does not verify the WebSocket endpoint used by multiplayer.
await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket timeout')); }, 10000);
  socket.addEventListener('open', () => { clearTimeout(timer); socket.close(); resolve(); }, { once: true });
  socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new Error('WebSocket failed')); }, { once: true });
});
console.log('Smoke test passed: health, HTML, vendor, game data, WebSocket');
