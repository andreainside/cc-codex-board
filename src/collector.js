// Collector: assembles the window list from local files + injected git/gh
// runners. Read-only. Never calls an LLM. FS access is synchronous (a handful of
// small files); git/gh are injected so they can be cached/throttled by the caller.

import fs from 'node:fs';
import path from 'node:path';
import { parseCcSession } from './cc-sessions.js';
import { summarizeTranscript } from './cc-transcript.js';
import { parseRollout, summarizeRollout, parseSessionIndex } from './codex.js';
import { parseDesktopSession } from './cc-desktop.js';
import { deriveStatus, compareWindows, summarize, STATUS_PRIORITY } from './status.js';
import { chooseHeadline } from './headline.js';

const NOOP_SUMMARIZER = {
  enabled: false,
  getTitle: () => null,
  schedule: () => null,
  summarizeNow: async () => null,
  getUsage: () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
};

// Entrypoints that are NOT user-facing windows: `claude -p` / SDK / headless
// runs (including this board's own summary calls). Real windows are 'cli'
// (terminal) or 'claude-desktop'.
const NON_WINDOW_ENTRYPOINTS = new Set(['sdk-cli']);

/** Encode a cwd into the ~/.claude/projects directory name (non-alnum → '-'). */
export function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Decide which zone a window belongs to by effective idle age.
 * @param {{id:string,status:string,lastActivityAt?:number,startedAt?:number}} w
 * @param {{now:number,idleArchiveMs:number,idleDropMs:number,getRestoredAt:(id:string)=>number}} opts
 * @returns {'main'|'archive'|'dropped'}
 */
export function classifyZone(w, opts) {
  if (w.status !== 'idle') return 'main';
  if (!opts.idleArchiveMs) return 'main';
  const eff = Math.max(w.lastActivityAt || 0, w.startedAt || 0, opts.getRestoredAt(w.id) || 0);
  const age = opts.now - eff;
  if (age < opts.idleArchiveMs) return 'main';
  if (opts.idleDropMs && age > opts.idleDropMs) return 'dropped';
  return 'archive';
}

/**
 * Make same-checkout cards distinguishable. After chooseHeadline, two windows in
 * one repo/cwd can still share a headline when it came from a SHARED signal
 * (pr.title / branch) and neither has its own window title — e.g. two title-less
 * sessions in one worktree. Fall those back to their per-session opening prompt
 * so no two cards shown together carry the same big headline.
 * @param {object[]} windows windows with `.headline` already chosen
 */
