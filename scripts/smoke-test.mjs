import assert from 'node:assert/strict';

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
assert.match(await (await get('/')).text(), /<html/i);
for (const path of ['/vendor/pixi.min.js', '/vendor/preact.module.js', '/data/config.json']) {
  assert.ok((await (await get(path)).arrayBuffer()).byteLength > 0, `${path} is empty`);
}

if (process.env.EXPECT_LOCAL_ASSETS === '1') {
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
