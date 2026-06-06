// Impure layer: shells out to read-only `git` / `gh` and checks pid liveness.
// The command executor is injected so the logic is unit-testable; the default
// uses execFileSync with a timeout. Parsing is delegated to the tested pure
// modules (repo.js, gh.js). Never writes anything.

import { execFileSync } from 'node:child_process';
import { repoFromRemoteUrl } from './repo.js';
import { parsePr } from './gh.js';
import { parseTerminalTitles, parsePsTtys, TERMINAL_APP_SCRIPT, ITERM_SCRIPT } from './terminal-titles.js';

const DEFAULT_TIMEOUT_MS = 8000;

function defaultExec(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: DEFAULT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Is a process still running? process.kill(pid, 0) probes without signalling. */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // exists but owned by another user
  }
}

const PR_VIEW_FIELDS = 'number,state,title,url,statusCheckRollup,reviews,latestReviews,reviewRequests';

/**
 * @param {{exec?:(file:string,args:string[])=>string, platform?:string}} [deps]
 */
export function createRunners({ exec = defaultExec, platform = process.platform } = {}) {
  function git(cwd, args) {
    return exec('git', ['-C', cwd, ...args]).trim();
  }

  // Whether a GUI app is already running — without launching it (osascript's
  // `is running` is safe; `tell application` would launch a stopped app).
  function isAppRunning(name) {
    try {
      return exec('osascript', ['-e', `application "${name}" is running`]).trim() === 'true';
    } catch {
      return false;
    }
  }

  // Best-effort: map CLI session pids to their terminal tab title (macOS only).
  // Reads tab titles read-only via AppleScript; only queries terminal apps that
  // are already running (never launches one).
  async function resolveTerminalTitles(pids) {
    const out = new Map();
    if (platform !== 'darwin' || !Array.isArray(pids) || pids.length === 0) return out;
    let pidTty;
    try {
      pidTty = parsePsTtys(exec('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')]));
    } catch {
      return out;
    }
    if (!pidTty.size) return out;

    const ttyTitle = new Map();
    for (const [proc, script] of [['Terminal', TERMINAL_APP_SCRIPT], ['iTerm2', ITERM_SCRIPT]]) {
      if (!isAppRunning(proc)) continue;
      try {
        for (const [tty, title] of parseTerminalTitles(exec('osascript', ['-e', script]))) ttyTitle.set(tty, title);
      } catch {
        /* automation denied / app busy — skip */
      }
    }
    for (const [pid, tty] of pidTty) {
      const title = ttyTitle.get(tty);
      if (title) out.set(pid, title);
    }
    return out;
  }

  async function resolveRepoBranch(cwd) {
    let branch = null;
    let repo = null;
    try {
      branch = git(cwd, ['branch', '--show-current']) || null;
    } catch {
      return { repo: null, branch: null }; // not a git repo
    }
    try {
      repo = repoFromRemoteUrl(git(cwd, ['remote', 'get-url', 'origin']));
    } catch {
      repo = null;
    }
    return { repo, branch };
  }

  function ghJson(args) {
    const out = exec('gh', args);
    return JSON.parse(out);
  }

  async function fetchPr(repo, { branch, prNumbers } = {}) {
    let number = null;
    if (Array.isArray(prNumbers) && prNumbers.length) {
      number = Math.max(...prNumbers);
    } else if (branch && branch !== 'HEAD') {
      try {
        const list = ghJson(['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'number']);
        if (Array.isArray(list) && list.length) number = list[0].number;
      } catch {
        number = null;
      }
    }
    if (number == null) return null;
    try {
      const view = ghJson(['pr', 'view', String(number), '-R', repo, '--json', PR_VIEW_FIELDS]);
      return parsePr(view);
    } catch {
      return null;
    }
  }

  return { isPidAlive, resolveRepoBranch, fetchPr, resolveTerminalTitles };
}
