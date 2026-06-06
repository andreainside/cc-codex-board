import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCwd, dedupeCodexThreads } from '../src/collector.js';

test('encodeCwd matches the ~/.claude/projects directory naming', () => {
  assert.equal(encodeCwd('/Users/dev/proj'), '-Users-dev-proj');
  assert.equal(
    encodeCwd('/Users/dev/proj/.claude/worktrees/feature+health+x'),
    '-Users-dev-proj--claude-worktrees-feature-health-x',
  );
});

test('dedupeCodexThreads collapses a resume chain to the most recent rollout', () => {
  const summaries = [
    { id: 'root', parentThreadId: null, startedAt: 100, title: 'old' },
    { id: 'resume1', parentThreadId: 'root', startedAt: 200, title: 'new' },
    { id: 'other', parentThreadId: null, startedAt: 150, title: 'separate' },
  ];
  const out = dedupeCodexThreads(summaries);
  assert.equal(out.length, 2);
  const titles = out.map((s) => s.title).sort();
  assert.deepEqual(titles, ['new', 'separate']);
});

test('dedupeCodexThreads keeps distinct top-level threads', () => {
  const summaries = [
    { id: 'a', parentThreadId: null, startedAt: 1, title: 'A' },
    { id: 'b', parentThreadId: null, startedAt: 2, title: 'B' },
  ];
  assert.equal(dedupeCodexThreads(summaries).length, 2);
});
