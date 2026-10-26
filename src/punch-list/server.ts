import { EventEmitter } from 'node:events';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { BoardStore } from './store.js';
import { questionStatus, type Board, type BoardEvent } from './model.js';
import { getToken, loadConfig } from './config.js';
import { cleanupBoards } from './retention.js';
import { VERSION } from './version.js';
import indexHtml from './page/index.html?raw';
import boardHtml from './page/board.html?raw';
import appJs from './page/app.js?raw';
import stylesCss from './page/styles.css?raw';

export const LISTENER_GRACE_MS = 10_000;
const MAX_WAIT_S = 25;
const EVENT_SETTLE_MS = 150;

export interface AppOptions {
  token: string;
  now?: () => number;
}

interface ListenerState {
  open: number;
  lastSeen: number;
}

export function resumePrompt(id: string): string {
  return `Use the punch-list skill to resume board "${id}": run its \`status ${id}\` command, handle anything pending, then run \`wait ${id}\` in the background.`;
}

export function createApp({ token, now = Date.now }: AppOptions) {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const store = new BoardStore((id) => bus.emit('change', id));
  const listeners = new Map<string, ListenerState>();

  const isListening = (id: string): boolean => {
    const l = listeners.get(id);
    if (!l) return false;
    return l.open > 0 || now() - l.lastSeen < LISTENER_GRACE_MS;
  };

  const touchListener = (id: string, delta: number) => {
    const l = listeners.get(id) ?? { open: 0, lastSeen: 0 };
    l.open = Math.max(0, l.open + delta);
    l.lastSeen = now();
    listeners.set(id, l);
    bus.emit('change', id);
    // Tell open pages when the grace period runs out.
    if (l.open === 0) setTimeout(() => bus.emit('change', id), LISTENER_GRACE_MS + 50).unref?.();
  };

  /** What the page needs to render a Board. */
  const view = (board: Board) => ({
    id: board.id,
    title: board.title,
    intro: board.intro,
    layout: board.layout,
    rev: board.rev,
    done: board.done,
    questions: board.questions.map((q) => ({ ...q, state: board.qstate[q.id], status: questionStatus(board, q.id) })),
    drafts: board.drafts,
    sent: board.sent,
    unsent: store.unsent(board),
    listening: isListening(board.id),
    resumePrompt: resumePrompt(board.id),
  });

  const app = new Hono();

  const hasToken = (c: Context) => c.req.header('x-sidekick-token') === token || c.req.query('t') === token;

  app.get('/api/health', (c) => c.json({ app: 'punch-list', version: VERSION }));
  app.get('/favicon.ico', (c) => c.body(null, 204));
  app.get('/assets/app.js', (c) => c.body(appJs, 200, { 'content-type': 'text/javascript; charset=utf-8' }));
  app.get('/assets/styles.css', (c) => c.body(stylesCss, 200, { 'content-type': 'text/css; charset=utf-8' }));

  app.use('*', async (c, next) => {
    if (!hasToken(c)) return c.json({ error: 'missing or wrong token' }, 401);
    await next();
  });

  app.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /not found/.test(msg) ? 404 : /already exists/.test(msg) ? 409 : 400;
    return c.json({ error: msg }, status);
  });

  // ---- Agent API ----

  app.post('/api/boards', async (c) => {
    const { id, input, replace, projectDir, sessionId } = await c.req.json();
    const board = store.create(id, input, { replace, projectDir, sessionId });
    return c.json({ id: board.id });
  });

  app.get('/api/boards', (c) =>
    c.json({ boards: store.list().map((b) => ({ id: b.id, title: b.title, done: b.done, createdAt: b.createdAt, listening: isListening(b.id), projectDir: b.projectDir })) }),
  );

  app.get('/api/boards/:id', (c) => {
    const board = store.get(c.req.param('id'));
    return c.json({ board, unsent: store.unsent(board), listening: isListening(board.id), pending: store.readEvents(board.id, false) });
  });

  app.delete('/api/boards/:id', (c) => {
    store.remove(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/boards/:id/push', async (c) => {
    store.push(c.req.param('id'), await c.req.json());
    return c.json({ ok: true });
  });

  app.post('/api/boards/:id/explain', async (c) => {
    const { qid, html } = await c.req.json();
    store.explain(c.req.param('id'), qid, html);
    return c.json({ ok: true });
  });

  app.post('/api/boards/:id/withdraw', async (c) => {
    const { qid, reason } = await c.req.json();
    store.withdraw(c.req.param('id'), qid, reason ?? '');
    return c.json({ ok: true });
  });

  app.get('/api/boards/:id/wait', async (c) => {
    const id = c.req.param('id');
    store.get(id);
    const timeoutS = Math.min(MAX_WAIT_S, Math.max(0, Number(c.req.query('timeout') ?? MAX_WAIT_S)));
    touchListener(id, +1);
    try {
      let events = store.readEvents(id);
      if (events.length === 0 && timeoutS > 0) {
        events = await new Promise<BoardEvent[]>((resolve) => {
          const done = (result: BoardEvent[]) => {
            clearTimeout(timer);
            clearTimeout(settling);
            bus.off('change', onChange);
            resolve(result);
          };
          let settling: NodeJS.Timeout | undefined;
          const onChange = (changed: string) => {
            if (changed !== id || settling) return;
            // Let events written in the same burst (Done = answers + done) arrive together.
            settling = setTimeout(() => {
              settling = undefined;
              const fresh = store.readEvents(id);
              if (fresh.length) done(fresh);
            }, EVENT_SETTLE_MS);
          };
          const timer = setTimeout(() => done([]), timeoutS * 1000);
          bus.on('change', onChange);
        });
      }
      return c.json({ events });
    } finally {
      touchListener(id, -1);
    }
  });

  app.get('/api/listening', (c) => {
    const session = c.req.query('session');
    const cwd = c.req.query('cwd');
    const boards = store
      .list()
      .filter((b) => !b.done && !isListening(b.id))
      .filter((b) => (session ? b.sessionId === session : cwd ? b.projectDir === cwd : true))
      .map((b) => ({ id: b.id, title: b.title, resumePrompt: resumePrompt(b.id) }));
    return c.json({ boards });
  });

  // ---- Page ----

  app.get('/', (c) => c.html(indexHtml));
  app.get('/b/:id', (c) => {
    store.get(c.req.param('id'));
    return c.html(boardHtml);
  });

  app.get('/b/:id/stream', (c) => {
    const id = c.req.param('id');
    store.get(id);
    return streamSSE(c, async (stream) => {
      let closed = false;
      const send = async () => {
        if (closed || !store.exists(id)) return;
        await stream.writeSSE({ event: 'state', data: JSON.stringify(view(store.get(id))) });
      };
      const onChange = (changed: string) => {
        if (changed === id) void send();
      };
      bus.on('change', onChange);
      stream.onAbort(() => {
        closed = true;
        bus.off('change', onChange);
      });
      await send();
      while (!closed) {
        await stream.sleep(15_000);
        if (!closed) await stream.writeSSE({ event: 'ping', data: '' });
      }
    });
  });

  app.get('/api/index', (c) =>
    c.json({ boards: store.list().map((b) => ({ id: b.id, title: b.title, done: b.done, createdAt: b.createdAt, listening: isListening(b.id), open: b.questions.filter((q) => questionStatus(b, q.id) === 'open').length })) }),
  );

  app.post('/b/:id/draft', async (c) => {
    const { qid, answer } = await c.req.json();
    store.saveDraft(c.req.param('id'), qid, answer);
    return c.json({ ok: true });
  });
  app.post('/b/:id/skip', async (c) => {
    const { qid, skipped } = await c.req.json();
    store.skip(c.req.param('id'), qid, skipped !== false);
    return c.json({ ok: true });
  });
  app.post('/b/:id/confirm', async (c) => {
    const { qid } = await c.req.json();
    store.confirm(c.req.param('id'), qid);
    return c.json({ ok: true });
  });
  app.post('/b/:id/explain', async (c) => {
    const { qid, text } = await c.req.json();
    store.requestExplain(c.req.param('id'), qid, text ?? '');
    return c.json({ ok: true });
  });
  app.post('/b/:id/send', (c) => c.json({ sent: store.send(c.req.param('id')) !== null }));
  app.post('/b/:id/done', (c) => {
    store.done(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/b/:id/reopen', (c) => {
    store.reopen(c.req.param('id'));
    return c.json({ ok: true });
  });

  return { app, store, isListening };
}

/** Runs the server in this process until it is killed. */
export async function startServer(): Promise<{ port: number }> {
  const { port } = loadConfig();
  cleanupBoards();
  const { app } = createApp({ token: getToken() });
  await new Promise<void>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve());
    server.on('error', reject);
  });
  return { port };
}
