import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';
import {
  BOARD_ID,
  hasValue,
  questionStatus,
  validateBoardInput,
  validatePatch,
  type AnswerValue,
  type Board,
  type BoardEvent,
  type EventType,
  type QState,
  type Question,
} from './model.js';

export interface CreateOptions {
  projectDir?: string;
  sessionId?: string;
  replace?: boolean;
}

const emptyState = (): QState => ({ skipped: false, withdrawn: false, changed: false, explaining: false, explanations: [] });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every Board on disk, cached in memory. One instance per server process. */
export class BoardStore {
  private cache = new Map<string, Board>();

  constructor(private readonly onChange: (id: string) => void = () => {}) {}

  create(id: string, raw: unknown, opts: CreateOptions = {}): Board {
    if (!BOARD_ID.test(id)) throw new Error(`board id "${id}" must be lowercase letters, digits and "-" (max 63)`);
    const input = validateBoardInput(raw);
    if (this.exists(id) && !opts.replace) throw new Error(`board "${id}" already exists; use push to change it, or replace to start over`);
    rmSync(paths().boardDir(id), { recursive: true, force: true });
    const board: Board = {
      id,
      title: input.title,
      intro: input.intro,
      layout: input.layout ?? { type: 'list' },
      questions: input.questions,
      qstate: Object.fromEntries(input.questions.map((q) => [q.id, emptyState()])),
      drafts: {},
      sent: {},
      forceSend: [],
      done: false,
      createdAt: new Date().toISOString(),
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      rev: 1,
      nextSeq: 1,
      readCursor: 0,
    };
    this.save(board);
    return board;
  }

  exists(id: string): boolean {
    return this.cache.has(id) || existsSync(join(paths().boardDir(id), 'board.json'));
  }

  get(id: string): Board {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const file = join(paths().boardDir(id), 'board.json');
    if (!existsSync(file)) throw new Error(`board "${id}" not found`);
    const board = JSON.parse(readFileSync(file, 'utf8')) as Board;
    this.cache.set(id, board);
    return board;
  }

  list(): Board[] {
    const dir = paths().boards;
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((id) => existsSync(join(dir, id, 'board.json')))
      .map((id) => this.get(id));
  }

  remove(id: string): void {
    this.get(id);
    this.cache.delete(id);
    rmSync(paths().boardDir(id), { recursive: true, force: true });
    this.onChange(id);
  }

  /** Agent update: upserts Questions and replaces title, intro or Layout. */
  push(id: string, raw: unknown): Board {
    const patch = validatePatch(raw);
    const board = this.get(id);
    if (patch.title !== undefined) board.title = patch.title;
    if (patch.intro !== undefined) board.intro = patch.intro;
    if (patch.layout !== undefined) board.layout = patch.layout;
    for (const q of patch.questions ?? []) this.upsert(board, q);
    board.done = false;
    return this.commit(board);
  }

  private upsert(board: Board, q: Question): void {
    const i = board.questions.findIndex((x) => x.id === q.id);
    if (i === -1) {
      board.questions.push(q);
      board.qstate[q.id] = emptyState();
      return;
    }
    const answered = hasValue(board.drafts[q.id]) || board.sent[q.id] !== undefined;
    if (answered && !same(board.questions[i], q)) board.qstate[q.id].changed = true;
    board.questions[i] = q;
  }

  explain(id: string, qid: string, html: string): Board {
    const board = this.get(id);
    const s = this.state(board, qid);
    s.explanations.push({ at: new Date().toISOString(), html, ...(s.pendingQuestion ? { question: s.pendingQuestion } : {}) });
    s.explaining = false;
    delete s.pendingQuestion;
    board.done = false;
    return this.commit(board);
  }

  withdraw(id: string, qid: string, reason: string): Board {
    const board = this.get(id);
    const s = this.state(board, qid);
    s.withdrawn = true;
    s.withdrawReason = reason;
    return this.commit(board);
  }

  /** Person typing or choosing: saved, not sent. */
  saveDraft(id: string, qid: string, answer: AnswerValue): Board {
    const board = this.get(id);
    const s = this.state(board, qid);
    board.drafts[qid] = answer.note ? { value: answer.value, note: answer.note } : { value: answer.value };
    if (hasValue(board.drafts[qid])) s.skipped = false;
    return this.commit(board);
  }

