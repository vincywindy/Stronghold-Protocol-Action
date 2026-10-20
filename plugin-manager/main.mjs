import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readCatalog, validateCatalog } from '../scripts/plugin-catalog.mjs';
import { refreshCatalog } from '../scripts/refresh-plugin-catalog.mjs';
import { requestJson } from './download.mjs';
import { initStore, current, readJson, writeJson } from './storage.mjs';
import { initGame, gameState, releasePlan, stageGameUpdate, defaultReleaseApi, gamePath } from './game-update.mjs';
import { installSelection, childEnvironment } from './installer.mjs';
import { Supervisor } from './supervisor.mjs';
import { createManagerServer } from './server.mjs';
import { commitGame, pruneHistory } from './lifecycle.mjs';

const image = path.resolve(process.env.GAME_IMAGE_DIR || '/app');
const bakedCatalog = readCatalog();
const enabled = process.env.PLUGIN_MANAGER_ENABLED || 'auto';
if (enabled === '0' || enabled === 'auto' && !Object.keys(bakedCatalog.sources).length) {
  const child = spawn(process.execPath, ['server/index.js'], { cwd: image, env: childEnvironment(), stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error); process.exit(1); });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  const data = path.resolve(process.env.PLUGIN_MANAGER_DATA_DIR || '/data');
  initStore(data);
  const game = await initGame(data, image);
  let catalog = bakedCatalog;
  const catalogFile = path.join(data, 'catalog.json');
  if (fs.existsSync(catalogFile)) {
    const cached = validateCatalog(readJson(catalogFile));
    // An image change may remove repositories; persisted catalog data cannot add permissions.
    if (Object.keys(cached.sources).length === Object.keys(bakedCatalog.sources).length &&
        Object.entries(cached.sources).every(([key, source]) => source.repository === bakedCatalog.sources[key]?.repository && source.ref === bakedCatalog.sources[key]?.ref)) catalog = cached;
  }
  let job = { action: 'startup', status: 'running' }, closing = false;
  const logs = [];
  const log = line => { const text = String(line).slice(-4000); console.log(text); logs.push(text); if (logs.length > 100) logs.shift(); };
  const supervisor = new Supervisor({ log });
  const api = {
    state() {
      const installed = current(data), activeGame = gameState(data);
      return { sources: catalog.sources, catalog: catalog.plugins, installed: installed.installed, host: installed.host || null, job, logs,
        game: { version: activeGame.version, origin: activeGame.origin, previousVersion: activeGame.previous?.version || null, ...supervisor.status() },
        restartRequired: installed.id !== supervisor.running?.plugins.id,
        releaseSource: process.env.GAME_UPDATE_URL || process.env.GAME_RELEASE_API || defaultReleaseApi };
    },
    start(action, body) {
      if (closing || job?.status === 'running') throw Object.assign(new Error('另一个管理任务正在运行'), { status: 409 });
      if (!['refresh', 'apply', 'restart', 'check-update', 'update-game', 'rollback-game'].includes(action)) throw new Error('Unknown action');
      if (action === 'apply' && (!Array.isArray(body.keys) || body.keys.some(key => typeof key !== 'string' || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(key)))) throw new Error('Invalid plugin selection');
      job = { action, status: 'running', startedAt: new Date().toISOString() };
      void (async () => {
        try {
          if (action === 'refresh') {
            catalog = await refreshCatalog(catalog, requestJson);
            writeJson(catalogFile, catalog);
          } else if (action === 'apply') {
            const before = current(data);
            const result = await installSelection({ data, app: gameState(data).dir, catalog, keys: body.keys, update: body.update === true, log });
            if (body.restart === true) {
              try { await supervisor.switchTo(gameState(data), current(data)); }
              catch (error) { writeJson(path.join(data, 'current.json'), { id: before.id }); throw error; }
            }
            job.result = { count: result.installed.length };
          } else if (action === 'restart') {
            await supervisor.switchTo(gameState(data), current(data));
          } else if (action === 'check-update') {
            const plan = await releasePlan();
            job.result = { version: plan.version, source: plan.source, packages: plan.assets.map(a => a.kind) };
          } else if (action === 'update-game') {
            const candidate = await stageGameUpdate({ data, image, plan: await releasePlan(), log });
            await commitGame({ data, supervisor, candidate, plugins: current(data) });
            job.result = { version: candidate.version };
          } else {
            const before = gameState(data);
            if (!before.previous) throw new Error('没有可回退的版本');
            const previous = { ...before.previous, dir: gamePath(data, before.previous.id) };
            await commitGame({ data, supervisor, plugins: current(data), candidate: { ...previous,
              previous: { id: before.id, version: before.version, origin: before.origin } } });
          }
          job.status = 'success';
          try { pruneHistory(data, supervisor.running); } catch (error) { log(`历史目录清理未完成：${error.message}`); }
        } catch (error) { job.status = 'failed'; job.error = error.message; log(error.message); }
        job.finishedAt = new Date().toISOString();
      })();
      return job;
    },
  };
  const server = createManagerServer({ api, image, password: process.env.PLUGIN_MANAGER_PASSWORD || '',
    allowedHosts: (process.env.PLUGIN_MANAGER_ALLOWED_HOSTS || '').split(',').filter(Boolean) });
  server.listen(Number(process.env.PLUGIN_MANAGER_PORT || 3001), process.env.PLUGIN_MANAGER_HOST || '0.0.0.0');
  server.on('error', error => { console.error(error); void shutdown(1); });
  async function shutdown(code = 0) {
    if (closing) return;
    closing = true;
    server.close();
    await supervisor.stop();
    process.exit(code);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });
  try { await supervisor.start(game, current(data)); job.status = 'success'; }
  catch (error) { job.status = 'failed'; job.error = error.message; log(`游戏启动失败，管理页面仍可用于恢复：${error.message}`); }
}
