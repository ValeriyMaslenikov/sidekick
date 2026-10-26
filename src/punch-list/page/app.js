// punch-list Board page. Renders the Board the server streams over SSE inside an
// editor-style frame (sidebar, main, explanation panel, status bar), keeps the person's
// typing local until it is saved, and talks back with small POSTs.

const token = new URLSearchParams(location.search).get('t') || '';
const boardId = decodeURIComponent(location.pathname.split('/')[2] || '');
const $ = (id) => document.getElementById(id);

let view = null;
/** Answers typed here but not yet confirmed saved by the server: qid -> {value, note}. */
const local = {};
const saveTimers = {};
const inflight = new Set();
const listeners = {};
const ui = loadUi();
ui.closed ||= [2, 3, 4];
ui.seen ||= {};

// ---------- status groups ----------

const GROUP_NAME = ['Needs you', 'Claude is explaining', 'Answered', 'Skipped', 'Withdrawn'];
const GROUP_CLASS = ['need', 'wait', 'ok', 'skip', 'skip'];
/** Status is shown by shape as well as colour: ! needs you, … explaining, ✓ answered, dashed – skipped, slashed withdrawn. */
const GLYPH = [
  '<svg class="g need" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.5v4.2M8 11.2v.3" stroke="var(--bg)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  '<svg class="g wait" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="11" cy="8" r="1.1" fill="currentColor"/></svg>',
  '<svg class="g ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="var(--bg)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  '<svg class="g skip" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2"/><path d="M5.5 8h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  '<svg class="g skip" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.5 11.5l7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
];
const CHEV = '<svg class="g chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

function hasValue(a) {
  if (!a) return false;
  const v = a.value;
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
const answerOf = (qid) => local[qid] ?? view?.drafts?.[qid];
const qById = (qid) => view.questions.find((q) => q.id === qid);

function groupOf(q) {
  const s = q.state || {};
  if (s.withdrawn) return 4;
  if (s.explaining) return 1;
  if (s.changed) return 0;
  if (hasValue(answerOf(q.id))) return 2;
  if (s.skipped) return 3;
  return 0;
}
const isUnsent = (qid) => view.unsent.includes(qid) || qid in local;
const isFresh = (q) => (q.state?.explanations?.length || 0) > (ui.seen[q.id] || 0);

function visible(q) {
  if (!q.showIf) return true;
  return Object.entries(q.showIf).every(([dep, want]) => {
    const got = answerOf(dep)?.value;
    const wants = Array.isArray(want) ? want.map(String) : [String(want)];
    if (Array.isArray(got)) return got.some((g) => wants.includes(String(g)));
    return got !== undefined && got !== null && wants.includes(String(got));
  });
}

/** Visible Questions, needs-you first, then explaining, answered, skipped, withdrawn; board order inside a group. */
function sortedIds() {
  return view.questions
    .map((q, i) => [q, i])
    .filter(([q]) => visible(q))
    .sort(([a, ai], [b, bi]) => groupOf(a) - groupOf(b) || ai - bi)
    .map(([q]) => q.id);
}

const stripTags = (s) => String(s).replace(/<[^>]+>/g, '');
function answerText(q) {
  const a = answerOf(q.id);
  if (!hasValue(a)) return '';
  const v = a.value;
  if (q.type === 'yes-no') return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : String(v);
  const label = (x) => {
    const o = (q.options || []).find((o) => o.value === x);
    return o ? stripTags(o.label) : String(x);
  };
  if (Array.isArray(v)) return v.map(label).join(', ');
  if (q.options) return label(v);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// ---------- helpers ----------

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false && kid !== '') n.append(kid);
  return n;
}

function loadUi() {
  try { return JSON.parse(localStorage.getItem(`pl:${boardId}:ui`) || '{}'); } catch { return {}; }
}
function saveUi() {
  try { localStorage.setItem(`pl:${boardId}:ui`, JSON.stringify(ui)); } catch {}
}

/** Inserts agent HTML and runs any scripts in it (innerHTML alone never runs them). */
function setRich(node, html) {
  node.innerHTML = html || '';
  for (const old of node.querySelectorAll('script')) {
    const s = document.createElement('script');
    for (const a of old.attributes) s.setAttribute(a.name, a.value);
    s.textContent = old.textContent;
    old.replaceWith(s);
  }
  queueMermaid();
}
const rich = (html, cls = 'rich') => { const n = el('div', { class: cls }); setRich(n, html); return n; };

