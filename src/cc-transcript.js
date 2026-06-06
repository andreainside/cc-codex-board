// Parses a Claude Code transcript JSONL:
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// All display text comes straight from the transcript — no summarisation.
// Pure: every function takes already-parsed lines (or raw text) and returns data.

const DEFAULT_TITLE_MAX = 90;

/**
 * Split a JSONL transcript into parsed objects, skipping blank/malformed lines.
 * @param {string} text
 * @returns {object[]}
 */
export function parseTranscriptLines(text) {
  const out = [];
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // tolerate partial/corrupt lines (a transcript may be mid-write)
    }
  }
  return out;
}

// Extract plain text from a transcript message's `content`, which is either a
// string (a typed prompt / reply) or an array of blocks. Only text/`input_text`
// blocks contribute; tool_result / image / attachment blocks are ignored.
function messageText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && (b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

// A "real" user prompt is something the human typed — not a tool_result, a
// slash-command echo, a system reminder, or a local-command caveat. Those are
// wrapped in angle-bracket tags or known prefixes.
function isMetaUserText(text) {
  const t = text.trimStart();
  if (!t) return true;
  if (t.startsWith('<')) return true; // <command-name>, <system-reminder>, <local-command-*>, <environment_context>
  if (t.startsWith('Caveat:')) return true;
  if (t.startsWith('[Request interrupted')) return true;
  return false;
}

function isUserLine(o) {
  return o && o.type === 'user' && o.message && o.message.role !== 'assistant';
}

function realUserTexts(lines) {
  const out = [];
  for (const o of lines) {
    if (!isUserLine(o)) continue;
    const text = messageText(o.message).trim();
    if (!text || isMetaUserText(text)) continue;
    out.push(text);
  }
  return out;
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '…';
}

/**
 * The session's opening prompt — the title of the window.
 * @param {object[]} lines
 * @param {{maxLength?:number}} [opts]
 * @returns {string}
 */
export function extractTitle(lines, opts = {}) {
  const maxLength = opts.maxLength ?? DEFAULT_TITLE_MAX;
  const texts = realUserTexts(lines);
  const first = texts[0] ?? '';
  return truncate(first.replace(/\s+/g, ' ').trim(), maxLength);
}

/**
 * What the window is doing right now = the latest `last-prompt` line, falling
 * back to the most recent real user message. NEVER an AI summary.
 * @param {object[]} lines
 * @param {{maxLength?:number}} [opts]
 * @returns {string}
 */
export function extractCurrentActivity(lines, opts = {}) {
  const maxLength = opts.maxLength ?? DEFAULT_TITLE_MAX;
  let lastPrompt = '';
  for (const o of lines) {
    if (o && o.type === 'last-prompt' && typeof o.lastPrompt === 'string') {
      lastPrompt = o.lastPrompt;
    }
  }
  if (!lastPrompt.trim()) {
    const texts = realUserTexts(lines);
    lastPrompt = texts[texts.length - 1] ?? '';
  }
  return truncate(lastPrompt.replace(/\s+/g, ' ').trim(), maxLength);
}

/**
 * Associated PRs from `pr-link` lines, deduped by number (latest wins),
 * sorted ascending by number.
 * @param {object[]} lines
 * @returns {{number:number, url:string, repository:string, timestamp:string}[]}
 */
export function extractPrLinks(lines) {
  // Transcript lines are in chronological file order, so the last pr-link seen
  // for a given number is the freshest — overwrite unconditionally (timestamps
  // can be missing, which must not let a stale entry win).
  const byNumber = new Map();
  for (const o of lines) {
    if (!o || o.type !== 'pr-link' || typeof o.prNumber !== 'number') continue;
    byNumber.set(o.prNumber, {
      number: o.prNumber,
      url: o.prUrl || '',
      repository: o.prRepository || '',
      timestamp: o.timestamp || '',
    });
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * Most recent activity timestamp (ms epoch), or null if none present.
 * @param {object[]} lines
 * @returns {number|null}
 */
export function extractLastActivityAt(lines) {
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
 * Best-effort needs-you signal: the last assistant turn ended with a question,
 * i.e. it is awaiting the user's input/decision. False positives are worse than
 * false negatives, so this stays conservative (must end in a question mark).
 * @param {object[]} lines
 * @returns {boolean}
 */
export function extractAwaitingInput(lines) {
  // Walk the transcript tracking the last *meaningful* turn — a real user
  // prompt or an assistant text reply. If the user has already responded after
  // the assistant's question, the last meaningful turn is the user's, so we are
  // NOT awaiting input (avoids the false positive).
  let last = null; // { role: 'assistant'|'user', text }
  for (const o of lines) {
    if (!o) continue;
    if (o.type === 'assistant' && o.message) {
      const t = messageText(o.message).trim();
      if (t) last = { role: 'assistant', text: t };
    } else if (isUserLine(o)) {
      const t = messageText(o.message).trim();
      if (t && !isMetaUserText(t)) last = { role: 'user', text: t };
    }
  }
  if (!last || last.role !== 'assistant') return false;
  return /[?？]$/.test(last.text.trimEnd());
}

/**
 * The most recent message in the transcript and who sent it — the literal
 * "last message", regardless of role (never a summary).
 * @param {object[]} lines
 * @param {{maxLength?:number}} [opts]
 * @returns {{role:'user'|'assistant', text:string}|null}
 */
export function extractLastMessage(lines, opts = {}) {
  const maxLength = opts.maxLength ?? DEFAULT_TITLE_MAX;
  let last = null;
  for (const o of lines) {
    if (!o) continue;
    if (o.type === 'assistant' && o.message) {
      const t = messageText(o.message).trim();
      if (t) last = { role: 'assistant', text: t };
    } else if (isUserLine(o)) {
      const t = messageText(o.message).trim();
      if (t && !isMetaUserText(t)) last = { role: 'user', text: t };
    }
  }
  if (!last) return null;
  return { role: last.role, text: truncate(last.text.replace(/\s+/g, ' ').trim(), maxLength) };
}

/**
 * Compose all transcript-derived fields from raw JSONL text.
 * @param {string} text
 * @param {{maxLength?:number}} [opts]
 */
export function summarizeTranscript(text, opts = {}) {
  const lines = parseTranscriptLines(text);
  return {
    title: extractTitle(lines, opts),
    currentActivity: extractCurrentActivity(lines, opts),
    prLinks: extractPrLinks(lines),
    lastActivityAt: extractLastActivityAt(lines),
    awaitingInput: extractAwaitingInput(lines),
    lastMessage: extractLastMessage(lines, opts),
  };
}
