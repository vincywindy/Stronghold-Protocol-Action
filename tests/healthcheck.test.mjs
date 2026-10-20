import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createManagerServer } from '../plugin-manager/server.mjs';
import { checkHealth, healthTarget } from '../plugin-manager/healthcheck.mjs';
import { initStore, writeJson } from '../plugin-manager/storage.mjs';

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

test('health target follows vanilla, automatic and explicitly enabled manager modes and custom ports', () => {
  assert.deepEqual(healthTarget({}, {}), { managed: false, url: 'http://127.0.0.1:3000/healthz' });
  assert.deepEqual(healthTarget({}, { lele: {} }), { managed: true, url: 'http://127.0.0.1:3001/healthz' });
  assert.equal(healthTarget({ PLUGIN_MANAGER_ENABLED: '0', PORT: '3100' }, { lele: {} }).url, 'http://127.0.0.1:3100/healthz');
  assert.equal(healthTarget({ PLUGIN_MANAGER_ENABLED: '1', PLUGIN_MANAGER_PORT: '3101' }, {}).url, 'http://127.0.0.1:3101/healthz');
});

test('recovery UI stays healthy with no game, protected by a password, without exposing its state', async t => {
  const server = createManagerServer({ image: '.', password: 'secret',
    api: { state: () => { throw new Error('broken game state'); } } });
  const port = await listen(server, t);
  await checkHealth({ PLUGIN_MANAGER_ENABLED: '1', PLUGIN_MANAGER_PORT: port }, {});
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.deepEqual(await response.json(), { ok: true, service: 'plugin-manager' });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 401);
  const authenticated = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` },
  });
  assert.equal(authenticated.status, 200);
  assert.match(await authenticated.text(), /html/i);
});

test('probe bypasses hostname policy but state endpoints do not', async t => {
  const port = await listen(createManagerServer({ image: '.', api: {} }), t);
  const get = pathname => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers: { Host: 'not-allowed.example' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  assert.equal(await get('/healthz'), 200);
  assert.equal(await get('/api/state'), 403);
});

test('probe fails on unhealthy game, wrong service or absent manager', async t => {
  let body = { ok: false };
  const server = http.createServer((req, res) => res.end(JSON.stringify(body)));
  const port = await listen(server, t);
  await assert.rejects(checkHealth({ PLUGIN_MANAGER_ENABLED: '0', PORT: port }, {}), /Unexpected/);
  body = { ok: true };
  await checkHealth({ PLUGIN_MANAGER_ENABLED: '0', PORT: port }, {});
  await assert.rejects(checkHealth({ PLUGIN_MANAGER_ENABLED: '1', PLUGIN_MANAGER_PORT: port }, {}), /Unexpected/);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(checkHealth({ PLUGIN_MANAGER_ENABLED: '1', PLUGIN_MANAGER_PORT: port }, {}));
});

test('actual manager remains reachable and container probe passes after legacy Lele startup failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-recovery-'));
  const data = path.join(root, 'data'), image = path.join(root, 'image');
  writeJson(path.join(image, 'package.json'), { version: '0.3.1' });
  const installed = initStore(data);
  writeJson(path.join(installed.dir, 'manifest.json'), { id: installed.id,
    installed: [{ key: 'lele/lele-rounds', adapter: 'lele', products: ['lele-rounds'] }] });
  const socket = http.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, GAME_IMAGE_DIR: image, PLUGIN_MANAGER_DATA_DIR: data,
    PLUGIN_MANAGER_ENABLED: '1', PLUGIN_MANAGER_HOST: '127.0.0.1', PLUGIN_MANAGER_PORT: String(port),
    PLUGIN_MANAGER_PASSWORD: 'test-password' };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../plugin-manager/main.mjs', import.meta.url))],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Drain output without including the environment or credentials in test logs.
  child.stdout.resume(); child.stderr.resume();
  const headers = { Authorization: `Basic ${Buffer.from('admin:test-password').toString('base64')}` };
  let state;
  for (let i = 0; i < 100; i++) {
    try {
      state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers })).json();
      if (state.job?.status === 'failed') break;
    } catch { /* Wait for the management socket, not the failed game process. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state?.game.alive, false);
  assert.match(state.job.error, /缺少宿主补丁/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, { headers })).status, 200);
  const probe = spawn(process.execPath, [fileURLToPath(new URL('../plugin-manager/healthcheck.mjs', import.meta.url))],
    { env, stdio: 'ignore' });
  assert.equal((await once(probe, 'exit'))[0], 0);
});