let mermaidQueued = false;
let mermaidLib = null;
function queueMermaid() {
  if (mermaidQueued) return;
  mermaidQueued = true;
  requestAnimationFrame(async () => {
    mermaidQueued = false;
    const pending = document.querySelectorAll('.mermaid:not([data-processed])');
    if (!pending.length) return;
    try {
      if (!mermaidLib) {
        mermaidLib = (await import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs')).default;
        const dark = !matchMedia('(prefers-color-scheme: light)').matches;
        mermaidLib.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
      }
      await mermaidLib.run({ nodes: [...pending] });
    } catch (err) {
      console.warn('punch-list: mermaid failed', err);
    }
  });
}

async function post(path, body = {}) {
  let res;
  try {
    res = await fetch(`/b/${encodeURIComponent(boardId)}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sidekick-token': token },
      body: JSON.stringify(body),
      // Lets a draft save finish even when the page is being closed or reloaded.
      keepalive: true,
    });
  } catch (err) {
    toast("Can't reach the punch-list server. Your answers are kept here and saved when it's back.");
    throw err;
  }
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error || res.statusText;
    toast(`Couldn't save: ${msg}`);
    throw new Error(msg);
  }
  return res.json();
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
function announce(text) {
  const l = $('live');
  l.textContent = '';
  setTimeout(() => (l.textContent = text), 30);
}

const isFocus = () => view?.layout.type === 'focus';
const wide = () => matchMedia('(min-width: 1400px)').matches;

// ---------- answers ----------

function setAnswer(qid, patch) {
  const cur = answerOf(qid) || { value: null };
  const next = { ...cur, ...patch };
  if (!next.note) delete next.note;
  local[qid] = next;
  clearTimeout(saveTimers[qid]);
  saveTimers[qid] = setTimeout(() => flushOne(qid), 400);
  refresh();
  emit('answer', { qid, answer: next });
}

async function flushOne(qid) {
  clearTimeout(saveTimers[qid]);
  delete saveTimers[qid];
  const answer = local[qid];
  if (!answer) return;
  const p = post('draft', { qid, answer }).then(() => {
    if (local[qid] === answer) delete local[qid];
  });
  inflight.add(p);
  try { await p; } finally { inflight.delete(p); }
}

/** Saves every answer that isn't on the server yet, including ones whose save failed earlier. */
async function flushAll() {
  await Promise.all([...inflight].map((p) => p.catch(() => {})));
  await Promise.all(Object.keys(local).map(flushOne));
}

// ---------- shared answer inputs ----------

function choicesFor(q) {
  if (q.type === 'yes-no') return [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
  if (q.type === 'scale') {
    const min = q.min ?? 1, max = q.max ?? 5, step = q.step ?? 1;
    const out = [];
    for (let v = min; v <= max + 1e-9; v += step) out.push({ value: v, label: String(v) });
    return out;
  }
  return q.options || [];
}

/** Records a picked choice. Returns true for single-answer types, so the focus layout can move on. */
function pick(q, value) {
  if (q.type === 'multi') {
    const set = new Set(Array.isArray(answerOf(q.id)?.value) ? answerOf(q.id).value : []);
    set.has(value) ? set.delete(value) : set.add(value);
    setAnswer(q.id, { value: (q.options || []).map((o) => o.value).filter((v) => set.has(v)) });
    return false;
  }
  setAnswer(q.id, { value });
  return true;
}

function renderInput(q, box, opts = {}) {
  const { keys = false, onPicked } = opts;
  box.replaceChildren();
  if (q.state?.withdrawn) return;
  const cur = answerOf(q.id)?.value;
  switch (q.type) {
    case 'yes-no':
    case 'single':
    case 'multi':
    case 'scale': {
      const multi = q.type === 'multi';
      const chosen = new Set(multi ? (Array.isArray(cur) ? cur : []) : [cur]);
      const list = el('div', { class: `choices${q.type === 'scale' ? ' row' : ''}`, role: 'group', 'aria-label': q.title });
      choicesFor(q).forEach((o, i) => {
        const on = chosen.has(o.value);
        const b = el('button', { type: 'button', class: `choice${on ? ' on' : ''}`, 'aria-pressed': String(on) });
        if (keys && i < 9) b.append(el('span', { class: 'key', text: String(i + 1) }));
        else b.style.gridTemplateColumns = '1fr';
        const body = el('span', { class: 'rich' });
        const label = el('b');
        setRich(label, o.label);
        body.append(label);
        if (o.recommended) body.append(el('span', { class: 'rec', text: 'recommended' }));
        if (o.detail) { const d = el('small'); setRich(d, o.detail); body.append(d); }
        b.append(body);
        b.addEventListener('click', () => {
          const single = pick(q, o.value);
          if (multi) {
            b.classList.toggle('on');
            b.setAttribute('aria-pressed', String(b.classList.contains('on')));
          } else {
            for (const x of list.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
          }
          if (single) onPicked?.();
        });
        list.append(b);
      });
      box.append(list);
      break;
    }
    case 'text': {
      const ta = el('textarea', { placeholder: 'Type your answer', 'aria-label': q.title, 'data-edit': 'answer' });
      ta.value = typeof cur === 'string' ? cur : '';
      ta.addEventListener('input', () => setAnswer(q.id, { value: ta.value }));
      box.append(ta);
      break;
    }
    case 'number': {
      const inp = el('input', { type: 'number', min: q.min, max: q.max, step: q.step, 'aria-label': q.title, 'data-edit': 'answer' });
      inp.value = cur ?? '';
      inp.addEventListener('input', () => setAnswer(q.id, { value: inp.value === '' ? null : Number(inp.value) }));
      box.append(inp);
      break;
    }
    case 'rank':
      box.append(rankList(q, cur, box, opts));
      break;
    case 'custom':
      if (hasValue(answerOf(q.id))) box.append(el('div', { class: 'muted', text: `Recorded: ${JSON.stringify(cur)}` }));
      break;
  }
}

function rankList(q, cur, box, opts) {
  const all = (q.options || []).map((o) => o.value);
  const order = Array.isArray(cur) ? [...cur.filter((v) => all.includes(v)), ...all.filter((v) => !cur.includes(v))] : all;
  const labelOf = (v) => stripTags(q.options.find((o) => o.value === v)?.label ?? v);
  const move = (i, d) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setAnswer(q.id, { value: next });
    renderInput(q, box, opts);
  };
  const list = el('ol', { class: 'rank' },
    order.map((v, i) => el('li', {},
      el('span', { text: labelOf(v) }),
      el('button', { type: 'button', class: 'btn small ghost', text: '↑', 'aria-label': `Move ${labelOf(v)} up`, disabled: i === 0, onclick: () => move(i, -1) }),
      el('button', { type: 'button', class: 'btn small ghost', text: '↓', 'aria-label': `Move ${labelOf(v)} down`, disabled: i === order.length - 1, onclick: () => move(i, 1) }),
    )),
  );
  const wrap = el('div', { class: 'section' }, list);
  if (!Array.isArray(cur)) wrap.append(el('button', { type: 'button', class: 'btn small ghost', text: 'This order is fine', onclick: () => { setAnswer(q.id, { value: order }); renderInput(q, box, opts); } }));
  return wrap;
}

function noteField(q, { hint } = {}) {
  const id = `note-${q.id}`;
  const ta = el('textarea', { id, class: 'note', placeholder: 'Optional', 'data-edit': 'note' });
  ta.value = answerOf(q.id)?.note || '';
  ta.addEventListener('input', () => setAnswer(q.id, { note: ta.value }));
  const label = el('label', { for: id, html: `Note for Claude <span style="color:var(--faint)">·${hint ? ' <kbd>e</kbd> to type,' : ''} <kbd>⇧↵</kbd> new line, <kbd>↵</kbd> next</span>` });
  return el('div', { class: 'field' }, label, ta);
}

function threadNode(q) {
  const th = el('div', { class: 'thread' });
  for (const x of q.state?.explanations || []) {
    const item = el('div', { class: 'expl' });
    if (x.question) item.append(el('div', { class: 'asked', text: `you asked: ${x.question}` }));
    item.append(rich(x.html));
    th.append(item);
  }
  if (q.state?.explaining) th.append(el('div', { class: 'typing', text: `Claude is explaining${q.state.pendingQuestion ? ` “${q.state.pendingQuestion}”` : ''}` }));
  return th;
}

function askBox(q, { onAsked } = {}) {
  const box = el('div', { class: 'ask', 'data-role': 'ask', hidden: true });
  const ta = el('textarea', { placeholder: "What's unclear? Ask your own question, or leave empty for a simpler explanation.", 'aria-label': 'Your question to Claude' });
  const submit = async () => {
    await post('explain', { qid: q.id, text: ta.value });
    box.hidden = true;
    ta.value = '';
    ta.blur();
    toast(isFocus() ? 'Claude is on it. Moving to the next question meanwhile.' : 'Claude is on it.');
    onAsked?.();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); submit(); }
  });
  box.append(ta, el('div', { class: 'actions' },
    el('button', { type: 'button', class: 'btn', html: 'Ask Claude <kbd>↵</kbd>', onclick: submit }),
    el('button', { type: 'button', class: 'btn ghost', html: 'Cancel <kbd>Esc</kbd>', onclick: () => (box.hidden = true) }),
  ));
  return box;
}

function changedNotice(q, after) {
  const box = el('div', { class: 'notice attn' });
  const said = answerText(q);
  box.append(el('span', { text: `Claude changed this question after you answered${said ? ` (you said ${said})` : ''}. Check your answer.` }));
  box.append(el('button', { type: 'button', class: 'btn small ghost', text: 'My answer still stands', onclick: async () => { await post('confirm', { qid: q.id }); after?.(); } }));
  return box;
}

// ---------- chrome: sidebar, progress, status bar ----------

function renderSidebar() {
  const list = $('sideList');
  const scroll = list.scrollTop;
  list.replaceChildren();
  const ids = sortedIds();
  const current = isFocus() ? focus.current : null;
  for (let g = 0; g < 5; g++) {
    const inGroup = ids.filter((id) => groupOf(qById(id)) === g);
    if (!inGroup.length) continue;
    const closed = ui.closed.includes(g) && !inGroup.includes(current);
    const sec = el('section', { class: `sec${closed ? ' closed' : ''}` });
    sec.append(el('button', {
      type: 'button', class: 'sec-head', 'aria-expanded': String(!closed),
      html: `${CHEV}${GLYPH[g]}<span>${GROUP_NAME[g]}</span><span class="n">${inGroup.length}</span>`,
      onclick: () => { ui.closed = ui.closed.includes(g) ? ui.closed.filter((x) => x !== g) : [...ui.closed, g]; saveUi(); renderSidebar(); },
    }));
    const items = el('div', { class: 'items' });
    for (const id of inGroup) {
      const q = qById(id);
      const cls = ['item', id === current && 'current', isFresh(q) && 'fresh', isUnsent(id) && g !== 4 && 'unsent', g === 4 && 'withdrawn'].filter(Boolean).join(' ');
      const b = el('button', { type: 'button', class: cls, title: q.title, html: `${GLYPH[g]}<span class="t"></span><span class="a"></span>` });
      b.querySelector('.t').textContent = q.title;
      b.querySelector('.a').textContent = answerText(q);
      b.setAttribute('aria-label', `${q.title}, ${GROUP_NAME[g].toLowerCase()}${answerText(q) ? `, answer ${answerText(q)}` : ''}`);
      if (id === current) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => reveal(id));
      items.append(b);
    }
    sec.append(items);
    list.append(sec);
  }
  list.scrollTop = scroll;
}

