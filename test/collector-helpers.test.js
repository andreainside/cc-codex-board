import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd, dedupeCodexThreads, loadDesktopTitles, disambiguateHeadlines } from '../src/collector.js';

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

test('dedupeCodexThreads collapses a 3-deep resume chain to one (transitive root)', () => {
  const out = dedupeCodexThreads([
    { id: 'A', parentThreadId: null, startedAt: 100, title: 'A' },
    { id: 'B', parentThreadId: 'A', startedAt: 200, title: 'B' },
    { id: 'C', parentThreadId: 'B', startedAt: 300, title: 'C' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'C'); // freshest in the chain
});

test('dedupeCodexThreads keeps the fresh resume when its startedAt is unparsable (null)', () => {
  const out = dedupeCodexThreads([
    { id: 'root', parentThreadId: null, startedAt: 100, lastActivityAt: 100, title: 'OLD root' },
    { id: 'resume1', parentThreadId: 'root', startedAt: null, lastActivityAt: 999, title: 'NEW resume' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'NEW resume'); // falls back to lastActivityAt for recency
});

test('disambiguateHeadlines splits same-checkout cards sharing a pr/branch headline onto their prompts', () => {
  const a = { repo: 'o/r', headline: { text: 'Shared PR', source: 'pr' }, title: 'work on auth', subtitle: 'work on auth' };
  const b = { repo: 'o/r', headline: { text: 'Shared PR', source: 'pr' }, title: 'fix the sleep card', subtitle: 'fix the sleep card' };
  const c = { repo: 'o/r', headline: { text: 'Own title', source: 'windowtitle' }, title: 'x', subtitle: '' };
  disambiguateHeadlines([a, b, c]);
  assert.deepEqual(a.headline, { text: 'work on auth', source: 'prompt' });
  assert.equal(a.subtitle, ''); // headline IS the prompt now → no duplicate line
  assert.deepEqual(b.headline, { text: 'fix the sleep card', source: 'prompt' });
  assert.equal(c.headline.text, 'Own title'); // a windowtitle headline is never touched
});

test('disambiguateHeadlines leaves unique headlines alone and never merges across repos', () => {
  const a = { repo: 'o/r1', headline: { text: 'Same', source: 'branch' }, title: 'pa' };
  const b = { repo: 'o/r2', headline: { text: 'Same', source: 'branch' }, title: 'pb' };
  const c = { repo: 'o/r1', headline: { text: 'Unique', source: 'pr' }, title: 'pc' };
  disambiguateHeadlines([a, b, c]);
  assert.equal(a.headline.text, 'Same'); // different repos → not a collision
  assert.equal(b.headline.text, 'Same');
  assert.equal(c.headline.text, 'Unique');
});

test('loadDesktopTitles prefers the live, most-recent record over a stale/archived one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-desktop-'));
  const write = (name, rec) => fs.writeFileSync(path.join(root, name), JSON.stringify(rec));
  // Same cliSessionId across three records; archived + older must not win.
  write('local_a_current.json', { cliSessionId: 'SESS-1', title: 'Current real title', titleSource: 'auto', isArchived: false, lastActivityAt: 2000 });
  write('local_b_archived.json', { cliSessionId: 'SESS-1', title: 'OLD archived title', isArchived: true, lastActivityAt: 5000 });
  write('local_c_oldlive.json', { cliSessionId: 'SESS-1', title: 'Older live title', isArchived: false, lastActivityAt: 1000 });
  const map = loadDesktopTitles(root);
  assert.equal(map.get('SESS-1').title, 'Current real title');
  fs.rmSync(root, { recursive: true, force: true });
});
