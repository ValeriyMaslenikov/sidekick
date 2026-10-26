export const QUESTION_TYPES = ['yes-no', 'single', 'multi', 'text', 'number', 'scale', 'rank', 'custom'] as const;
export const LAYOUT_TYPES = ['list', 'tabs', 'wizard', 'columns', 'custom'] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type LayoutType = (typeof LAYOUT_TYPES)[number];

export interface Option {
  value: string;
  label: string;
  detail?: string;
  recommended?: boolean;
}

export interface Question {
  id: string;
  title: string;
  /** Free HTML shown under the title. */
  body?: string;
  type: QuestionType;
  options?: Option[];
  min?: number;
  max?: number;
  step?: number;
  /** Show this Question only when every listed Question's Answer matches (a value, or one of a list). */
  showIf?: Record<string, string | string[]>;
  optional?: boolean;
  /** Group id from `layout.groups`: a tab, a wizard step or a column. */
  group?: string;
}

export interface Layout {
  type: LayoutType;
  groups?: { id: string; title: string }[];
  /** Columns Layout: "status" makes one column per answer status instead of per group. */
  columnsBy?: "group" | "status";
  /** Custom Layout only: page HTML; Questions mount into `[data-pl-question="<id>"]`. */
  html?: string;
  /** Custom Layout only: script run after mounting, with `window.punchList` available. */
  script?: string;
}

export interface Explanation {
  at: string;
  html: string;
  /** The person's own question that prompted this Explanation, if they typed one. */
  question?: string;
}

export interface QState {
  skipped: boolean;
  withdrawn: boolean;
  withdrawReason?: string;
  changed: boolean;
  explaining: boolean;
  pendingQuestion?: string;
  explanations: Explanation[];
}

export interface AnswerValue {
  value: unknown;
  note?: string;
}

export type EventType = 'answers' | 'explain' | 'done' | 'reopened';

export interface BoardEvent {
  seq: number;
  at: string;
  type: EventType;
  data: unknown;
}

export interface BoardInput {
  title: string;
  intro?: string;
  layout?: Layout;
  questions: Question[];
}

export interface BoardPatch {
  title?: string;
  intro?: string;
  layout?: Layout;
  questions?: Question[];
}

export interface Board {
  id: string;
  title: string;
  intro?: string;
  layout: Layout;
  questions: Question[];
  qstate: Record<string, QState>;
  drafts: Record<string, AnswerValue>;
  sent: Record<string, AnswerValue>;
  /** Question ids whose Answer must go out on the next send even if unchanged (a confirmed Changed question). */
  forceSend: string[];
  done: boolean;
  createdAt: string;
  projectDir?: string;
  sessionId?: string;
  rev: number;
  nextSeq: number;
  readCursor: number;
}

export type QuestionStatus = 'open' | 'answered' | 'skipped' | 'withdrawn';

export const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NEEDS_OPTIONS: QuestionType[] = ['single', 'multi', 'rank'];

export function hasValue(a: AnswerValue | undefined): boolean {
  if (!a) return false;
  const v = a.value;
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function questionStatus(board: Board, qid: string): QuestionStatus {
  const s = board.qstate[qid];
  if (s?.withdrawn) return 'withdrawn';
  if (hasValue(board.drafts[qid])) return 'answered';
  if (s?.skipped) return 'skipped';
  return 'open';
}

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function validateQuestion(q: unknown, path: string): Question {
  if (!isRecord(q)) fail(path, 'must be an object');
  if (typeof q.id !== 'string' || !QUESTION_ID.test(q.id)) fail(`${path}.id`, 'must be 1-64 letters, digits, "_" or "-"');
  if (typeof q.title !== 'string' || !q.title.trim()) fail(`${path}.title`, 'must be a non-empty string');
  if (!QUESTION_TYPES.includes(q.type as QuestionType)) fail(`${path}.type`, `must be one of ${QUESTION_TYPES.join(', ')}`);
  if (q.body !== undefined && typeof q.body !== 'string') fail(`${path}.body`, 'must be an HTML string');
  if (NEEDS_OPTIONS.includes(q.type as QuestionType)) {
    if (!Array.isArray(q.options) || q.options.length === 0) fail(`${path}.options`, `is required for type "${q.type}"`);
  }
  if (q.options !== undefined) {
    if (!Array.isArray(q.options)) fail(`${path}.options`, 'must be an array');
    const seen = new Set<string>();
    q.options.forEach((o, i) => {
      if (!isRecord(o) || typeof o.value !== 'string' || typeof o.label !== 'string') {
        fail(`${path}.options[${i}]`, 'must have string "value" and "label"');
      }
      if (seen.has(o.value)) fail(`${path}.options[${i}].value`, `duplicate "${o.value}"`);
      seen.add(o.value);
    });
  }
  if (q.showIf !== undefined && !isRecord(q.showIf)) fail(`${path}.showIf`, 'must be an object of question id to value(s)');
  return q as unknown as Question;
}

export function validateLayout(l: unknown, path = 'layout'): Layout {
  if (!isRecord(l)) fail(path, 'must be an object');
  if (!LAYOUT_TYPES.includes(l.type as LayoutType)) fail(`${path}.type`, `must be one of ${LAYOUT_TYPES.join(', ')}`);
  if (l.groups !== undefined) {
    if (!Array.isArray(l.groups)) fail(`${path}.groups`, 'must be an array');
    l.groups.forEach((g, i) => {
      if (!isRecord(g) || typeof g.id !== 'string' || typeof g.title !== 'string') fail(`${path}.groups[${i}]`, 'must have string "id" and "title"');
    });
  }
  if (l.type === 'custom' && typeof l.html !== 'string') fail(`${path}.html`, 'is required for a custom layout');
  return l as unknown as Layout;
}

function validateQuestions(list: unknown, path = 'questions'): Question[] {
  if (!Array.isArray(list)) fail(path, 'must be an array');
  if (path === 'questions' && list.length === 0) fail(path, 'needs at least one question');
  const seen = new Set<string>();
  return list.map((q, i) => {
    const v = validateQuestion(q, `${path}[${i}]`);
    if (seen.has(v.id)) fail(`${path}[${i}].id`, `duplicate "${v.id}"`);
    seen.add(v.id);
    return v;
  });
}

export function validateBoardInput(x: unknown): BoardInput {
  if (!isRecord(x)) fail('board', 'must be an object');
  if (typeof x.title !== 'string' || !x.title.trim()) fail('title', 'must be a non-empty string');
  return {
    title: x.title,
    intro: typeof x.intro === 'string' ? x.intro : undefined,
    layout: x.layout === undefined ? undefined : validateLayout(x.layout),
    questions: validateQuestions(x.questions),
  };
}

export function validatePatch(x: unknown): BoardPatch {
  if (!isRecord(x)) fail('patch', 'must be an object');
  if (x.title !== undefined && (typeof x.title !== 'string' || !x.title.trim())) fail('title', 'must be a non-empty string');
  return {
    title: x.title as string | undefined,
    intro: typeof x.intro === 'string' ? x.intro : undefined,
    layout: x.layout === undefined ? undefined : validateLayout(x.layout),
    questions: x.questions === undefined ? undefined : validateQuestions(x.questions),
  };
}
