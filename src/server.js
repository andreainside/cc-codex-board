// HTTP layer: GET /api/windows -> board JSON; everything else -> static files
// from public/. The request handler takes an injected getBoard so it is
// unit-testable; createBoardProvider wires the collector + cached git/gh runners.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard } from './collector.js';
import { createRunners } from './runner.js';
import { createSummarizer } from './summarizer.js';
import { memoizeAsync } from './cache.js';
import { chooseHeadline } from './headline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    let tooBig = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    req.on('data', (chunk) => {
      if (tooBig) return; // already draining; discard
      data += chunk;
      if (data.length > limit) {
        tooBig = true;
        data = ''; // free memory; keep draining so the socket stays open for the response
        req.resume();
      }
    });
    req.on('end', () => {
      if (tooBig) return finish(null);
      try { finish(JSON.parse(data || '{}')); } catch { finish(null); }
    });
    req.on('close', () => finish(null)); // destroyed (oversized) or client aborted
    req.on('error', () => finish(null));
  });
}

/**
 * @param {{getBoard:()=>Promise<object>, summarizeWindow?:Function|null, restoreWindow?:Function|null, dismissWindow?:Function|null, publicDir?:string}} deps
 */
export function createRequestHandler({ getBoard, summarizeWindow = null, restoreWindow = null, dismissWindow = null, publicDir = DEFAULT_PUBLIC }) {
  const root = path.resolve(publicDir);
  return async function handle(req, res) {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      pathname = req.url || '/';
    }

    if (pathname === '/api/windows') {
      try {
        const board = await getBoard();
        sendJson(res, 200, board);
      } catch (err) {
        sendJson(res, 500, { error: String((err && err.message) || err) });
      }
      return;
    }

    if (pathname === '/api/summarize' || pathname === '/api/restore' || pathname === '/api/dismiss') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method Not Allowed' }); return; }
      const body = await readJsonBody(req);
      const id = body && typeof body.id === 'string' ? body.id : null;
      if (!id) { sendJson(res, 400, { error: 'missing id' }); return; }
      const fn = pathname === '/api/summarize' ? summarizeWindow : pathname === '/api/restore' ? restoreWindow : dismissWindow;
      try {
        const result = fn ? await fn(id) : null;
        if (!result) { sendJson(res, 404, { error: 'unknown window' }); return; }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: String((err && err.message) || err) });
      }
      return;
    }

    // Static files, sandboxed to public/. Resolve symlinks BEFORE the boundary
    // check (fs.readFile would otherwise follow a symlink that escapes public/).
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    let target;
    try {
      target = fs.realpathSync(path.resolve(root, rel));
    } catch {
      res.writeHead(404); res.end('Not found'); return;
    }
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(target, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  };
}

/**
 * Wire the collector with cached, throttled git/gh runners.
 * @param {object} config resolved config
 */
export function createBoardProvider(config) {
  const runners = createRunners();

  const gitKey = (cwd) => cwd;
  const resolveRepoBranch = config.git
    ? memoizeAsync(runners.resolveRepoBranch, { ttlMs: config.gitTtlMs, keyFn: gitKey })
    : async () => ({ repo: null, branch: null });

  const prKey = (repo, info = {}) => `${repo}|${info.branch || ''}|${(info.prNumbers || []).join(',')}`;
  const fetchPr = config.gh
    ? memoizeAsync(runners.fetchPr, { ttlMs: config.gitTtlMs, keyFn: prKey })
    : async () => null;

  // Terminal tab titles change rarely; cache briefly (keyed by the pid set).
  const resolveTerminalTitles = config.terminalTitles
    ? memoizeAsync(runners.resolveTerminalTitles, { ttlMs: 8000, keyFn: (pids) => (pids || []).slice().sort().join(',') })
    : null;

  // Persistent across builds so its cache + idle-transition tracking survive.
  const summarizer = createSummarizer({ enabled: !!config.summary, model: config.summaryModel, timeoutMs: config.summaryTimeoutMs });

  const restoredAt = new Map(); // id -> ms; manual restore resets the idle clock
  const dismissedAt = new Map(); // id -> ms; manual "忽略" mutes needs-you until new activity

  const build = () =>
    buildBoard({
      claudeRoot: config.claudeRoot,
      codexRoot: config.codexRoot,
      desktopRoot: config.desktopRoot,
      now: Date.now(),
      isPidAlive: runners.isPidAlive,
      resolveRepoBranch,
      fetchPr,
      resolveTerminalTitles,
      summarizer,
      runningRecencyMs: config.runningRecencyMs,
      codexActiveWindowMs: config.codexActiveWindowMs,
      titleMax: config.titleMax,
      labels: config.labels,
      idleArchiveMs: config.idleArchiveMs,
      idleDropMs: config.idleDropMs,
      getRestoredAt: (id) => restoredAt.get(id) || 0,
      getDismissedAt: (id) => dismissedAt.get(id) || 0,
    });

  // Cache the whole board briefly so rapid browser polling is cheap; git/gh
  // calls inside have their own longer TTL.
  const getBoard = memoizeAsync(build, { ttlMs: config.localTtlMs, keyFn: () => 'board' });

  async function summarizeWindow(id) {
    const board = await getBoard();
    const all = [...(board.windows || []), ...((board.archive && board.archive.windows) || [])];
    const w = all.find((x) => x.id === id);
    if (!w) return null;
    const title = await summarizer.summarizeNow(w);
    if (!title) return { id, title: null, headline: w.headline };
    return { id, title, headline: chooseHeadline({ ...w, summaryTitle: title }) };
  }

  async function restoreWindow(id) {
    const board = await getBoard();
    const all = [...(board.windows || []), ...((board.archive && board.archive.windows) || [])];
    if (!all.some((x) => x.id === id)) return null;
    restoredAt.set(id, Date.now());
    // prune stale restore markers
    const cutoff = Date.now() - (config.idleDropMs || 30 * 3600_000);
    for (const [k, v] of restoredAt) if (v < cutoff) restoredAt.delete(k);
    return { id, ok: true };
  }

  // Manual "忽略": mute a window's needs-you alert. It re-arms automatically once
  // the window sees new activity (deriveStatus compares dismissedAt vs lastActivityAt).
  async function dismissWindow(id) {
    const board = await getBoard();
    const all = [...(board.windows || []), ...((board.archive && board.archive.windows) || [])];
    if (!all.some((x) => x.id === id)) return null;
    dismissedAt.set(id, Date.now());
    // prune stale dismiss markers
    const cutoff = Date.now() - (config.idleDropMs || 30 * 3600_000);
    for (const [k, v] of dismissedAt) if (v < cutoff) dismissedAt.delete(k);
    return { id, ok: true };
  }

  return { getBoard, summarizeWindow, restoreWindow, dismissWindow };
}

/**
 * Create (but do not start) the HTTP server.
 * @param {object} config
 */
export function createServer(config) {
  const { getBoard, summarizeWindow, restoreWindow, dismissWindow } = createBoardProvider(config);
  const handler = createRequestHandler({ getBoard, summarizeWindow, restoreWindow, dismissWindow });
  return http.createServer(handler);
}
