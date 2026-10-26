import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getToken, takeRetentionNotice } from './config.js';
import { paths } from './paths.js';
import { baseUrl, call, ensureServer, health, HttpError, PortTakenError } from './client.js';
import { startServer, resumePrompt } from './server.js';
import { BoardStore } from './store.js';
import { questionStatus, type Board, type BoardEvent } from './model.js';
import { VERSION } from './version.js';

const BIN = fileURLToPath(import.meta.url);

const USAGE = `punch-list ${VERSION}: put an agent's questions on a live local web page.

  open <board> --file <path|-> [--replace] [--no-open]   create a Board from JSON, print its URL
  push <board> --file <path|->                           add or update Questions, title, intro or Layout
  explain <board> <question> (--html <html> | --file <path|->)   add an Explanation to a Question
  withdraw <board> <question> --reason <text>           grey out a Question that is no longer needed
  close <board>                                          mark the Board done from the agent side
  wait <board> [--timeout <seconds>]                     block until Events arrive, print them as JSON
  status <board>                                         full snapshot: Questions, Answers, pending Events
  url <board> | list | rm <board> | stop

Board format: see reference/board-format.md next to this skill's SKILL.md.`;

interface Args {
  _: string[];
  flags: Record<string, string | true>;
}

function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

function readSource(file: string | true | undefined, what: string): string {
  if (typeof file !== 'string') throw new Error(`${what} needs --file <path> (or --file - for stdin)`);
  return file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
}

function readJson(file: string | true | undefined, what: string): unknown {
  const text = readSource(file, what);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${what}: the file is not valid JSON (${(err as Error).message})`);
  }
}

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing <${name}>\n\n${USAGE}`);
  return value;
}

const enc = encodeURIComponent;
const print = (x: unknown): void => {
  process.stdout.write(JSON.stringify(x, null, 2) + "\n");
};
const boardUrl = (id: string) => `${baseUrl()}/b/${encodeURIComponent(id)}?t=${getToken()}`;

function openBrowser(url: string): void {
  if (process.env.PUNCH_LIST_NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // The URL is printed anyway.
  }
}

/** The agent-facing view of a Board. */
function snapshot(board: Board, listening: boolean, pending: BoardEvent[]) {
  return {
    id: board.id,
    title: board.title,
    url: boardUrl(board.id),
    done: board.done,
    listening,
    layout: board.layout.type,
    questions: board.questions.map((q) => {
      const s = board.qstate[q.id];
      return {
        id: q.id,
        title: q.title,
        type: q.type,
        status: questionStatus(board, q.id),
        ...(board.drafts[q.id] ? { answer: board.drafts[q.id] } : {}),
        sentToAgent: board.sent[q.id] !== undefined,
        changed: s.changed,
        explaining: s.explaining,
        ...(s.pendingQuestion ? { pendingQuestion: s.pendingQuestion } : {}),
        explanations: s.explanations.length,
        ...(s.withdrawn ? { withdrawn: s.withdrawReason || true } : {}),
      };
    }),
    pendingEvents: pending,
  };
}

async function waitCmd(id: string, timeoutFlag: string | true | undefined): Promise<void> {
  const total = typeof timeoutFlag === 'string' ? Number(timeoutFlag) : Infinity;
  if (Number.isNaN(total) || total < 0) throw new Error('--timeout must be a number of seconds');
  const deadline = Date.now() + total * 1000;
  for (;;) {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const slice = Math.min(25, left);
    try {
      const { events } = await call<{ events: BoardEvent[] }>('GET', `/api/boards/${encodeURIComponent(id)}/wait?timeout=${slice}`);
      if (events.length || Date.now() >= deadline) return print(events);
    } catch (err) {
      // Errors the server answered with (unknown board, bad token) won't fix themselves.
      if (err instanceof HttpError) throw err;
      // The server went away: bring it back and keep waiting. A foreign program on the port ends the wait.
      await new Promise((r) => setTimeout(r, 500));
      await ensureServer(BIN).catch((e) => {
        if (e instanceof PortTakenError) throw e;
      });
      if (Date.now() >= deadline) return print([]);
    }
  }
}

