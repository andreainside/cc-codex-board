import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, STATUS_PRIORITY, compareWindows, summarize } from '../src/status.js';

const NOW = Date.parse('2026-06-06T06:00:00.000Z');
const opts = { now: NOW, runningRecencyMs: 90_000 };

test('needs-you: idle window whose last turn awaits the user', () => {
  const w = { rawStatus: 'idle', awaitingInput: true, lastActivityAt: NOW - 10 * 60_000 };
  assert.equal(deriveStatus(w, opts), 'needs-you');
});

test('a running window is never needs-you even if it asked a question', () => {
  const w = { rawStatus: 'busy', awaitingInput: true, lastActivityAt: NOW };
  assert.equal(deriveStatus(w, opts), 'running');
});

test('running: explicit busy/running raw status', () => {
  assert.equal(deriveStatus({ rawStatus: 'busy' }, opts), 'running');
  assert.equal(deriveStatus({ rawStatus: 'running' }, opts), 'running');
});

test('running: no raw status but very recent activity (desktop session)', () => {
  const w = { rawStatus: undefined, lastActivityAt: NOW - 30_000 };
  assert.equal(deriveStatus(w, opts), 'running');
});

test('idle: no raw status and stale activity', () => {
  const w = { rawStatus: undefined, lastActivityAt: NOW - 3 * 60 * 60_000 };
  assert.equal(deriveStatus(w, opts), 'idle');
});

test('explicit idle status beats recency (CLI session that just printed an away summary)', () => {
  const w = { rawStatus: 'idle', lastActivityAt: NOW - 1000, awaitingInput: false };
  assert.equal(deriveStatus(w, opts), 'idle');
});

test('waiting-ci-review: idle with a PR whose CI or review is pending', () => {
  assert.equal(deriveStatus({ rawStatus: 'idle', pr: { number: 250, ciStatus: 'pending', reviewStatus: 'none' } }, opts), 'waiting-ci-review');
  assert.equal(deriveStatus({ rawStatus: 'idle', pr: { number: 250, ciStatus: 'pass', reviewStatus: 'pending' } }, opts), 'waiting-ci-review');
});

test('needs-you outranks waiting-ci-review', () => {
  const w = { rawStatus: 'idle', awaitingInput: true, pr: { number: 1, ciStatus: 'pending', reviewStatus: 'pending' } };
  assert.equal(deriveStatus(w, opts), 'needs-you');
});

test('compareWindows orders by status priority then recency', () => {
  const a = { status: 'idle', lastActivityAt: NOW };
  const b = { status: 'needs-you', lastActivityAt: NOW - 100000 };
  const c = { status: 'running', lastActivityAt: NOW };
  const sorted = [a, b, c].sort(compareWindows).map((w) => w.status);
  assert.deepEqual(sorted, ['needs-you', 'running', 'idle']);
  assert.ok(STATUS_PRIORITY['needs-you'] < STATUS_PRIORITY['idle']);
});

test('compareWindows breaks ties by most-recent activity first', () => {
  const older = { status: 'running', lastActivityAt: NOW - 5000 };
  const newer = { status: 'running', lastActivityAt: NOW };
  assert.deepEqual([older, newer].sort(compareWindows), [newer, older]);
});

test('summarize counts windows by status', () => {
  const windows = [
    { status: 'needs-you' },
    { status: 'needs-you' },
    { status: 'running' },
    { status: 'waiting-ci-review' },
    { status: 'idle' },
  ];
  const s = summarize(windows);
  assert.equal(s.total, 5);
  assert.equal(s.counts['needs-you'], 2);
  assert.equal(s.counts['running'], 1);
  assert.equal(s.counts['waiting-ci-review'], 1);
  assert.equal(s.counts['idle'], 1);
});
