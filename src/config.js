// Configuration: defaults < config file < CLI flags. Pure resolution so it can
// be unit-tested; the bin handles reading the file and the home dir.

import path from 'node:path';

export const DEFAULTS = {
  port: 4317,
  localTtlMs: 5000, // re-read local session files at most this often
  gitTtlMs: 45000, // git/gh per cwd/repo at most this often (rate-limit friendly)
  runningRecencyMs: 90_000, // activity newer than this ⇒ "running" when no raw status
  codexActiveWindowMs: 2 * 60 * 60_000, // a Codex rollout counts as a live window if active within this
  titleMax: 90,
  git: true,
  gh: true,
  open: false,
  terminalTitles: true, // resolve CLI terminal tab titles (macOS, read-only AppleScript)
  summary: false, // OPT-IN: AI headline via `claude -p` (CC subscription). Off ⇒ zero LLM calls.
  summaryModel: 'claude-haiku-4-5',
  labels: {}, // pid or cwd -> friendly label
};

// Where the Claude Desktop app stores per-tab session records (with titles).
function defaultDesktopRoot(home, platform) {
  if (platform === 'darwin') {
    return `${home}/Library/Application Support/Claude/claude-code-sessions`;
  }
  return null; // best-effort; unknown layout on other platforms
}

function expandHome(p, home) {
  if (typeof p !== 'string') return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/**
 * @param {{home:string, fileConfig?:object, flags?:object}} input
 */
export function resolveConfig({ home, platform = process.platform, fileConfig = {}, flags = {} }) {
  const c = { ...DEFAULTS, ...fileConfig };

  // Flag overrides (only when present)
  if (flags.port != null) c.port = Number(flags.port);
  if (flags['claude-root']) c.claudeRoot = flags['claude-root'];
  if (flags['codex-root']) c.codexRoot = flags['codex-root'];
  if (flags['desktop-root']) c.desktopRoot = flags['desktop-root'];
  if (flags['no-git']) c.git = false;
  if (flags['no-gh']) c.gh = false;
  if (flags.open) c.open = true;
  if (flags['no-terminal-titles']) c.terminalTitles = false;
  if (flags.summary) c.summary = true;
  if (flags['no-summary']) c.summary = false;
  if (flags['summary-model']) c.summaryModel = flags['summary-model'];

  c.claudeRoot = expandHome(c.claudeRoot || path.join(home, '.claude'), home);
  c.codexRoot = expandHome(c.codexRoot || path.join(home, '.codex'), home);
  const desktop = c.desktopRoot !== undefined ? c.desktopRoot : defaultDesktopRoot(home, platform);
  c.desktopRoot = desktop ? expandHome(desktop, home) : null;
  c.labels = c.labels || {};
  return c;
}

/**
 * Minimal CLI flag parser: --key value, --key=value, --flag.
 * Numeric-looking values are coerced to numbers.
 * @param {string[]} argv
 */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = coerce(body.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = coerce(next);
        i += 1;
      } else {
        flags[body] = true;
      }
    }
  }
  return flags;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}
