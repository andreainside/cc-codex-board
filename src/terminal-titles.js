// Resolves the on-screen title of a TERMINAL window (Apple Terminal / iTerm2)
// for a CLI Claude Code session, so every card can be matched to its window.
// macOS-only, best-effort, read-only (reads tab titles via AppleScript). Pure
// parsing here; the osascript/ps invocation lives in runner.js.

/** Normalize a tty into a /dev path, or null when there is none. */
export function normalizeTty(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t === '??' || t === '-') return null;
  return t.startsWith('/dev/') ? t : `/dev/${t}`;
}

// Claude Code prefixes the terminal tab title with an ANIMATED status glyph — a
// braille spinner (U+2800–U+28FF) or a sparkle/asterisk (✳ ✶ ✷ …). The
// AppleScript snapshots one frame, so the glyph differs every refresh and is
// meaningless out of context. Strip a leading run of such glyphs + the space
// after them, so the stored title is the stable text the user actually reads.
// Braille spinner frames (U+2800–U+28FF; the sparse frames ⠂⠄⠈ render as a tiny
// dot) and the sparkle/asterisk family (U+2722–U+273F, incl. ✳ ✶ ✷ ✻). The
// trailing whitespace is OPTIONAL (\s*) so a title that is ONLY a spinner frame
// (no following text) strips to '' — parseTerminalTitles then drops that tty
// rather than rendering a lone braille dot as a headline.
const STATUS_GLYPH_RE = /^[⠀-⣿✢-✿]+\s*/u;

/** Drop the leading animated spinner/status glyph from a terminal tab title. */
export function stripStatusGlyph(title) {
  if (typeof title !== 'string') return title;
  return title.replace(STATUS_GLYPH_RE, '').trim();
}

/** Parse "tty<TAB>title" lines (from the AppleScript) into a Map. */
export function parseTerminalTitles(output) {
  const map = new Map();
  if (!output) return map;
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const tty = normalizeTty(line.slice(0, tab));
    const title = stripStatusGlyph(line.slice(tab + 1).trim());
    if (tty && title) map.set(tty, title);
  }
  return map;
}

/** Parse `ps -o pid=,tty=` output into pid -> /dev/tty. */
export function parsePsTtys(output) {
  const map = new Map();
  if (!output) return map;
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const tty = normalizeTty(m[2]);
    if (tty) map.set(Number(m[1]), tty);
  }
  return map;
}

// AppleScript that prints "tty<TAB>title" for every Terminal.app tab.
// (ASCII character 9) is an unambiguous tab; the bare `tab` keyword can serialize
// as literal text through osascript.
export const TERMINAL_APP_SCRIPT = `tell application "Terminal"
set out to ""
repeat with w in windows
repeat with t in tabs of w
try
set out to out & (tty of t) & (ASCII character 9) & (custom title of t) & linefeed
end try
end repeat
end repeat
return out
end tell`;

// AppleScript that prints "tty<TAB>title" for every iTerm2 session.
export const ITERM_SCRIPT = `tell application "iTerm2"
set out to ""
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
try
set out to out & (tty of s) & (ASCII character 9) & (name of s) & linefeed
end try
end repeat
end repeat
end repeat
return out
end tell`;