export function disambiguateHeadlines(windows) {
  const byKey = new Map(); // `${group}\n${headline}` -> windows
  for (const w of windows) {
    if (!w.headline) continue;
    const key = `${w.repo || w.cwd || ''}\n${w.headline.text}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(w);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue; // unique already
    for (const w of group) {
      if (w.headline.source !== 'pr' && w.headline.source !== 'branch') continue; // only shared signals
      const prompt = (w.title || '').trim();
      if (prompt && prompt !== '(尚无提问)' && prompt !== w.headline.text) {
        w.headline = { text: prompt, source: 'prompt' };
        w.subtitle = ''; // the prompt IS the headline now → don't repeat it below
      }
    }
  }
}

/** Collapse Codex resume chains: keep the most recent rollout per root thread. */
export function dedupeCodexThreads(summaries) {
  // Resolve each rollout's TERMINAL root by chasing parent pointers transitively
  // (A←B←C all collapse to A), with a visited-guard against cycles. A single
  // `parentThreadId || id` hop missed 3-deep chains, leaving duplicate cards.
  const byId = new Map();
  for (const s of summaries) if (s && s.id != null) byId.set(s.id, s);
  const rootOf = (s) => {
    const seen = new Set();
    let cur = s;
    while (cur && cur.parentThreadId != null && byId.has(cur.parentThreadId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentThreadId);
    }
    return cur && cur.id != null ? cur.id : s.id;
  };
  // Recency falls back to lastActivityAt when startedAt is missing (an unparsable
  // session_meta timestamp must not let a stale root outrank a live resume).
  const recency = (s) => s.startedAt ?? s.lastActivityAt ?? 0;
  const byRoot = new Map();
  for (const s of summaries) {
    const root = rootOf(s);
    const prev = byRoot.get(root);
    if (!prev || recency(s) >= recency(prev)) byRoot.set(root, s);
  }
  return [...byRoot.values()];
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Missing files are normal; anything else (e.g. EACCES) is worth surfacing.
    if (err && err.code !== 'ENOENT') {
      process.stderr.write(`⚠ could not read ${file}: ${err.code || err.message}\n`);
    }
    return null;
  }
}

// Parse cache keyed by file path + mtime + size + maxLength, so unchanged
// transcripts/rollouts are not re-read or re-parsed on every ~5s refresh.
const summaryCache = new Map();
// Monotonic build counter so we can drop entries for files that scrolled out of
// the scan window and were not touched this cycle (otherwise the Map grows
// unbounded over a long-running daemon).
let cacheGen = 0;

function cachedSummary(file, maxLength, compute) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = summaryCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.maxLength === maxLength) {
    hit.gen = cacheGen; // touched this cycle → keep
    return hit.summary;
  }
  const text = safeRead(file);
  if (text == null) return null;
  const summary = compute(text);
  summaryCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, maxLength, summary, gen: cacheGen });
  return summary;
}

// Start a fresh collection cycle; entries not re-touched before pruneSummaryCache
// are considered stale and evicted.
function startCacheCycle() {
  cacheGen += 1;
}

function pruneSummaryCache() {
  for (const [file, entry] of summaryCache) if (entry.gen !== cacheGen) summaryCache.delete(file);
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Locate a CC transcript: try the encoded-cwd path, then fall back to scanning
// project dirs for <sessionId>.jsonl (covers any encoding edge cases).
export function findTranscriptPath(claudeRoot, cwd, sessionId) {
  const projects = path.join(claudeRoot, 'projects');
  const direct = path.join(projects, encodeCwd(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  // Fallback scan for encoding edge cases. The same <sessionId>.jsonl can exist
  // under multiple project dirs; trust the fallback only when it is UNAMBIGUOUS
  // (exactly one match), else give up rather than summarize a different cwd's
  // transcript picked by arbitrary fs order.
  const matches = [];
  for (const dir of listDir(projects)) {
    const cand = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(cand)) matches.push(cand);
  }
  return matches.length === 1 ? matches[0] : null;
}

// A desktop record is a better title source than what we already have if it is
// live where the other is archived, or (same archived state) more recent.
// Prevents an arbitrary fs-order, stale, or archived record from clobbering the
// current tab title when one cliSessionId has multiple local_*.json files.
function isBetterDesktopRecord(next, prev) {
  if (!prev) return true;
  if (!!next.isArchived !== !!prev.isArchived) return !next.isArchived;
  return (next.lastActivityAt ?? 0) >= (prev.lastActivityAt ?? 0);
}

/**
 * Load the Claude Desktop per-tab titles, mapping cliSessionId -> the best
 * record { title, titleSource }. Best-effort; empty Map if the app dir is absent.
 * @param {string|null} desktopRoot path to .../Claude/claude-code-sessions
 * @returns {Map<string,{title:string, titleSource?:string}>}
 */
export function loadDesktopTitles(desktopRoot) {
  const best = new Map(); // cliSessionId -> full parsed record (for tie-breaking)
  if (!desktopRoot) return best;
  const stack = [desktopRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.startsWith('local_') && e.name.endsWith('.json')) {
        const d = parseDesktopSession(safeRead(full) || '');
        if (d && d.title && isBetterDesktopRecord(d, best.get(d.cliSessionId))) best.set(d.cliSessionId, d);
      }
    }
  }
  return best;
}

/**
 * Build base CC window records (no git/gh enrichment yet).
 * @param {{claudeRoot:string, now:number, isPidAlive:(pid:number)=>boolean, titleMax?:number, desktopTitles?:Map<string,string>}} deps
 */
export function collectCcWindows({ claudeRoot, now, isPidAlive, titleMax, desktopTitles }) {
  const sessionsDir = path.join(claudeRoot, 'sessions');
  const titles = desktopTitles || new Map();
  const windows = [];
  for (const file of listDir(sessionsDir)) {
    if (!file.endsWith('.json')) continue;
    const session = parseCcSession(safeRead(path.join(sessionsDir, file)) || '');
    if (!session) continue;
    if (NON_WINDOW_ENTRYPOINTS.has(session.entrypoint)) continue; // headless `claude -p` / SDK, not a window
    if (!isPidAlive(session.pid)) continue; // stale session file → window is gone

    const transcriptPath = findTranscriptPath(claudeRoot, session.cwd, session.sessionId);
    const t =
      (transcriptPath && cachedSummary(transcriptPath, titleMax, (text) => summarizeTranscript(text, { maxLength: titleMax }))) ||
      { title: '', currentActivity: '', prLinks: [], lastActivityAt: null, awaitingInput: false };

    const lastActivityAt = Math.max(t.lastActivityAt ?? 0, session.updatedAt ?? 0) || session.startedAt;
    const desktop = titles.get(session.sessionId) || null; // best Claude Desktop tab record
    windows.push({
      id: `cc:${session.pid}`,
      tool: 'CC',
      entrypoint: session.entrypoint || null, // 'cli' (terminal) vs 'claude-desktop'
      pid: session.pid,
      sessionId: session.sessionId,
      cwd: session.cwd,
      windowTitle: desktop ? desktop.title : null, // title shown on the user's screen
      title: t.title || '(尚无提问)',
      currentActivity: t.currentActivity || '',
      lastMessage: t.lastMessage || null,
      rawStatus: session.status,
      // CC writes this while the cli window is blocked on the user (e.g.
      // "permission prompt"); it's a transient, authoritative needs-you signal.
      waitingFor: typeof session.waitingFor === 'string' ? session.waitingFor : null,
      awaitingInput: t.awaitingInput,
      prLinks: t.prLinks,
      startedAt: session.startedAt,
      lastActivityAt,
      branch: null,
      repo: null,
      pr: null,
    });
  }
  return windows;
}

/**
 * Build base Codex-local window records from rollout files.
 * @param {{codexRoot:string, now:number, activeWindowMs:number, titleMax?:number, scanWindowMs?:number}} deps
 */
export function collectCodexWindows({ codexRoot, now, activeWindowMs, titleMax, scanWindowMs }) {
  const sessionsDir = path.join(codexRoot, 'sessions');
  const scanCutoff = now - (scanWindowMs ?? activeWindowMs * 4);
  const index = parseSessionIndex(safeRead(path.join(codexRoot, 'session_index.jsonl')) || '');

  // Walk YYYY/MM/DD for rollout files, cheaply pre-filtered by mtime.
  const files = [];
  for (const y of listDir(sessionsDir)) {
    const yDir = path.join(sessionsDir, y);
    for (const m of listDir(yDir)) {
      const mDir = path.join(yDir, m);
      for (const d of listDir(mDir)) {
        const dDir = path.join(mDir, d);
        for (const f of listDir(dDir)) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const full = path.join(dDir, f);
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            continue;
          }
          if (mtime >= scanCutoff) files.push(full);
        }
      }
    }
  }

  const summaries = [];
  for (const full of files) {
    const s = cachedSummary(full, titleMax, (text) => summarizeRollout(text, { maxLength: titleMax }));
    if (!s) continue;
    if (s.isSubagent) continue; // guardian/compact internal rollouts are not windows
    const last = s.lastActivityAt ?? s.startedAt ?? 0;
    summaries.push({ ...s, lastActivityAt: last, file: full });
  }

  const deduped = dedupeCodexThreads(summaries);
  const windows = [];
  for (const s of deduped) {
    const last = s.lastActivityAt ?? s.startedAt ?? 0;
    if (now - last > activeWindowMs) continue; // conservative liveness (宁漏勿误报)
    const fromIndex = s.id && index.get(s.id);
    const threadName = (fromIndex && fromIndex.threadName) || null;
    const title = s.title || threadName || '(尚无提问)';
    windows.push({
      id: `codex:${s.id}`,
      tool: 'Codex-local',
      entrypoint: null,
      pid: null,
      sessionId: s.id,
      cwd: s.cwd,
      windowTitle: threadName, // Codex's sidebar thread name = the displayed title
      title,
      currentActivity: s.currentActivity || '',
      lastMessage: s.currentActivity ? { role: 'user', text: s.currentActivity } : null,
      rawStatus: s.status,
      waitingFor: null, // Codex has no equivalent blocked-on-user flag yet
      awaitingInput: false, // Codex needs-you heuristic deferred (avoid false positives)
      prLinks: [],
      startedAt: s.startedAt,
      lastActivityAt: last,
      branch: null,
      repo: null,
      pr: null,
    });
  }
  return windows;
}

/**
 * Enrich windows with branch/repo and PR status via injected async runners.
 * @param {object[]} windows
 * @param {{resolveRepoBranch:(cwd:string)=>Promise<{repo:string|null,branch:string|null}>,
 *   fetchPr:(repo:string, info:{branch:string|null, prNumbers:number[]})=>Promise<object|null>}} deps
 */
export async function enrichWindows(windows, { resolveRepoBranch, fetchPr }) {
  // Enrich windows in parallel — git/gh per window is independent, and the
  // injected runners are cached so duplicate cwds/repos collapse. Sequential
  // awaits would make first-load latency O(n·t) instead of O(t).
  await Promise.all(
    windows.map(async (w) => {
      if (!w.cwd) return;
      try {
        const { repo, branch } = (await resolveRepoBranch(w.cwd)) || {};
        w.repo = repo ?? null;
        w.branch = branch ?? null;
      } catch (err) {
        if (process.env.DEBUG) process.stderr.write(`git error for ${w.cwd}: ${err.message}\n`);
      }
      const prNumbers = (w.prLinks || []).map((p) => p.number);
      if (w.repo && branchOrNumbers(w.branch, prNumbers) && fetchPr) {
        try {
          w.pr = (await fetchPr(w.repo, { branch: w.branch, prNumbers })) || null;
        } catch (err) {
          if (process.env.DEBUG) process.stderr.write(`gh error for ${w.repo}: ${err.message}\n`);
          w.pr = null;
        }
      }
    }),
  );
  return windows;
}

function branchOrNumbers(branch, prNumbers) {
  return (branch && branch !== 'HEAD') || prNumbers.length > 0;
}

/**
 * Assemble the full board: collect, enrich, derive status, sort, group by repo.
 * @param {object} deps
 */
export async function buildBoard(deps) {
  const {
    claudeRoot,
    codexRoot,
    desktopRoot = null,
    now,
    isPidAlive,
    resolveRepoBranch,
    fetchPr,
    resolveTerminalTitles = null,
    summarizer = NOOP_SUMMARIZER,
    runningRecencyMs = 90_000,
    codexActiveWindowMs = 2 * 60 * 60_000,
    titleMax = 90,
    labels = {},
    idleArchiveMs = 4 * 3600_000,
    idleDropMs = 30 * 3600_000,
    getRestoredAt = () => 0,
    getDismissedAt = () => 0,
  } = deps;

  startCacheCycle();
  const desktopTitles = loadDesktopTitles(desktopRoot);
  const cc = claudeRoot ? collectCcWindows({ claudeRoot, now, isPidAlive, titleMax, desktopTitles }) : [];
  const codexCollectMs = idleDropMs > 0 ? Math.max(codexActiveWindowMs, idleDropMs) : 7 * 24 * 3600_000;
  const codex = codexRoot
    ? collectCodexWindows({ codexRoot, now, activeWindowMs: codexCollectMs, titleMax })
    : [];
  const windows = [...cc, ...codex];
  pruneSummaryCache(); // drop cache entries for files not touched this cycle

  // Fill in terminal tab titles for CLI windows that lack a displayed title.
  const cliPids = windows.filter((w) => w.tool === 'CC' && !w.windowTitle && w.pid).map((w) => w.pid);
  if (resolveTerminalTitles && cliPids.length) {
    try {
      const titles = await resolveTerminalTitles(cliPids);
      for (const w of windows) {
        if (!w.windowTitle && titles.has(w.pid)) w.windowTitle = titles.get(w.pid);
      }
    } catch {
      /* best-effort */
    }
  }

  await enrichWindows(windows, { resolveRepoBranch, fetchPr });

  for (const w of windows) {
    w.label = labels[String(w.pid)] || labels[w.cwd] || null;
    w.pr = w.pr || null;
    w.status = deriveStatus(
      {
        rawStatus: w.rawStatus,
        awaitingInput: w.awaitingInput,
        waitingFor: w.waitingFor,
        dismissedAt: getDismissedAt(w.id),
        lastActivityAt: w.lastActivityAt,
        pr: w.pr,
      },
      { now, runningRecencyMs },
    );
    // Headline: cached AI summary (if enabled) → window title → PR → branch → prompt.
    w.summaryTitle = summarizer.getTitle(w) || null;
    w.headline = chooseHeadline(w);
    // Show the opening prompt as a subtitle only when it isn't already the headline
    // AND doesn't merely duplicate the headline text (e.g. a Codex window whose
    // thread name equals its title would otherwise print the same line twice).
    w.subtitle = w.headline.source !== 'prompt' && w.title && w.title !== w.headline.text ? w.title : '';
  }

  // Final pass: split any two same-checkout cards that still share a pr/branch
  // headline (neither had its own window title) back onto their opening prompts.
  disambiguateHeadlines(windows);

  // Idle lifecycle: bucket idle windows by effective idle age.
  const zoneOpts = { now, idleArchiveMs, idleDropMs, getRestoredAt };
  const mainWindows = [];
  const archiveWindows = [];
  for (const w of windows) {
    const z = classifyZone(w, zoneOpts);
    if (z === 'main') mainWindows.push(w);
    else if (z === 'archive') archiveWindows.push(w);
    // 'dropped' → omitted from the payload entirely
  }

  // Auto-summaries only for main windows (don't spend calls on stale/archived).
  for (const w of mainWindows) {
    const p = summarizer.schedule(w);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  mainWindows.sort(compareWindows);

  // Group main by repo; group order = best status priority within it, then name.
  const groupMap = new Map();
  for (const w of mainWindows) {
    const key = w.repo || w.cwd || '(unknown)';
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(w);
  }
  const groups = [...groupMap.entries()]
    .map(([repo, ws]) => ({
      repo,
      windows: ws.sort(compareWindows),
      topPriority: Math.min(...ws.map((w) => STATUS_PRIORITY[w.status] ?? 99)),
    }))
    .sort((a, b) => a.topPriority - b.topPriority || a.repo.localeCompare(b.repo));

  // Archive: most-recent activity first (review timeline).
  archiveWindows.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

  return {
    generatedAt: now,
    meta: { summaryEnabled: !!summarizer.enabled, llmUsage: summarizer.getUsage() },
    summary: summarize(mainWindows),
    windows: mainWindows,
    groups,
    archive: { count: archiveWindows.length, windows: archiveWindows },
  };
}