function renderProgress() {
  const shown = view.questions.filter((q) => visible(q) && groupOf(q) !== 4);
  const counts = [0, 0, 0, 0];
  for (const q of shown) counts[groupOf(q)]++;
  const segs = el('div', { class: 'segments' });
  const labels = el('div', { class: 'labels' });
  const jump = (g) => { const id = sortedIds().find((x) => groupOf(qById(x)) === g); if (id) reveal(id); };
  counts.forEach((n, g) => {
    if (n) {
      const s = el('button', { type: 'button', class: `segment ${GROUP_CLASS[g]}`, title: `${GROUP_NAME[g]}: ${n}`, 'aria-label': `${GROUP_NAME[g]}: ${n}`, onclick: () => jump(g) });
      s.style.flexGrow = n;
      segs.append(s);
    }
    labels.append(el('button', { type: 'button', html: `${GLYPH[g]}<b>${n}</b> ${GROUP_NAME[g].toLowerCase()}`, onclick: () => jump(g) }));
  });
  $('progress').replaceChildren(segs, labels);
  $('sbCounts').innerHTML = counts.map((n, g) => `<span title="${GROUP_NAME[g]}">${GLYPH[g]}${n}</span>`).join('');
  const unsent = shown.filter((q) => isUnsent(q.id)).length;
  $('sbUnsent').textContent = unsent ? `${unsent} unsent` : focus.lastSentAt ? `sent ${clock(focus.lastSentAt)}` : 'all sent';
  $('send').disabled = unsent === 0;
  $('done').textContent = view.done ? 'Done ✓' : 'Done';
  $('done').disabled = view.done;
}

function renderChrome() {
  document.title = `${view.title} · punch-list`;
  $('title').textContent = view.title;
  $('crumbBoard').textContent = view.id;
  const cq = isFocus() && focus.current ? qById(focus.current) : null;
  $('crumbQ').textContent = cq ? cq.title : '';
  $('crumbSep').hidden = !cq;
  if ($('intro').dataset.html !== (view.intro || '')) {
    $('intro').dataset.html = view.intro || '';
    setRich($('intro'), view.intro);
  }
  $('banner-listen').hidden = view.listening || view.done;
  $('resume-prompt').textContent = view.resumePrompt;
  $('banner-done').hidden = !view.done;
  $('listen').classList.toggle('off', !view.listening);
  $('listenText').textContent = view.listening ? 'listening' : 'not listening';
  $('app').classList.toggle('no-insp', !isFocus());
  $('mainIn').classList.toggle('wide', view.layout.type === 'columns' || view.layout.type === 'custom');
  renderSidebar();
  renderProgress();
}

/** Cheap update after a local change (an answer, a note): status, counts, sidebar. */
function refresh() {
  if (!view) return;
  renderChrome();
  if (isFocus()) renderFocusSoft();
  else refreshCards();
}

// ---------- focus layout ----------

const focus = { current: null, lastDir: 1, hardKey: null, pendingAdvance: null, deferred: false };

function firstNeeding(after) {
  const ids = sortedIds();
  const start = after == null || !ids.includes(after) ? 0 : ids.indexOf(after) + 1;
  return [...ids.slice(start), ...ids.slice(0, start)].find((id) => groupOf(qById(id)) === 0) || null;
}

function goTo(id, dir) {
  const ids = sortedIds();
  focus.lastDir = dir ?? (ids.indexOf(id) >= ids.indexOf(focus.current) ? 1 : -1);
  focus.current = id;
  focus.hardKey = null;
  renderFocus();
  renderChrome();
  $('main').scrollTo({ top: 0 });
  const q = id && qById(id);
  if (q) announce(`${q.title}. ${GROUP_NAME[groupOf(q)]}. Question ${ids.indexOf(id) + 1} of ${ids.length}.`);
  else announce('Nothing needs you right now.');
}

