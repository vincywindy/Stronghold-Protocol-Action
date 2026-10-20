import fs from 'node:fs';
import path from 'node:path';
import { current, generationPath, writeJson } from './storage.mjs';
import { gamePath, gameState } from './game-update.mjs';

export async function commitGame({ data, supervisor, candidate, plugins, save = writeJson }) {
  const before = gameState(data);
  await supervisor.switchTo(candidate, plugins);
  try {
    const { dir, ...saved } = candidate;
    save(path.join(data, 'game.json'), saved);
  } catch (error) {
    // A healthy new process is not committed until its persistent pointer is saved.
    // Restore the old process before callers consider removing the failed candidate.
    await supervisor.switchTo(before, plugins);
    throw error;
  }
}

export function pruneHistory(data, running) {
  const game = gameState(data), plugins = current(data);
  // Keep rollback targets and the still-running plugin directory when restart was deferred.
  const groups = [
    ['games', new Set([game.id, game.previous?.id, running?.game.id]), gamePath],
    ['generations', new Set([plugins.id, plugins.previousId, running?.plugins.id]), generationPath],
  ];
  for (const [folder, keep, resolve] of groups) {
    const root = path.resolve(data, folder);
    for (const id of fs.readdirSync(root)) {
      if (keep.has(id) || !/^[a-f0-9-]{36}$/.test(id)) continue;
      const target = path.resolve(resolve(data, id));
      if (path.dirname(target) !== root || fs.lstatSync(target).isSymbolicLink()) continue;
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}
