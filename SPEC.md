# cc-codex-board — Design Spec

A reusable, per-person, locally-deployed dashboard of all your live **Claude Code (CC)** and **Codex** windows.

## Problem
People run many CC and Codex windows at once and lose track of which is which. They need a local dashboard that shows, at a glance, every live window: what it's doing, its status, when it started, the linked PR / CI / review state — and crucially **which physical window each card is**, so they can jump straight to the right one.

## Scope
Read-only live snapshot dashboard. Per-person, runs locally. macOS/Linux, Node ≥ 18, no dependencies.

### Non-goals
- **Minimal actions only.** Two explicit local actions are supported: (1) on-demand manual summarize (calls `claude -p` on the user's subscription — click is the user's consent; never writes transcripts or repos), and (2) restore from archive (changes in-memory view state only — never writes transcripts or repos). All other write actions (focus/merge/trigger/etc.) are out of scope.
- No persistence/history DB — live snapshot only.
- No multi-user hosting — each person runs their own.

## Hard rules
- **Read-only on the user's machine.** Only reads `~/.claude` / `~/.codex` (+ the Claude Desktop app's session dir) and runs read-only `git` / `gh` / `osascript`. Never writes to transcripts or repos.
- **Zero LLM calls by default.** All text comes from existing local files or read-only `git`/`gh` — including titles the apps already generated (read, not generated). The board does not generate summaries itself.
  - **One opt-in exception:** `--summary` produces an AI headline via the local `claude -p` (the user's CC **subscription**, not the metered API). Off by default; see *Optional AI headline*.

## Architecture
A single local Node service = **collector** + **static web page**.
- **Collector** reads local files and shells to read-only `git`/`gh`/`osascript`; exposes `GET /api/windows` → JSON.
- **Frontend**: one page, polls `/api/windows` every 5s, renders grouped cards.
- **Start**: one command (`npx github:<user>/cc-codex-board` or `node bin/cc-codex-board.js`).
- **Cost control:** local session files re-read at most ~5s; `git`/`gh` cached ~45s per cwd/repo; terminal titles cached ~8s.

## Data sources
| Need | Source |
|---|---|
| CC live windows | `~/.claude/sessions/<pid>.json` → `{pid, sessionId, cwd, startedAt, status?, updatedAt?, entrypoint, kind}`. Liveness via `kill(pid,0)`. Headless `sdk-cli` (e.g. `claude -p`) sessions are **excluded** (not windows). |
| CC title / activity / PRs | transcript `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl` → first user prompt (opening prompt), latest `last-prompt`, `pr-link` lines, last message, timestamps, awaiting-input signal |
| CC Desktop window title | `…/Application Support/Claude/claude-code-sessions/**/local_*.json` → `title`, matched by `cliSessionId` |
| CC terminal window title | `osascript` → Terminal.app / iTerm2 tab title, matched by the session's tty (macOS) |
| Codex local windows | `~/.codex/sessions/Y/M/D/rollout-*.jsonl` (subagent/guardian rollouts filtered out); liveness via recent activity |
| Codex window title | `~/.codex/session_index.jsonl` → `thread_name` |
| Codex cloud review + PR/CI/review | `gh pr view/list` (Codex cloud review = a review by the `chatgpt-codex-connector` bot) |
| Branch / repo | `git -C <cwd> branch --show-current`; repo `owner/name` from `git remote` |

## Window model (per card)
- `tool`: `CC` | `Codex-local` | `Codex-cloud`; `entrypoint` distinguishes **CC 终端** (`cli`) vs **CC 桌面** (`claude-desktop`)
- **Three-level title:**
  1. `headline` — what it's working on. Non-LLM order, most session-specific first: the window's own tab/thread title (Claude Desktop / terminal / Codex) → PR title → humanized branch → opening prompt. A window title is ranked above pr/branch because pr/branch are shared by every session in one checkout and would otherwise collapse sibling windows to one headline; `disambiguateHeadlines` then splits any residual collision (two title-less windows in one checkout) back onto each window's opening prompt. With `--summary`, an AI one-liner takes precedence.
  2. `subtitle` — the session's opening prompt (shown only when it isn't already the headline, and not when it merely duplicates the headline text)
  3. `windowTitle` — the **on-screen title** of the real window (🖥), so a card maps to a window
