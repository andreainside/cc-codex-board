# cc-codex-board

A tiny **local, read-only dashboard** for all your live **Claude Code (CC)** and **Codex** windows. At a glance: what each window is, what it's doing, its status, when it started, and its linked PR / CI / review state — so you can instantly find the right window and trace progress.

> **Zero LLM calls by default.** Every line on the board comes from your existing local files or read-only `git` / `gh` — including window titles the apps already generated (it *reads* them; it doesn't generate them). It does **not** consume any CC / Codex usage. There is one **opt-in** exception, [`--summary`](#optional-ai-headline---summary), which is off by default.

## Run it

No install needed — run it straight from GitHub (Node ≥ 18, zero dependencies):

```bash
npx github:andreainside/cc-codex-board --open
# then open http://localhost:4317
```

Or clone and run:

```bash
git clone https://github.com/andreainside/cc-codex-board.git
cd cc-codex-board
node bin/cc-codex-board.js --open      # or: npm start
```

**Upgrading:** `npx github:...` always pulls the latest `main` on restart — just restart the command. Clone users: `git pull`, then restart.

**For colleagues:** it just reads your own `~/.claude` / `~/.codex` and runs read-only `git`/`gh`. Optional bits: install [`gh`](https://cli.github.com) and `gh auth login` for PR/CI/review status; on macOS the first run may ask to allow controlling Terminal (to read terminal tab titles — say yes, or `--no-terminal-titles`); and since everyone has a CC plan, `--summary` gives AI headlines using your own subscription.

## What it shows

- **Summary bar** — counts per status (`2 等你 · 2 跑着 · 1 等CI/复评 · 1 空闲`).
- **Grouped by repo**, card grid, **left color stripe by status**, **needs-you pinned to top**.
- Auto-refreshes every 5s with an "updated Ns ago" indicator.
- **✨ 总结 button** on every card — click to request an on-demand AI title for that window (uses your local `claude -p`, click = consent; works even without `--summary`).
- **Idle lifecycle:** windows idle for more than 4h move to a **🗄 存档** (archive) view instead of cluttering the main board; windows idle more than 30h are dropped entirely. Each archived card shows how long it has been idle and has an **↩ 恢复** button that moves it back to the main view instantly.
- **按仓库 / 按状态 toggle** — switch between repo-grouped and status-grouped layout; preference is remembered in `localStorage`.
- **专注 filter** — one click hides 空闲 and 等CI/复评 windows, showing only 等你 and 跑着; persists across refreshes.
- **Top bar LLM usage** — shows real call count, total tokens, and cost accumulated this session (`0 次 LLM 调用` until a summary actually runs).
- **Per-conversation notes** — each card has an editable `📝` note field below its headline. Click to edit, Enter or blur saves, Esc cancels, clearing the text deletes the note. Notes are stored in the browser's `localStorage` keyed by the session's `sessionId`, so they persist across window restarts — but are per-browser and never written to disk (the board stays read-only).
- **Folder / worktree sub-grouping** — in the 按仓库 view, when a repo has windows in multiple working directories (e.g. git worktrees), each folder gets its own `📁` sub-section. Single-folder repos stay flat. (按状态 and 存档 views are unchanged.)

Each card has a three-level title so you can both understand and *locate* the window:

1. **Headline** — what the window is working on. Non-LLM by default: PR title → humanized branch → the app's own tab/thread title → opening prompt. With [`--summary`](#optional-ai-headline---summary) it's an AI one-liner.
2. **Subtitle** — the session's **opening prompt** (the precise, unique first thing you asked).
3. **🖥 window title** — the exact title shown on your screen, so you can match the card to the real window: Claude Desktop tab name, Codex thread name, or the **terminal tab title** for CLI sessions (read via AppleScript, matched by tty; macOS only — first run may ask to allow controlling Terminal; disable with `--no-terminal-titles`).

Plus: tool badge (**CC 终端 / CC 桌面 / Codex 本地**) · status · `branch · pid` · **上一条消息** (the literal latest turn, you/AI) · `PR# · CI · Codex review` · `🕐 start · duration · last-activity`.

## Status taxonomy

| Status | Color | Meaning |
|---|---|---|
| **needs-you** | red (pinned) | Idle **and** the last turn ended awaiting your input/decision. |
| **running** | blue | Actively working (raw status, or very recent activity). |
| **waiting-ci-review** | amber | PR open with CI or review pending. |
| **idle** | gray | Idle, nothing pending. |

The `needs-you` heuristic is deliberately conservative — **false positives are worse than false negatives**.

## How it works

A single local Node service = collector + static page.

| Source | Used for |
|---|---|
| `~/.claude/sessions/<pid>.json` | live CC windows (pid, cwd, startedAt, status); liveness via `kill(pid,0)` |
| `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl` | title (first user prompt), current activity (`last-prompt`), PRs (`pr-link`), timestamps, needs-you signal |
| `~/.codex/sessions/Y/M/D/rollout-*.jsonl` | Codex local windows (subagent/guardian rollouts filtered out); liveness via recent activity |
| `~/.codex/session_index.jsonl` | Codex thread name = its on-screen window title |
| `…/Claude/claude-code-sessions/**/local_*.json` (macOS) | Claude **Desktop** tab title, matched by `cliSessionId` — the 🖥 window-match line |
| `osascript` → Terminal.app / iTerm2 (macOS) | **CLI** terminal tab title, matched by the session's tty — the 🖥 line for terminal windows |
| `git -C <cwd>` | branch + repo (`owner/name` from the remote) |
| `gh pr view/list` | PR number + title, CI status, review status, Codex cloud review (a review by the `chatgpt-codex-connector` bot) |

**Cost control:** local session files are re-read at most every ~5s; `git`/`gh` results are cached ~45s per cwd/repo to respect GitHub's rate limits.

**Read-only:** it only reads `~/.claude` / `~/.codex` and runs read-only `git` / `gh`. It never writes to your transcripts or repos.

## Configuration

Optional `config.json` (see `config.example.json`) or `~/.cc-codex-board.json`. Flags override the file:

```
--port <n>           port (default 4317)
--config <path>      config JSON path
--claude-root <dir>  override ~/.claude
--codex-root <dir>   override ~/.codex
--no-git             skip git (no branch/repo)
--no-gh              skip gh (no PR/CI/review)
--idle-archive <h>   idle windows older than h hours → archive view (default 4; 0 disables)
--idle-drop <h>      idle windows older than h hours → dropped entirely (default 30; 0 = keep forever)
--open               open the browser
```

Friendly labels (e.g. a teammate's bot) map a `pid` or `cwd` to a name:

```json
{ "labels": { "12345": "Alice", "/Users/you/worktrees/x": "review-bot" } }
```

### Optional AI headline (`--summary`)

Off by default — the board stays zero-LLM. When you pass `--summary` (or `"summary": true`), the headline becomes a short AI one-liner generated by your **local `claude -p`**, which runs on your **Claude Code subscription** (OAuth) — *not* the metered API. To keep it cheap and rate-limit-friendly it only summarizes a window **when it finishes a turn** (running → idle), caches the result per turn, runs on **Haiku** by default, and silently falls back to the non-LLM headline on any error. Trade-off: it does consume a little CC subscription usage, so it's opt-in.

## Tests

```bash
npm test    # node --test, no dependencies
```

Unit tests cover every parser (CC sessions, transcript title/last-prompt/pr-link/timestamps, Codex rollouts, status derivation, `gh` JSON, repo mapping, TTL cache, config); an integration test drives the collector over a fixture `~/.claude` + `~/.codex` tree; a frontend test renders from a sample `/api/windows` payload.

## Changelog

### 0.2.0

- **Needs-you fix:** `等你` now also triggers when a tool call is pending (awaiting a permission / confirmation prompt), not only when the last assistant message ends with a question.
- **LLM usage counter:** the top bar shows real call count, total tokens, and cost for this session; honest `0 次 LLM 调用` until a summary actually runs.
- **✨ 总结 button:** every card has an on-demand manual AI summary button — works even without `--summary`; the click is the per-window consent.
- **Idle lifecycle + ↩ 恢复:** windows idle >4h move to 🗄 存档; >30h are dropped. Archived cards show idle age and a restore button. Thresholds configurable via `--idle-archive` / `--idle-drop` (0 disables each).
- **按仓库 / 按状态 toggle:** switch between repo-grouped and status-grouped layout with localStorage persistence.
- **专注 filter:** one-click mode that hides 空闲 and 等CI/复评, showing only 等你 and 跑着.
- **Per-conversation notes:** each card has an editable `📝` note below its headline (click to edit, Enter/blur saves, Esc cancels, empty deletes); stored in browser `localStorage` keyed by `sessionId` — persists across restarts, per-browser only, never written to disk.
- **Folder / worktree sub-grouping:** in 按仓库 view, repos with windows across multiple working directories show each folder as a `📁` sub-section; single-folder repos stay flat.

## License

MIT.