  skip(id: string, qid: string, skipped: boolean): Board {
    const board = this.get(id);
    this.state(board, qid).skipped = skipped;
    return this.commit(board);
  }

  /** Person accepts a Changed question's Answer as it stands; it goes out on the next send. */
  confirm(id: string, qid: string): Board {
    const board = this.get(id);
    this.state(board, qid).changed = false;
    if (!board.forceSend.includes(qid)) board.forceSend.push(qid);
    return this.commit(board);
  }

  requestExplain(id: string, qid: string, text: string): BoardEvent {
    const board = this.get(id);
    const s = this.state(board, qid);
    s.explaining = true;
    if (text.trim()) s.pendingQuestion = text.trim();
    else delete s.pendingQuestion;
    const event = this.event(board, 'explain', { qid, title: this.question(board, qid).title, text: text.trim() });
    this.commit(board);
    return event;
  }

  /** Unsent Answers: drafts that differ from what was last sent, plus confirmed Changed questions. */
  unsent(board: Board): string[] {
    return board.questions
      .map((q) => q.id)
      .filter((qid) => {
        const d = board.drafts[qid];
        if (board.forceSend.includes(qid)) return true;
        if (d === undefined) return false;
        return !same(d, board.sent[qid]);
      });
  }

  send(id: string): BoardEvent | null {
    const board = this.get(id);
    const qids = this.unsent(board);
    if (qids.length === 0) return null;
    const answers = qids.map((qid) => {
      const d = board.drafts[qid] ?? { value: null };
      board.sent[qid] = d;
      board.qstate[qid].changed = false;
      return { qid, title: this.question(board, qid).title, value: d.value, ...(d.note ? { note: d.note } : {}) };
    });
    board.forceSend = [];
    const event = this.event(board, 'answers', { answers });
    this.commit(board);
    return event;
  }

  done(id: string): BoardEvent {
    this.send(id);
    const board = this.get(id);
    const summary = { answered: [] as string[], skipped: [] as string[], unanswered: [] as string[] };
    for (const q of board.questions) {
      const status = questionStatus(board, q.id);
      if (status === 'answered') summary.answered.push(q.id);
      else if (status === 'skipped') summary.skipped.push(q.id);
      else if (status === 'open') summary.unanswered.push(q.id);
    }
    board.done = true;
    const event = this.event(board, 'done', summary);
    this.commit(board);
    return event;
  }

  reopen(id: string): BoardEvent {
    const board = this.get(id);
    board.done = false;
    const event = this.event(board, 'reopened', {});
    this.commit(board);
    return event;
  }

  /** Events after the read cursor. With `advance`, they count as delivered. */
  readEvents(id: string, advance = true): BoardEvent[] {
    const board = this.get(id);
    const file = join(paths().boardDir(id), 'events.jsonl');
    if (!existsSync(file)) return [];
    const events = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as BoardEvent)
      .filter((e) => e.seq > board.readCursor);
    if (advance && events.length) {
      board.readCursor = events[events.length - 1].seq;
      this.persist(board);
    }
    return events;
  }

  private question(board: Board, qid: string): Question {
    const q = board.questions.find((x) => x.id === qid);
    if (!q) throw new Error(`question "${qid}" not found on board "${board.id}"`);
    return q;
  }

  private state(board: Board, qid: string): QState {
    this.question(board, qid);
    return (board.qstate[qid] ??= emptyState());
  }

  private event(board: Board, type: EventType, data: unknown): BoardEvent {
    const event: BoardEvent = { seq: board.nextSeq++, at: new Date().toISOString(), type, data };
    mkdirSync(paths().boardDir(board.id), { recursive: true });
    appendFileSync(join(paths().boardDir(board.id), 'events.jsonl'), JSON.stringify(event) + '\n');
    return event;
  }

  private commit(board: Board): Board {
    board.rev++;
    this.save(board);
    return board;
  }

  private save(board: Board): void {
    this.persist(board);
    this.onChange(board.id);
  }

  private persist(board: Board): void {
    this.cache.set(board.id, board);
    const dir = paths().boardDir(board.id);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, 'board.json.tmp');
    writeFileSync(tmp, JSON.stringify(board, null, 2));
    renameSync(tmp, join(dir, 'board.json'));
  }
}
