// Parses `gh pr view --json ...` output into the board's PR record.
// Pure: takes already-parsed JSON objects. The actual `gh` invocation + caching
// lives in the collector/runner; these parsers respect GitHub rate limits by
// being called only on cached data.

// The GitHub login the Codex cloud reviewer posts as.
const CODEX_BOT_LOGINS = new Set(['chatgpt-codex-connector', 'codex']);

function isCodexLogin(login) {
  if (!login) return false;
  const l = String(login).toLowerCase();
  if (CODEX_BOT_LOGINS.has(l)) return true;
  return l.includes('codex');
}

/**
 * Reduce a statusCheckRollup array to a single CI status.
 * Severity order: fail > pending > pass > none.
 * @param {object[]|null} rollup
 * @returns {'pass'|'fail'|'pending'|'none'}
 */
export function parseCiStatus(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let sawPending = false;
  let sawPass = false;
  for (const check of rollup) {
    const one = classifyCheck(check);
    if (one === 'fail') return 'fail';
    if (one === 'pending') sawPending = true;
    else if (one === 'pass') sawPass = true;
  }
  if (sawPending) return 'pending';
  if (sawPass) return 'pass';
  return 'none';
}

function classifyCheck(check) {
  if (!check) return 'none';
  // CheckRun: has status + conclusion
  if (check.status != null || check.conclusion != null) {
    const status = String(check.status || '').toUpperCase();
    const conclusion = String(check.conclusion || '').toUpperCase();
    if (status && status !== 'COMPLETED') return 'pending'; // QUEUED / IN_PROGRESS / PENDING / WAITING
    if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(conclusion)) return 'fail';
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) return 'pass';
    if (!conclusion) return 'pending';
    return 'pending';
  }
  // StatusContext: has state
  const state = String(check.state || '').toUpperCase();
  if (state === 'SUCCESS') return 'pass';
  if (['FAILURE', 'ERROR'].includes(state)) return 'fail';
  if (['PENDING', 'EXPECTED'].includes(state)) return 'pending';
  return 'none';
}

/**
 * Reduce reviews to a single review status.
 * Severity order: changes > approved > pending > none.
 * @param {{latestReviews?:object[], reviews?:object[], reviewRequests?:object[]}} pr
 * @returns {'approved'|'changes'|'pending'|'none'}
 */
export function parseReviewStatus(pr) {
  if (!pr) return 'none';
  const reviews = Array.isArray(pr.latestReviews) && pr.latestReviews.length
    ? pr.latestReviews
    : Array.isArray(pr.reviews)
      ? pr.reviews
      : [];
  let approved = false;
  let commented = false;
  for (const r of reviews) {
    const state = String(r.state || '').toUpperCase();
    if (state === 'CHANGES_REQUESTED') return 'changes';
    if (state === 'APPROVED') approved = true;
    else if (state === 'COMMENTED') commented = true;
  }
  if (approved) return 'approved';
  if (commented) return 'pending';
  if (Array.isArray(pr.reviewRequests) && pr.reviewRequests.length) return 'pending';
  return 'none';
}

/**
 * Codex cloud review state for the PR.
 * done   — the codex bot has posted a review/comment.
 * pending — a codex review is requested but not yet posted.
 * none   — codex is uninvolved.
 * @param {{reviews?:object[], reviewRequests?:object[]}} pr
 * @returns {'done'|'pending'|'none'}
 */
export function parseCodexReview(pr) {
  if (!pr) return 'none';
  const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
  for (const r of reviews) {
    const login = r.author && r.author.login;
    if (isCodexLogin(login)) return 'done';
    if (typeof r.body === 'string' && /Codex Review/i.test(r.body)) return 'done';
  }
  const requests = Array.isArray(pr.reviewRequests) ? pr.reviewRequests : [];
  for (const req of requests) {
    if (isCodexLogin(req.login || req.slug || req.name)) return 'pending';
  }
  return 'none';
}

/**
 * Compose the board PR record from a `gh pr view --json` object.
 * @param {object} pr
 */
export function parsePr(pr) {
  if (!pr) return null;
  return {
    number: pr.number ?? null,
    state: pr.state ?? null,
    title: pr.title ?? null,
    url: pr.url ?? null,
    ciStatus: parseCiStatus(pr.statusCheckRollup),
    reviewStatus: parseReviewStatus(pr),
    codexReview: parseCodexReview(pr),
  };
}
