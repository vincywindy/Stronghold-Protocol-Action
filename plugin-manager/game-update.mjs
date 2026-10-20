import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson } from './storage.mjs';
import { releaseEntries, extractEntries } from './archive.mjs';

export const defaultReleaseApi = 'https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/latest';
export function gamePath(data, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid game generation');
  return path.join(data, 'games', id);
}
export function gameState(data) {
  const state = readJson(path.join(data, 'game.json'));
  return { ...state, dir: gamePath(data, state.id) };
}
export async function initGame(data, image) {
  if (fs.existsSync(path.join(data, 'game.json'))) return gameState(data);
  const id = randomUUID(), dir = gamePath(data, id);
  await fs.promises.cp(image, dir, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true });
  const version = readJson(path.join(dir, 'package.json')).version;
  writeJson(path.join(data, 'game.json'), { id, version, origin: 'image', updatedAt: new Date().toISOString() });
  return gameState(data);
}
export async function releaseRequest(url, { json = false, maxBytes = 256 * 1024 * 1024 } = {}) {
  // The URL is administrator configuration, not an unauthenticated request argument.
  // Redirects are needed for GitHub Release assets, but credentials never leave the API host.
  let target = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Release URL must use HTTPS without embedded credentials');
    const headers = { 'User-Agent': 'stronghold-plugin-manager' };
    if (json) headers.Accept = 'application/vnd.github+json';
    if (target.hostname === 'api.github.com' && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(180000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); target = new URL(response.headers.get('location'), target); continue; }
    if (!response.ok) throw new Error(`Release download returned HTTP ${response.status}`);
    let length = 0; const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > (json ? 8 * 1024 * 1024 : maxBytes)) throw new Error('Release download exceeds size limit');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    return json ? JSON.parse(bytes.toString('utf8')) : bytes;
  }
  throw new Error('Too many Release redirects');
}
export async function releasePlan(env = process.env, request = releaseRequest) {
  if (env.GAME_UPDATE_URL) return { version: null, source: env.GAME_UPDATE_URL, assets: [{ url: env.GAME_UPDATE_URL, sha256: env.GAME_UPDATE_SHA256 || '', kind: 'configured' }] };
  const source = env.GAME_RELEASE_API || defaultReleaseApi;
  const release = await request(source, { json: true });
  if (release.draft || release.prerelease || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name) || !Array.isArray(release.assets)) throw new Error('Expected a stable Release response');
  const version = release.tag_name.replace(/^v/, '');
  const assets = ['update', 'lite'].map(kind => {
    const matches = release.assets.filter(asset => asset.name === `Stronghold-Protocol-v${version}-${kind}.zip`);
    if (matches.length > 1) throw new Error('Ambiguous Release asset');
    const asset = matches[0];
    return asset && { url: asset.browser_download_url, sha256: asset.digest?.replace(/^sha256:/, '') || '', kind };
  }).filter(Boolean);
  if (!assets.length) throw new Error('No update or lite ZIP in Release');
  return { version, source, assets };
}
export async function stageGameUpdate({ data, image, plan, request = releaseRequest, log = () => {}, validation }) {
  const old = gameState(data);
  // Use the immutable image's updater to validate data before executing any newly downloaded code.
  const updater = validation || await import(pathToFileURL(path.join(image, 'server/update.js')));
  let failure;
  for (const asset of plan.assets) {
    const id = randomUUID(), dir = gamePath(data, id);
    try {
      log(`下载 ${asset.kind} 更新包`);
      const bytes = await request(asset.url);
      if (asset.sha256 && (!/^[a-f0-9]{64}$/.test(asset.sha256) || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)) throw new Error('Release SHA-256 mismatch');
      const entries = releaseEntries(bytes);
      const manifest = updater.parseManifest(entries.get('MANIFEST.json').toString('utf8'));
      if (plan.version && manifest.app !== plan.version) throw new Error('Release version does not match manifest');
      const update = entries.has('UPDATE.json') ? updater.parseUpdate(entries.get('UPDATE.json').toString('utf8')) : null;
      if (update && (update.app !== manifest.app || !update.from.includes(old.version))) throw new Error(`Update does not support base ${old.version}`);
      // Every executable archive member must be authenticated by the Release manifest.
      for (const [rel, content] of entries) {
        if (['MANIFEST.json', 'UPDATE.json'].includes(rel)) continue;
        const expected = update?.files.get(rel) || manifest.files.get(rel);
        // Upstream lite v0.3.1 includes data/assets.json outside MANIFEST.json.
        // Keep the local art snapshot instead of overwriting it with unverified setup data.
        if (!update && !expected && (rel.startsWith('public/assets/') || rel.startsWith('public/fonts/') ||
            ['data/assets.json', 'data/local-assets.json', 'data/local-fx.json'].includes(rel))) {
          entries.delete(rel);
          continue;
        }
        if (!expected || expected.size !== content.length || createHash('sha256').update(content).digest('hex') !== expected.sha256) throw new Error(`Release file integrity failed: ${rel}`);
        if (rel.endsWith('.node')) throw new Error('Release contains native addons; rebuild the platform-specific image');
      }
      if (update) await fs.promises.cp(old.dir, dir, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true });
      else {
        fs.mkdirSync(dir, { recursive: true });
        // Lite archives replace all program files, but retain the existing art and its manifests.
        for (const rel of ['public/assets', 'public/fonts', 'data/assets.json', 'data/local-assets.json', 'data/local-fx.json']) {
          const source = path.join(old.dir, rel);
          if (fs.existsSync(source)) await fs.promises.cp(source, path.join(dir, rel), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
        }
      }
      extractEntries(entries, dir);
      const verified = updater.verifyFiles(dir, manifest.files);
      const broken = [...verified.missing, ...verified.mismatched].filter(updater.affectsRuntime);
      if (broken.length) throw new Error(`Release baseline differs (${broken.length} runtime files), e.g. ${broken.slice(0, 3).join(', ')}`);
      if (update) {
        const result = updater.applyPendingUpdate(dir, { log: { log, warn: log, error: log } });
        if (result.state !== 'applied' || result.art?.length) throw new Error('Update manifest could not be completely applied');
      }
      const pkg = readJson(path.join(dir, 'package.json'));
      if (pkg.version !== manifest.app) throw new Error('Package version differs from Release manifest');
      const requiredMajor = Number(/>=\s*(\d+)/.exec(pkg.engines?.node || '')?.[1] || 0);
      if (requiredMajor > Number(process.versions.node.split('.')[0])) throw new Error('New game requires a newer Node runtime; update the image');
      return { id, dir, version: manifest.app, origin: asset.kind, updatedAt: new Date().toISOString(), previous: { id: old.id, version: old.version, origin: old.origin } };
    } catch (error) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      failure = error;
      log(`${asset.kind}: ${error.message}${plan.assets.length > 1 ? '；尝试下一个可用包' : ''}`);
    }
  }
  throw failure;
}
