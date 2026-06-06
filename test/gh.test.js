import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCiStatus, parseReviewStatus, parseCodexReview, parsePr } from '../src/gh.js';

test('parseCiStatus: none when no checks', () => {
  assert.equal(parseCiStatus([]), 'none');
  assert.equal(parseCiStatus(null), 'none');
});

test('parseCiStatus: pass when all CheckRuns succeed', () => {
  const checks = [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
  ];
  assert.equal(parseCiStatus(checks), 'pass');
});

test('parseCiStatus: pending when any check is in progress', () => {
  const checks = [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
  ];
  assert.equal(parseCiStatus(checks), 'pending');
});

test('parseCiStatus: fail outranks pending', () => {
  const checks = [
    { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
  ];
  assert.equal(parseCiStatus(checks), 'fail');
});

test('parseCiStatus: handles StatusContext state field', () => {
  assert.equal(parseCiStatus([{ __typename: 'StatusContext', state: 'SUCCESS' }]), 'pass');
  assert.equal(parseCiStatus([{ __typename: 'StatusContext', state: 'PENDING' }]), 'pending');
  assert.equal(parseCiStatus([{ __typename: 'StatusContext', state: 'FAILURE' }]), 'fail');
});

test('parseReviewStatus: approved / changes / pending / none', () => {
  assert.equal(parseReviewStatus({ latestReviews: [{ author: { login: 'a' }, state: 'APPROVED' }] }), 'approved');
  assert.equal(parseReviewStatus({ latestReviews: [{ author: { login: 'a' }, state: 'CHANGES_REQUESTED' }] }), 'changes');
  assert.equal(parseReviewStatus({ latestReviews: [{ author: { login: 'a' }, state: 'COMMENTED' }] }), 'pending');
  assert.equal(parseReviewStatus({ latestReviews: [], reviewRequests: [{ login: 'rev' }] }), 'pending');
  assert.equal(parseReviewStatus({ latestReviews: [], reviewRequests: [] }), 'none');
});

test('parseReviewStatus: changes_requested outranks an approval', () => {
  const pr = {
    latestReviews: [
      { author: { login: 'a' }, state: 'APPROVED' },
      { author: { login: 'b' }, state: 'CHANGES_REQUESTED' },
    ],
  };
  assert.equal(parseReviewStatus(pr), 'changes');
});

test('parseCodexReview: done when the codex bot has reviewed', () => {
  const pr = { reviews: [{ author: { login: 'chatgpt-codex-connector' }, state: 'COMMENTED', body: '### 💡 Codex Review\n...' }] };
  assert.equal(parseCodexReview(pr), 'done');
});

test('parseCodexReview: pending when codex review is requested but not posted', () => {
  const pr = { reviews: [], reviewRequests: [{ login: 'chatgpt-codex-connector' }] };
  assert.equal(parseCodexReview(pr), 'pending');
});

test('parseCodexReview: none when codex is uninvolved', () => {
  const pr = { reviews: [{ author: { login: 'human' }, state: 'APPROVED' }], reviewRequests: [] };
  assert.equal(parseCodexReview(pr), 'none');
});

test('parsePr composes the full PR record', () => {
  const pr = {
    number: 250,
    state: 'OPEN',
    title: 'count uncovered gaps inside the sleep span as Awake',
    url: 'https://github.com/acme/app/pull/250',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    latestReviews: [],
    reviews: [],
    reviewRequests: [],
  };
  const out = parsePr(pr);
  assert.equal(out.number, 250);
  assert.equal(out.state, 'OPEN');
  assert.equal(out.title, 'count uncovered gaps inside the sleep span as Awake');
  assert.equal(out.ciStatus, 'pass');
  assert.equal(out.reviewStatus, 'none');
  assert.equal(out.codexReview, 'none');
  assert.equal(out.url, 'https://github.com/acme/app/pull/250');
});