function nextNeeding() {
  clearTimeout(focus.pendingAdvance);
  const next = firstNeeding(focus.current);
  if (!next && !focus.current) return;
  goTo(next && next !== focus.current ? next : null, 1);
}

/** Changes that need the question card rebuilt; answers typed here never do. */
function focusHardKey(q) {
  const { state, status, ...def } = q;
  return JSON.stringify([q.id, def, state?.changed, state?.withdrawn, state?.explanations?.length, state?.explaining, state?.pendingQuestion, wide()]);
}

function renderFocus() {
  const board = $('board');
  if (focus.current && (!view.questions.some((q) => q.id === focus.current) || !visible(qById(focus.current)))) focus.current = firstNeeding(null);
  const q = focus.current && qById(focus.current);
  const key = q ? focusHardKey(q) : `done:${view.done}:${unsentCount()}:${focus.lastSentAt}:${JSON.stringify(view.questions.map((x) => [x.id, groupOf(x)]))}`;
  if (key === focus.hardKey) return renderFocusSoft();
  // Never rebuild under the person's cursor; catch up when they leave the field.
  const typing = document.activeElement?.matches?.('textarea, input') && ($('board').contains(document.activeElement) || $('inspBody').contains(document.activeElement));
  if (typing && q && focus.hardKey && focus.hardKey.startsWith(`["${q.id}"`)) {
    focus.deferred = true;
    return renderFocusSoft();
  }
  focus.deferred = false;
  focus.hardKey = key;
  board.replaceChildren();
  if (!q) {
    board.append(doneCard());
  } else {
    if (isFresh(q)) { ui.seen[q.id] = q.state.explanations.length; saveUi(); }
    board.append(el('div', { 'data-slot': 'prev' }), focusCard(q), el('div', { 'data-slot': 'next' }));
  }
  board.append(el('div', { class: 'hint', html: '<span><kbd>1</kbd>–<kbd>9</kbd> pick</span><span><kbd>e</kbd> edit text</span><span><kbd>↵</kbd> next that needs me</span><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>s</kbd> skip</span><span><kbd>?</kbd> wait, what?</span><span><kbd>⌘B</kbd> list</span><span><kbd>⌘↵</kbd> send to Claude</span>' }));
  renderFocusSoft();
  renderInspector();
}
document.addEventListener('focusout', () => setTimeout(() => { if (focus.deferred && isFocus()) renderFocus(); }, 0));

/** Updates what can change while the person is typing: status line, colour, neighbours. */
function renderFocusSoft() {
  const q = focus.current && qById(focus.current);
  const card = $('board').querySelector('.f-card[data-qid]');
  if (!q || !card) return;
  const g = groupOf(q);
  card.classList.remove('need-c', 'wait-c', 'ok-c', 'skip-c');
  card.classList.add(`${GROUP_CLASS[g]}-c`);
  const ids = sortedIds();
  const inGroup = ids.filter((id) => groupOf(qById(id)) === g);
  card.querySelector('[data-slot=status]').innerHTML = `${GLYPH[g]}${GROUP_NAME[g]} · ${inGroup.indexOf(q.id) + 1} of ${inGroup.length}`;
  card.querySelector('[data-slot=pos]').textContent = `${ids.indexOf(q.id) + 1} / ${ids.length}`;
  const skip = card.querySelector('[data-act=skip]');
  if (skip) skip.innerHTML = q.state?.skipped ? 'Unskip <kbd>s</kbd>' : 'Skip for now <kbd>s</kbd>';
  const i = ids.indexOf(q.id);
  $('board').querySelector('[data-slot=prev]')?.replaceChildren(peek(ids[i - 1], '↑ prev'));
  $('board').querySelector('[data-slot=next]')?.replaceChildren(peek(ids[i + 1], '↓ next'));
}

function peek(id, where) {
  if (!id) return el('div', { class: 'peek empty', 'aria-hidden': 'true' });
  const q = qById(id);
  const g = groupOf(q);
  const b = el('button', { type: 'button', class: 'peek', html: `${GLYPH[g]}<span class="t"></span><span class="chip ${GROUP_CLASS[g]}"></span><span class="where">${where}</span>` });
  b.querySelector('.t').textContent = q.title;
  b.querySelector('.chip').textContent = g === 2 ? answerText(q) : GROUP_NAME[g].toLowerCase();
  b.setAttribute('aria-label', `${where.replace(/[↑↓]\s*/, '')}: ${q.title}, ${GROUP_NAME[g].toLowerCase()}`);
  b.addEventListener('click', () => goTo(id, where.includes('↑') ? -1 : 1));
  return b;
}

function focusCard(q) {
  const card = el('section', { class: 'f-card enter', 'data-qid': q.id, 'aria-labelledby': 'qtitle' });
  card.style.setProperty('--from', `${focus.lastDir * 10}px`);
  card.append(el('div', { class: 'f-top' }, el('span', { 'data-slot': 'status' }), el('span', { 'data-slot': 'pos' })));
  card.append(el('h2', { id: 'qtitle', text: q.title }));
  if (q.state?.withdrawn) card.append(el('div', { class: 'notice muted-box', text: `Withdrawn${q.state.withdrawReason ? `: ${q.state.withdrawReason}` : ''}` }));
  else if (q.state?.changed) card.append(changedNotice(q, nextNeeding));
  if (q.body) card.append(rich(q.body, 'rich body'));
  if (q.state?.withdrawn) return card;

  const input = el('div');
  renderInput(q, input, {
    keys: true,
    onPicked: () => { clearTimeout(focus.pendingAdvance); focus.pendingAdvance = setTimeout(nextNeeding, 380); },
  });
  const editable = q.type === 'text' || q.type === 'number';
  if (editable) card.append(el('div', { class: 'field' }, el('label', { html: 'Your answer <span style="color:var(--faint)">· <kbd>e</kbd> to type, <kbd>⇧↵</kbd> new line, <kbd>↵</kbd> next, <kbd>Esc</kbd> to leave</span>' }), input));
  else card.append(input);
  if (!editable && q.type !== 'custom') card.append(noteField(q, { hint: true }));
  if (!wide()) {
    if (q.state?.explanations?.length || q.state?.explaining) card.append(threadNode(q));
    card.append(askBox(q, { onAsked: () => setTimeout(nextNeeding, 300) }));
  }
  card.append(el('div', { class: 'actions' },
    el('button', { type: 'button', class: 'btn ghost', 'data-act': 'what', html: 'Wait, what? <kbd>?</kbd>', onclick: openAsk }),
    el('button', { type: 'button', class: 'btn link', 'data-act': 'skip', onclick: skipCurrent }),
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', class: 'btn', html: 'Next that needs me <kbd>↵</kbd>', onclick: nextNeeding }),
  ));
  return card;
}

