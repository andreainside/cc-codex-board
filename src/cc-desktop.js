// Reads the Claude DESKTOP app's per-tab session records, which carry the
// title shown on each tab in the UI:
//   ~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json
// Each record's `cliSessionId` matches a ~/.claude/sessions/<pid>.json sessionId,
// so it lets us label a card with the exact window title the user sees.
// We only READ this already-generated title — the board itself calls no LLM.

/**
 * @param {string} text
 * @returns {null | {cliSessionId:string, title:string, titleSource?:string,
 *   isArchived?:boolean, lastActivityAt?:number}}
 */
export function parseDesktopSession(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || typeof o.cliSessionId !== 'string') return null;
  return {
    cliSessionId: o.cliSessionId,
    title: typeof o.title === 'string' ? o.title : '',
    titleSource: o.titleSource,
    isArchived: !!o.isArchived,
    lastActivityAt: typeof o.lastActivityAt === 'number' ? o.lastActivityAt : null,
  };
}
