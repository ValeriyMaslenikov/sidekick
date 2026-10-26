import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(__dirname, '..', 'skills', 'punch-list', 'bin', 'punch-list.mjs');
const home = mkdtempSync(join(tmpdir(), 'sidekick-cli-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, SIDEKICK_HOME: home, PUNCH_LIST_NO_OPEN: '1', CLAUDE_CODE_SESSION_ID: 'sess-1' };

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8', timeout: 20_000 });
}
function runJson(args: string[], input?: string) {
  const r = run(args, input);
  if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const token = () => readFileSync(join(home, 'token'), 'utf8').trim();
const page = (id: string, action: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/b/${id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sidekick-token': token() }, body: JSON.stringify(body) });

const boardJson = JSON.stringify({ title: 'CLI test', questions: [{ id: 'q1', title: 'Yes?', type: 'yes-no' }] });

describe('punch-list CLI (built bundle)', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'build.mjs')], { stdio: 'inherit' });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ port, retentionDays: 90 }));
  }, 60_000);
  afterAll(() => { run(['stop']); });

  it('opens a board, starting the server, and prints its URL and the retention notice', () => {
    const out = runJson(['open', 'cli-test', '--file', '-'], boardJson);
    expect(out.url).toBe(`http://127.0.0.1:${port}/b/cli-test?t=${token()}`);
    expect(out.notice).toMatch(/Boards are kept for 90 days/);
    expect(runJson(['open', 'cli-test2', '--file', '-'], boardJson).notice).toBeUndefined();
  });

  it('refuses to open over an existing board without --replace', () => {
    const r = run(['open', 'cli-test', '--file', '-'], boardJson);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
  });

  it('prints [] for a non-blocking wait', () => {
    expect(runJson(['wait', 'cli-test', '--timeout', '0'])).toEqual([]);
  });

  it('exits a running wait with the explain request from the page', async () => {
    const child = spawn(process.execPath, [BIN, 'wait', 'cli-test'], { env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await new Promise((r) => setTimeout(r, 400));
    await page('cli-test', 'explain', { qid: 'q1', text: 'why?' });
    const code = await new Promise((r) => child.on('exit', r));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual([expect.objectContaining({ type: 'explain', data: { qid: 'q1', title: 'Yes?', text: 'why?' } })]);
  });

  it('keeps waiting through a server restart', async () => {
    const child = spawn(process.execPath, [BIN, 'wait', 'cli-test'], { env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await new Promise((r) => setTimeout(r, 400));
    run(['stop']);
    await new Promise((r) => setTimeout(r, 2500));
    await page('cli-test', 'explain', { qid: 'q1', text: 'again' });
    const code = await new Promise((r) => child.on('exit', r));
    expect(code).toBe(0);
    expect(JSON.parse(out)[0].data.text).toBe('again');
  }, 20_000);

  it('adds an explanation and shows it in status', () => {
    runJson(['explain', 'cli-test', 'q1', '--html', '<p>Because.</p>']);
    const s = runJson(['status', 'cli-test']);
    expect(s.questions[0]).toMatchObject({ id: 'q1', explanations: 1, explaining: false });
  });

  it('blocks the Claude Code stop hook only while a session board has no listener', async () => {
    const block = run(['hook-stop'], JSON.stringify({ session_id: 'sess-1' }));
    expect(JSON.parse(block.stdout)).toMatchObject({ decision: 'block' });
    expect(block.stdout).toMatch(/cli-test/);
    expect(run(['hook-stop'], JSON.stringify({ session_id: 'other' })).stdout).toBe('');
    await page('cli-test', 'done', {});
    await page('cli-test2', 'done', {});
    expect(run(['hook-stop'], JSON.stringify({ session_id: 'sess-1' })).stdout).toBe('');
  });

  it('lets Claude stop when the stop hook already fired once', () => {
    runJson(['open', 'hooky', '--file', '-'], boardJson);
    expect(run(['hook-stop'], JSON.stringify({ session_id: 'sess-1', stop_hook_active: true })).stdout).toBe('');
    runJson(['close', 'hooky']);
    expect(run(['hook-stop'], JSON.stringify({ session_id: 'sess-1' })).stdout).toBe('');
  });

  it('stop does not kill a process that is not our server', async () => {
    run(['stop']);
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(home, 'server.pid'), String(other.pid));
    run(['stop']);
    await new Promise((r) => setTimeout(r, 200));
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    other.kill();
  });

  it('fails clearly when the port belongs to another program', async () => {
    run(['stop']);
    const foreign: Server = createServer((_, res) => res.end('hello')).listen(port, '127.0.0.1');
    await new Promise((r) => foreign.once('listening', r));
    try {
      const r = run(['list']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`Port ${port} is in use by another program; set "port" in ${join(home, 'config.json')}`);
      const w = run(['wait', 'cli-test']);
      expect(w.status).toBe(2);
    } finally {
      foreign.close();
    }
  });
});