- `branch`, `cwd`, `pid`
- `lastMessage` — the literal latest turn (you / AI), never a summary
- `status`, `pr {number, title, ciStatus, reviewStatus, codexReview, url}`
- `startedAt`, `runningDuration`, `lastActivityAt`, `repo` (grouping key)

## Status taxonomy + priority
1. **needs-you** (red, pinned): the window is blocked on the user. Triggered by any of: (a) the cli session file's `waitingFor` field is set — CC's own authoritative "blocked on the user" flag, written while a terminal window sits at a permission/approval prompt (the `tool_use` isn't flushed to the transcript yet, so (c) can't see it); (b) the last assistant message ending with a question; or (c) a tool call pending with no `tool_result` yet (desktop approvals). (a) is authoritative and overrides a busy/recent guess; (b)/(c) yield to an authoritative busy status. Conservative — false positives are worse than false negatives. Can be manually muted (see 忽略 below).
2. **running** (blue): raw status running/busy, or very recent activity.
3. **waiting-ci-review** (amber): PR open with CI or review pending.
4. **idle** (gray).

## Layout
Top summary bar (counts per status) · grouped by repo · card grid · left color stripe by status · needs-you pinned to top · auto-refresh with "updated Ns ago".

**View controls:** 按仓库 / 按状态 toggle (localStorage); 专注 filter (hides 空闲 + 等CI/复评, localStorage); 🗄 存档 view (idle-archived windows, each with idle-age label and ↩ 恢复 button).

**Per-card user notes:** each card exposes an editable `📝` note field below its headline. Notes are stored in the browser's `localStorage` keyed by the session's `sessionId`; they survive page reloads and server restarts but are browser-local and never written to disk (the board stays read-only). A filled note is styled as a sticky note (amber底色 + soft shadow) so your own annotations stand out from the read-only card text.

**忽略 (manual dismiss):** every `等你/needs-you` card carries a `忽略` button. Clicking it mutes that window's needs-you alert (the card drops to `空闲/idle` and the top-bar count decrements) — for when you've decided you're done with the conversation and won't answer its question. The mute is held server-side in an in-memory `dismissedAt` map (like `restoredAt`) and **re-arms automatically** once the window produces genuinely new activity (a new question / permission prompt bumps `lastActivityAt` past the dismissal). It does not survive a server restart.

**Folder / worktree sub-grouping (按仓库 view only):** when a repo has windows in more than one working directory (e.g. separate git worktrees), the 按仓库 view nests each folder as a `📁` sub-section within the repo group. Repos with a single folder remain flat. 按状态 and 存档 views are unaffected.

**Idle lifecycle:** idle windows are promoted out of the main view based on effective idle age (= `max(lastActivityAt, startedAt, restoredAt)`): `< idleArchiveMs` (default 4h) → main; `≥ idleArchiveMs` and `< idleDropMs` (default 30h) → archive; `≥ idleDropMs` → dropped (omitted from payload). Both thresholds are configurable via `--idle-archive <h>` / `--idle-drop <h>`; 0 disables the respective tier. Non-idle windows (needs-you, running, waiting-ci-review) are never archived.

**LLM usage counter:** `meta.llmUsage { calls, inputTokens, outputTokens, costUsd }` is included in every `/api/windows` payload; it accumulates across on-demand and auto-summary calls this server session and is displayed in the top bar.

## Optional AI headline (`--summary`)
Off by default. When enabled, the headline is a short AI one-liner from the local `claude -p` on the user's CC subscription. To stay cheap and rate-limit-friendly it:
- sends only the opening prompt + latest instruction + latest message (~800 chars), **never the full transcript**;
- summarizes a window only when it has finished a turn (idle) and has no summary for that turn, **staggered** under a concurrency cap and **cached per turn** (≈ one Haiku call per window per completed turn);
- never summarizes a running window; backs off on failure; falls back to the non-LLM headline.

## Cost
0 LLM calls by default. Cost = local CPU + GitHub API via `gh` (free, rate-limited → cached). With `--summary`, a little CC subscription usage. Does not consume CC/Codex usage otherwise.

## Tech
Node ≥ 18, no dependencies. Plain HTML/CSS/JS frontend. Config file + flags (roots, port, labels, toggles). Tested with `node --test` (parser units + a fixture-tree integration test + frontend render test).
