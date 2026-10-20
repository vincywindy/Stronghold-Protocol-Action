import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export function archivePath(name) {
  if (!name || name.length > 1024 || /[\x00-\x1f\\:*?"<>|]/.test(name) || name.startsWith('/') ||
      name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error(`Unsafe ZIP path: ${name}`);
  return name;
}
export function readZip(buffer) {
  // Release lite/update archives use ordinary ZIP. Reject ZIP64/encryption rather
  // than guessing offsets or letting an archive allocate unbounded memory.
  let end = -1;
  for (let pos = buffer.length - 22; pos >= Math.max(0, buffer.length - 65557); pos--) {
    if (buffer.readUInt32LE(pos) === 0x06054b50 && pos + 22 + buffer.readUInt16LE(pos + 20) === buffer.length) { end = pos; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP');
  const count = buffer.readUInt16LE(end + 10);
  if (count === 65535 || count > 60000 || count !== buffer.readUInt16LE(end + 8)) throw new Error('Unsupported ZIP entry count');
  let pos = buffer.readUInt32LE(end + 16), total = 0;
  const centralEnd = pos + buffer.readUInt32LE(end + 12);
  if (centralEnd > end) throw new Error('Invalid ZIP directory');
  const entries = new Map(), seen = new Set();
  for (let n = 0; n < count; n++) {
    if (pos + 46 > centralEnd || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid ZIP directory entry');
    const flags = buffer.readUInt16LE(pos + 8), method = buffer.readUInt16LE(pos + 10);
    const size = buffer.readUInt32LE(pos + 24), compressed = buffer.readUInt32LE(pos + 20);
    const length = buffer.readUInt16LE(pos + 28), extra = buffer.readUInt16LE(pos + 30), comment = buffer.readUInt16LE(pos + 32);
    const mode = (buffer.readUInt32LE(pos + 38) >>> 16) & 0xf000;
    const local = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + length).toString('utf8');
    pos += 46 + length + extra + comment;
    if (pos > centralEnd || flags & 1 || ![0, 8].includes(method) || (mode && ![0x8000, 0x4000].includes(mode))) throw new Error('Unsupported ZIP entry');
    archivePath(name.endsWith('/') ? name.slice(0, -1) : name);
    if (seen.has(name.toLowerCase())) throw new Error('Duplicate ZIP path');
    seen.add(name.toLowerCase());
    if (name.endsWith('/')) continue;
    total += size;
    if (size > 128 * 1024 * 1024 || total > 1024 * 1024 * 1024) throw new Error('ZIP unpacked size limit exceeded');
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP local header');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length) throw new Error('Truncated ZIP');
    const packed = buffer.subarray(start, start + compressed);
    const content = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
    if (content.length !== size) throw new Error('ZIP size mismatch');
    entries.set(name, content);
  }
  return entries;
}
export function releaseEntries(buffer) {
  const all = readZip(buffer);
  const manifests = [...all.keys()].filter(key => key === 'MANIFEST.json' || key === 'Stronghold-Protocol/MANIFEST.json');
  if (manifests.length !== 1) throw new Error('Release must contain one root MANIFEST.json');
  const prefix = manifests[0].slice(0, -'MANIFEST.json'.length);
  const entries = new Map();
  for (const [name, bytes] of all) {
    if (!name.startsWith(prefix)) throw new Error('ZIP contains files outside release root');
    const rel = archivePath(name.slice(prefix.length));
    // User configuration and installed plugins are managed separately, never supplied by an update.
    if (rel === 'plugins/config.json' || rel.split('/').some(p => p === '.env' || p.startsWith('.env.')) ||
        rel.startsWith('plugins/') && !rel.startsWith('plugins/_template/') && !['plugins/README.md', 'plugins/AGENTS.md'].includes(rel)) throw new Error(`Release attempts to replace user configuration: ${rel}`);
    entries.set(rel, bytes);
  }
  return entries;
}
export function extractEntries(entries, destination) {
  for (const [name, bytes] of entries) {
    archivePath(name);
    const file = path.join(destination, name);
    // No archive-controlled symlinks are accepted; also refuse inherited symlink parents.
    for (let dir = path.dirname(file); dir !== destination; dir = path.dirname(dir)) {
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Symlink in extraction path: ${name}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Symlink extraction target: ${name}`);
    fs.writeFileSync(file, bytes);
  }
}
