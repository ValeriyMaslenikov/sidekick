# punch-list Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `punch-list` skill: a local server with a live Board page plus a shell CLI for agents, shipped as a committed single-file bundle.

**Architecture:**
- One Node process (`punch-list serve`) holds every Board under `~/.sidekick/`.
  - It serves the page and pushes state to the browser over server-sent events.
  - It answers the CLI over HTTP on 127.0.0.1 with a per-install token.
- The CLI starts the server on demand.
- `wait` long-polls in 25 s slices until Events arrive, so it can run in the background in Claude Code.
- The page is plain HTML/JS embedded into the bundle as text.

**Tech Stack:**
- Node 24, TypeScript, pnpm (dev only).
- Server: `hono` + `@hono/node-server`.
- Build and test: `esbuild` (bundle), `vitest`.
- Page: Mermaid loaded from jsDelivr on demand.

**Spec:** `docs/superpowers/specs/2026-10-26-punch-list-design.md` (vocabulary in `CONTEXT.md`)

## Global Constraints

- Bind `127.0.0.1` only. Every API and page request needs the token: header `x-sidekick-token`, or `?t=` on page and SSE URLs.
- Home dir: `~/.sidekick`, overridable with the `SIDEKICK_HOME` env var (tests always set it).
- Config: `~/.sidekick/config.json` = `{ "port": 7317, "retentionDays": 90 }`. Token in `~/.sidekick/token`.
- Retention: delete Boards whose `createdAt` is older than `retentionDays`, on server start.
- Retention notice: show it the first time, and again whenever the config contents change. Its text: `Boards are kept for <N> days; change that in <config path>`.
- Listener is live while a `wait` poll is open, or within 10 s of the last one.
- `bin/punch-list.mjs` runs on plain Node ≥ 20 with no `node_modules`.
- Board ids: `^[a-z0-9][a-z0-9-]{0,62}$`.

## Review Focus

1. **Page reload mid-answer:** typed but unsent answers survive. They are saved on the server as drafts (debounced) and restored. Covered in Task 3 (`saveDraft` test) and Task 5 (manual check).
2. **Server restart while `wait` runs in the background:** `wait` retries the connection and restarts the server instead of dying. Covered in Task 4 (`wait survives server restart` test).
3. **Agent pushes an edit to an answered Question:** the Answer is kept and the Question flagged `changed`; an unchanged re-push does not flag it. Covered in Task 2.
4. **Port already taken by something else:** the CLI exits non-zero with `Port 7317 is in use by another program; set "port" in <config>`. Covered in Task 4.
5. **Bad Board JSON from the agent** (unknown type, duplicate question id): the CLI exits non-zero with a message naming the field, and the Board is unchanged. Covered in Task 2.

---

### Task 1: Repo scaffold, paths, config, token, retention

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE` (MIT), `src/punch-list/paths.ts`, `src/punch-list/config.ts`, `src/punch-list/retention.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `paths(): { home, config, token, state, boards, boardDir(id) }`
  - `loadConfig(): { port: number; retentionDays: number }`: creates the default file if missing.
  - `getToken(): string`: creates 32 random hex chars if missing, file mode 0600.
  - `takeRetentionNotice(): string | null`: returns the notice once per config hash, recording the hash in `state.json`.
  - `cleanupBoards(now: Date): string[]`: returns the deleted ids.

- [ ] Step 1: Tests:
  - `loadConfig` creates `{port:7317,retentionDays:90}`.
  - `getToken` is stable across calls.
  - `takeRetentionNotice` returns the text, then `null`, then the text again after the config file changes.
  - `cleanupBoards` deletes a Board whose `meta.json` `createdAt` is 91 days old and keeps one that is 89 days old.
- [ ] Step 2: Run `pnpm vitest run test/config.test.ts`. Expect it to FAIL.
- [ ] Step 3: Implement. Hash = sha256 of the config file text.
- [ ] Step 4: Run again. Expect PASS. Commit.

### Task 2: Board model and store

