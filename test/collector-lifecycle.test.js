import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard } from '../src/collector.js';

const H = 3600_000;
const NOW = 1_000_000_000_000;

// A CC window that is idle, with lastActivityAt `ageH` hours ago.
function idleCc(id, ageH) {
  return { pid: Number(id.split(':')[1]), id };
}

async function build(extra = {}) {
  // Inject a fake collector path by stubbing claude/codex roots off and feeding
  // windows through a minimal monkey of buildBoard deps is not possible directly;
  // instead drive via the real collectors using temp dirs is heavy. We test the
  // zone logic by calling buildBoard with empty roots + a summarizer that yields
  // nothing, then asserting structure. Lifecycle math is covered through the
  // integration fixture; here we assert the payload SHAPE (archive present).
  return buildBoard({
    claudeRoot: null,
    codexRoot: null,
    now: NOW,
    isPidAlive: () => true,
    resolveRepoBranch: async () => ({ repo: null, branch: null }),
    fetchPr: async () => null,
    ...extra,
  });
}

test('buildBoard payload includes meta.llmUsage and archive bucket', async () => {
  const board = await build();
  assert.ok(board.meta && board.meta.llmUsage, 'meta.llmUsage present');
  assert.equal(board.meta.llmUsage.calls, 0);
  assert.ok(board.archive && Array.isArray(board.archive.windows), 'archive bucket present');
  assert.equal(board.archive.count, 0);
});
