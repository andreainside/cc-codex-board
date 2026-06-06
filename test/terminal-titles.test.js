import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTty, parseTerminalTitles, parsePsTtys } from '../src/terminal-titles.js';

test('normalizeTty prefixes /dev/ and rejects empties', () => {
  assert.equal(normalizeTty('ttys073'), '/dev/ttys073');
  assert.equal(normalizeTty('/dev/ttys015'), '/dev/ttys015');
  assert.equal(normalizeTty('??'), null);
  assert.equal(normalizeTty(''), null);
  assert.equal(normalizeTty(null), null);
});

test('parseTerminalTitles maps tty -> title (tab-separated)', () => {
  const out = '/dev/ttys073\t⠐ Implement cc-codex-board\n/dev/ttys003\t✳ Add dedup test\n\n';
  const m = parseTerminalTitles(out);
  assert.equal(m.get('/dev/ttys073'), '⠐ Implement cc-codex-board');
  assert.equal(m.get('/dev/ttys003'), '✳ Add dedup test');
  assert.equal(m.size, 2);
});

test('parseTerminalTitles skips lines without a title', () => {
  const m = parseTerminalTitles('/dev/ttys001\t\n/dev/ttys002\tok\n');
  assert.equal(m.has('/dev/ttys001'), false);
  assert.equal(m.get('/dev/ttys002'), 'ok');
});

test('parsePsTtys maps pid -> /dev/tty from `ps -o pid=,tty=`', () => {
  const out = ' 79437 ttys073\n 31786 ttys003\n 1234 ??\n';
  const m = parsePsTtys(out);
  assert.equal(m.get(79437), '/dev/ttys073');
  assert.equal(m.get(31786), '/dev/ttys003');
  assert.equal(m.has(1234), false); // no controlling tty
});