**Files:**
- Create: `src/punch-list/model.ts`, `src/punch-list/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces types:
  - `QuestionType = 'yes-no'|'single'|'multi'|'text'|'number'|'scale'|'rank'|'custom'`
  - `Question {id,title,body?,type,options?,min?,max?,step?,showIf?:Record<string,string|string[]>,optional?,group?}`
  - `Layout {type:'list'|'tabs'|'wizard'|'columns'|'custom', groups?:{id,title}[], html?, script?}`
  - `QState {status:'open'|'answered'|'skipped'|'withdrawn', changed:boolean, withdrawReason?, explaining:boolean, explanations:{at,html,question?}[]}`
  - `AnswerValue {value:unknown, note?:string}`
  - `BoardEvent {seq, at, type:'answers'|'explain'|'done'|'reopened', data}`
  - `Board {id,title,intro?,layout,questions,qstate:Record<id,QState>,drafts:Record<id,AnswerValue>,sent:Record<id,AnswerValue>,done:boolean,createdAt,projectDir,sessionId?,rev,readCursor}`
- Produces functions:
  - `validateBoardInput(x): {title,intro?,layout?,questions}`: throws `Error` naming the field.
  - `store.create(id, input, {projectDir, sessionId, replace})`
  - `store.push(id, patch)`: upsert questions; `changed=true` only when the JSON of an answered question differs.
  - `store.explain(id, qid, html)`, `store.withdraw(id, qid, reason)`
  - `store.saveDraft(id, qid, AnswerValue)` (no Event)
  - `store.skip(id, qid, skipped)`
  - `store.requestExplain(id, qid, text)` → Event `explain`
  - `store.send(id)` → Event `answers` with the drafts that differ from `sent`
  - `store.done(id)` → sends, then Event `done` with summary `{answered,skipped,unanswered}`
  - `store.reopen(id)`
  - `store.readEvents(id, advance=true)`, `store.get(id)`, `store.list()`, `store.remove(id)`
- Every mutation bumps `rev` and calls `onChange(id)`.
- An agent push or explain on a done Board sets `done=false`.

- [ ] Step 1: Tests:
  - create, then get round-trips.
  - Create again without `replace` throws `already exists`.
  - A duplicate question id throws, naming `questions[1].id`.
  - Push with a changed title on an answered question → `changed:true`. Identical push → `changed` stays `false`.
  - `send` emits only changed drafts. A second `send` with no changes emits nothing.
  - `done` summary counts are correct.
  - `readEvents` advances the cursor, so the second call is empty.
  - A push after done → `done:false`.
- [ ] Step 2: Run. Expect FAIL.
- [ ] Step 3: Implement. Write files atomically: `board.json` (write tmp + rename) and `events.jsonl` (append).
- [ ] Step 4: Run. Expect PASS. Commit.

### Task 3: HTTP server (API, SSE, listener tracking, page)

**Files:**
- Create: `src/punch-list/server.ts`, `src/punch-list/page/index.html`, `src/punch-list/page/app.js`, `src/punch-list/page/styles.css`
- Test: `test/server.test.ts` (uses `app.request`)

**Interfaces:**
- Consumes: Task 1 and Task 2.
- Produces: `createApp(store): Hono` and `startServer(): Promise<{port}>`.
- Agent routes (token header):
  - `POST /api/boards` `{id,input,replace,projectDir,sessionId}`
  - `POST /api/boards/:id/push`
  - `POST /api/boards/:id/explain` `{qid,html}`
  - `POST /api/boards/:id/withdraw`
  - `GET /api/boards/:id/wait?timeout=<s>` (≤25 s, returns `{events}`)
  - `GET /api/boards/:id`, `GET /api/boards`, `DELETE /api/boards/:id`
  - `GET /api/health` → `{app:'punch-list', version}`
  - `GET /api/listening?session=<id>&cwd=<dir>` → Boards not done with no live Listener
- Page routes (`?t=`):
  - `GET /` (index of Boards), `GET /b/:id`, `GET /b/:id/stream` (SSE: `state` event carrying the page view + `listening`)
  - `POST /b/:id/draft|skip|explain|send|done|reopen`
- The page view includes `listening:boolean` and `resumePrompt`, e.g. `Resume listening on punch-list board "<id>": run status, then wait.`

- [ ] Step 1: Tests:
  - Missing token → 401.
  - Create, then `wait?timeout=0` → `{events:[]}`.
  - Page POST `explain` → the next `wait` returns the `explain` Event.
  - `wait` held open marks the Board listening; 11 s after it closes it is not listening (fake timers).
  - `/api/listening` filters by sessionId.
  - `saveDraft` via `POST /b/:id/draft`, then `GET /api/boards/:id` shows the draft.
- [ ] Step 2: Run. Expect FAIL.
- [ ] Step 3: Implement the server. Write the page (`app.js`) with these parts:
  - **Render:** keyed per-question cards, re-rendered only when that question's JSON or state changes. Focused inputs keep their caret.
  - **Layouts:** list, tabs, wizard, columns, custom. Custom renders `layout.html`, mounts cards into `[data-pl-question=<id>]`, then runs `layout.script` with `window.punchList = {answer, explain, skip, send, done, state, on, renderQuestion}`.
  - **Rules:** `showIf` evaluation.
  - **Answer inputs:** all the answer types. `rank` uses up/down buttons. `custom` reads `punchList.answer`.
  - **Explanations:** an Explanations thread per card, with an "Explain better" box.
  - **States:** the Skip toggle, the Changed banner with a Confirm button, and the Withdrawn style.
  - **Chrome:** the sticky bar with the open count, "Send to Claude" (shows how many are unsent), and Done (with a warning when some are unanswered), plus the not-listening banner with a Copy button.
  - **Drafts:** debounced at 400 ms.
  - **Rich content:** Mermaid via `import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs')`, only when a `.mermaid` element exists. Light and dark themes.
