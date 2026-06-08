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

// Did the assistant's turn end on a question? Checks the last PROSE line, looking
// past trailing fenced code blocks and option list-items — a clarifying question
// is commonly followed by a ```diff``` or a bulleted list of choices, where the
// absolute last character isn't '?'.
function endsWithQuestion(text) {
  const lines = String(text).split('\n');
  let fence = false;
  const inFence = lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return true; } // the fence delimiter line itself
    return fence;
  });
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (inFence[i]) continue;
    const line = lines[i].trimEnd();
    if (!line.trim()) continue;
    if (/[?？]$/.test(line)) return true; // a question (incl. a bulleted one)
    if (/^\s*([-*+]|\d+[.)])\s/.test(line)) continue; // a non-question list item → keep scanning up
    return false; // a prose line that isn't a question → the turn ended on a statement
  }
  return false;
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
  // Slice by code POINTS, not UTF-16 code units, so the cut never lands between
  // the two halves of an astral char (emoji / CJK ext) and leaves a broken �.
  const cps = Array.from(text);
  if (cps.length <= maxLength) return text;
  return cps.slice(0, maxLength).join('').trimEnd() + '…';
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
 * Best-effort needs-you signal. True when the session is awaiting the user:
 *  (1) the last assistant text ended with a question, OR
 *  (2) a tool call is still pending (no tool_result anywhere) — i.e. blocked on a
 *      permission / confirmation / plan-approval prompt. deriveStatus gates this
 *      behind an authoritative busy status, so a CLI/Codex window with an
 *      in-flight tool stays "running".
 * Conservative: a real user message after an unresolved tool clears the signal.
 *
 * tool_use ↔ tool_result are matched by set membership over the WHOLE transcript,
 * NOT by forward scan order: Claude Code can flush a tool_result line to the JSONL
 * *before* its tool_use line (sub-second write race). A strict delete-then-add
 * forward pass would no-op the delete then re-add the id, leaving it stuck
 * "pending" forever and falsely flagging a busy autonomous session as awaiting
 * input. A result anywhere in the transcript resolves its use.
 * @param {object[]} lines
 * @returns {boolean}
 */
export function extractAwaitingInput(lines) {
  const resolved = new Set(); // every tool_use id that has a tool_result anywhere
  for (const o of lines) {
    if (!isUserLine(o)) continue;
    const c = o.message.content;
    if (Array.isArray(c)) {
      for (const b of c) if (b && b.type === 'tool_result' && b.tool_use_id) resolved.add(b.tool_use_id);
    }
  }

  let last = null; // { role: 'assistant'|'user', text }
  const pendingToolUse = new Set(); // tool_use ids with no tool_result anywhere

  for (const o of lines) {
    if (!o) continue;
    if (o.type === 'assistant' && o.message) {
      const c = o.message.content;
      if (Array.isArray(c)) {
        for (const b of c) if (b && b.type === 'tool_use' && b.id && !resolved.has(b.id)) pendingToolUse.add(b.id);
      }
      const t = messageText(o.message).trim();
      if (t) last = { role: 'assistant', text: t };
    } else if (isUserLine(o)) {
      const t = messageText(o.message).trim();
      if (t && !isMetaUserText(t)) {
        last = { role: 'user', text: t };
        pendingToolUse.clear(); // user moved on; no longer blocking on a tool
      }
    }
  }

  if (last && last.role === 'assistant' && endsWithQuestion(last.text)) return true;
  return pendingToolUse.size > 0;
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
