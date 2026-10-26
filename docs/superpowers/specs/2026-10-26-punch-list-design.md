# punch-list — design

Date: 2026-10-26. Status: approved for planning after review.
Vocabulary: see [`CONTEXT.md`](../../../CONTEXT.md) (Board, Question, Answer, Explain request, Explanation, Layout, Event, Listener, Retention, Skipped / Changed / Withdrawn question).

## 1. Intent

Coding agents often end a turn with 10–20 questions in the terminal. That wall of text is hard to follow. Many questions are unclear without more context, so the person has to stop, ask about one, lose their place, answer the rest, and come back. That drains focus.

`punch-list` moves those questions to a live local web page, a **Board**. The person answers at their own pace, in any order, with rich visuals. When a Question is unclear, they press one button and the agent adds an Explanation in place, while they carry on with the rest. The agent keeps listening in the background, so the terminal stays free for normal chat.

It is the first skill in **`sidekick`**: a public, MIT-licensed repo of skills that help a person in daily work with AI agents.

## 2. Goals

1. The agent can put any number of Questions on a Board, at any visual complexity: free HTML, diagrams, tabs, CDN libraries.
2. Two-way and live:
   - The agent pushes Questions, Explanations, Layout changes and Question edits, and the page updates without a reload.
   - Explain requests reach the agent at once.
   - Answers reach the agent when the person presses **Send to Claude**.
3. Every Question has an **"Explain better"** button, with an optional "my question is…" box. It never blocks the rest of the Board.
4. The Layout fits the use case. The agent picks it, or the person asks for one in the terminal: list, tabs, wizard, columns (Jira-like), or fully custom.
5. Fully supported in Claude Code in v1. The CLI is shell-first, so other agents can use it with the limits in 5.11.
6. Zero-setup install via git clone, the Claude Code plugin marketplace, or `npx skills`.

## 3. Non-goals

- A chat channel. Requests that are not about one Question (for example "add a question about X" or "use tabs") go to the agent in the terminal, not through the Board.
- Hosting, multi-user sharing, or remote access. It is local-only, for one person on their own machine.
- Sandboxing the agent's HTML. The agent is trusted.
- An MCP server. It may come later, but v1 is shell-first.

## 4. Anti-goals (failure even if it "works")

- The person has to watch the terminal to know something changed on the Board, or the other way round.
- Pressing "Explain better" freezes the Board, or loses answers or drafts.
- The agent ends its turn and silently stops listening, so the person's Answers go nowhere and they don't know.
- The Board blocks the terminal chat while it is open.
- Installing needs more than one step, or needs `pnpm install` on the user's machine.
- Old Boards pile up forever in the home directory.

## 5. Decisions (made with the user)

### 5.1 Repo and naming
- Repo `sidekick`, public, MIT, at `~/Projects/personal/sidekick`. It is separate from the private `~/Projects/personal/local-skills`.
- Skill name `punch-list`. "Punch list" is builder's slang for the open items to settle before hand-off.
- Repo layout follows both the `npx skills` convention (`skills/<name>/SKILL.md`) and the Claude Code plugin convention (`.claude-plugin/`).

### 5.2 Agent ↔ server protocol
- **Shell-first CLI.** Any agent drives it through shell commands.
- **Listening model:** `wait <board>` blocks until at least one Event exists after the agent's cursor, then prints the Events and exits. The agent runs it **in the background**, so Claude Code can end its turn and the person can keep chatting. When `wait` exits, the agent is woken, handles the Events, and immediately starts a new `wait`.
- **Events are durable and ordered.** They are stored on disk. A `wait` returns everything the agent hasn't seen yet, so nothing is lost while no Listener is running.
- **Answers are delivered when the person sends them, not on every change.**
  - Answers are saved on the server as the person types, so nothing is lost on reload.
  - They reach the agent only when the person presses **Send to Claude**. That sends every new or changed Answer since the last send, and can be pressed any number of times. Done also sends.
  - The agent wakes once per send, not once per keystroke or choice, which keeps token use sane.
