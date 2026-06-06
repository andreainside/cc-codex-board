import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, classifyZone } from '../src/collector.js';

const H = 3600_000;
const NOW = 1_000_000_000_000;

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

const opts = { now: NOW, idleArchiveMs: 4 * H, idleDropMs: 30 * H, getRestoredAt: () => 0 };
const w = (status, ageH) => ({ id: 'x', status, lastActivityAt: NOW - ageH * H, startedAt: NOW - ageH * H });

test('classifyZone: idle 1h → main', () => assert.equal(classifyZone(w('idle', 1), opts), 'main'));
test('classifyZone: idle 5h → archive', () => assert.equal(classifyZone(w('idle', 5), opts), 'archive'));
test('classifyZone: idle 31h → dropped', () => assert.equal(classifyZone(w('idle', 31), opts), 'dropped'));
test('classifyZone: needs-you 40h → main', () => assert.equal(classifyZone(w('needs-you', 40), opts), 'main'));
test('classifyZone: running → main', () => assert.equal(classifyZone(w('running', 99), opts), 'main'));
test('classifyZone: restored 5h-idle → main', () => {
  const o = { ...opts, getRestoredAt: () => NOW };
  assert.equal(classifyZone(w('idle', 5), o), 'main');
});
test('classifyZone: idleArchiveMs=0 → always main', () => {
  assert.equal(classifyZone(w('idle', 99), { ...opts, idleArchiveMs: 0 }), 'main');
});
test('classifyZone: idleDropMs=0 → never dropped', () => {
  assert.equal(classifyZone(w('idle', 99), { ...opts, idleDropMs: 0 }), 'archive');
});
