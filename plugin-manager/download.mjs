import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safePath } from '../scripts/plugin-catalog.mjs';

export async function requestBytes(url, limit = 8 * 1024 * 1024) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname)) throw new Error('Unsupported download host');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'stronghold-plugin-manager' };
  if (parsed.hostname === 'api.github.com' && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${parsed.pathname}`);
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new Error('Download exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function requestJson(url) { return JSON.parse((await requestBytes(url)).toString('utf8')); }
export function rawUrl(source, relative) {
  safePath(relative);
  return `https://raw.githubusercontent.com/${source.repository}/${source.revision}/${relative.split('/').map(encodeURIComponent).join('/')}`;
}
export async function downloadPlugin(plugin, source, destination, { bytes = requestBytes, json = requestJson } = {}) {
  fs.mkdirSync(destination, { recursive: true });
  if (plugin.adapter === 'forge') {
    const buffer = await bytes(rawUrl(source, plugin.path), 256 * 1024 * 1024);
    if (createHash('sha256').update(buffer).digest('hex') !== plugin.sha256) throw new Error(`SHA-256 mismatch: ${plugin.id}`);
    const file = path.join(destination, 'source.zip');
    fs.writeFileSync(file, buffer);
    return file;
  }
  const tree = await json(`https://api.github.com/repos/${source.repository}/git/trees/${source.revision}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete repository tree');
  const files = tree.tree.filter(entry => entry.path.startsWith(`${plugin.path}/`) && entry.type !== 'tree');
  if (!files.length || files.length > 5000) throw new Error('Invalid plugin file count');
  let total = 0;
  const seen = new Set();
  for (const entry of files) {
    const rel = entry.path.slice(plugin.path.length + 1);
    safePath(rel);
    // Git symlinks/submodules must not turn a selected directory into an arbitrary filesystem write.
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || seen.has(rel.toLowerCase())) throw new Error(`Unsafe plugin entry: ${rel}`);
    seen.add(rel.toLowerCase());
    const buffer = await bytes(rawUrl(source, entry.path), 64 * 1024 * 1024);
    total += buffer.length;
    if (total > 256 * 1024 * 1024) throw new Error('Plugin directory exceeds size limit');
    const file = path.join(destination, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'plugin.json'), 'utf8'));
  if (manifest.id !== plugin.id) throw new Error('Downloaded manifest identity mismatch');
  return destination;
}
