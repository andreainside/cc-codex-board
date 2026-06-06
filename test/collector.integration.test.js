import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBoard } from '../src/collector.js';

let home;
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}
function writeJsonl(file, objs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-fix-'));
  const claude = path.join(home, '.claude');
  const codex = path.join(home, '.codex');

  // --- CC sessions ---
  writeJson(path.join(claude, 'sessions', '1001.json'), {
    pid: 1001, sessionId: 'sid-running', cwd: '/work/app', startedAt: NOW - 3 * 3600_000, entrypoint: 'claude-desktop',
  });
  writeJson(path.join(claude, 'sessions', '1002.json'), {
    pid: 1002, sessionId: 'sid-needsyou', cwd: '/work/app', startedAt: NOW - 5 * 3600_000, status: 'idle', updatedAt: NOW - 10 * 60_000, entrypoint: 'cli',
  });
  // stale session: pid not alive -> excluded
  writeJson(path.join(claude, 'sessions', '9999.json'), {
    pid: 9999, sessionId: 'sid-dead', cwd: '/work/app', startedAt: NOW - 9 * 3600_000, entrypoint: 'cli',
  });
  // headless `claude -p` (e.g. the board's own summary calls): sdk-cli -> excluded
  writeJson(path.join(claude, 'sessions', '1003.json'), {
    pid: 1003, sessionId: 'sid-sdk', cwd: '/work/app', startedAt: NOW - 60_000, entrypoint: 'sdk-cli',
  });

  const projDir = path.join(claude, 'projects', '-work-app');
  writeJsonl(path.join(projDir, 'sid-running.jsonl'), [
    { type: 'user', message: { role: 'user', content: '实现登录页' }, timestamp: iso(3 * 3600_000) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已完成实现。' }] }, timestamp: iso(25_000) },
    { type: 'last-prompt', lastPrompt: '加上单元测试' },
  ]);
  writeJsonl(path.join(projDir, 'sid-needsyou.jsonl'), [
    { type: 'user', message: { role: 'user', content: '修复登录崩溃 bug' }, timestamp: iso(5 * 3600_000) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '要我推送并开 PR 吗?' }] }, timestamp: iso(10 * 60_000) },
    { type: 'last-prompt', lastPrompt: '已提 PR,等评审' },
    { type: 'pr-link', prNumber: 42, prUrl: 'https://github.com/acme/app/pull/42', prRepository: 'acme/app', timestamp: iso(10 * 60_000) },
  ]);

  // --- Codex rollouts ---
  const d = new Date(NOW);
  const Y = String(d.getFullYear());
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const dayDir = path.join(codex, 'sessions', Y, M, D);
  writeJsonl(path.join(dayDir, 'rollout-2026-06-06T13-00-00-conv-user.jsonl'), [
    { timestamp: iso(70 * 60_000), type: 'session_meta', payload: { id: 'conv-user', cwd: '/work/app', thread_source: 'user', source: 'vscode' } },
    { timestamp: iso(60_000), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context></environment_context>' }] } },
    { timestamp: iso(60_000), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '设计一体式小盒子' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  // subagent rollout -> excluded
  writeJsonl(path.join(dayDir, 'rollout-2026-06-06T13-30-00-conv-guard.jsonl'), [
    { timestamp: iso(50 * 60_000), type: 'session_meta', payload: { id: 'conv-guard', cwd: '/work/app', thread_source: 'subagent', source: { subagent: { other: 'guardian' } } } },
    { timestamp: iso(50 * 60_000), type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  writeJsonl(path.join(codex, 'session_index.jsonl'), [
    { id: 'conv-user', thread_name: '设计一体式小盒子', updated_at: iso(60_000) },
  ]);
});

after(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('buildBoard produces the expected live window list from a fixture tree', async () => {
  const board = await buildBoard({
    claudeRoot: path.join(home, '.claude'),
    codexRoot: path.join(home, '.codex'),
    now: NOW,
    isPidAlive: (pid) => pid === 1001 || pid === 1002 || pid === 1003,
    resolveRepoBranch: async (cwd) => ({ repo: 'acme/app', branch: 'feature/x', _cwd: cwd }),
    fetchPr: async (repo, { prNumbers }) =>
      prNumbers.includes(42)
        ? { number: 42, url: 'https://github.com/acme/app/pull/42', ciStatus: 'pending', reviewStatus: 'none', codexReview: 'pending' }
        : null,
  });

  // dead session, sdk-cli (headless), and subagent all excluded => exactly 3 windows
  assert.equal(board.windows.length, 3);
  assert.ok(!board.windows.some((w) => w.id === 'cc:1003'), 'headless sdk-cli session excluded');

  // needs-you pinned first
  assert.equal(board.windows[0].status, 'needs-you');
  assert.equal(board.windows[0].id, 'cc:1002');
  assert.equal(board.windows[0].title, '修复登录崩溃 bug');
  assert.equal(board.windows[0].pr.number, 42);

  // running desktop window (recent activity, no raw status)
  const running = board.windows.find((w) => w.id === 'cc:1001');
  assert.equal(running.status, 'running');
  assert.equal(running.currentActivity, '加上单元测试');

  // codex window present, idle, subagent excluded
  const codex = board.windows.find((w) => w.id === 'codex:conv-user');
  assert.ok(codex, 'codex user window should be present');
  assert.equal(codex.tool, 'Codex-local');
  assert.equal(codex.title, '设计一体式小盒子');
  assert.ok(!board.windows.some((w) => w.id === 'codex:conv-guard'), 'guardian subagent excluded');

  // summary + grouping
  assert.equal(board.summary.total, 3);
  assert.equal(board.summary.counts['needs-you'], 1);
  assert.equal(board.groups.length, 1);
  assert.equal(board.groups[0].repo, 'acme/app');
  assert.equal(board.groups[0].windows[0].status, 'needs-you');
});