const unsentCount = () => view.questions.filter((q) => visible(q) && groupOf(q) !== 4 && isUnsent(q.id)).length;
const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What Enter does when nothing needs the person: send unsent answers, else mark the board done. */
function primaryAction() {
  if (unsentCount() > 0) return sendAll();
  if (!view.done) return $('done').click();
}

function doneCard() {
  const shown = view.questions.filter(visible);
  const skipped = shown.filter((q) => groupOf(q) === 3);
  const explaining = shown.filter((q) => groupOf(q) === 1);
  const unsent = unsentCount();
  const card = el('section', { class: 'f-card done-card enter ok-c' });
  card.innerHTML = '<svg class="big" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="var(--bg)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const actions = el('div', { class: 'actions' });
  if (view.done) {
    card.append(el('h2', { text: 'Board marked done' }), el('p', { class: 'muted', style: 'margin:0', text: 'Claude has everything and is working on it. You can close this tab; reopen the board if you want to change something.' }));
    actions.append(el('button', { type: 'button', class: 'btn ghost', text: 'Reopen', onclick: () => post('reopen') }));
  } else if (unsent > 0) {
    card.append(el('h2', { text: skipped.length || explaining.length ? 'Nothing needs you right now' : 'Everything is answered' }), el('p', { class: 'muted', style: 'margin:0', text: `${unsent} answer${unsent === 1 ? " hasn't" : "s haven't"} been sent to Claude yet.` }));
    actions.append(
      el('button', { type: 'button', class: 'btn', 'data-primary': '', html: 'Send to Claude <kbd>↵</kbd>', onclick: sendAll }),
      el('button', { type: 'button', class: 'btn ghost', text: 'Done', onclick: () => $('done').click() }),
    );
  } else {
    const at = focus.lastSentAt ? ` at ${clock(focus.lastSentAt)}` : '';
    card.append(el('h2', { text: `Sent to Claude${at}` }), el('p', { class: 'muted', style: 'margin:0', text: "Claude has your answers. Mark the board done when you're finished, or keep editing: changes show up here as unsent." }));
    const firstAnswered = sortedIds().find((id) => groupOf(qById(id)) === 2);
    actions.append(
      el('button', { type: 'button', class: 'btn', 'data-primary': '', html: 'Mark board done <kbd>↵</kbd>', onclick: () => $('done').click() }),
      firstAnswered ? el('button', { type: 'button', class: 'btn ghost', text: 'Review answers', onclick: () => goTo(firstAnswered, -1) }) : null,
    );
  }
  if (explaining.length) card.append(el('p', { class: 'muted', style: 'margin:0', text: `Claude is still explaining ${explaining.length} question${explaining.length > 1 ? 's' : ''}; it comes back to the top when the answer lands.` }));
  if (skipped.length) {
    const later = el('div', { class: 'later' }, el('div', { class: 'f-top' }, el('span', { text: 'You skipped' })));
    for (const q of skipped) later.append(peek(q.id, 'go back'));
    card.append(later);
  }
  card.append(actions);
  return card;
}

function renderInspector() {
  const body = $('inspBody');
  body.replaceChildren();
  if (!isFocus() || !wide()) return;
  const q = focus.current && qById(focus.current);
  if (!q) return body.append(el('div', { class: 'empty-state', text: 'Explanations for the current question show up here.' }));
  body.append(el('div', { class: 'insp-q' }, el('b', { text: q.title })));
  if (q.state?.explanations?.length || q.state?.explaining) body.append(threadNode(q));
  else body.append(el('div', { class: 'empty-state', html: 'Not sure what this question means? Press <kbd>?</kbd> and ask. Claude answers here while you carry on with the next question.' }));
  if (!q.state?.withdrawn) body.append(askBox(q, { onAsked: () => setTimeout(nextNeeding, 300) }));
}

function openAsk() {
  const scope = isFocus() && wide() ? $('inspBody') : $('board');
  const box = scope.querySelector('[data-role=ask]');
  if (!box) return;
  box.hidden = false;
  box.querySelector('textarea').focus();
}

async function skipCurrent() {
  const q = focus.current && qById(focus.current);
  if (!q) return;
  const skipping = !q.state?.skipped;
  await post('skip', { qid: q.id, skipped: skipping });
  if (skipping) nextNeeding();
}

// ---------- card layouts (list, tabs, wizard, columns, custom) ----------

const cards = new Map();
let layoutKey = null;
let modal = null;

function defKey(q) {
  const { state, status, ...def } = q;
  return JSON.stringify([def, state?.changed, state?.withdrawn, state?.withdrawReason]);
}
const threadKey = (q) => JSON.stringify([q.state?.explanations, q.state?.explaining, q.state?.pendingQuestion]);

function makeCard(q) {
  const parts = {
    head: el('div', { class: 'card-head' }),
    body: el('div', { class: 'rich' }),
    notice: el('div'),
    input: el('div'),
    note: el('div'),
    thread: el('div'),
    ask: el('div'),
    actions: el('div', { class: 'card-actions' }),
  };
  const node = el('section', { class: 'card', 'data-qid': q.id }, Object.values(parts));
  const card = { el: node, parts, keys: {} };
  cards.set(q.id, card);
  return card;
}

function updateCard(q) {
  const card = cards.get(q.id) || makeCard(q);
  const { parts, keys } = card;
  const dk = defKey(q);
  const focusedInside = card.el.contains(document.activeElement) && document.activeElement !== document.body;
  if (keys.def !== dk) {
    keys.def = dk;
    renderHead(q, parts.head);
    setRich(parts.body, q.body);
    parts.body.hidden = !q.body;
    parts.notice.replaceChildren();
    if (q.state?.withdrawn) parts.notice.append(el('div', { class: 'notice muted-box', text: `Withdrawn${q.state.withdrawReason ? `: ${q.state.withdrawReason}` : ''}` }));
    else if (q.state?.changed) parts.notice.append(changedNotice(q));
    renderInput(q, parts.input);
    parts.note.replaceChildren();
    if (!q.state?.withdrawn && q.type !== 'custom') parts.note.append(noteField(q));
    renderActions(q, parts.actions, parts.ask);
    keys.draft = JSON.stringify(view.drafts[q.id]);
  } else {
    const dkey = JSON.stringify(view.drafts[q.id]);
    if (keys.draft !== dkey && !(q.id in local) && !focusedInside) {
      renderInput(q, parts.input);
      parts.note.replaceChildren();
      if (!q.state?.withdrawn && q.type !== 'custom') parts.note.append(noteField(q));
    }
    keys.draft = dkey;
  }
  const tk = threadKey(q);
  if (keys.thread !== tk) {
    keys.thread = tk;
    parts.thread.replaceChildren(threadNode(q));
  }
  refreshCardStatus(q, card);
  return card;
}

