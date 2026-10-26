import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { paths } from './paths.js';

export interface Config {
  port: number;
  retentionDays: number;
}

const DEFAULTS: Config = { port: 7317, retentionDays: 90 };

function ensureHome(): void {
  mkdirSync(paths().home, { recursive: true });
}

/** Reads the config, creating it with defaults when missing. Unknown or invalid values fall back to defaults. */
export function loadConfig(): Config {
  ensureHome();
  const file = paths().config;
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n');
    return { ...DEFAULTS };
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>;
  return {
    port: Number.isInteger(raw.port) ? (raw.port as number) : DEFAULTS.port,
    retentionDays: typeof raw.retentionDays === 'number' && raw.retentionDays > 0 ? raw.retentionDays : DEFAULTS.retentionDays,
  };
}

/** The per-install secret every request must carry. */
export function getToken(): string {
  ensureHome();
  const file = paths().token;
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(16).toString('hex');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

interface State {
  noticeConfigHash?: string;
}

function readState(): State {
  try {
    return JSON.parse(readFileSync(paths().state, 'utf8')) as State;
  } catch {
    return {};
  }
}

/** Returns the retention notice the first time, and again after the config file changes; otherwise null. */
export function takeRetentionNotice(): string | null {
  const config = loadConfig();
  const hash = createHash('sha256').update(readFileSync(paths().config, 'utf8')).digest('hex');
  const state = readState();
  if (state.noticeConfigHash === hash) return null;
  writeFileSync(paths().state, JSON.stringify({ ...state, noticeConfigHash: hash }, null, 2) + '\n');
  return `Boards are kept for ${config.retentionDays} days; change that in ${paths().config}`;
}
