import { describe, expect, it, beforeEach } from 'vitest';
import { freshHome } from './helpers.js';
import { createApp } from '../src/punch-list/server.js';

const TOKEN = 'a'.repeat(32);
const board = {
  title: 'Errors',
  questions: [
    { id: 'rows', title: 'Delete the rows?', type: 'yes-no' },
    { id: 'flip', title: 'Flip?', type: 'single', options: [{ value: 'a', label: 'A' }] },
  ],
};

describe('server', () => {
  let clock: number;
  let ctx: ReturnType<typeof createApp>;
  const agent = (path: string, init: RequestInit = {}) =>
    ctx.app.request(path, { ...init, headers: { 'x-sidekick-token': TOKEN, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const post = (path: string, body: unknown) => agent(path, { method: 'POST', body: JSON.stringify(body) });

  beforeEach(async () => {
    freshHome();
    clock = 1_000_000;
    ctx = createApp({ token: TOKEN, now: () => clock });
    await post('/api/boards', { id: 'errors', input: board, projectDir: '/p', sessionId: 's1' });
  });

  it('rejects requests without the token', async () => {
    expect((await ctx.app.request('/api/boards')).status).toBe(401);
    expect((await ctx.app.request('/b/errors')).status).toBe(401);
    expect((await ctx.app.request('/b/errors?t=' + TOKEN)).status).toBe(200);
  });

  it('reports health without a token so the CLI can find it', async () => {
    expect(await (await ctx.app.request('/api/health')).json()).toMatchObject({ app: 'punch-list' });
  });

  it('returns no events immediately for a zero-timeout wait', async () => {
    expect(await (await agent('/api/boards/errors/wait?timeout=0')).json()).toEqual({ events: [] });
  });

  it('delivers a page explain request to the next wait', async () => {
    await post('/b/errors/explain', { qid: 'flip', text: 'what?' });
    const { events } = await (await agent('/api/boards/errors/wait?timeout=0')).json();
    expect(events).toEqual([expect.objectContaining({ type: 'explain', data: { qid: 'flip', title: 'Flip?', text: 'what?' } })]);
  });

  it('wakes a pending wait as soon as an event arrives', async () => {
    const pending = agent('/api/boards/errors/wait?timeout=20');
    await new Promise((r) => setTimeout(r, 20));
    await post('/b/errors/draft', { qid: 'rows', answer: { value: 'yes' } });
    await post('/b/errors/send', {});
    const { events } = await (await pending).json();
    expect(events[0]).toMatchObject({ type: 'answers' });
  });

  it('counts a listener while a wait is open and for 10 seconds after', async () => {
    expect(ctx.isListening('errors')).toBe(false);
    const pending = agent('/api/boards/errors/wait?timeout=20');
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.isListening('errors')).toBe(true);
    await post('/b/errors/explain', { qid: 'rows', text: '' });
    await pending;
    clock += 9_000;
    expect(ctx.isListening('errors')).toBe(true);
    clock += 2_000;
    expect(ctx.isListening('errors')).toBe(false);
  });

  it('lists boards of a session that are not done and have no listener', async () => {
    await post('/api/boards', { id: 'other', input: board, projectDir: '/p', sessionId: 's2' });
    const res = await (await agent('/api/listening?session=s1')).json();
    expect(res.boards.map((b: { id: string }) => b.id)).toEqual(['errors']);
    await post('/b/errors/done', {});
    expect((await (await agent('/api/listening?session=s1')).json()).boards).toEqual([]);
  });

  it('saves a draft from the page without sending it', async () => {
    await post('/b/errors/draft', { qid: 'rows', answer: { value: 'yes', note: 'sure' } });
    const status = await (await agent('/api/boards/errors')).json();
    expect(status.board.drafts.rows).toEqual({ value: 'yes', note: 'sure' });
    expect(status.unsent).toEqual(['rows']);
    expect((await (await agent('/api/boards/errors/wait?timeout=0')).json()).events).toEqual([]);
  });

  it('returns a 400 naming the field for a bad push', async () => {
    const res = await post('/api/boards/errors/push', { questions: [{ id: 'x', title: 'X', type: 'nope' }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/questions\[0\]\.type/);
  });

  it('returns 409 when opening a board that exists without replace', async () => {
    const res = await post('/api/boards', { id: 'errors', input: board });
    expect(res.status).toBe(409);
  });
});