function statusChip(q) {
  const g = groupOf(q);
  return el('span', { class: `chip ${GROUP_CLASS[g]}`, 'data-chip': 'status', text: q.state?.changed ? 'changed' : GROUP_NAME[g].toLowerCase() });
}

function refreshCardStatus(q, card) {
  const g = groupOf(q);
  card.el.classList.toggle('is-answered', g === 2);
  card.el.classList.toggle('is-withdrawn', g === 4);
  card.el.classList.toggle('is-changed', !!q.state?.changed);
  card.el.classList.toggle('is-explaining', g === 1);
  const meta = card.parts.head.querySelector('.card-meta');
  if (meta) {
    meta.querySelector('[data-chip=status]').replaceWith(statusChip(q));
    meta.querySelector('[data-chip=unsent]').hidden = !isUnsent(q.id) || g === 4;
  }
  const skip = card.parts.actions.querySelector('[data-act=skip]');
  if (skip) {
    skip.textContent = q.state?.skipped ? 'Unskip' : 'Skip for now';
    skip.hidden = g === 2 || g === 4;
  }
  card.el.hidden = !visible(q);
}

function renderHead(q, head) {
  head.replaceChildren(
    el('h3', { class: 'card-title', text: q.title }),
    el('div', { class: 'card-meta' },
      el('span', { 'data-chip': 'status' }),
      el('span', { class: 'chip accent', 'data-chip': 'unsent', text: 'unsent', title: 'Not sent to Claude yet' }),
      view.layout.type === 'columns' ? null : el('button', { type: 'button', class: 'btn small link', text: 'Expand', onclick: () => openModal(q.id) }),
    ),
  );
}

function renderActions(q, actions, ask) {
  actions.replaceChildren();
  ask.replaceChildren();
  if (q.state?.withdrawn) return;
  const box = askBox(q);
  ask.append(box);
  actions.append(
    el('button', { type: 'button', class: 'btn small ghost', text: 'Wait, what? Explain better', onclick: () => { box.hidden = false; box.querySelector('textarea').focus(); } }),
    el('button', { type: 'button', class: 'btn small link', 'data-act': 'skip', onclick: () => post('skip', { qid: q.id, skipped: !qById(q.id).state?.skipped }) }),
  );
}

function groupsOf() {
  const qs = view.questions;
  const defined = view.layout.groups || [];
  if (!defined.length) return null;
  const ids = new Set(defined.map((g) => g.id));
  const groups = defined.map((g) => ({ ...g, qs: qs.filter((q) => q.group === g.id) }));
  const rest = qs.filter((q) => !ids.has(q.group));
  if (rest.length) groups.push({ id: '_other', title: 'Other', qs: rest });
  return groups.filter((g) => g.qs.length);
}

function pages() {
  const groups = groupsOf();
  if (groups) return groups;
  return view.questions.map((q, i) => ({ id: q.id, title: `${i + 1}. ${q.title.length > 28 ? q.title.slice(0, 27) + '…' : q.title}`, qs: [q] }));
}

function buildLayout() {
  closeModal();
  const root = $('board');
  root.replaceChildren();
  const type = view.layout.type;
  for (const q of view.questions) updateCard(q);
  if (type === 'tabs') buildTabs(root);
  else if (type === 'wizard') buildWizard(root);
  else if (type === 'columns') buildColumns(root);
  else if (type === 'custom') buildCustom(root);
  else buildList(root);
}

function buildList(root) {
  const groups = groupsOf();
  if (!groups) return root.append(...view.questions.map((q) => cards.get(q.id).el));
  for (const g of groups) root.append(el('div', { class: 'section' }, el('h2', { text: g.title }), g.qs.map((q) => cards.get(q.id).el)));
}

