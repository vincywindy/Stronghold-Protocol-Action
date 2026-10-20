import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safePath, copyTree } from '../scripts/plugin-catalog.mjs';
import { requestBytes, requestJson, rawUrl } from './download.mjs';
import { readJson, writeJson } from './storage.mjs';

export const LELE_REPOSITORY = 'llleeeqi/Stronghold-Protocol-Lele-Mods';
const patchName = 'patches/modpack-code.patch';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const blobHash = value => createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
const execute = promisify(execFile);
const runtimeFile = rel => /^(server|shared|tools|config)\//.test(rel) ||
  rel === 'NOTICE.md' || rel.startsWith('public/') && !rel.startsWith('public/dev/');
const sharedDirectories = ['node_modules', 'public/assets', 'public/fonts'];

export async function downloadHostBundle(source, destination, { bytes = requestBytes, json = requestJson } = {}) {
  if (source.repository !== LELE_REPOSITORY || !/^[a-f0-9]{40}$/.test(source.revision)) throw new Error('Unsupported Lele host source');
  const tree = await json(`https://api.github.com/repos/${source.repository}/git/trees/${source.revision}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete Lele host repository tree');
  const entries = tree.tree.filter(e => e.type !== 'tree' && (
    [patchName, 'upstream.lock.json', 'LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md'].includes(e.path) ||
    e.path.startsWith('mods/assets/public/art/') || e.path.startsWith('notices/')));
  if (!entries.some(e => e.path === patchName) || !entries.some(e => e.path === 'upstream.lock.json') ||
      entries.length > 1000) throw new Error('Missing/invalid Lele host bundle');
  let total = 0;
  const files = {}, seen = new Set();
  for (const entry of entries) {
    safePath(entry.path);
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || seen.has(entry.path.toLowerCase())) throw new Error('Unsafe Lele host entry');
    seen.add(entry.path.toLowerCase());
    const buffer = await bytes(rawUrl(source, entry.path), 16 * 1024 * 1024);
    // Fetch all inputs from one commit and authenticate them against that commit's Git tree.
    if (blobHash(buffer) !== entry.sha) throw new Error(`Lele host download integrity failed: ${entry.path}`);
    total += buffer.length;
    if (total > 64 * 1024 * 1024) throw new Error('Lele host bundle exceeds size limit');
    const target = path.join(destination, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    files[entry.path] = sha256(buffer);
  }
  const lock = readJson(path.join(destination, 'upstream.lock.json'));
  if (lock.upstream !== 'https://github.com/sganggs/Stronghold-Protocol.git' ||
      !/^[a-f0-9]{40}$/.test(lock.revision) || lock.plugin_host?.api !== 1 ||
      typeof lock.plugin_host.version !== 'string' || !Array.isArray(lock.plugin_host.features) ||
      !lock.plugin_host.features.length || lock.plugin_host.features.some(f => !/^[a-z][a-z0-9-]*$/.test(f))) {
    throw new Error('Unsupported Lele host API/lock format');
  }
  const host = { type: 'lele', repository: source.repository, revision: source.revision,
    api: 1, version: lock.plugin_host.version, baseline: lock.revision, patchSha256: files[patchName] };
  writeJson(path.join(destination, 'bundle.json'), { ...host, files });
  return host;
}

export function readHostPatch(buffer) {
  const chunks = buffer.toString('utf8').split(/(?=^diff --git )/m);
  const files = [], seen = new Set();
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const header = /^diff --git a\/(\S+) b\/(\S+)\n/.exec(chunk);
    if (!header || header[1] !== header[2]) throw new Error('Unsupported Lele patch header/rename');
    const rel = header[1];
    // .gitignore is source-checkout metadata; never write hidden files or deployment configuration.
    if (rel !== '.gitignore') safePath(rel);
    if (seen.has(rel.toLowerCase())) throw new Error(`Duplicate Lele patch path: ${rel}`);
    seen.add(rel.toLowerCase());
    if (/^(?:old mode|new mode|rename |copy )/m.test(chunk) ||
        /^(?:new|deleted) file mode (?!100644$|100755$)/m.test(chunk)) throw new Error(`Unsafe Lele patch mode: ${rel}`);
    if (!runtimeFile(rel)) {
      if (rel !== '.gitignore' && !/^(docs|test|public\/dev)\//.test(rel)) throw new Error(`Unsupported Lele patch target: ${rel}`);
      continue;
    }
    if (/^public\/(?:assets|fonts|vendor)\//.test(rel)) throw new Error(`Lele patch cannot replace shared assets: ${rel}`);
    const index = /^index ([a-f0-9]{7,40})\.\.([a-f0-9]{7,40})(?: (100644|100755))?$/m.exec(chunk);
    if (!index) throw new Error(`Missing Lele patch identities: ${rel}`);
    // Git's own path parser must see exactly the paths we validated, including binary patches.
    for (const line of chunk.split('\n').filter(l => /^(---|\+\+\+) /.test(l))) {
      const expected = line.startsWith('---') ? `--- a/${rel}` : `+++ b/${rel}`;
      if (line !== expected && !/^(---|\+\+\+) \/dev\/null$/.test(line)) throw new Error(`Mismatched Lele patch path: ${rel}`);
    }
    files.push({ path: rel, before: index[1], after: index[2], patch: chunk });
  }
  if (!files.length) throw new Error('Empty Lele runtime patch');
  return files;
}

function checkIdentity(root, rel, identity) {
  const target = path.join(root, rel);
  for (let at = target; at !== root; at = path.dirname(at)) {
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw new Error(`Lele patch target is a link: ${rel}`);
  }
  if (/^0+$/.test(identity)) {
    if (fs.existsSync(target)) throw new Error(`Lele patch expected absent file: ${rel}`);
  } else if (!fs.existsSync(target) || !fs.statSync(target).isFile() ||
      !blobHash(fs.readFileSync(target)).startsWith(identity)) throw new Error(`Lele 补丁基线不匹配：${rel}`);
}

async function applyPatch(app, file) {
  // Git handles binary patches; no downloaded shell, generator, npm hook or installer is executed.
  // Ceiling/config isolation also prevents a surrounding checkout or user Git settings affecting apply.
  const config = path.join(path.dirname(file), 'gitconfig');
  fs.writeFileSync(config, '');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    GIT_CEILING_DIRECTORIES: path.dirname(app), GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config };
  for (const args of [['--check'], []]) await execute('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', ...args, file],
    { cwd: app, env, timeout: 120000, maxBuffer: 1024 * 1024 });
}

export async function prepareRuntime(game, plugins, { log = () => {}, apply = applyPatch } = {}) {
  const needsHost = plugins.installed.some(p => p.adapter === 'lele');
  if (!needsHost) return game;
  if (!plugins.host) throw new Error('已安装的 Lele 插件缺少宿主补丁，请在管理页重新“应用选择”以安装兼容层');
  const bundle = path.join(plugins.dir, 'host-bundle'), manifest = readJson(path.join(bundle, 'bundle.json'));
  if (manifest.revision !== plugins.host.revision || manifest.patchSha256 !== plugins.host.patchSha256 ||
      manifest.repository !== LELE_REPOSITORY || manifest.api !== 1) throw new Error('Lele host bundle metadata mismatch');
  const version = readJson(path.join(game.dir, 'package.json')).version;
  if (version !== manifest.version) throw new Error(`Lele 宿主补丁仅适配 ${manifest.version}，当前游戏为 ${version}；请更新插件补丁或卸载全部 Lele 插件后再更新游戏`);
  for (const [rel, digest] of Object.entries(manifest.files)) {
    safePath(rel);
    const file = path.join(bundle, rel);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== digest) throw new Error(`Lele host bundle integrity failed: ${rel}`);
  }
  const patch = fs.readFileSync(path.join(bundle, patchName));
  if (sha256(patch) !== manifest.patchSha256) throw new Error('Lele host patch integrity failed');
  const files = readHostPatch(patch);
  const base = path.resolve(game.dir);
  for (const file of files) checkIdentity(base, file.path, file.before);
  // A derivative belongs to one immutable plugin generation and pristine game directory.
  // Release verification and rollback always use the pristine directory, never patched code.
  const key = sha256(`${base}\0${manifest.patchSha256}\0recipe-1`);
  const hosts = path.join(plugins.dir, 'hosts'), ready = path.join(hosts, key);
  if (fs.existsSync(path.join(ready, 'ready.json'))) return { ...game, dir: path.join(ready, 'app'), host: plugins.host };
  const stage = path.join(hosts, randomUUID()), app = path.join(stage, 'app');
  fs.mkdirSync(stage, { recursive: true });
  try {
    log(`准备 Lele 宿主 API ${manifest.api}，游戏 ${version}，来源 ${manifest.revision.slice(0, 12)}`);
    await fs.promises.cp(base, app, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true,
      filter: from => !sharedDirectories.includes(path.relative(base, from).split(path.sep).join('/')) });
    // Large immutable art/dependencies can be shared. The patch allowlist excludes these paths.
    for (const rel of sharedDirectories) if (fs.existsSync(path.join(base, rel))) {
      fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
      fs.symlinkSync(path.join(base, rel), path.join(app, rel), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const patchFile = path.join(stage, 'runtime.patch');
    fs.writeFileSync(patchFile, files.map(f => f.patch).join(''));
    await apply(app, patchFile);
    for (const file of files) checkIdentity(app, file.path, file.after);
    // This is the data contract in Lele's finalize-plugin-host.mjs: preserve vanilla tables and
    // expose empty feature slots. Only room-selected plugins populate them via normal validation.
    const configFile = path.join(app, 'data/config.json'), config = readJson(configFile);
    const lock = readJson(path.join(bundle, 'upstream.lock.json'));
    if (!config.economy || typeof config.economy !== 'object') throw new Error('Missing upstream economy data');
    config.economy.leleHost = { api: 1, enabled: {}, packages: Object.fromEntries(lock.plugin_host.features.map(f => [f, {}])) };
    writeJson(configFile, config);
    const art = path.join(bundle, 'mods/assets/public/art');
    if (fs.existsSync(art)) copyTree(art, path.join(app, 'public/art'));
    const notices = path.join(app, 'lele-host-notices');
    for (const rel of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md', 'notices', 'upstream.lock.json']) {
      if (fs.existsSync(path.join(bundle, rel))) copyTree(path.join(bundle, rel), path.join(notices, rel));
    }
    writeJson(path.join(stage, 'ready.json'), { ...plugins.host, base });
    fs.renameSync(stage, ready);
    return { ...game, dir: path.join(ready, 'app'), host: plugins.host };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
