import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, parseFlags } from '../src/config.js';

test('resolveConfig applies defaults rooted at home', () => {
  const c = resolveConfig({ home: '/home/me' });
  assert.equal(c.claudeRoot, '/home/me/.claude');
  assert.equal(c.codexRoot, '/home/me/.codex');
  assert.equal(c.localTtlMs, 5000);
  assert.ok(c.gitTtlMs >= 30000 && c.gitTtlMs <= 60000);
  assert.equal(c.port, 4317);
  assert.equal(c.summary, false); // zero-LLM by default; opt-in only
  assert.equal(c.summaryModel, 'claude-haiku-4-5');
});

test('resolveConfig sets the macOS desktop sessions root', () => {
  const c = resolveConfig({ home: '/home/me', platform: 'darwin' });
  assert.match(c.desktopRoot, /claude-code-sessions$/);
  const linux = resolveConfig({ home: '/home/me', platform: 'linux' });
  assert.equal(linux.desktopRoot, null); // best-effort; unknown on other platforms
});

test('resolveConfig: --summary enables the opt-in AI headline', () => {
  assert.equal(resolveConfig({ home: '/h', flags: { summary: true } }).summary, true);
});

test('resolveConfig: flags override file override defaults', () => {
  const c = resolveConfig({
    home: '/home/me',
    fileConfig: { port: 5000, runningRecencyMs: 1000, labels: { '123': 'Alice' } },
    flags: { port: 6000 },
  });
  assert.equal(c.port, 6000); // flag wins
  assert.equal(c.runningRecencyMs, 1000); // file wins over default
  assert.equal(c.labels['123'], 'Alice');
});

test('resolveConfig expands ~ in configured roots', () => {
  const c = resolveConfig({ home: '/home/me', fileConfig: { claudeRoot: '~/custom/.claude' } });
  assert.equal(c.claudeRoot, '/home/me/custom/.claude');
});

test('resolveConfig: --no-gh / --no-git disable the runners', () => {
  const c = resolveConfig({ home: '/h', flags: { 'no-gh': true, 'no-git': true } });
  assert.equal(c.gh, false);
  assert.equal(c.git, false);
});

test('parseFlags parses --key value, --flag, and --key=value', () => {
  const f = parseFlags(['--port', '9000', '--no-gh', '--claude-root=/x/.claude', '--open']);
  assert.equal(f.port, 9000);
  assert.equal(f['no-gh'], true);
  assert.equal(f['claude-root'], '/x/.claude');
  assert.equal(f.open, true);
});

test('idle thresholds: defaults are 4h / 30h', () => {
  const c = resolveConfig({ home: '/h' });
  assert.equal(c.idleArchiveMs, 4 * 3600_000);
  assert.equal(c.idleDropMs, 30 * 3600_000);
});

test('idle thresholds: flags in hours; 0 disables', () => {
  const c = resolveConfig({ home: '/h', flags: { 'idle-archive': 2, 'idle-drop': 0 } });
  assert.equal(c.idleArchiveMs, 2 * 3600_000);
  assert.equal(c.idleDropMs, 0);
});

test('idle thresholds: config file uses hours', () => {
  const c = resolveConfig({ home: '/h', fileConfig: { idleArchiveHours: 6, idleDropHours: 48 } });
  assert.equal(c.idleArchiveMs, 6 * 3600_000);
  assert.equal(c.idleDropMs, 48 * 3600_000);
});

test('summary timeout: default 90s; --summary-timeout overrides (seconds)', () => {
  assert.equal(resolveConfig({ home: '/h' }).summaryTimeoutMs, 90_000);
  assert.equal(resolveConfig({ home: '/h', flags: { 'summary-timeout': 180 } }).summaryTimeoutMs, 180_000);
});
