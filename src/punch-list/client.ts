import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { getToken, loadConfig } from './config.js';
import { paths } from './paths.js';

/** Thrown when the configured port answers but is not a punch-list server. Exit code 2. */
export class PortTakenError extends Error {
  constructor(port: number) {
    super(`Port ${port} is in use by another program; set "port" in ${paths().config}`);
  }
}

export const baseUrl = () => `http://127.0.0.1:${loadConfig().port}`;

type Health = 'ours' | 'foreign' | 'down';

export async function health(): Promise<Health> {
  try {
    const res = await fetch(`${baseUrl()}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json().catch(() => null)) as { app?: string } | null;
    return body?.app === 'punch-list' ? 'ours' : 'foreign';
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    // A refused connection means nothing listens; any other failure means something odd holds the port.
    return code === 'ECONNREFUSED' || code === 'ECONNRESET' ? 'down' : 'foreign';
  }
}

/** Makes sure our server is running, starting it in the background from `bin` when it is not. */
export async function ensureServer(bin: string): Promise<void> {
  const state = await health();
  if (state === 'ours') return;
  if (state === 'foreign') throw new PortTakenError(loadConfig().port);
  const log = openSync(paths().serverLog, 'a');
  spawn(process.execPath, [bin, 'serve'], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const now = await health();
    if (now === 'ours') return;
    if (now === 'foreign') throw new PortTakenError(loadConfig().port);
  }
  throw new Error(`punch-list server did not start; see ${paths().serverLog}`);
}

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: { 'x-sidekick-token': getToken(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `${method} ${path} failed with ${res.status}`);
  return json;
}
