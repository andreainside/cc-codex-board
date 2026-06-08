// Status taxonomy + priority (approved in SPEC).
//   needs-you (red, pinned)  >  running  >  waiting-ci-review  >  idle
// Pure derivation from an already-assembled window record.

export const STATUS = {
  NEEDS_YOU: 'needs-you',
  RUNNING: 'running',
  WAITING: 'waiting-ci-review',
  IDLE: 'idle',
};

export const STATUS_PRIORITY = {
  'needs-you': 0,
  running: 1,
  'waiting-ci-review': 2,
  idle: 3,
};

const DEFAULT_RUNNING_RECENCY_MS = 90_000;

const RUNNING_RAW = new Set(['running', 'busy', 'working', 'active']);
const IDLE_RAW = new Set(['idle', 'waiting', 'done', 'complete']);

// Is the window actively working right now, and do we KNOW it (authoritative) or
// only guess it (recency)? An explicit raw status (CC CLI `status`, Codex task
// state) is authoritative. Desktop sessions carry no raw status, so the running
// flag falls back to activity recency — a guess, flagged `authoritative:false`.
function runningSignal(window, now, recencyMs) {
  const raw = typeof window.rawStatus === 'string' ? window.rawStatus.toLowerCase() : null;
  if (raw && RUNNING_RAW.has(raw)) return { running: true, authoritative: true };
  if (raw && IDLE_RAW.has(raw)) return { running: false, authoritative: true };
  if (typeof window.lastActivityAt === 'number') {
    return { running: now - window.lastActivityAt <= recencyMs, authoritative: false };
  }
  return { running: false, authoritative: false };
}

function prPending(pr) {
  if (!pr || pr.number == null) return false;
  return pr.ciStatus === 'pending' || pr.reviewStatus === 'pending';
}

/**
 * Derive the board status for a window.
 * @param {{rawStatus?:string, awaitingInput?:boolean, waitingFor?:string|null,
 *   dismissedAt?:number, lastActivityAt?:number,
 *   pr?:{number?:number, ciStatus?:string, reviewStatus?:string}}} window
 * @param {{now?:number, runningRecencyMs?:number}} [opts]
 * @returns {'needs-you'|'running'|'waiting-ci-review'|'idle'}
 */
export function deriveStatus(window, opts = {}) {
  const now = opts.now ?? Date.now();
  const recencyMs = opts.runningRecencyMs ?? DEFAULT_RUNNING_RECENCY_MS;
  const { running, authoritative } = runningSignal(window, now, recencyMs);

  // Manual dismissal ("忽略"): the user decided this window's pending ask is
  // handled and doesn't want it flagged red anymore. Suppress needs-you until
  // genuinely NEW activity arrives — i.e. lastActivityAt advances past the moment
  // it was dismissed. (Mirrors the restore clock; a new question/permission prompt
  // bumps lastActivityAt and re-arms the alert.)
  const dismissed =
    typeof window.dismissedAt === 'number' && window.dismissedAt >= (window.lastActivityAt ?? 0);

  // needs-you = the window is blocked on the user. Two signals:
  //  (1) waitingFor — CC's OWN authoritative "blocked on the user" flag, written to
  //      the cli session file while a permission/approval prompt is showing (the
  //      tool_use isn't flushed to the transcript yet, so awaitingInput can't see
  //      it). Authoritative: it overrides even a busy/recent-activity guess.
  //  (2) awaitingInput — derived from the transcript (last turn ended with a
  //      question, or a pending tool with no result). It outranks a *presumed*
  //      running state (desktop recency guess) but yields to an AUTHORITATIVE busy
  //      status (CLI `status=busy`, Codex task running) — that tool is executing.
  if (!dismissed) {
    if (window.waitingFor) return STATUS.NEEDS_YOU;
    if (window.awaitingInput && !(running && authoritative)) return STATUS.NEEDS_YOU;
  }
  if (running) return STATUS.RUNNING;
  if (prPending(window.pr)) return STATUS.WAITING;
  return STATUS.IDLE;
}

/**
 * Sort comparator: status priority asc, then most-recent activity first,
 * then most-recently started first.
 */
export function compareWindows(a, b) {
  const pa = STATUS_PRIORITY[a.status] ?? 99;
  const pb = STATUS_PRIORITY[b.status] ?? 99;
  if (pa !== pb) return pa - pb;
  const la = a.lastActivityAt ?? a.startedAt ?? 0;
  const lb = b.lastActivityAt ?? b.startedAt ?? 0;
  if (la !== lb) return lb - la;
  return (b.startedAt ?? 0) - (a.startedAt ?? 0);
}

/**
 * Count windows per status for the summary bar.
 * @param {{status:string}[]} windows
 */
export function summarize(windows) {
  const counts = { 'needs-you': 0, running: 0, 'waiting-ci-review': 0, idle: 0 };
  for (const w of windows) {
    if (w.status in counts) counts[w.status] += 1;
  }
  return { total: windows.length, counts };
}
