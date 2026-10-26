---
name: punch-list
description: Put your questions for the person on a live local web page (a Board) instead of the terminal, and keep listening for their answers and "explain better" requests in the background. Use whenever you have about 4 or more questions or decisions for the person, when a question needs a diagram, table or example to be understood, or when the person asks for a board, a form, or "the questions in the browser".
---

# punch-list

A Board is a live page at `http://127.0.0.1:<port>/b/<board>`. You push Questions to it; the person answers at their own pace, skips, comes back, and presses **"Wait, what? Explain better"** on anything unclear. Their actions come back to you as Events. The page updates live whenever you push.

Run the CLI with Node from this skill's directory (shown as "Base directory for this skill"):

```bash
PL="node <this skill's directory>/bin/punch-list.mjs"
```

No install step; the server starts itself.

## The loop

1. **Write the Board** as JSON (format: `reference/board-format.md`) and open it:
   `$PL open <board> --file board.json` (board ids: lowercase, digits, `-`; use `--file -` to pipe it in).
   It prints `url` and sometimes `notice`. Give the person the url. If `notice` is present, pass it on word for word (it tells them how long Boards are kept and where to change that).
2. **Listen in the background**: run `$PL wait <board>` with `run_in_background: true`. You are free to end your turn and chat; when `wait` exits you are woken with its output.
3. **Handle the Events** (a JSON array), then **immediately start a new background `wait`**. Never leave an open Board without a Listener: the page tells the person when nobody is listening.
   - `explain` `{qid, title, text}`: the person doesn't understand the Question; `text` is their own question, if any. Handle these first. Reply with `$PL explain <board> <qid> --file expl.html` (or `--html '...'`). Explain in plain words and add what helps: an example, a small table, a Mermaid diagram (`<pre class="mermaid">…</pre>`), a before/after. Don't repeat the question.
   - `answers` `{answers: [{qid, title, value, note?}]}`: the person pressed "Send to Claude". Record them. Push follow-up Questions if an answer calls for one. Answers can still change until `done`, so don't start irreversible work on them yet unless the person said to.
   - `done` `{answered, skipped, unanswered}`: the person is finished. Act on the Answers. For skipped or unanswered ones, use sensible defaults and say so, ask in the terminal, or push follow-ups (pushing reopens the Board, so keep listening).
   - `reopened`: the person reopened a done Board; keep listening.
4. When the work is done, tell the person in the terminal what you did with their answers.

## Changing the Board while they work

- `$PL push <board> --file patch.json`: add Questions (follow-ups), edit Questions, change `title`, `intro` or `layout`. The page redraws live and keeps their answers. Editing an answered Question marks it **Changed** so they re-check it.
- `$PL withdraw <board> <qid> --reason "Not needed after your answer to Q2"`: grey out a Question you no longer need. Never silently drop one.
- `$PL status <board>`: full snapshot (Questions, Answers, states, pending Events). Use it to resume a Board after a restart or context compaction, then start `wait` again.
- `$PL close <board>`: mark the Board done from your side when the person says they don't need it any more (stops the Stop hook from asking you to listen).
- Other: `$PL url <board>`, `$PL list`, `$PL rm <board>` (clean up Boards you no longer need; stop its `wait` first).

## Writing good Boards

- One Question per decision. Put the recommended option first with `"recommended": true` and say why in its `detail`.
- Give each Question the context needed to answer it in `body` (HTML): what it's about, what changes depending on the answer. The person shouldn't need to scroll back through the terminal.
- Leave `layout` out to get `focus`, the default: one Question at a time, the ones that need the person first, with a status sidebar and your Explanations in a side panel. It suits almost every Board. Use `list`, `tabs` or `wizard` (with `layout.groups` and each Question's `group`) when the person wants to see many Questions at once, `columns` for triage-style boards, `custom` when nothing fits. If the person asks for a different arrangement, push a new `layout`.
- Use `showIf` for instant follow-ups that need no thinking ("show Q4 when Q3 is yes"); push new Questions for follow-ups that do.
- Answer types: `yes-no`, `single`, `multi`, `text`, `number`, `scale`, `rank`, `custom`. Every Question also has an optional note.
- Requests that aren't about one Question ("use tabs", "add a question about X") come to you in the terminal; apply them with `push`.

## Rules

- Keep a background `wait` running while any Board you opened is not done.
- In Claude Code, a Stop hook (if installed) blocks ending your turn when one of your Boards is open with no Listener; start `wait` in the background and end the turn normally.
- Without background commands (other agents), `wait` blocks your chat; prefer `$PL wait <board> --timeout 0` at natural pauses, and tell the person to say "check the board" when they've answered.
