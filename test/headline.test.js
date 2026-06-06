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

test('chooseHeadline falls back to PR title, then branch, then window title, then opening prompt', () => {
  assert.deepEqual(chooseHeadline({ pr: { title: 'Fix sleep gap' }, branch: 'feature/health/x', title: 'op' }), { text: 'Fix sleep gap', source: 'pr' });
  assert.deepEqual(chooseHeadline({ branch: 'feature/health/sleep-fix', windowTitle: 'Win', title: 'op' }), { text: 'health · sleep-fix', source: 'branch' });
  assert.deepEqual(chooseHeadline({ branch: 'main', windowTitle: 'Sleep report missing', title: 'User ID (Clerk): xyz' }), { text: 'Sleep report missing', source: 'windowtitle' });
  assert.deepEqual(chooseHeadline({ branch: 'main', title: '开场提问' }), { text: '开场提问', source: 'prompt' });
  assert.deepEqual(chooseHeadline({ title: '开场提问' }), { text: '开场提问', source: 'prompt' });
});