/** Claude Code Stop hook: keep Claude from ending its turn while one of its Boards has no Listener. */
async function hookStop(): Promise<void> {
  let input: { session_id?: string; cwd?: string; stop_hook_active?: boolean } = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  // Claude is already continuing because of this hook once: let it stop rather than loop.
  if (!input.session_id || input.stop_hook_active) return;
  let boards: { id: string; title: string; resumePrompt: string }[];
  try {
    ({ boards } = await call<{ boards: typeof boards }>('GET', `/api/listening?session=${encodeURIComponent(input.session_id)}`));
  } catch {
    // Server down: nothing can be listening, so every open Board of this session needs a Listener.
    boards = new BoardStore()
      .list()
      .filter((b) => !b.done && b.sessionId === input.session_id)
      .map((b) => ({ id: b.id, title: b.title, resumePrompt: resumePrompt(b.id) }));
  }
  if (!boards.length) return;
  const list = boards.map((b) => `"${b.id}" (${b.title})`).join(', ');
  print({
    decision: 'block',
    reason: `punch-list board ${list} is open and nobody is listening. Run \`node ${process.argv[1]} wait <board>\` in the background (run_in_background) before ending your turn. If the person no longer needs the board, run \`node ${process.argv[1]} close <board>\`.`,
  });
}

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const [cmd, a1, a2] = args._;
  const f = args.flags;
  try {
    switch (cmd) {
      case 'serve': {
        process.on('uncaughtException', (err) => console.error(`punch-list: uncaught error: ${err.stack ?? err}`));
        process.on('unhandledRejection', (err) => console.error(`punch-list: unhandled rejection: ${err}`));
        const { port } = await startServer();
        writeFileSync(`${paths().home}/server.pid`, String(process.pid));
        console.log(`punch-list ${VERSION} listening on http://127.0.0.1:${port}`);
        return new Promise<number>(() => {});
      }
      case 'hook-stop':
        await hookStop();
        return 0;
      case 'stop': {
        // Only signal the pid our own server reports, never a stale pid file's.
        if ((await health()) === 'ours') {
          const { pid } = await call<{ pid: number }>('GET', '/api/health');
          try {
            process.kill(pid);
          } catch {
            // Already gone.
          }
        }
        rmSync(`${paths().home}/server.pid`, { force: true });
        print({ stopped: true });
        return 0;
      }
      case undefined:
      case 'help':
      case '--help':
        console.log(USAGE);
        return 0;
    }

    await ensureServer(BIN);
    switch (cmd) {
      case 'open': {
        const id = need(a1, 'board');
        const input = readJson(f.file, 'open');
        await call('POST', '/api/boards', { id, input, replace: f.replace === true, projectDir: process.cwd(), sessionId: process.env.CLAUDE_CODE_SESSION_ID });
        const url = boardUrl(id);
        if (f['no-open'] !== true) openBrowser(url);
        const notice = takeRetentionNotice();
        print({
          url,
          ...(notice ? { notice: `Tell the person: ${notice}` } : {}),
          next: `Give the person the url, then run \`punch-list wait ${id}\` in the background and handle each batch of Events.`,
        });
        return 0;
      }
      case 'close':
        await call('POST', `/api/boards/${enc(need(a1, 'board'))}/close`, {});
        print({ closed: a1 });
        return 0;
      case 'push':
        await call('POST', `/api/boards/${enc(need(a1, 'board'))}/push`, readJson(f.file, 'push'));
        print({ ok: true });
        return 0;
      case 'explain': {
        const html = typeof f.html === 'string' ? f.html : readSource(f.file, 'explain');
        await call('POST', `/api/boards/${enc(need(a1, 'board'))}/explain`, { qid: need(a2, 'question'), html });
        print({ ok: true });
        return 0;
      }
      case 'withdraw':
        await call('POST', `/api/boards/${enc(need(a1, 'board'))}/withdraw`, { qid: need(a2, 'question'), reason: typeof f.reason === 'string' ? f.reason : '' });
        print({ ok: true });
        return 0;
      case 'wait':
        await waitCmd(need(a1, 'board'), f.timeout);
        return 0;
      case 'status': {
        const id = need(a1, 'board');
        const r = await call<{ board: Board; listening: boolean; pending: BoardEvent[] }>('GET', `/api/boards/${enc(id)}`);
        print(snapshot(r.board, r.listening, r.pending));
        return 0;
      }
      case 'url':
        print({ url: boardUrl(need(a1, 'board')) });
        return 0;
      case 'list': {
        const r = await call<{ boards: unknown[] }>('GET', '/api/boards');
        print({ index: `${baseUrl()}/?t=${getToken()}`, boards: r.boards });
        return 0;
      }
      case 'rm':
        await call('DELETE', `/api/boards/${enc(need(a1, 'board'))}`);
        print({ removed: a1 });
        return 0;
      default:
        throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
    }
  } catch (err) {
    process.stderr.write(`punch-list: ${(err as Error).message}\n`);
    return err instanceof PortTakenError ? 2 : 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
