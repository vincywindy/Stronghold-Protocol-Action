import { h, render } from '/vendor/preact.module.js';
import { useEffect, useRef, useState } from '/vendor/hooks.module.js';
import htm from '/vendor/htm.module.js';
const html = htm.bind(h);
const names = { copied: '已安装', imported: '已导入', partial: '部分导入', 'bundled-only': '仅保留原包' };
const jobNames = { startup: '启动游戏', refresh: '刷新目录', apply: '应用插件', restart: '重启游戏', 'check-update': '检查更新', 'update-game': '更新游戏', 'rollback-game': '回退游戏' };
const jobStates = { running: '进行中', success: '已完成', failed: '失败' };
const label = p => typeof p.name === 'string' ? p.name : p.name?.zh || p.id;
function App() {
  const [state, setState] = useState(null), [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState(''), [error, setError] = useState('');
  const dirty = useRef(false);
  const setDirty = value => { dirty.current = value; };
  const [restart, setRestart] = useState(false);
  async function refresh() {
    try {
      const response = await fetch('/api/state');
      if (!response.ok) throw new Error(`读取状态失败（${response.status}）`);
      const value = await response.json();
      setState(value);
      // A response started before a click must not erase the user's new selection.
      if (!dirty.current) setSelected(new Set(value.installed.map(p => p.key)));
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { refresh(); const timer = setInterval(refresh, 2500); return () => clearInterval(timer); }, []);
  async function action(name, body = {}, message) {
    if (message && !confirm(message)) return;
    setError('');
    try {
      const response = await fetch(`/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Manager-Token': state.csrf }, body: JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '操作失败');
      if (name === 'apply') setDirty(false);
      await refresh();
    } catch (e) { setError(e.message); }
  }
  if (!state) return html`<main><h1>卫戍协议 · 管理中心</h1><p>${error || '正在连接…'}</p></main>`;
  const busy = state.job?.status === 'running';
  const installed = new Map(state.installed.map(p => [p.key, p]));
  const rows = [...state.catalog];
  for (const record of state.installed) if (!rows.some(p => `${p.source}/${p.id}` === record.key)) {
    const [source, id] = record.key.split('/');
    rows.push({ source, id, name: id, version: '来源已移除' });
  }
  const visible = rows.filter(p => `${p.source}/${p.id} ${state.sources[p.source]?.repository || ''} ${label(p)}`.toLowerCase().includes(filter.toLowerCase()));
  function toggle(key, checked) { const next = new Set(selected); checked ? next.add(key) : next.delete(key); setSelected(next); setDirty(true); }
  return html`<main>
    <div class="masthead"><span class="service"><span class="crosshair" aria-hidden="true">+</span>STRONGHOLD PROTOCOL // MANAGEMENT</span><span class="node-label">TACTICAL CO-OP NODE · 管理终端</span></div>
    <header><div><p class="eyebrow">STRONGHOLD PROTOCOL <span>ALLIANCE</span></p><h1>卫戍协议 · <em>管理中心</em></h1><p class="subtitle">维护游戏版本与插件，在房间中选择本局启用的内容。</p></div><span class=${state.game.alive ? 'connection is-online' : 'connection warn'}>${state.game.alive ? '游戏运行中' : '游戏未运行'}</span></header>
    <div class="overview" aria-label="插件概览"><div><span>已启用仓库</span><strong>${Object.keys(state.sources).length.toString().padStart(2, '0')}</strong></div><div><span>可选插件</span><strong>${state.catalog.length.toString().padStart(2, '0')}</strong></div><div><span>已下载插件</span><strong class="selected-count">${state.installed.length.toString().padStart(2, '0')}</strong></div></div>
    ${error && html`<p role="alert" class="error">${error}</p>`}
    <section><div class="section-title"><div class="section-heading"><span class="section-number" aria-hidden="true">01</span><div><h2>游戏版本 <span class="version">${state.game.version || '未知'}</span></h2><div class="section-caption">VERSION CONTROL</div></div></div></div>
      <p class="release-source"><span>更新来源</span><code>${state.releaseSource}</code></p>
      <p class="muted">当前宿主：${state.game.host ? `Lele API ${state.game.host.api} · ${state.game.host.version} · ${state.game.host.revision.slice(0, 12)}` : '原版'}${state.host && state.restartRequired ? '；已准备 Lele 兼容层，重启后生效' : ''}</p>
      <p class="muted">优先下载增量更新包，基线不匹配时尝试精简程序包；保留现有素材和插件。更新、回退及重启会中断正在进行的对局。</p>
      <div class="actions"><button disabled=${busy} onClick=${() => action('check-update')}>检查更新</button>
      <button disabled=${busy} onClick=${() => action('update-game', {}, '下载并更新游戏？切换版本时将中断当前对局，启动失败会恢复原版本。')}>下载更新并重启</button>
      <button disabled=${busy || !state.game.previousVersion} onClick=${() => action('rollback-game', {}, '回退游戏并重启？当前对局将中断。')}>回退${state.game.previousVersion ? `到 ${state.game.previousVersion}` : ''}</button>
      <button disabled=${busy} onClick=${() => action('restart', {}, '重启游戏会中断当前对局，是否继续？')}>重启游戏</button></div>
      ${state.restartRequired && html`<p class="warn">插件目录有待应用的变更，请在合适的时候重启游戏。</p>`}
    </section>
    <section><div class="section-title"><div class="section-heading"><span class="section-number" aria-hidden="true">02</span><div><h2>插件仓库</h2><div class="section-caption">PLUGIN REPOSITORIES</div></div></div><button disabled=${busy} onClick=${() => action('refresh')}>刷新目录 / 检查插件更新</button></div>
      <p class="muted">勾选后应用才会下载。取消勾选并应用会卸载。更新先刷新目录，再点击“更新已选插件”。</p>
      <input type="search" aria-label="搜索插件" placeholder="搜索插件名称、ID 或仓库…" value=${filter} onInput=${e => setFilter(e.target.value)}/>
      ${!Object.keys(state.sources).length && html`<p>此镜像未启用插件来源。构建时勾选需要的仓库；游戏更新功能仍可使用。</p>`}
      <div class="plugin-list">${visible.map(p => {
        const key = `${p.source}/${p.id}`, have = installed.get(key);
        return html`<article key=${key} class=${selected.has(key) ? 'is-selected' : ''}><label><input type="checkbox" checked=${selected.has(key)} disabled=${busy} onChange=${e => toggle(key, e.target.checked)}/><span><strong>${state.sources[p.source]?.repository.split('/')[1] || p.source} + ${label(p)}</strong><small>${key} · 目录版本 ${p.version}${have ? ` · 已下载 ${have.version}` : ''}</small></span></label>
          <span class=${have?.status === 'bundled-only' || have?.status === 'partial' ? 'badge warn' : have ? 'badge installed' : 'badge'}>${have ? names[have.status] || have.status : '未安装'}</span>
          ${have && (have.version !== p.version || have.revision !== state.sources[p.source]?.revision) && html`<small>来源有更新，可重新下载</small>`}
          ${p.adapter === 'lele' && html`<small class="muted">安装时自动准备同版本 Lele 宿主补丁，重启后生效。补丁修改独立运行副本，游戏更新须通过兼容检查。</small>`}
          ${have?.diagnostics?.length > 0 && html`<details><summary>安装诊断</summary><pre>${JSON.stringify(have.diagnostics, null, 2)}</pre></details>`}
        </article>`;
      })}</div>
      <div class="actions install-actions"><button disabled=${busy} onClick=${() => { const next = new Set(selected); for (const p of visible) next.add(`${p.source}/${p.id}`); setSelected(next); setDirty(true); }}>选择当前列表</button>
      <button disabled=${busy} onClick=${() => { setSelected(new Set()); setDirty(true); }}>取消全部</button>
      <label><input type="checkbox" checked=${restart} onChange=${e => setRestart(e.target.checked)}/>应用后重启游戏</label>
      <button class="primary" disabled=${busy} onClick=${() => action('apply', { keys: [...selected], restart }, '应用选择？未勾选的已安装插件将被卸载。勾选重启时会中断对局。')}>应用选择（${selected.size}）</button>
      <button disabled=${busy} onClick=${() => action('apply', { keys: [...selected], update: true, restart }, '重新下载并更新所选插件？未勾选的已安装插件将被卸载。')}>更新已选插件</button></div>
    </section>
    <section><div class="section-title"><div class="section-heading"><span class="section-number" aria-hidden="true">03</span><div><h2>任务与日志</h2><div class="section-caption">OPERATION LOG</div></div></div></div><p class="task-status" aria-live="polite">${state.job ? jobNames[state.job.action] || state.job.action : '等待操作'}<span class=${state.job?.status === 'failed' ? 'badge warn' : 'badge installed'}>${state.job ? jobStates[state.job.status] || state.job.status : '就绪'}</span></p>
      ${state.job?.error && html`<p class="error">${state.job.error}</p>`}
      ${state.job?.result && html`<pre>${JSON.stringify(state.job.result, null, 2)}</pre>`}
      <details open=${busy}><summary>运行日志</summary><pre>${state.logs.join('\n')}</pre></details>
    </section>
    <footer><span>STRONGHOLD PROTOCOL // ALLIANCE</span><span>卫戍协议：盟约 · 管理终端</span></footer>
  </main>`;
}
render(html`<${App}/>`, document.getElementById('app'));
