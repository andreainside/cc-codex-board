// Parses Codex local session files:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
//   ~/.codex/session_index.jsonl   (id -> thread_name, updated_at)
// Codex Desktop also writes "subagent" rollouts (guardian / compact) that are
// NOT user-facing windows; those are filtered out. Pure functions only.

const DEFAULT_MAX = 90;

/**
 * Parse a rollout JSONL into its session_meta payload and all parsed lines.
 * @param {string} text
 * @returns {{meta: object, lines: object[]}}
 */
export function parseRollout(text) {
  const lines = [];
  if (text) {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // tolerate corrupt / mid-write lines
      }
    }
  }
  const metaLine = lines.find((o) => o && o.type === 'session_meta');
  const meta = (metaLine && metaLine.payload) || {};
  return { meta, lines };
}

/**
 * True when a rollout is an internal subagent (guardian, compact, …), not a
 * user-facing window. Drives the "宁漏勿误报" filter.
 * @param {object} meta session_meta payload
 * @returns {boolean}
 */
export function isSubagentRollout(meta) {
  if (!meta) return false;
  if (meta.thread_source === 'subagent') return true;
  const src = meta.source;
  if (src && typeof src === 'object' && src.subagent) return true;
  return false;
}

// Codex user messages are response_item entries with role:user; the very first
// is usually a synthetic <environment_context> block, which is skipped.
function codexUserTexts(lines) {
  const out = [];
  for (const o of lines) {
    if (!o || o.type !== 'response_item') continue;
    const p = o.payload;
    if (!p || p.type !== 'message' || p.role !== 'user') continue;
    const text = (Array.isArray(p.content) ? p.content : [])
      .filter((b) => b && (b.type === 'input_text' || b.type === 'text') && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) continue;
    if (text.startsWith('<')) continue; // <environment_context>, <permissions instructions>, …
    out.push(text);
  }
  return out;
}

function truncate(text, maxLength) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLength) return t;
  return t.slice(0, maxLength).trimEnd() + '…';
}

/** First real user prompt — the window title. */
export function extractCodexTitle(lines, opts = {}) {
  const texts = codexUserTexts(lines);
  return truncate(texts[0] ?? '', opts.maxLength ?? DEFAULT_MAX);
}

/** Latest real user prompt — what it's doing now. */
export function extractCodexActivity(lines, opts = {}) {
  const texts = codexUserTexts(lines);
  return truncate(texts[texts.length - 1] ?? '', opts.maxLength ?? DEFAULT_MAX);
}

/**
 * Running while a turn is in flight (task_started seen last), idle once the turn
 * finished — whether it completed (task_complete) or was interrupted
 * (turn_aborted, e.g. the user pressed Esc). Defaults to idle. Without the
 * turn_aborted case an aborted turn would stay "running" forever, since Codex
 * never writes a task_complete for it.
 * @returns {'running'|'idle'}
 */
export function extractCodexStatus(lines) {
  let state = 'idle';
  for (const o of lines) {
    if (!o || o.type !== 'event_msg' || !o.payload) continue;
    const t = o.payload.type;
    if (t === 'task_started') state = 'running';
    else if (t === 'task_complete' || t === 'turn_aborted') state = 'idle';
  }
  return state;
}

/** Max line timestamp in ms, or null. */
export function extractCodexLastActivityAt(lines) {
  let max = null;
  for (const o of lines) {
    if (!o || typeof o.timestamp !== 'string') continue;
    const t = Date.parse(o.timestamp);
    if (Number.isNaN(t)) continue;
    if (max === null || t > max) max = t;
  }
  return max;
}

/**
 * Parse session_index.jsonl into a Map of conversation id -> { threadName, updatedAt }.
 * @param {string} text
 * @returns {Map<string,{threadName:string, updatedAt:number|null}>}
 */
export function parseSessionIndex(text) {
  const map = new Map();
  if (!text) return map;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o.id !== 'string') continue;
    map.set(o.id, {
      threadName: typeof o.thread_name === 'string' ? o.thread_name : '',
      updatedAt: o.updated_at ? Date.parse(o.updated_at) || null : null,
    });
  }
  return map;
}

/**
 * Extract start time (ms) and conversation id from a rollout filename.
 * rollout-2026-06-06T14-09-54-<uuid>.jsonl
 * @param {string} name
 * @returns {{startedAt:number|null, id:string|null}}
 */
export function parseRolloutFilename(name) {
  const m = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f-]+)\.jsonl$/.exec(name);
  if (!m) return { startedAt: null, id: null };
  const [, date, hh, mm, ss, id] = m;
  const startedAt = Date.parse(`${date}T${hh}:${mm}:${ss}`);
  return { startedAt: Number.isNaN(startedAt) ? null : startedAt, id };
}

/**
 * Compose a Codex window summary from raw rollout text.
 * @param {string} text
 * @param {{maxLength?:number}} [opts]
 */
export function summarizeRollout(text, opts = {}) {
  const { meta, lines } = parseRollout(text);
  const metaTs = lines.find((o) => o && o.type === 'session_meta')?.timestamp;
  return {
    id: meta.id ?? null,
    cwd: meta.cwd ?? null,
    parentThreadId: meta.parent_thread_id ?? null,
    isSubagent: isSubagentRollout(meta),
    title: extractCodexTitle(lines, opts),
    currentActivity: extractCodexActivity(lines, opts),
    status: extractCodexStatus(lines),
    startedAt: metaTs ? Date.parse(metaTs) || null : null,
    lastActivityAt: extractCodexLastActivityAt(lines),
  };
}