- **Explain requests are delivered at once.** The person is waiting on those.
- **On each wake for Answers:** the agent records them and pushes any follow-ups. It treats them as final for acting only on Done, because Answers can still change.

### 5.3 Listener guarantees
- A Board that is not done should always have a Listener.
- The page shows whether an agent is listening. When none is, it shows "Claude isn't listening" with a **copyable prompt** that tells the agent to resume listening on this Board. This is the fallback for every agent.
- **Claude Code stop hook:** when Claude tries to end its turn, the hook blocks only if a Board opened by this agent is not done **and** has no live Listener. It never blocks just because a Board is open, since the background `wait` is what keeps the chat free.

### 5.4 Question model
- Each Question is a **JSON wrapper around a free HTML body**.
  - Wrapper: id, title, answer type, options, `showIf` rules, optional flag.
  - Body: any HTML, including Mermaid diagrams, tabs inside the question, and CDN libraries.
- Answer types:
  - `yes-no`, `single`, `multi`, `text`, `number`/`scale`, `rank` (drag to order).
  - `custom`: the question's own HTML provides the input and reports a value through the helper library.
- Every answer type has an optional per-question note.
- **Follow-ups work two ways:**
  - Declarative `showIf` rules (for example, show Q4 when Q3 = "yes") for instant cases.
  - The agent reacts to an Answer Event and pushes new Questions, for cases that need thinking.

### 5.5 Explain better
- Every Question has an "Explain better" button with an optional free-text box.
- Pressing it sends an Explain request Event and marks the Question "Claude is explaining…". The rest of the Board stays usable.
- The agent replies by adding an **Explanation**, which can hold any HTML, including diagrams and examples. It appears live under the Question.
- Explanations stack like a mini thread, and the person can ask again.

### 5.6 Question states
- **Skipped:** the person sets the Question aside. It stays open, and the Board shows how many are still open.
- **Changed:** the agent edited an answered Question. The Answer is kept, the Question is flagged "Changed: check your answer", and confirming or changing it sends an Event.
- **Withdrawn:** the agent no longer needs the Question. It is greyed out, shows the agent's reason, and is never silently deleted.
- **Done:** allowed with open or skipped Questions. The page warns first (for example "3 questions not answered"). The Done Event lists what was answered, skipped and unanswered.
- **Done is not final.** The person can reopen the Board, and the agent can push follow-up Questions after reading the summary. Either one puts the Board back to "not done", so it needs a Listener again and the stop hook applies.

### 5.7 Layouts
- Built-in: **list, tabs, wizard, columns**. The agent assigns Questions to groups, steps or columns.
- **Modal** is not a Layout. It is an "open details" display available in any Layout.
- **Custom Layout:** the agent supplies the page shell (HTML/JS) and uses the in-page helper library. That library offers answer, explain, skip and done, and subscriptions to new Explanations, Question edits and Layout changes.
- In every Layout the Question stays the unit, so Answers, Explain requests and states behave the same.
- **Live Layout change:** the agent can switch the Layout mid-Board. The page redraws, and Answers and unsent drafts are kept.

### 5.8 Server, storage and Retention
- **One background server** for all Boards, started automatically by the CLI when it isn't running.
- Each Board is at `/b/<board>`. An index page lists all Boards with their status (open or done).
- Boards are stored under `~/.sidekick/boards/<board>/`: the definition, Answers, Explanations and the Event log. Restarts lose nothing.
- **Retention:**
  - On server start, Boards opened more than **90 days** ago are deleted.
  - The limit lives in a config file under `~/.sidekick/`.
  - The server's start output tells the agent to notify the person: "Boards are kept for 90 days; change that in `<path to config>`".
  - The notice is shown **the first time on a machine and again after the config changes**, not on every start.