- [ ] Step 4: Run. Expect PASS. Commit.

### Task 4: CLI, server auto-start, stop hook, bundle

**Files:**
- Create: `src/punch-list/cli.ts`, `src/punch-list/client.ts`, `scripts/build.mjs`, `skills/punch-list/bin/punch-list.mjs` (build output, committed)
- Test: `test/cli.test.ts` (spawns the built bundle with a temp `SIDEKICK_HOME` and a random port)

**Interfaces:**
- Commands:
  - `open <id> --file <path|-> [--replace] [--no-open]` → `{url, notice?}`
  - `push <id> --file`
  - `explain <id> <qid> (--file|--html)`
  - `withdraw <id> <qid> --reason`
  - `wait <id> [--timeout <s>]`: default waits forever. Prints a JSON array of Events once, then exits 0.
  - `status <id>`, `url <id>`, `list`, `rm <id>`
  - `serve` (internal, foreground), `stop`
  - `hook-stop`: reads the Claude Code hook JSON from stdin. If a Board for that `session_id` is not done and has no Listener, prints `{"decision":"block","reason":"..."}`.
- `ensureServer()`:
  - GET `/api/health`. If nothing is listening, spawn `serve` detached and poll for up to 5 s.
  - If something answers but isn't punch-list, exit with code 2 and the port message.
- `open` records `CLAUDE_CODE_SESSION_ID` and `process.cwd()`. It launches the browser via `open`/`xdg-open`.

- [ ] Step 1: Tests:
  - `open` prints a url containing `/b/<id>?t=`.
  - `wait --timeout 0` prints `[]`.
  - A page `explain` while `wait` runs makes it exit with that Event.
  - Kill the server mid-`wait` → `wait` restarts it and still gets a later Event.
  - Port held by a plain `http.createServer` → exit 2 with the message.
  - `hook-stop` blocks for that session and is silent after `done`.
- [ ] Step 2: Build with `node scripts/build.mjs`: esbuild, platform node, format esm, the page files as `text` loader, banner `#!/usr/bin/env node`.
- [ ] Step 3: Run tests. Expect PASS. Commit, including the bundle.

### Task 5: Skill, plugin packaging, install script, README, live test

**Files:**
- Create:
  - `skills/punch-list/SKILL.md`, `skills/punch-list/reference/board-format.md`
  - `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`
  - `scripts/install-skills.mjs`, `README.md`

- [ ] Step 1: `SKILL.md`:
  - When to use it: 4 or more questions, or any question that needs visuals.
  - The loop: `open`, tell the user the URL and any notice, run `wait` in the background, and on each wake handle Explain requests first (with `explain`), record Answers, push follow-ups, act only on `done`, then restart `wait`.
  - Choosing a Layout. Resuming via `status`. Never ending work silently while a Board isn't done.
- [ ] Step 2: `hooks/hooks.json` sets a Stop hook to `node ${CLAUDE_PLUGIN_ROOT}/skills/punch-list/bin/punch-list.mjs hook-stop`. The install script symlinks `skills/*` into `~/.claude/skills` and `~/.agents/skills`, and adds the same Stop hook to `~/.claude/settings.json` (idempotent, backing the file up first).
- [ ] Step 3: Live test.
  - Open a sample Board covering every Layout and answer type with Mermaid.
  - Drive it in a real browser: answer, explain, send, done.
  - Confirm the background `wait` wakes, and that an Explanation appears live.
- [ ] Step 4: Commit.
