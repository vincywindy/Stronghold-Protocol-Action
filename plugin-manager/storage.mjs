import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
export function generationPath(data, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid generation ID');
  return path.join(data, 'generations', id);
}
export function initStore(data) {
  fs.mkdirSync(path.join(data, 'generations'), { recursive: true });
  const file = path.join(data, 'current.json');
  if (!fs.existsSync(file)) {
    const id = randomUUID(), dir = generationPath(data, id);
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    writeJson(path.join(dir, 'manifest.json'), { id, installed: [], createdAt: new Date().toISOString() });
    writeJson(file, { id });
  }
  return current(data);
}
export function current(data) {
  const pointer = readJson(path.join(data, 'current.json'));
  const dir = generationPath(data, pointer.id);
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (manifest.id !== pointer.id || !Array.isArray(manifest.installed)) throw new Error('Invalid persisted plugin manifest');
  return { ...manifest, dir };
}
export function activate(data, manifest) {
  writeJson(path.join(generationPath(data, manifest.id), 'manifest.json'), manifest);
  // The game keeps using its previous directory until restart. A crash before this
  // atomic pointer swap leaves the complete previous installation usable.
  writeJson(path.join(data, 'current.json'), { id: manifest.id });
}
