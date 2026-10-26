import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Points SIDEKICK_HOME at a fresh temp dir and returns it. */
export function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sidekick-test-'));
  process.env.SIDEKICK_HOME = dir;
  return dir;
}
