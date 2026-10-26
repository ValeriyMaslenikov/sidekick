import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { paths } from './paths.js';

const DAY_MS = 86_400_000;

/** Deletes Boards opened more than `retentionDays` ago. Returns the ids removed. */
export function cleanupBoards(now: Date = new Date()): string[] {
  const { retentionDays } = loadConfig();
  const dir = paths().boards;
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const id of readdirSync(dir)) {
    const file = join(dir, id, 'board.json');
    let createdAt: number;
    try {
      createdAt = Date.parse((JSON.parse(readFileSync(file, 'utf8')) as { createdAt: string }).createdAt);
    } catch {
      continue;
    }
    if (now.getTime() - createdAt > retentionDays * DAY_MS) {
      rmSync(join(dir, id), { recursive: true, force: true });
      removed.push(id);
    }
  }
  return removed.sort();
}
