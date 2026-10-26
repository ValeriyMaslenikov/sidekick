import { describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshHome } from './helpers.js';
import { paths } from '../src/punch-list/paths.js';
import { loadConfig, getToken, takeRetentionNotice } from '../src/punch-list/config.js';
import { cleanupBoards } from '../src/punch-list/retention.js';

const DAY = 86_400_000;

describe('config', () => {
  beforeEach(() => { freshHome(); });

  it('creates the default config on first load', () => {
    expect(loadConfig()).toEqual({ port: 7317, retentionDays: 90 });
    expect(JSON.parse(readFileSync(paths().config, 'utf8'))).toEqual({ port: 7317, retentionDays: 90 });
  });

  it('keeps the token stable across calls', () => {
    const t = getToken();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(getToken()).toBe(t);
  });

  it('shows the retention notice once per config version', () => {
    loadConfig();
    const first = takeRetentionNotice();
    expect(first).toBe(`Boards are kept for 90 days; change that in ${paths().config}`);
    expect(takeRetentionNotice()).toBeNull();
    writeFileSync(paths().config, JSON.stringify({ port: 7317, retentionDays: 30 }));
    expect(takeRetentionNotice()).toBe(`Boards are kept for 30 days; change that in ${paths().config}`);
  });
});

describe('cleanupBoards', () => {
  beforeEach(() => { freshHome(); loadConfig(); });

  function board(id: string, ageDays: number, now: Date) {
    const dir = paths().boardDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'board.json'), JSON.stringify({ id, createdAt: new Date(now.getTime() - ageDays * DAY).toISOString() }));
  }

  it('deletes boards older than the retention and keeps newer ones', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    board('old-one', 91, now);
    board('new-one', 89, now);
    expect(cleanupBoards(now)).toEqual(['old-one']);
    expect(existsSync(paths().boardDir('old-one'))).toBe(false);
    expect(existsSync(paths().boardDir('new-one'))).toBe(true);
  });
});
