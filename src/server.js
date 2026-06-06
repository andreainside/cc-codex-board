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

/**
 * @param {{getBoard:()=>Promise<object>, publicDir?:string}} deps
 */
export function createRequestHandler({ getBoard, publicDir = DEFAULT_PUBLIC }) {
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
  const summarizer = createSummarizer({ enabled: !!config.summary, model: config.summaryModel });

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
    });

  // Cache the whole board briefly so rapid browser polling is cheap; git/gh
  // calls inside have their own longer TTL.
  const getBoard = memoizeAsync(build, { ttlMs: config.localTtlMs, keyFn: () => 'board' });
  return { getBoard };
}

/**
 * Create (but do not start) the HTTP server.
 * @param {object} config
 */
export function createServer(config) {
  const { getBoard } = createBoardProvider(config);
  const handler = createRequestHandler({ getBoard });
  return http.createServer(handler);
}