- The agent also cleans up after itself, for example removing a Board when the person asks to.

### 5.9 Safety
- Listens only on **127.0.0.1**.
- A **random per-install token** is required in the Board URL and on every write request. This stops other websites in the browser from reading or writing Boards through localhost.
- The agent's HTML runs unsandboxed. This is by design, because sandboxing would block rich Layouts.

### 5.10 Stack and distribution
- Node 24 + TypeScript, pnpm for development, Hono for HTTP, **server-sent events** for server → page, and plain HTTP POST for page → server.
- The page itself is plain HTML/JS with **no build step**. Libraries load from CDNs on demand, and Mermaid is supported.
- A **prebuilt single-file bundle is committed**, so it runs on plain Node with no install step. That means marketplace and `npx skills` installs, which only copy files, work out of the box. pnpm is for developing the repo only.
- Git-clone installs get a script that symlinks each skill into `~/.claude/skills` (and `~/.agents/skills` for other agents), plus the Claude Code stop hook.
- The skill's `SKILL.md` calls the bundle by a path relative to its own folder, so no global install is needed.
- The browser tab opens automatically the first time a Board gets Questions.

### 5.11 Other agents (v1)
- v1 fully supports **Claude Code only**.
- Other agents can use the same CLI. Because most of them can't run `wait` in the background, their `wait` blocks their chat while it runs. The README says so plainly, and the page's copyable resume prompt is their fallback.
- `wait --timeout 0` (a non-blocking check) exists from day one, so proper support for other agents (checking at turn boundaries) is cheap to add later.

## 6. Calls made by the designer (check these)

- **Listener liveness:** the server counts a Listener as live while a `wait` connection is open. After a `wait` ends there is a short grace period (about 10 s) before the page says "not listening", because the agent reconnects between Events.
- **CLI shape:** one binary per skill (`skills/punch-list/bin/punch-list.mjs`) with subcommands, roughly:
  - `open` (create or replace a Board from a JSON file)
  - `push` (add or update Questions or Layout)
  - `explain <qid>` (add an Explanation)
  - `withdraw <qid>`
  - `wait`
  - `status`, `url`, `rm`
  Exact flags are left to the builder.
- **`wait` output:** JSON lines on stdout, one per Event, with a cursor so the next `wait` continues from it.
- **Fixed default port, configurable.** If the port is taken by something that isn't the punch-list server, fail clearly.
- **Unsent drafts** are kept in the browser's local storage per Board, so a reload doesn't lose half-typed text.
- **Board identity:** the agent picks a readable slug.
  - `open` refuses if a Board with that slug already exists, unless `--replace` is passed explicitly. Updating an existing Board always goes through `push`.
  - The Board records the project directory and agent session it was opened from, for the index page and the stop hook.
- **Custom Layout chrome:** the server always injects its own chrome around any Layout, custom ones included: the listening banner with the copyable prompt, the open-question count, the Done button and warning, and token handling. A custom Layout can't drop these guarantees.
- **Resuming:** the server keeps the read cursor per Board, so the agent doesn't have to remember it.
  - `status <board>` returns a full snapshot (Questions, Answers, states, pending Explain requests) plus any unread Events.
  - The resume prompt tells the agent to run `status`, then `wait`. A new or compacted session can pick up a Board cold.
- **Prior art to read before building:** the superpowers brainstorming "visual companion" server. It already does a session key in the URL, the newest-screen convention, and click events written to a file. Reuse ideas, not code.

## 7. Left to the builder

- Exact JSON schema field names, CLI flags, port number and config file format.
- Visual design of the built-in Layouts and the page chrome. Readable, both light and dark themes.
- Test strategy and tooling.
- How the stop hook identifies "Boards opened by this agent". It could use the session id Claude Code passes to hooks, recorded when the Board is opened. Choose whatever is reliable.
- Server idle shutdown, if any.
