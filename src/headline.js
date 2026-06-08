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
  // Drop a leading kind segment (feature/fix/chore/…) even when it is the ONLY
  // segment: a bare-kind branch ('feature', 'fix', 'release') carries no useful
  // info, so collapse it to null rather than surfacing the lone word as a
  // headline that would still outrank a real per-session window title.
  if (segs.length && KIND_PREFIXES.has(segs[0].toLowerCase())) segs = segs.slice(1);
  const label = segs.join(' · ').trim();
  return label || null;
}

/**
 * Pick the headline and report which source it came from (so the renderer can
 * avoid repeating the opening prompt as a subtitle).
 *
 * Priority is ordered by how SESSION-SPECIFIC each signal is. summaryTitle (an
 * AI summary of this very session) wins; then the window's own tab/thread title
 * (Claude Desktop, terminal, or Codex), which names THIS window. pr.title and
 * branch sit BELOW them because they are shared by every session in the same
 * checkout/PR — ranking them higher made multiple windows in one worktree
 * collapse to a single identical headline. The paste-y opening prompt is the last
 * resort. (buildBoard runs a final pass that disambiguates any residual collision
 * — two title-less windows in one checkout — by falling back to the prompt.)
 * @param {{summaryTitle?:string, pr?:{title?:string}, branch?:string,
 *   windowTitle?:string, title?:string}} w
 * @returns {{text:string, source:'summary'|'pr'|'branch'|'windowtitle'|'prompt'}}
 */
export function chooseHeadline(w) {
  if (w.summaryTitle && w.summaryTitle.trim()) return { text: w.summaryTitle.trim(), source: 'summary' };
  if (w.windowTitle && w.windowTitle.trim()) return { text: w.windowTitle.trim(), source: 'windowtitle' };
  if (w.pr && w.pr.title && w.pr.title.trim()) return { text: w.pr.title.trim(), source: 'pr' };
  const branch = humanizeBranch(w.branch);
  if (branch) return { text: branch, source: 'branch' };
  return { text: (w.title || '').trim(), source: 'prompt' };
}
