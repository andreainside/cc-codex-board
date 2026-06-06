# cc-codex-board — Design Spec

A reusable, per-person, locally-deployed dashboard of all your live **Claude Code (CC)** and **Codex** windows.

## Problem
People run many CC and Codex windows at once and lose track of which is which. They need a local dashboard that shows, at a glance, every live window: what it's doing, its status, when it started, the linked PR / CI / review state — and crucially **which physical window each card is**, so they can jump straight to the right one.

## Scope
Read-only live snapshot dashboard. Per-person, runs locally. macOS/Linux, Node ≥ 18, no dependencies.

### Non-goals
- **No actions** (no focus/merge/trigger). Read-only.
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
  1. `headline` — what it's working on. Non-LLM order: PR title → humanized branch → app/terminal window title → opening prompt. With `--summary`, an AI one-liner takes precedence.
  2. `subtitle` — the session's opening prompt (shown only when it isn't already the headline)
  3. `windowTitle` — the **on-screen title** of the real window (🖥), so a card maps to a window
- `branch`, `cwd`, `pid`
- `lastMessage` — the literal latest turn (you / AI), never a summary
- `status`, `pr {number, title, ciStatus, reviewStatus, codexReview, url}`
- `startedAt`, `runningDuration`, `lastActivityAt`, `repo` (grouping key)

## Status taxonomy + priority
1. **needs-you** (red, pinned): idle **and** the last turn ended awaiting the user (conservative — false positives are worse than false negatives).
2. **running** (blue): raw status running/busy, or very recent activity.
3. **waiting-ci-review** (amber): PR open with CI or review pending.
4. **idle** (gray).

## Layout
Top summary bar (counts per status) · grouped by repo · card grid · left color stripe by status · needs-you pinned to top · auto-refresh with "updated Ns ago".

## Optional AI headline (`--summary`)
Off by default. When enabled, the headline is a short AI one-liner from the local `claude -p` on the user's CC subscription. To stay cheap and rate-limit-friendly it:
- sends only the opening prompt + latest instruction + latest message (~800 chars), **never the full transcript**;
- summarizes a window only when it has finished a turn (idle) and has no summary for that turn, **staggered** under a concurrency cap and **cached per turn** (≈ one Haiku call per window per completed turn);
- never summarizes a running window; backs off on failure; falls back to the non-LLM headline.

## Cost
0 LLM calls by default. Cost = local CPU + GitHub API via `gh` (free, rate-limited → cached). With `--summary`, a little CC subscription usage. Does not consume CC/Codex usage otherwise.

## Tech
Node ≥ 18, no dependencies. Plain HTML/CSS/JS frontend. Config file + flags (roots, port, labels, toggles). Tested with `node --test` (parser units + a fixture-tree integration test + frontend render test).
