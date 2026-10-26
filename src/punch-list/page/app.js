// punch-list Board page. Renders the Board the server streams over SSE, keeps the
// person's typing local until it is saved, and talks back with small POSTs.

const token = new URLSearchParams(location.search).get('t') || '';
const boardId = decodeURIComponent(location.pathname.split('/')[2] || '');
const $ = (id) => document.getElementById(id);

let view = null;
/** Answers typed here but not yet confirmed saved by the server: qid -> {value, note}. */
const local = {};
const saveTimers = {};
const inflight = new Set();
/** qid -> { el, parts, keys } */
const cards = new Map();
let layoutKey = null;
let modal = null; // { qid, parent, next }
const listeners = {};
const ui = loadUi();

// ---------- helpers ----------

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
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
        const dark = matchMedia('(prefers-color-scheme: dark)').matches;
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

function hasValue(a) {
  if (!a) return false;
  const v = a.value;
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function answerOf(qid) {
  return local[qid] ?? view?.drafts?.[qid];
}

function statusOf(q) {
  if (q.state?.withdrawn) return 'withdrawn';
  if (hasValue(answerOf(q.id))) return 'answered';
  if (q.state?.skipped) return 'skipped';
  return 'open';
}

function isUnsent(qid) {
  return view.unsent.includes(qid) || qid in local;
}

function visible(q) {
  if (!q.showIf) return true;
  return Object.entries(q.showIf).every(([dep, want]) => {
    const got = answerOf(dep)?.value;
    const wants = Array.isArray(want) ? want.map(String) : [String(want)];
    if (Array.isArray(got)) return got.some((g) => wants.includes(String(g)));
    return got !== undefined && got !== null && wants.includes(String(got));
  });
}

// ---------- answers ----------

function setAnswer(qid, patch) {
  const cur = answerOf(qid) || { value: null };
  const next = { ...cur, ...patch };
  if (!next.note) delete next.note;
  local[qid] = next;
  clearTimeout(saveTimers[qid]);
  saveTimers[qid] = setTimeout(() => flushOne(qid), 400);
  refreshDerived();
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

// ---------- question cards ----------

function defKey(q) {
  const { state, status, ...def } = q;
  return JSON.stringify([def, state?.changed, state?.withdrawn, state?.withdrawReason]);
}
function threadKey(q) {
  return JSON.stringify([q.state?.explanations, q.state?.explaining, q.state?.pendingQuestion]);
}

function makeCard(q) {
  const parts = {
    head: el('div', { class: 'card-head' }),
    body: el('div', { class: 'card-body rich' }),
    notice: el('div'),
    input: el('div', { class: 'card-input' }),
    note: el('div'),
    thread: el('div', { class: 'thread' }),
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
    renderNotice(q, parts.notice);
    renderInput(q, parts.input);
    renderNote(q, parts.note);
    renderActions(q, parts.actions, parts.ask);
    keys.draft = JSON.stringify(view.drafts[q.id]);
  } else {
    // Another tab or a reload changed the saved answer: show it unless the person is typing here.
    const dkey = JSON.stringify(view.drafts[q.id]);
    if (keys.draft !== dkey && !(q.id in local) && !focusedInside) {
      renderInput(q, parts.input);
      renderNote(q, parts.note);
    }
    keys.draft = dkey;
  }

  const tk = threadKey(q);
  if (keys.thread !== tk) {
    keys.thread = tk;
    renderThread(q, parts.thread);
  }
  refreshCardStatus(q, card);
  return card;
}

function refreshCardStatus(q, card) {
  const status = statusOf(q);
  card.el.classList.toggle('is-answered', status === 'answered');
  card.el.classList.toggle('is-withdrawn', status === 'withdrawn');
  card.el.classList.toggle('is-changed', !!q.state?.changed);
  const meta = card.parts.head.querySelector('.card-meta');
  if (meta) {
    meta.querySelector('[data-chip=status]').replaceWith(statusChip(q, status));
    const unsent = meta.querySelector('[data-chip=unsent]');
    unsent.hidden = !isUnsent(q.id) || status === 'withdrawn';
  }
  const skipBtn = card.parts.actions.querySelector('[data-act=skip]');
  if (skipBtn) {
    skipBtn.textContent = q.state?.skipped ? 'Unskip' : 'Skip for now';
    skipBtn.hidden = status === 'answered' || status === 'withdrawn';
  }
  card.el.hidden = !visible(q);
}

function statusChip(q, status) {
  const label = q.state?.changed ? 'changed' : q.state?.explaining ? 'explaining' : status;
  const tone = q.state?.changed ? 'attn' : q.state?.explaining ? 'accent' : status === 'answered' ? 'ok' : status === 'skipped' ? 'attn' : '';
  return el('span', { class: `chip ${tone}`, 'data-chip': 'status', text: label });
}

function renderHead(q, head) {
  head.replaceChildren(
    el('h3', { class: 'card-title', text: q.title }),
    el('div', { class: 'card-meta' },
      el('span', { 'data-chip': 'status' }),
      el('span', { class: 'chip accent', 'data-chip': 'unsent', text: 'unsent', title: 'Not sent to Claude yet' }),
      view.layout.type === 'columns' ? null : el('button', { type: 'button', class: 'btn small link', title: 'Open in a larger view', text: 'Expand', onclick: () => openModal(q.id) }),
    ),
  );
}

function renderNotice(q, box) {
  box.replaceChildren();
  if (q.state?.withdrawn) {
    box.append(el('div', { class: 'notice muted-box', text: `Withdrawn${q.state.withdrawReason ? `: ${q.state.withdrawReason}` : ''}` }));
  } else if (q.state?.changed) {
    box.append(el('div', { class: 'notice attn' },
      el('span', { text: 'Claude changed this question after you answered. Check your answer.' }),
      el('button', { type: 'button', class: 'btn small ghost', text: 'My answer still stands', onclick: () => post('confirm', { qid: q.id }) }),
    ));
  }
}

function renderInput(q, box) {
  box.replaceChildren();
  if (q.state?.withdrawn) return;
  const cur = answerOf(q.id)?.value;
  const name = `q-${q.id}`;
  switch (q.type) {
    case 'yes-no':
      box.append(seg([['yes', 'Yes'], ['no', 'No']], cur, (v) => setAnswer(q.id, { value: v })));
      break;
    case 'single':
    case 'multi': {
      const multi = q.type === 'multi';
      const chosen = new Set(multi ? (Array.isArray(cur) ? cur : []) : [cur]);
      box.append(el('div', { class: 'opts', role: multi ? 'group' : 'radiogroup' },
        (q.options || []).map((o) => {
          const input = el('input', { type: multi ? 'checkbox' : 'radio', name, value: o.value, checked: chosen.has(o.value) });
          input.addEventListener('change', () => {
            if (!multi) return setAnswer(q.id, { value: o.value });
            const now = new Set(Array.isArray(answerOf(q.id)?.value) ? answerOf(q.id).value : []);
            input.checked ? now.add(o.value) : now.delete(o.value);
            setAnswer(q.id, { value: (q.options || []).map((x) => x.value).filter((v) => now.has(v)) });
          });
          const label = el('span', { class: 'opt-label' }, el('span', { class: 'rich' }));
          setRich(label.firstChild, o.label);
          if (o.recommended) label.append(el('span', { class: 'chip attn', text: 'recommended' }));
          const body = el('span', { class: 'rich' }, label);
          if (o.detail) {
            const d = el('span', { class: 'opt-detail rich' });
            setRich(d, o.detail);
            body.append(d);
          }
          return el('label', { class: 'opt' }, input, body);
        }),
      ));
      break;
    }
    case 'text': {
      const ta = el('textarea', { name, placeholder: 'Type your answer' });
      ta.value = typeof cur === 'string' ? cur : '';
      ta.addEventListener('input', () => setAnswer(q.id, { value: ta.value }));
      box.append(ta);
      break;
    }
    case 'number': {
      const inp = el('input', { type: 'number', name, min: q.min, max: q.max, step: q.step });
      inp.value = cur ?? '';
      inp.addEventListener('input', () => setAnswer(q.id, { value: inp.value === '' ? null : Number(inp.value) }));
      box.append(inp);
      break;
    }
    case 'scale': {
      const min = q.min ?? 1, max = q.max ?? 5, step = q.step ?? 1;
      const vals = [];
      for (let v = min; v <= max + 1e-9; v += step) vals.push([v, String(v)]);
      box.append(seg(vals, cur, (v) => setAnswer(q.id, { value: v })));
      break;
    }
    case 'rank':
      box.append(rankList(q, cur));
      break;
    case 'custom':
      if (hasValue(answerOf(q.id))) box.append(el('div', { class: 'muted', text: `Recorded: ${JSON.stringify(cur)}` }));
      break;
  }
}

function seg(values, cur, onPick) {
  return el('div', { class: 'seg' },
    values.map(([v, label]) =>
      el('button', { type: 'button', class: 'btn ghost', 'aria-pressed': String(cur === v), text: label, onclick: (e) => {
        for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
        onPick(v);
      } }),
    ),
  );
}

function rankList(q, cur) {
  const all = (q.options || []).map((o) => o.value);
  const order = Array.isArray(cur) ? [...cur.filter((v) => all.includes(v)), ...all.filter((v) => !cur.includes(v))] : all;
  const labelOf = (v) => q.options.find((o) => o.value === v)?.label ?? v;
  const move = (i, d) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setAnswer(q.id, { value: next });
    renderInput(q, cards.get(q.id).parts.input);
  };
  const list = el('ol', { class: 'rank' },
    order.map((v, i) => el('li', {},
      el('span', { text: labelOf(v) }),
      el('button', { type: 'button', class: 'btn small ghost', text: '↑', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }),
      el('button', { type: 'button', class: 'btn small ghost', text: '↓', 'aria-label': 'Move down', disabled: i === order.length - 1, onclick: () => move(i, 1) }),
    )),
  );
  const wrap = el('div', { class: 'section' }, list);
  if (!Array.isArray(cur)) wrap.append(el('button', { type: 'button', class: 'btn small ghost', text: 'This order is fine', onclick: () => { setAnswer(q.id, { value: order }); renderInput(q, cards.get(q.id).parts.input); } }));
  return wrap;
}

function renderNote(q, box) {
  box.replaceChildren();
  if (q.state?.withdrawn) return;
  const note = answerOf(q.id)?.note || '';
  const ta = el('textarea', { placeholder: 'Note for Claude (optional)', rows: 2 });
  ta.value = note;
  ta.style.minHeight = '44px';
  ta.addEventListener('input', () => setAnswer(q.id, { note: ta.value }));
  if (note) return box.append(ta);
  const toggle = el('button', { type: 'button', class: 'btn small link note-toggle', text: '+ Add a note', onclick: () => { toggle.replaceWith(ta); ta.focus(); } });
  box.append(toggle);
}

function renderThread(q, box) {
  box.replaceChildren();
  for (const x of q.state?.explanations || []) {
    const item = el('div', { class: 'expl' });
    if (x.question) item.append(el('div', { class: 'expl-q' }, el('strong', { text: 'You asked: ' }), document.createTextNode(x.question)));
    const body = el('div', { class: 'rich' });
    setRich(body, x.html);
    item.append(body);
    box.append(item);
  }
  if (q.state?.explaining) {
    box.append(el('div', { class: 'explaining' },
      el('span', { class: 'dots', text: 'Claude is explaining' }),
      q.state.pendingQuestion ? el('span', { class: 'muted', text: `(${q.state.pendingQuestion})` }) : null,
    ));
  }
}

function renderActions(q, actions, ask) {
  actions.replaceChildren();
  ask.replaceChildren();
  if (q.state?.withdrawn) return;
  const askBox = () => {
    const ta = el('textarea', { placeholder: "What's unclear? Ask your own question, or leave empty for a simpler explanation." });
    const submit = async () => {
      await post('explain', { qid: q.id, text: ta.value });
      ask.replaceChildren();
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
    ask.replaceChildren(el('div', { class: 'ask' }, ta,
      el('div', { class: 'card-actions' },
        el('button', { type: 'button', class: 'btn small', text: 'Ask Claude', onclick: submit }),
        el('button', { type: 'button', class: 'btn small ghost', text: 'Cancel', onclick: () => ask.replaceChildren() }),
      )));
    ta.focus();
  };
  actions.append(
    el('button', { type: 'button', class: 'btn small ghost', text: 'Wait, what? Explain better', onclick: askBox }),
    el('button', { type: 'button', class: 'btn small link', 'data-act': 'skip', onclick: () => post('skip', { qid: q.id, skipped: !q.state?.skipped }) }),
  );
}

// ---------- layouts ----------

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

function computeLayoutKey() {
  return JSON.stringify([view.layout, view.questions.map((q) => [q.id, q.group])]);
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

function pages() {
  const groups = groupsOf();
  if (groups) return groups;
  return view.questions.map((q, i) => ({ id: q.id, title: `${i + 1}. ${q.title.length > 28 ? q.title.slice(0, 27) + '…' : q.title}`, qs: [q] }));
}

function buildTabs(root) {
  const ps = pages();
  if (!ps.length) return;
  if (!ps.some((p) => p.id === ui.tab)) ui.tab = ps[0]?.id;
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  const panel = el('div', { class: 'section' });
  const show = (id) => {
    ui.tab = id;
    saveUi();
    for (const b of bar.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    panel.replaceChildren(...ps.find((p) => p.id === id).qs.map((q) => cards.get(q.id).el));
    queueMermaid();
  };
  for (const p of ps) {
    bar.append(el('button', { type: 'button', class: 'tab', role: 'tab', 'data-id': p.id, onclick: () => show(p.id) },
      el('span', { text: p.title }), el('span', { class: 'count', 'data-count': p.id })));
  }
  root.append(bar, panel);
  show(ui.tab);
}

function buildWizard(root) {
  const ps = pages();
  if (!ps.length) return;
  ui.step = Math.min(Math.max(0, ui.step || 0), ps.length - 1);
  const progress = el('div', { class: 'progress' }, el('div'));
  const label = el('span', { class: 'muted' });
  const panel = el('div', { class: 'section' });
  const back = el('button', { type: 'button', class: 'btn ghost', text: 'Back' });
  const next = el('button', { type: 'button', class: 'btn', text: 'Next' });
  const show = (i) => {
    ui.step = i;
    saveUi();
    const p = ps[i];
    label.textContent = `Step ${i + 1} of ${ps.length}${p && view.layout.groups?.length ? ` · ${p.title}` : ''}`;
    progress.firstChild.style.width = `${((i + 1) / ps.length) * 100}%`;
    panel.replaceChildren(...(p ? p.qs.map((q) => cards.get(q.id).el) : []));
    back.disabled = i === 0;
    next.disabled = i === ps.length - 1;
    next.textContent = i === ps.length - 1 ? 'Last step' : 'Next';
    queueMermaid();
    scrollTo({ top: 0, behavior: 'smooth' });
  };
  back.onclick = () => show(ui.step - 1);
  next.onclick = () => show(ui.step + 1);
  root.append(progress, el('div', { class: 'wizard-nav' }, label), panel, el('div', { class: 'wizard-nav' }, back, next));
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
    ? [['open', 'Open'], ['skipped', 'Skipped'], ['answered', 'Answered'], ['withdrawn', 'Withdrawn']].map(([id, title]) => ({ id, title, qs: view.questions.filter((q) => statusOf(q) === id) }))
    : groupsOf();
  wrap.replaceChildren(...cols.filter((c) => c.qs.length || c.id === 'open').map((c) => {
    const shown = c.qs.filter(visible);
    return el('div', { class: 'column' },
      el('h2', {}, el('span', { text: c.title }), el('span', { text: String(shown.length) })),
      shown.map((q) => {
        const status = statusOf(q);
        return el('button', { type: 'button', class: 'mini', onclick: () => openModal(q.id) },
          el('span', { class: 'mini-title', text: q.title }),
          el('span', { class: 'card-meta' }, statusChip(q, status), isUnsent(q.id) ? el('span', { class: 'chip accent', text: 'unsent' }) : null),
        );
      }),
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

// ---------- modal ----------

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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------- bar, banners, counts ----------

function refreshDerived() {
  if (!view) return;
  for (const q of view.questions) {
    const card = cards.get(q.id);
    if (card) refreshCardStatus(q, card);
  }
  const shown = view.questions.filter((q) => visible(q) && statusOf(q) !== 'withdrawn');
  const count = (s) => shown.filter((q) => statusOf(q) === s).length;
  const unsent = shown.filter((q) => isUnsent(q.id)).length;
  $('counts').replaceChildren(...[
    el('span', { text: `${count('answered')}/${shown.length} answered` }),
    count('skipped') ? el('span', { text: `${count('skipped')} skipped` }) : null,
    el('span', { text: unsent ? `${unsent} unsent` : 'all sent' }),
  ].filter(Boolean));
  const send = $('send');
  send.textContent = unsent ? `Send to Claude (${unsent})` : 'Send to Claude';
  send.disabled = unsent === 0;
  $('done').textContent = view.done ? 'Done ✓' : 'Done';
  $('done').disabled = view.done;
  for (const badge of document.querySelectorAll('[data-count]')) {
    const p = pages().find((x) => x.id === badge.dataset.count);
    const open = p ? p.qs.filter((q) => visible(q) && ['open', 'skipped'].includes(statusOf(q))).length : 0;
    badge.textContent = open ? String(open) : '✓';
  }
  if (view.layout.type === 'columns' && !modal) fillColumns();
}

function refreshBanners() {
  $('banner-listen').hidden = view.listening || view.done;
  $('resume-prompt').textContent = view.resumePrompt;
  $('banner-done').hidden = !view.done;
  const dot = $('listen-dot');
  dot.classList.toggle('on', view.listening);
  dot.title = view.listening ? 'Claude is listening' : "Claude isn't listening";
}

$('copy-resume').addEventListener('click', async () => {
  const text = $('resume-prompt').textContent;
  try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into your agent.'); }
  catch { const r = document.createRange(); r.selectNodeContents($('resume-prompt')); getSelection().removeAllRanges(); getSelection().addRange(r); }
});

$('send').addEventListener('click', async () => {
  await flushAll();
  const { sent } = await post('send');
  toast(sent ? 'Sent to Claude.' : 'Nothing new to send.');
});

$('done').addEventListener('click', async () => {
  await flushAll();
  const shown = view.questions.filter((q) => visible(q) && statusOf(q) !== 'withdrawn');
  const open = shown.filter((q) => statusOf(q) === 'open').length;
  const skipped = shown.filter((q) => statusOf(q) === 'skipped').length;
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
  send: () => $('send').click(),
  done: () => $('done').click(),
  open: (qid) => openModal(qid),
  state: () => ({ ...view, answers: Object.fromEntries(view.questions.map((q) => [q.id, answerOf(q.id)])) }),
  on: (name, fn) => { (listeners[name] ||= []).push(fn); return () => { listeners[name] = listeners[name].filter((f) => f !== fn); }; },
  renderQuestion: (qid, node) => { const c = cards.get(qid); if (c) node.replaceChildren(c.el); },
};
window.punchList = api;

// ---------- live connection ----------

function render(next) {
  const firstRender = !view;
  view = next;
  document.title = `${view.title} · punch-list`;
  $('title').textContent = view.title;
  $('board-id').textContent = view.id;
  if ($('intro').dataset.html !== (view.intro || '')) {
    $('intro').dataset.html = view.intro || '';
    setRich($('intro'), view.intro);
  }
  const lk = computeLayoutKey();
  if (lk !== layoutKey) {
    layoutKey = lk;
    buildLayout();
  } else {
    for (const q of view.questions) updateCard(q);
  }
  for (const id of [...cards.keys()]) if (!view.questions.some((q) => q.id === id)) cards.delete(id);
  refreshBanners();
  refreshDerived();
  emit('state', api.state());
  if (firstRender) queueMermaid();
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
