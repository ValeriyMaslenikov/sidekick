import { describe, expect, it, beforeEach } from 'vitest';
import { freshHome } from './helpers.js';
import { BoardStore } from '../src/punch-list/store.js';
import { questionStatus } from '../src/punch-list/model.js';

const input = () => ({
  title: 'Fix the dev errors',
  questions: [
    { id: 'rows', title: 'Delete the dead rows?', type: 'yes-no' },
    { id: 'flip', title: 'What to do with flip?', type: 'single', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { id: 'notes', title: 'Anything else?', type: 'text', optional: true },
  ],
});

const opts = { projectDir: '/tmp/proj', sessionId: 's1' };

describe('BoardStore', () => {
  let store: BoardStore;
  beforeEach(() => { freshHome(); store = new BoardStore(); });

  it('round-trips a created board, also from disk', () => {
    store.create('errors', input(), opts);
    expect(store.get('errors').title).toBe('Fix the dev errors');
    expect(new BoardStore().get('errors').questions.map((q) => q.id)).toEqual(['rows', 'flip', 'notes']);
  });

  it('refuses to create over an existing board unless replace is set', () => {
    store.create('errors', input(), opts);
    expect(() => store.create('errors', input(), opts)).toThrow(/already exists/);
    store.saveDraft('errors', 'rows', { value: 'yes' });
    store.create('errors', input(), { ...opts, replace: true });
    expect(store.get('errors').drafts).toEqual({});
  });

  it('rejects a duplicate question id, naming the field, and leaves the board unchanged', () => {
    const bad = input();
    bad.questions[1].id = 'rows';
    expect(() => store.create('errors', bad, opts)).toThrow(/questions\[1\]\.id/);
    store.create('errors', input(), opts);
    expect(() => store.push('errors', { questions: [{ id: 'x', title: 'X', type: 'nope' }] })).toThrow(/questions\[0\]\.type/);
    expect(store.get('errors').questions).toHaveLength(3);
  });

  it('rejects a bad board id', () => {
    expect(() => store.create('Bad Id!', input(), opts)).toThrow(/board id/);
  });

  it('flags an answered question as changed only when its content differs', () => {
    store.create('errors', input(), opts);
    store.saveDraft('errors', 'flip', { value: 'a' });
    store.push('errors', { questions: [input().questions[1]] });
    expect(store.get('errors').qstate.flip.changed).toBe(false);
    store.push('errors', { questions: [{ ...input().questions[1], title: 'What now with flip?' }] });
    expect(store.get('errors').qstate.flip.changed).toBe(true);
    expect(store.get('errors').drafts.flip).toEqual({ value: 'a' });
  });

  it('sends only answers that changed since the last send', () => {
    store.create('errors', input(), opts);
    store.saveDraft('errors', 'rows', { value: 'yes' });
    store.saveDraft('errors', 'flip', { value: 'b', note: 'cheapest' });
    const first = store.send('errors');
    expect(first?.data).toEqual({ answers: [
      { qid: 'rows', title: 'Delete the dead rows?', value: 'yes' },
      { qid: 'flip', title: 'What to do with flip?', value: 'b', note: 'cheapest' },
    ] });
    expect(store.send('errors')).toBeNull();
    store.saveDraft('errors', 'rows', { value: 'no' });
    expect(store.send('errors')?.data).toEqual({ answers: [{ qid: 'rows', title: 'Delete the dead rows?', value: 'no' }] });
  });

  it('records an explain request and clears it when the agent explains', () => {
    store.create('errors', input(), opts);
    store.requestExplain('errors', 'flip', 'what is flip?');
    expect(store.get('errors').qstate.flip.explaining).toBe(true);
    store.explain('errors', 'flip', '<p>Flip is a coin game.</p>');
    const q = store.get('errors').qstate.flip;
    expect(q.explaining).toBe(false);
    expect(q.explanations).toEqual([expect.objectContaining({ html: '<p>Flip is a coin game.</p>', question: 'what is flip?' })]);
  });

  it('summarises answered, skipped and unanswered questions on done', () => {
    store.create('errors', input(), opts);
    store.saveDraft('errors', 'rows', { value: 'yes' });
    store.skip('errors', 'flip', true);
    store.done('errors');
    const events = store.readEvents('errors');
    expect(events.map((e) => e.type)).toEqual(['answers', 'done']);
    expect(events[1].data).toEqual({ answered: ['rows'], skipped: ['flip'], unanswered: ['notes'] });
    expect(store.get('errors').done).toBe(true);
    expect(questionStatus(store.get('errors'), 'flip')).toBe('skipped');
  });

  it('advances the read cursor so events are delivered once', () => {
    store.create('errors', input(), opts);
    store.requestExplain('errors', 'rows', '');
    expect(store.readEvents('errors')).toHaveLength(1);
    expect(store.readEvents('errors')).toHaveLength(0);
    store.requestExplain('errors', 'flip', '');
    expect(new BoardStore().readEvents('errors', false).map((e) => e.data)).toEqual([{ qid: 'flip', title: 'What to do with flip?', text: '' }]);
  });

  it('reopens a done board when the agent pushes a follow-up', () => {
    store.create('errors', input(), opts);
    store.done('errors');
    store.push('errors', { questions: [{ id: 'more', title: 'One more?', type: 'yes-no' }] });
    expect(store.get('errors').done).toBe(false);
  });

  it('keeps a withdrawn question with its reason and leaves it out of the done summary', () => {
    store.create('errors', input(), opts);
    store.withdraw('errors', 'notes', 'not needed');
    store.done('errors');
    const b = store.get('errors');
    expect(b.qstate.notes).toMatchObject({ withdrawn: true, withdrawReason: 'not needed' });
    expect(store.readEvents('errors').at(-1)?.data).toEqual({ answered: [], skipped: [], unanswered: ['rows', 'flip'] });
  });

  it('lists and removes boards', () => {
    store.create('a-board', input(), opts);
    store.create('b-board', input(), opts);
    expect(store.list().map((b) => b.id).sort()).toEqual(['a-board', 'b-board']);
    store.remove('a-board');
    expect(store.list().map((b) => b.id)).toEqual(['b-board']);
    expect(() => store.get('a-board')).toThrow(/not found/);
  });

  it('reopens a done board when the person changes an answer', () => {
    store.create('errors', input(), opts);
    store.done('errors');
    store.readEvents('errors');
    store.saveDraft('errors', 'rows', { value: 'no' });
    expect(store.get('errors').done).toBe(false);
    expect(store.readEvents('errors').map((e) => e.type)).toEqual(['reopened']);
  });

  it('requires at least one question', () => {
    expect(() => store.create('errors', { title: 'Empty', questions: [] }, opts)).toThrow(/questions: needs at least one/);
  });

  it('treats an identical re-push with keys in another order as unchanged', () => {
    store.create('errors', input(), opts);
    store.saveDraft('errors', 'flip', { value: 'a' });
    store.push('errors', { questions: [{ options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], type: 'single', title: 'What to do with flip?', id: 'flip' }] });
    expect(store.get('errors').qstate.flip.changed).toBe(false);
  });

  it('refuses ids outside the boards directory on every lookup', () => {
    expect(() => store.get('../x')).toThrow(/board id/);
    expect(store.exists('../x')).toBe(false);
  });

  it('uses the focus layout by default and accepts it explicitly', () => {
    store.create('errors', input(), opts);
    expect(store.get('errors').layout).toEqual({ type: 'focus' });
    store.push('errors', { layout: { type: 'list' } });
    store.push('errors', { layout: { type: 'focus' } });
    expect(store.get('errors').layout.type).toBe('focus');
  });

  it('counts a note with no option picked as the person\'s own answer', () => {
    store.create('errors', input(), opts);
    store.saveDraft('errors', 'flip', { value: null, note: 'Neither: scale it to zero' });
    expect(questionStatus(store.get('errors'), 'flip')).toBe('answered');
    expect(store.send('errors')?.data).toEqual({ answers: [
      { qid: 'flip', title: 'What to do with flip?', value: null, ownAnswer: 'Neither: scale it to zero' },
    ] });
    store.done('errors');
    expect(store.readEvents('errors').at(-1)?.data).toMatchObject({ answered: ['flip'] });
  });

  it('keeps a note as a note once an option is picked', () => {
    store.create('errors', input(), opts);
    store.saveDraft('errors', 'flip', { value: 'a', note: 'cheapest' });
    expect(store.send('errors')?.data).toEqual({ answers: [{ qid: 'flip', title: 'What to do with flip?', value: 'a', note: 'cheapest' }] });
  });
});

