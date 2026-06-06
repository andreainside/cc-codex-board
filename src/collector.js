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

/** Collapse Codex resume chains: keep the most recent rollout per root thread. */
export function dedupeCodexThreads(summaries) {
  const byRoot = new Map();
  for (const s of summaries) {
    const root = s.parentThreadId || s.id;
    const prev = byRoot.get(root);
    if (!prev || (s.startedAt ?? 0) >= (prev.startedAt ?? 0)) byRoot.set(root, s);
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

function cachedSummary(file, maxLength, compute) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = summaryCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.maxLength === maxLength) {
    return hit.summary;
  }
  const text = safeRead(file);
  if (text == null) return null;
  const summary = compute(text);
  summaryCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, maxLength, summary });
  return summary;
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
function findTranscriptPath(claudeRoot, cwd, sessionId) {
  const projects = path.join(claudeRoot, 'projects');
  const direct = path.join(projects, encodeCwd(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  for (const dir of listDir(projects)) {
    const cand = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Load the Claude Desktop per-tab titles, mapping cliSessionId -> displayed
 * title. Best-effort; returns an empty Map if the app dir is absent.
 * @param {string|null} desktopRoot path to .../Claude/claude-code-sessions
 * @returns {Map<string,string>}
 */
export function loadDesktopTitles(desktopRoot) {
  const map = new Map();
  if (!desktopRoot) return map;
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
        if (d && d.title) map.set(d.cliSessionId, d.title);
      }
    }
  }
  return map;
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
    windows.push({
      id: `cc:${session.pid}`,
      tool: 'CC',
      entrypoint: session.entrypoint || null, // 'cli' (terminal) vs 'claude-desktop'
      pid: session.pid,
      sessionId: session.sessionId,
      cwd: session.cwd,
      windowTitle: titles.get(session.sessionId) || null, // title shown on the user's screen
      title: t.title || '(尚无提问)',
      currentActivity: t.currentActivity || '',
      lastMessage: t.lastMessage || null,
      rawStatus: session.status,
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
  } = deps;

  const desktopTitles = loadDesktopTitles(desktopRoot);
  const cc = claudeRoot ? collectCcWindows({ claudeRoot, now, isPidAlive, titleMax, desktopTitles }) : [];
  const codexCollectMs = idleDropMs > 0 ? Math.max(codexActiveWindowMs, idleDropMs) : 7 * 24 * 3600_000;
  const codex = codexRoot
    ? collectCodexWindows({ codexRoot, now, activeWindowMs: codexCollectMs, titleMax })
    : [];
  const windows = [...cc, ...codex];

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
      { rawStatus: w.rawStatus, awaitingInput: w.awaitingInput, lastActivityAt: w.lastActivityAt, pr: w.pr },
      { now, runningRecencyMs },
    );
    // Headline: cached AI summary (if enabled) → PR title → branch → opening prompt.
    w.summaryTitle = summarizer.getTitle(w) || null;
    w.headline = chooseHeadline(w);
    // Show the opening prompt as a subtitle only when it isn't already the headline.
    w.subtitle = w.headline.source !== 'prompt' ? w.title || '' : '';
  }

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
