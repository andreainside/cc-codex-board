// Parses Claude Code session files: ~/.claude/sessions/<pid>.json
// One file per launched CC window. Pure: takes file text, returns a session object.

/**
 * Parse the JSON text of a single CC session file.
 * @param {string} text raw file contents
 * @returns {null | {pid:number, sessionId:string, cwd:string, startedAt:number,
 *   status?:string, updatedAt?:number, entrypoint?:string, kind?:string,
 *   version?:string, procStart?:string}}
 */
export function parseCcSession(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.pid !== 'number') return null;
  if (typeof obj.sessionId !== 'string' || !obj.sessionId) return null;
  if (typeof obj.cwd !== 'string' || !obj.cwd) return null;
  return obj;
}