function buildTabs(root) {
  const ps = pages();
  if (!ps.length) return;
  if (!ps.some((p) => p.id === ui.tab)) ui.tab = ps[0].id;
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  const panel = el('div', { class: 'section' });
  const show = (id) => {
    ui.tab = id;
    saveUi();
    for (const b of bar.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    panel.replaceChildren(...ps.find((p) => p.id === id).qs.map((q) => cards.get(q.id).el));
    queueMermaid();
  };
  for (const p of ps) bar.append(el('button', { type: 'button', class: 'tab', role: 'tab', 'data-id': p.id, onclick: () => show(p.id) }, el('span', { text: p.title }), el('span', { class: 'count', 'data-count': p.id })));
  root.append(bar, panel);
  show(ui.tab);
}

function buildWizard(root) {
  const ps = pages();
  if (!ps.length) return;
  ui.step = Math.min(Math.max(0, ui.step || 0), ps.length - 1);
  const bar = el('div', { class: 'wizard-bar' }, el('div'));
  const label = el('span', { class: 'muted' });
  const panel = el('div', { class: 'section' });
  const back = el('button', { type: 'button', class: 'btn ghost', text: 'Back' });
  const next = el('button', { type: 'button', class: 'btn', text: 'Next' });
  const show = (i) => {
    ui.step = i;
    saveUi();
    const p = ps[i];
    label.textContent = `Step ${i + 1} of ${ps.length}${view.layout.groups?.length ? ` · ${p.title}` : ''}`;
    bar.firstChild.style.width = `${((i + 1) / ps.length) * 100}%`;
    panel.replaceChildren(...p.qs.map((q) => cards.get(q.id).el));
    back.disabled = i === 0;
    next.disabled = i === ps.length - 1;
    next.textContent = i === ps.length - 1 ? 'Last step' : 'Next';
    $('main').scrollTo({ top: 0, behavior: 'smooth' });
    queueMermaid();
  };
  back.onclick = () => show(ui.step - 1);
  next.onclick = () => show(ui.step + 1);
  root.append(bar, el('div', { class: 'wizard-nav' }, label), panel, el('div', { class: 'wizard-nav' }, back, next));
  show(ui.step);
}

function buildColumns(root) {
  root.append(el('div', { class: 'columns', id: 'columns' }));
  fillColumns();
}

function fillColumns() {
  const wrap = $('columns');
  if (!wrap) return;
  const byStatus = view.layout.columnsBy === 'status' || !view.layout.groups?.length;
  const cols = byStatus
    ? [0, 1, 2, 3, 4].map((g) => ({ id: g, title: GROUP_NAME[g], qs: view.questions.filter((q) => groupOf(q) === g) }))
    : groupsOf();
  wrap.replaceChildren(...cols.filter((c) => c.qs.length || c.id === 0).map((c) => {
    const shown = c.qs.filter(visible);
    return el('div', { class: 'column' },
      el('h2', {}, el('span', { text: c.title }), el('span', { text: String(shown.length) })),
      shown.map((q) => el('button', { type: 'button', class: 'mini', onclick: () => openModal(q.id) },
        el('span', { class: 'mini-title', text: q.title }),
        el('span', { class: 'card-meta' }, statusChip(q), isUnsent(q.id) ? el('span', { class: 'chip accent', text: 'unsent' }) : null),
      )),
    );
  }));
}

function buildCustom(root) {
  setRich(root, view.layout.html);
  const placed = new Set();
  for (const slot of root.querySelectorAll('[data-pl-question]')) {
    const card = cards.get(slot.getAttribute('data-pl-question'));
    if (card) {
      slot.replaceChildren(card.el);
      placed.add(slot.getAttribute('data-pl-question'));
    }
  }
  const rest = view.questions.filter((q) => !placed.has(q.id));
  if (rest.length) root.append(el('div', { class: 'section' }, el('h2', { text: 'More questions' }), rest.map((q) => cards.get(q.id).el)));
  if (view.layout.script) {
    try { new Function('punchList', view.layout.script)(api); } catch (err) { console.error('punch-list: layout script failed', err); toast('The custom layout script failed; see the console.'); }
  }
}

function refreshCards() {
  for (const q of view.questions) {
    const card = cards.get(q.id);
    if (card) refreshCardStatus(q, card);
  }
  for (const badge of document.querySelectorAll('[data-count]')) {
    const p = pages().find((x) => x.id === badge.dataset.count);
    const open = p ? p.qs.filter((q) => visible(q) && [0, 3].includes(groupOf(q))).length : 0;
    badge.textContent = open ? String(open) : '✓';
  }
  if (view.layout.type === 'columns' && !modal) fillColumns();
}

function openModal(qid) {
  closeModal();
  const card = cards.get(qid);
  if (!card) return;
  modal = { qid, parent: card.el.parentNode, next: card.el.nextSibling };
  $('modal-body').replaceChildren(card.el);
  card.el.hidden = false;
  $('modal').hidden = false;
  queueMermaid();
}

function closeModal() {
  if (!modal) return;
  const card = cards.get(modal.qid);
  if (card && modal.parent) modal.parent.insertBefore(card.el, modal.next);
  else card?.el.remove();
  modal = null;
  $('modal').hidden = true;
  if (view?.layout.type === 'columns') fillColumns();
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });

/** Shows a Question wherever the current layout keeps it. */
function reveal(qid) {
  $('app').classList.remove('mobile-open');
  if (isFocus()) return goTo(qid);
  const type = view.layout.type;
  if (type === 'columns') return openModal(qid);
  if (type === 'tabs' || type === 'wizard') {
    const ps = pages();
    const i = ps.findIndex((p) => p.qs.some((q) => q.id === qid));
    if (i === -1) return;
    if (type === 'tabs') ui.tab = ps[i].id; else ui.step = i;
    saveUi();
    buildLayout();
  }
  const node = cards.get(qid)?.el;
  if (node) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1200);
  }
}

/** Card layouts: Enter in a text box moves on to the next visible question card. */
function nextCardAfter(node) {
  const cardsInView = [...$('board').querySelectorAll('.card[data-qid]')].filter((c) => !c.hidden);
  const next = cardsInView[cardsInView.indexOf(node.closest('.card')) + 1];
  if (!next) return;
  next.scrollIntoView({ behavior: 'smooth', block: 'center' });
  next.classList.add('flash');
  setTimeout(() => next.classList.remove('flash'), 1200);
  next.querySelector('[data-edit=answer], .choice, [data-edit=note]')?.focus({ preventScroll: true });
}

// ---------- status bar actions ----------

$('copy-resume').addEventListener('click', async () => {
  const text = $('resume-prompt').textContent;
  try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into your agent.'); }
  catch { const r = document.createRange(); r.selectNodeContents($('resume-prompt')); getSelection().removeAllRanges(); getSelection().addRange(r); }
});

async function sendAll() {
  await flushAll();
  const { sent } = await post('send');
  if (sent) focus.lastSentAt = new Date();
  toast(sent ? 'Sent to Claude.' : 'Nothing new to send.');
  if (isFocus()) renderFocus();
  renderProgress();
}
$('send').addEventListener('click', sendAll);

$('done').addEventListener('click', async () => {
  await flushAll();
  const shown = view.questions.filter((q) => visible(q) && groupOf(q) !== 4);
  const open = shown.filter((q) => groupOf(q) === 0).length;
  const skipped = shown.filter((q) => groupOf(q) === 3).length;
  if (open + skipped === 0) return finish();
  $('confirm-text').textContent = [open && `${open} not answered`, skipped && `${skipped} skipped`].filter(Boolean).join(', ') + '.';
  $('actions').hidden = true;
  $('confirm-done').hidden = false;
});
$('keep').addEventListener('click', () => { $('actions').hidden = false; $('confirm-done').hidden = true; });
$('done-anyway').addEventListener('click', finish);
async function finish() {
  $('actions').hidden = false;
  $('confirm-done').hidden = true;
  await flushAll();
  await post('done');
  toast('Marked done. Claude has your answers.');
}
$('reopen').addEventListener('click', () => post('reopen'));

// ---------- sidebar collapse (remembered per browser) ----------

function setCollapsed(c) {
  $('app').classList.toggle('collapsed', c);
  $('toggleSide').setAttribute('aria-expanded', String(!c));
  try { localStorage.setItem('pl-sidebar', c ? 'collapsed' : 'open'); } catch {}
}
function toggleSidebar() {
  if (matchMedia('(max-width: 760px)').matches) return $('app').classList.toggle('mobile-open');
  setCollapsed(!$('app').classList.contains('collapsed'));
}
$('toggleSide').addEventListener('click', toggleSidebar);
{
  let saved = null;
  try { saved = localStorage.getItem('pl-sidebar'); } catch {}
  setCollapsed(saved ? saved === 'collapsed' : innerWidth < 1100);
}
// ---------- explanation panel width (drag, arrow keys; remembered per browser) ----------

