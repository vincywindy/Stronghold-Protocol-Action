import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { childEnvironment } from './installer.mjs';
import { prepareRuntime } from './lele-host.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class Supervisor {
  constructor({ env = process.env, log = console.log, healthTimeout = 30000, prepare = prepareRuntime } = {}) {
    this.env = env; this.log = log; this.healthTimeout = healthTimeout; this.prepare = prepare; this.child = null; this.running = null;
  }
  async stop() {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    // Process groups also stop outstanding match workers; Docker's init reaps orphans.
    const signal = kind => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, kind); else child.kill(kind); } catch {}
    };
    signal('SIGTERM');
    const timeout = setTimeout(() => signal('SIGKILL'), 7000);
    await exited;
    clearTimeout(timeout);
  }
  async start(game, plugins, runtime) {
    runtime ||= await this.prepare(game, plugins, { log: this.log });
    const child = spawn(process.execPath, [fileURLToPath(new URL('./game-process.mjs', import.meta.url)), runtime.dir, path.join(plugins.dir, 'plugins')], {
      cwd: runtime.dir, env: { ...childEnvironment(this.env), SP_PLUGIN_SCRIPTS: this.env.SP_PLUGIN_SCRIPTS || 'sandbox' },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let spawnError;
    child.on('error', error => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => this.log(chunk.toString('utf8').slice(-4000)));
    const until = Date.now() + this.healthTimeout;
    while (Date.now() < until) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Game exited during startup (${child.exitCode ?? child.signalCode})`);
      try {
        const response = await fetch(`http://127.0.0.1:${this.env.PORT || 3000}/healthz`, { signal: AbortSignal.timeout(1500) });
        if (response.ok && (await response.json()).ok) { this.running = { game, plugins, runtime }; return; }
      } catch {}
      await pause(250);
    }
    await this.stop();
    throw new Error('Game startup health check timed out');
  }
  async switchTo(game, plugins) {
    const before = this.running;
    // Incompatible host patches must fail while the current game is still running.
    const runtime = await this.prepare(game, plugins, { log: this.log });
    await this.stop();
    try { await this.start(game, plugins, runtime); }
    catch (error) {
      await this.stop();
      if (before) {
        this.log('启动失败，恢复上一次运行版本');
        await this.start(before.game, before.plugins, before.runtime);
      }
      throw error;
    }
  }
  status() { return { alive: Boolean(this.child?.pid && this.child.exitCode === null && this.child.signalCode === null), version: this.running?.game.version || null,
    pluginGeneration: this.running?.plugins.id || null, host: this.running?.runtime?.host || null }; }
}
