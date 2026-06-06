import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDesktopSession } from '../src/cc-desktop.js';

test('parseDesktopSession extracts the displayed tab title keyed by cliSessionId', () => {
  const text = JSON.stringify({
    sessionId: 'local_f86a8254',
    cliSessionId: 'a78658f0-99e9-4ab8-985b-87a0b969afa0',
    cwd: '/Users/dev/proj',
    title: 'Windows machine utility',
    titleSource: 'auto',
    isArchived: false,
    lastActivityAt: 1780715505957,
  });
  const d = parseDesktopSession(text);
  assert.equal(d.cliSessionId, 'a78658f0-99e9-4ab8-985b-87a0b969afa0');
  assert.equal(d.title, 'Windows machine utility');
  assert.equal(d.isArchived, false);
});

test('parseDesktopSession returns null without a cliSessionId', () => {
  assert.equal(parseDesktopSession(JSON.stringify({ title: 'x' })), null);
  assert.equal(parseDesktopSession('{bad'), null);
});

test('parseDesktopSession tolerates a missing title', () => {
  const d = parseDesktopSession(JSON.stringify({ cliSessionId: 'abc' }));
  assert.equal(d.cliSessionId, 'abc');
  assert.equal(d.title, '');
});
