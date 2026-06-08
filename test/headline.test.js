import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeBranch, chooseHeadline } from '../src/headline.js';

test('humanizeBranch strips the kind prefix and joins segments', () => {
  assert.equal(humanizeBranch('feature/health/login-crash-fix'), 'health · login-crash-fix');
  assert.equal(humanizeBranch('feature/api/rate-limit-aware'), 'api · rate-limit-aware');
  assert.equal(humanizeBranch('fix/login-crash'), 'login-crash');
});

test('humanizeBranch returns null for non-descriptive branches', () => {
  assert.equal(humanizeBranch('main'), null);
  assert.equal(humanizeBranch('master'), null);
  assert.equal(humanizeBranch('HEAD'), null);
  assert.equal(humanizeBranch(''), null);
  assert.equal(humanizeBranch(null), null);
});

test('chooseHeadline prefers the AI summary when present', () => {
  const w = { summaryTitle: '修睡眠占比 bug', pr: { title: 'PR title' }, branch: 'feature/x', title: 'opening' };
  assert.deepEqual(chooseHeadline(w), { text: '修睡眠占比 bug', source: 'summary' });
});

test('chooseHeadline order: summary → window title → PR title → branch → opening prompt', () => {
  // window title (per-session) outranks pr/branch (shared across a checkout)
  assert.deepEqual(chooseHeadline({ branch: 'feature/health/sleep-fix', windowTitle: 'Win', title: 'op' }), { text: 'Win', source: 'windowtitle' });
  assert.deepEqual(chooseHeadline({ pr: { title: 'Fix sleep gap' }, branch: 'feature/health/x', windowTitle: 'Win', title: 'op' }), { text: 'Win', source: 'windowtitle' });
  // no window title → PR title, then branch
  assert.deepEqual(chooseHeadline({ pr: { title: 'Fix sleep gap' }, branch: 'feature/health/x', title: 'op' }), { text: 'Fix sleep gap', source: 'pr' });
  assert.deepEqual(chooseHeadline({ branch: 'feature/health/sleep-fix', title: 'op' }), { text: 'health · sleep-fix', source: 'branch' });
  // nothing but the prompt
  assert.deepEqual(chooseHeadline({ branch: 'main', title: '开场提问' }), { text: '开场提问', source: 'prompt' });
  assert.deepEqual(chooseHeadline({ title: '开场提问' }), { text: '开场提问', source: 'prompt' });
});

test('humanizeBranch collapses a bare kind-only branch to null (not a useless one-word headline)', () => {
  for (const b of ['feature', 'feat', 'fix', 'bugfix', 'hotfix', 'chore', 'release', 'refactor', 'docs']) {
    assert.equal(humanizeBranch(b), null, `bare '${b}' should be null`);
  }
  assert.equal(humanizeBranch('feature/feature'), 'feature'); // only the leading kind is stripped
});

test('chooseHeadline: a window title outranks pr.title and branch (per-session beats shared)', () => {
  // Two sessions in one checkout share branch + PR; the window's own tab/thread
  // title is what distinguishes them, so it must win over both.
  const w = {
    pr: { title: 'Add web_fetch server tool' },
    branch: 'feature/chat/web-fetch-server-tool',
    windowTitle: 'Investigate sleep data',
    title: 'User ID (Clerk): user_xxx …',
  };
  assert.deepEqual(chooseHeadline(w), { text: 'Investigate sleep data', source: 'windowtitle' });
});
