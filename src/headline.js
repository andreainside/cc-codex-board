// Chooses a card's big headline ("what is this window working on") from
// available NON-LLM signals, falling back to the opening prompt. When the
// optional summarizer is enabled, its AI summary takes precedence.

const KIND_PREFIXES = new Set(['feature', 'feat', 'fix', 'bugfix', 'hotfix', 'chore', 'release', 'refactor', 'test', 'docs']);
const NON_DESCRIPTIVE = new Set(['main', 'master', 'head', 'develop', 'dev', '']);

/**
 * Turn a branch into a readable label, or null if it carries no useful info.
 * feature/health/login-crash-fix → "health · login-crash-fix"
 * @param {string|null|undefined} branch
 * @returns {string|null}
 */
export function humanizeBranch(branch) {
  if (!branch || typeof branch !== 'string') return null;
  if (NON_DESCRIPTIVE.has(branch.toLowerCase())) return null;
  let segs = branch.split('/').filter(Boolean);
  if (segs.length > 1 && KIND_PREFIXES.has(segs[0].toLowerCase())) segs = segs.slice(1);
  const label = segs.join(' · ').trim();
  return label || null;
}

/**
 * Pick the headline and report which source it came from (so the renderer can
 * avoid repeating the opening prompt as a subtitle).
 * @param {{summaryTitle?:string, pr?:{title?:string}, branch?:string, windowTitle?:string, title?:string}} w
 * @returns {{text:string, source:'summary'|'pr'|'branch'|'windowtitle'|'prompt'}}
 */
export function chooseHeadline(w) {
  if (w.summaryTitle && w.summaryTitle.trim()) return { text: w.summaryTitle.trim(), source: 'summary' };
  if (w.pr && w.pr.title && w.pr.title.trim()) return { text: w.pr.title.trim(), source: 'pr' };
  const branch = humanizeBranch(w.branch);
  if (branch) return { text: branch, source: 'branch' };
  // The app/sidebar-displayed title beats a raw paste-y opening prompt.
  if (w.windowTitle && w.windowTitle.trim()) return { text: w.windowTitle.trim(), source: 'windowtitle' };
  return { text: (w.title || '').trim(), source: 'prompt' };
}