const INSP_DEFAULT = 380;
const inspMax = () => Math.max(300, Math.min(900, innerWidth - 640));
function setInspWidth(w, save = true) {
  const width = Math.round(Math.min(inspMax(), Math.max(280, w)));
  $('app').style.setProperty('--inspector', `${width}px`);
  $('inspResizer').setAttribute('aria-valuenow', String(width));
  if (save) try { localStorage.setItem('pl-inspector', String(width)); } catch {}
  return width;
}
{
  const r = $('inspResizer');
  r.setAttribute('aria-valuemin', '280');
  r.setAttribute('aria-valuemax', String(inspMax()));
  let saved = null;
  try { saved = Number(localStorage.getItem('pl-inspector')); } catch {}
  setInspWidth(saved || INSP_DEFAULT, false);
  r.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { r.setPointerCapture(e.pointerId); } catch {}
    r.classList.add('dragging');
    document.body.classList.add('resizing');
    const right = $('inspector').getBoundingClientRect().right;
    const move = (ev) => setInspWidth(right - ev.clientX, false);
    const up = (ev) => {
      setInspWidth(right - ev.clientX);
      r.classList.remove('dragging');
      document.body.classList.remove('resizing');
      r.removeEventListener('pointermove', move);
      r.removeEventListener('pointerup', up);
    };
    r.addEventListener('pointermove', move);
    r.addEventListener('pointerup', up);
  });
  r.addEventListener('dblclick', () => setInspWidth(INSP_DEFAULT));
  r.addEventListener('keydown', (e) => {
    const cur = parseInt(getComputedStyle($('app')).getPropertyValue('--inspector'), 10) || INSP_DEFAULT;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setInspWidth(cur + 24); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setInspWidth(cur - 24); }
  });
}
matchMedia('(min-width: 1400px)').addEventListener('change', () => { if (isFocus()) { focus.hardKey = null; renderFocus(); } });

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches?.('textarea, input, select, [contenteditable]');
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendAll(); return; }
  if ((e.key === 'b' || e.key === 'B') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleSidebar(); return; }
  if (typing) {
    // In a text box: Shift+Enter is a new line (the browser default), Enter moves to the next question.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.target.matches('[data-edit]')) {
      e.preventDefault();
      e.target.blur();
      if (isFocus()) nextNeeding();
      else nextCardAfter(e.target);
      return;
    }
    if (e.key === 'Escape') {
      const ask = e.target.closest('[data-role=ask]');
      if (ask) ask.hidden = true;
      e.target.blur();
    }
    return;
  }
  if (e.key === 'Escape') return closeModal();
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'l' || e.key === 'L') return toggleSidebar();
  if (!view || !isFocus()) return;
  const ids = sortedIds();
  const i = ids.indexOf(focus.current);
  if (e.key === 'Enter' && !e.target.closest?.('button, a')) { e.preventDefault(); return focus.current ? nextNeeding() : primaryAction(); }
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); if (ids[i + 1]) goTo(ids[i + 1], 1); return; }
  if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); if (i > 0) goTo(ids[i - 1], -1); return; }
  const q = focus.current && qById(focus.current);
  if (!q) return;
  if (e.key === 'e') {
    e.preventDefault();
    const t = $('board').querySelector('[data-edit]');
    if (t) { t.focus(); if (t.type !== 'number') t.setSelectionRange(t.value.length, t.value.length); }
    return;
  }
  if (e.key === 's' || e.key === 'S') return skipCurrent();
  if (e.key === '?') { e.preventDefault(); return openAsk(); }
  if (/^[1-9]$/.test(e.key)) $('board').querySelectorAll('.f-card .choice')[Number(e.key) - 1]?.click();
});

// ---------- custom-layout API ----------

function emit(name, payload) {
  for (const fn of listeners[name] || []) {
    try { fn(payload); } catch (err) { console.error(err); }
  }
}

const api = {
  answer: (qid, value) => setAnswer(qid, { value }),
  note: (qid, note) => setAnswer(qid, { note }),
  explain: (qid, text = '') => post('explain', { qid, text }),
  skip: (qid, skipped = true) => post('skip', { qid, skipped }),
  send: () => sendAll(),
  done: () => $('done').click(),
  open: (qid) => reveal(qid),
  state: () => ({ ...view, answers: Object.fromEntries(view.questions.map((q) => [q.id, answerOf(q.id)])) }),
  on: (name, fn) => { (listeners[name] ||= []).push(fn); return () => { listeners[name] = listeners[name].filter((f) => f !== fn); }; },
  renderQuestion: (qid, node) => { const c = cards.get(qid); if (c) node.replaceChildren(c.el); },
};
window.punchList = api;

// ---------- live connection ----------

function render(next) {
  const wasExplaining = view ? new Set(view.questions.filter((q) => q.state?.explaining).map((q) => q.id)) : new Set();
  view = next;
  if (isFocus()) {
    if (layoutKey !== 'focus') { layoutKey = 'focus'; cards.clear(); focus.hardKey = null; }
    if (!focus.current || !view.questions.some((q) => q.id === focus.current)) focus.current = firstNeeding(null);
    renderFocus();
    renderChrome();
  } else {
    const lk = JSON.stringify([view.layout, view.questions.map((q) => [q.id, q.group])]);
    if (lk !== layoutKey) { layoutKey = lk; buildLayout(); }
    else for (const q of view.questions) updateCard(q);
    for (const id of [...cards.keys()]) if (!view.questions.some((q) => q.id === id)) cards.delete(id);
    renderChrome();
    refreshCards();
  }
  for (const q of view.questions) {
    if (wasExplaining.has(q.id) && !q.state?.explaining) {
      toast(`New explanation on “${q.title}”`);
      announce(`Claude explained “${q.title}”.`);
    }
  }
  emit('state', api.state());
}

function connect() {
  const es = new EventSource(`/b/${encodeURIComponent(boardId)}/stream?t=${encodeURIComponent(token)}`);
  let lostTimer;
  let lost = false;
  es.addEventListener('state', (e) => {
    clearTimeout(lostTimer);
    $('banner-conn').hidden = true;
    render(JSON.parse(e.data));
    if (lost) {
      lost = false;
      // Back online: save anything that failed while the server was away.
      flushAll().catch(() => {});
    }
  });
  es.onerror = () => {
    lost = true;
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => ($('banner-conn').hidden = false), 1500);
  };
}

window.addEventListener('beforeunload', () => { for (const qid of Object.keys(saveTimers)) flushOne(qid); });
connect();
