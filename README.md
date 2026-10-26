# sidekick

Skills that help a person in daily work with AI agents.

## punch-list

When an agent has a pile of questions for you, reading twenty of them in a terminal drains focus, and one unclear question derails the rest. `punch-list` moves them to a live page on your machine:

- answer in any order, skip and come back, add a note to any answer;
- press **"Wait, what? Explain better"** on any question (optionally with your own question), keep going, and the agent's explanation (text, tables, diagrams) appears under it live;
- by default you see one question at a time, the ones that need you first, with a sidebar of every question by status and the agent's explanations in a side panel; keyboard-first (`1`–`9`, `↵`, `e`, `?`, `s`, `⌘B`);
- the agent can switch to a list, tabs, a wizard, Jira-like columns, or its own page when that fits better;
- press **Send to Claude** whenever you like; the agent gets the answers while you keep working, and can add follow-up questions;
- the agent listens in the background, so the terminal stays free for normal chat; if it stops listening, the page says so and gives you a prompt to paste.

Everything runs locally (`127.0.0.1`, with a per-install token). Boards live in `~/.sidekick/boards/` and are deleted 90 days after they were opened; change `retentionDays` in `~/.sidekick/config.json`.

Fully supported in Claude Code. Other agents can use the same CLI, but most can't run commands in the background, so `wait` blocks their chat while it runs.

## Install

Requires Node 20 or newer. Nothing else: the CLI is a committed single-file bundle.

**Claude Code plugin**

```
/plugin marketplace add ValeriyMaslenikov/sidekick
/plugin install sidekick@sidekick
```

The plugin includes the Stop hook that keeps Claude from ending its turn while one of its boards has nobody listening.

**git clone**

```bash
git clone https://github.com/ValeriyMaslenikov/sidekick ~/Projects/sidekick
cd ~/Projects/sidekick && node scripts/install-skills.mjs
```

This symlinks each skill into `~/.claude/skills` and `~/.agents/skills` and adds the Stop hook to `~/.claude/settings.json` (backup kept; `--no-hook` to skip).

**npx skills**

```bash
npx skills add ValeriyMaslenikov/sidekick
```

## Use

Ask your agent to "use punch-list" or "put the questions on a board"; the skill also triggers on its own when the agent has many questions. Under the hood:

```bash
PL="node skills/punch-list/bin/punch-list.mjs"
$PL open my-board --file board.json   # prints the URL
$PL wait my-board                     # run in the background; exits with each batch of events
$PL explain my-board q3 --html '<p>Simpler: …</p>'
$PL status my-board
```

Board format: [`skills/punch-list/reference/board-format.md`](skills/punch-list/reference/board-format.md).

## Develop

```bash
pnpm install
pnpm test        # builds the bundle and runs the suite
pnpm build       # rebuild skills/punch-list/bin/punch-list.mjs; commit it
```

Source is in `src/punch-list/`; the page is plain HTML/JS in `src/punch-list/page/`. Vocabulary: [`CONTEXT.md`](CONTEXT.md).

## License

MIT
