import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCcSession } from '../src/cc-sessions.js';

test('parses a desktop session that has no status field', () => {
  const text = JSON.stringify({
    pid: 9184,
    sessionId: 'a78658f0-99e9-4ab8-985b-87a0b969afa0',
    cwd: '/Users/dev/proj',
    startedAt: 1780715505957,
    procStart: 'Sat Jun  6 03:11:45 2026',
    version: '2.1.156',
    kind: 'interactive',
    entrypoint: 'claude-desktop',
  });
  const s = parseCcSession(text);
  assert.equal(s.pid, 9184);
  assert.equal(s.sessionId, 'a78658f0-99e9-4ab8-985b-87a0b969afa0');
  assert.equal(s.cwd, '/Users/dev/proj');
  assert.equal(s.startedAt, 1780715505957);
  assert.equal(s.status, undefined);
  assert.equal(s.entrypoint, 'claude-desktop');
});

test('parses a CLI session with status and updatedAt', () => {
  const text = JSON.stringify({
    pid: 31786,
    sessionId: 'd7bdf0b0-9f99-4a31-b363-e18216063319',
    cwd: '/Users/dev/proj/.claude/worktrees/feature+health+x',
    startedAt: 1780630915760,
    status: 'idle',
    updatedAt: 1780718048799,
    entrypoint: 'cli',
  });
  const s = parseCcSession(text);
  assert.equal(s.status, 'idle');
  assert.equal(s.updatedAt, 1780718048799);
});

test('returns null for malformed JSON', () => {
  assert.equal(parseCcSession('{not json'), null);
});

test('returns null when a required field is missing', () => {
  assert.equal(parseCcSession(JSON.stringify({ sessionId: 'x', cwd: '/a' })), null); // no pid
  assert.equal(parseCcSession(JSON.stringify({ pid: 1, cwd: '/a' })), null); // no sessionId
  assert.equal(parseCcSession(JSON.stringify({ pid: 1, sessionId: 'x' })), null); // no cwd
});
