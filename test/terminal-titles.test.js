import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTty, parseTerminalTitles, parsePsTtys, stripStatusGlyph } from '../src/terminal-titles.js';

test('normalizeTty prefixes /dev/ and rejects empties', () => {
  assert.equal(normalizeTty('ttys073'), '/dev/ttys073');
  assert.equal(normalizeTty('/dev/ttys015'), '/dev/ttys015');
  assert.equal(normalizeTty('??'), null);
  assert.equal(normalizeTty(''), null);
  assert.equal(normalizeTty(null), null);
});

test('parseTerminalTitles maps tty -> title (tab-separated), stripping the spinner glyph', () => {
  const out = '/dev/ttys073\t⠐ Implement cc-codex-board\n/dev/ttys003\t✳ Add dedup test\n\n';
  const m = parseTerminalTitles(out);
  // The leading animated spinner glyph (braille / ✳) is dropped — it's a single
  // captured frame and changes every refresh.
  assert.equal(m.get('/dev/ttys073'), 'Implement cc-codex-board');
  assert.equal(m.get('/dev/ttys003'), 'Add dedup test');
  assert.equal(m.size, 2);
});

test('stripStatusGlyph removes a leading spinner glyph but leaves clean titles intact', () => {
  assert.equal(stripStatusGlyph('⠐ Implement cc-codex-board'), 'Implement cc-codex-board');
  assert.equal(stripStatusGlyph('✳ Add dedup test'), 'Add dedup test');
  assert.equal(stripStatusGlyph('⠂ · Add web_fetch support'), '· Add web_fetch support');
  assert.equal(stripStatusGlyph('Plain title, no glyph'), 'Plain title, no glyph');
  // No leading space after a non-spinner first char ⇒ untouched (don't eat content).
  assert.equal(stripStatusGlyph('C++ refactor'), 'C++ refactor');
  // A title that is ONLY a spinner frame (no text) collapses to '' (\s* not \s+).
  assert.equal(stripStatusGlyph('⠿'), '');
  assert.equal(stripStatusGlyph('✳'), '');
  assert.equal(stripStatusGlyph('⠋⠙⠹'), '');
});

test('parseTerminalTitles drops a tty whose title is only a spinner glyph', () => {
  const m = parseTerminalTitles('/dev/ttys001\t⠐ \n/dev/ttys002\t⠿\n/dev/ttys003\t⠐ Real title\n');
  assert.equal(m.has('/dev/ttys001'), false); // glyph + trailing space → empty → skipped
  assert.equal(m.has('/dev/ttys002'), false); // bare glyph → empty → skipped
  assert.equal(m.get('/dev/ttys003'), 'Real title');
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
