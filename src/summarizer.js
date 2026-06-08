// OPTIONAL AI headline generator. Off by default — the board is zero-LLM unless
// this is explicitly enabled. When on, it shells out to the local `claude -p`
// (print/headless) which runs on the user's CC SUBSCRIPTION (OAuth), not the
// pay-per-token API. To stay cheap and rate-limit friendly it only summarizes a
// window when its turn completes (running → idle, or first sighting while idle),
// caches per turn, and falls back silently to the non-LLM headline on any error.

import { execFile } from 'node:child_process';
import os from 'node:os';

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_LEN = 24;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_CONCURRENCY = 3;

function defaultExec(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Run from a neutral cwd so `claude -p` doesn't load the window's project
    // CLAUDE.md / .mcp.json — the titling task needs none of it.
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, cwd: os.tmpdir() }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Build the (bounded) prompt asking for a short "what is this doing" title. */
export function buildSummaryPrompt(window) {
  const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
  const lastMsg = window.lastMessage ? clip(window.lastMessage.text, 200) : '';
  return [
    'Title this coding session for a dashboard. In <= 8 words (or <= 16 Chinese characters),',
    'say what it is working on right now. Output ONLY the title — no quotes, no preamble.',
    '',
    `Opening request: ${clip(window.title, 300)}`,
    `Latest instruction: ${clip(window.currentActivity, 300)}`,
    lastMsg ? `Latest message: ${lastMsg}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Clean the model output into a tidy single-line title. */
export function parseSummaryOutput(stdout, opts = {}) {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  if (!stdout) return '';
  let line = String(stdout).split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  line = line.replace(/^["'“”『「]+/, '').replace(/["'“”』」]+$/, '').trim();
  if (line.length > maxLen) line = line.slice(0, maxLen);
  return line;
}

/**
 * Parse `claude -p --output-format json` stdout into { title, usage }.
 * Falls back to treating stdout as a plain-text title (usage:null) if not JSON.
 * @param {string} stdout
 * @param {{maxLen?:number}} [opts]
 */
export function parseClaudeResult(stdout, opts = {}) {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  if (!stdout) return { title: '', usage: null };
  let obj = null;
  try { obj = JSON.parse(stdout); } catch { obj = null; }
  if (obj && typeof obj === 'object' && (typeof obj.result === 'string' || obj.usage)) {
    // `claude -p` can exit 0 with an ERROR envelope (rate limit, overloaded,
    // max-turns, refusal): { is_error:true, result:<human error text> }. The
    // process didn't throw, so the caller's try/catch never fires — treat it as a
    // failure here so it backs off and falls back to the non-LLM headline instead
    // of rendering the raw error string as the window's title.
    if (obj.is_error) return { title: '', usage: null };
    const u = obj.usage || {};
    const usage = {
      inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      outputTokens: u.output_tokens || 0,
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0,
    };
    return { title: parseSummaryOutput(obj.result || '', { maxLen }), usage };
  }
  return { title: parseSummaryOutput(stdout, { maxLen }), usage: null };
}

// A window has "advanced" (needs a fresh summary) whenever its last activity
// timestamp changes — that marks a new completed turn.
function signatureOf(window) {
  return String(window.lastActivityAt ?? window.startedAt ?? '');
}

/**
 * @param {{enabled:boolean, model?:string, exec?:Function, maxLen?:number,
 *   timeoutMs?:number, concurrency?:number}} opts
 */
export function createSummarizer({
  enabled,
  model = DEFAULT_MODEL,
  exec = defaultExec,
  maxLen = DEFAULT_MAX_LEN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  now = () => Date.now(),
  retryBackoffMs = 60_000,
} = {}) {
  const cache = new Map(); // id -> { signature, title }   (successful summaries)
  const failed = new Map(); // id -> { signature, at }      (last failure, for backoff)
  const inflight = new Set(); // id currently summarizing
  let active = 0;

  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  function recordUsage(usage) {
    totals.calls += 1;
    if (usage) {
      totals.inputTokens += usage.inputTokens || 0;
      totals.outputTokens += usage.outputTokens || 0;
      totals.costUsd += usage.costUsd || 0;
    }
  }
  function getUsage() { return { ...totals }; }

  function getTitle(window) {
    const hit = cache.get(window.id);
    if (hit && hit.signature === signatureOf(window)) return hit.title;
    return null;
  }

  async function runSummary(window) {
    const sig = signatureOf(window);
    inflight.add(window.id);
    active += 1;
    try {
      // Titling needs no tools or project context. --strict-mcp-config skips
      // loading the user's MCP servers (initializing ~20 of them on a busy
      // machine is the dominant startup cost); defaultExec also runs it from a
      // neutral cwd so no per-project CLAUDE.md/.mcp.json is loaded.
      const args = ['-p', '--output-format', 'json', '--strict-mcp-config', '--model', model, buildSummaryPrompt(window)];
      const stdout = await exec('claude', args, timeoutMs);
      const { title, usage } = parseClaudeResult(stdout, { maxLen });
      recordUsage(usage);
      if (title) {
        cache.set(window.id, { signature: sig, title });
        failed.delete(window.id);
        return title;
      }
      failed.set(window.id, { signature: sig, at: now() });
      return null;
    } catch {
      failed.set(window.id, { signature: sig, at: now() }); // back off; don't hammer a broken claude
      return null; // fall back to the non-LLM headline; never poison the cache
    } finally {
      inflight.delete(window.id);
      active -= 1;
    }
  }

  /**
   * Summarize an idle window that has no summary for its current turn. Eligible
   * windows beyond the concurrency cap are skipped and naturally retried on the
   * next refresh (so a startup burst staggers out instead of being dropped).
   * Returns the in-progress Promise when it triggers work, else null.
   */
  function schedule(window) {
    if (!enabled) return null;
    if (window.status === 'running') return null; // only summarize completed turns
    if (getTitle(window) !== null) return null; // already summarized this turn
    if (inflight.has(window.id)) return null;

    const sig = signatureOf(window);
    const f = failed.get(window.id);
    if (f && f.signature === sig && now() - f.at < retryBackoffMs) return null; // within backoff

    if (active >= concurrency) return null; // shed; retried next refresh as slots free
    return runSummary(window);
  }

  /**
   * Manual on-demand summary: bypasses enabled / running / turn-gating / backoff.
   * Still dedupes via inflight. The click itself is the user's consent, so this
   * runs even when auto-summary (enabled) is off.
   */
  async function summarizeNow(window) {
    if (inflight.has(window.id)) return getTitle(window);
    return runSummary(window);
  }

  return { enabled, getTitle, schedule, summarizeNow, getUsage };
}
