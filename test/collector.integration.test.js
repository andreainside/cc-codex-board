import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBoard, findTranscriptPath } from '../src/collector.js';

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

test('two Claude Desktop windows in ONE checkout/PR get distinct headlines from their tab titles', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-headline-'));
  try {
    const claude = path.join(h, '.claude');
    const desktopRoot = path.join(h, 'desktop');
    const cwd = '/work/app';
    // Two desktop sessions, SAME cwd → same branch + same PR. Only the per-tab
    // title distinguishes them (the collision bug).
    writeJson(path.join(claude, 'sessions', '3001.json'), { pid: 3001, sessionId: 'sid-web', cwd, startedAt: NOW - 3600_000, entrypoint: 'claude-desktop' });
    writeJson(path.join(claude, 'sessions', '3002.json'), { pid: 3002, sessionId: 'sid-sleep', cwd, startedAt: NOW - 3600_000, entrypoint: 'claude-desktop' });
    writeJson(path.join(desktopRoot, 'a', 'local_web.json'), { cliSessionId: 'sid-web', title: 'web_fetch work', titleSource: 'auto', isArchived: false, lastActivityAt: NOW - 30_000 });
    writeJson(path.join(desktopRoot, 'a', 'local_sleep.json'), { cliSessionId: 'sid-sleep', title: 'Investigate sleep data', titleSource: 'auto', isArchived: false, lastActivityAt: NOW - 30_000 });
    const projDir = path.join(claude, 'projects', '-work-app');
    writeJsonl(path.join(projDir, 'sid-web.jsonl'), [{ type: 'user', message: { role: 'user', content: 'add web_fetch' }, timestamp: iso(30_000) }]);
    writeJsonl(path.join(projDir, 'sid-sleep.jsonl'), [{ type: 'user', message: { role: 'user', content: 'User ID (Clerk): user_xxx' }, timestamp: iso(30_000) }]);

    const board = await buildBoard({
      claudeRoot: claude,
      codexRoot: path.join(h, '.codex'),
      desktopRoot,
      now: NOW,
      isPidAlive: (pid) => pid === 3001 || pid === 3002,
      // Same checkout: identical branch + identical PR title for both windows.
      resolveRepoBranch: async () => ({ repo: 'acme/app', branch: 'feature/chat/web-fetch-server-tool' }),
      fetchPr: async () => ({ number: 271, title: 'Add web_fetch server tool', ciStatus: 'pass', reviewStatus: 'none' }),
    });

    const web = board.windows.find((w) => w.id === 'cc:3001');
    const sleep = board.windows.find((w) => w.id === 'cc:3002');
    // The desktop tab title wins over the shared PR title + branch → distinct headlines.
    assert.equal(web.headline.text, 'web_fetch work');
    assert.equal(web.headline.source, 'windowtitle');
    assert.equal(sleep.headline.text, 'Investigate sleep data');
    assert.notEqual(web.headline.text, sleep.headline.text); // no collision
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('terminal-titled CLI windows win their headline; a title-less sibling disambiguates via its prompt', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-term-'));
  try {
    const claude = path.join(h, '.claude');
    const cwd = '/work/app';
    // Three windows, ONE checkout → same branch + same PR. 5001 is a CLI session
    // with a terminal title; 5002 is a CLI session with a terminal title; 5003 is
    // a desktop session with NO title record (falls to the shared PR title).
    writeJson(path.join(claude, 'sessions', '5001.json'), { pid: 5001, sessionId: 'sid-a', cwd, startedAt: NOW - 3600_000, entrypoint: 'cli' });
    writeJson(path.join(claude, 'sessions', '5002.json'), { pid: 5002, sessionId: 'sid-b', cwd, startedAt: NOW - 3600_000, entrypoint: 'cli' });
    writeJson(path.join(claude, 'sessions', '5003.json'), { pid: 5003, sessionId: 'sid-c', cwd, startedAt: NOW - 3600_000, entrypoint: 'claude-desktop' });
    const projDir = path.join(claude, 'projects', '-work-app');
    writeJsonl(path.join(projDir, 'sid-a.jsonl'), [{ type: 'user', message: { role: 'user', content: 'add web_fetch tool' }, timestamp: iso(30_000) }]);
    writeJsonl(path.join(projDir, 'sid-b.jsonl'), [{ type: 'user', message: { role: 'user', content: 'write the tests' }, timestamp: iso(30_000) }]);
    writeJsonl(path.join(projDir, 'sid-c.jsonl'), [{ type: 'user', message: { role: 'user', content: 'investigate the data bug' }, timestamp: iso(30_000) }]);

    const board = await buildBoard({
      claudeRoot: claude,
      codexRoot: path.join(h, '.codex'),
      now: NOW,
      isPidAlive: (pid) => pid >= 5001 && pid <= 5003,
      resolveRepoBranch: async () => ({ repo: 'acme/app', branch: 'feature/chat/web-fetch-server-tool' }),
      fetchPr: async () => ({ number: 271, title: 'Add web_fetch server tool', ciStatus: 'pass', reviewStatus: 'none' }),
      // 5001/5002 have distinct terminal titles; 5003 (desktop) has none.
      resolveTerminalTitles: async () => new Map([[5001, 'Add web_fetch tool'], [5002, 'Write web_fetch tests']]),
    });

    const a = board.windows.find((w) => w.id === 'cc:5001');
    const b = board.windows.find((w) => w.id === 'cc:5002');
    const c = board.windows.find((w) => w.id === 'cc:5003');
    assert.equal(a.headline.text, 'Add web_fetch tool'); // terminal title wins over the shared PR
    assert.equal(b.headline.text, 'Write web_fetch tests');
    // 5003 had no window title → would land on the shared PR title; since it is the
    // ONLY window left on that PR headline, it stays the PR title (no false split).
    assert.equal(c.headline.text, 'Add web_fetch server tool');
    const headlines = [a, b, c].map((w) => w.headline.text);
    assert.equal(new Set(headlines).size, 3, 'all three headlines are distinct');
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('two title-less windows in one checkout fall back to distinct prompts (no identical headline)', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-dis-'));
  try {
    const claude = path.join(h, '.claude');
    const cwd = '/work/app';
    // Two desktop sessions, no title records → both would land on the shared PR.
    writeJson(path.join(claude, 'sessions', '6001.json'), { pid: 6001, sessionId: 'sid-p', cwd, startedAt: NOW - 3600_000, entrypoint: 'claude-desktop' });
    writeJson(path.join(claude, 'sessions', '6002.json'), { pid: 6002, sessionId: 'sid-q', cwd, startedAt: NOW - 3600_000, entrypoint: 'claude-desktop' });
    const projDir = path.join(claude, 'projects', '-work-app');
    writeJsonl(path.join(projDir, 'sid-p.jsonl'), [{ type: 'user', message: { role: 'user', content: 'implement the parser' }, timestamp: iso(30_000) }]);
    writeJsonl(path.join(projDir, 'sid-q.jsonl'), [{ type: 'user', message: { role: 'user', content: 'review the migration' }, timestamp: iso(30_000) }]);
    const board = await buildBoard({
      claudeRoot: claude, codexRoot: path.join(h, '.codex'), now: NOW,
      isPidAlive: (pid) => pid === 6001 || pid === 6002,
      resolveRepoBranch: async () => ({ repo: 'acme/app', branch: 'feature/x' }),
      fetchPr: async () => ({ number: 9, title: 'Shared PR title', ciStatus: 'pass', reviewStatus: 'none' }),
    });
    const p = board.windows.find((w) => w.id === 'cc:6001');
    const q = board.windows.find((w) => w.id === 'cc:6002');
    assert.notEqual(p.headline.text, q.headline.text); // not both 'Shared PR title'
    assert.equal(p.headline.source, 'prompt');
    assert.equal(p.headline.text, 'implement the parser');
    assert.equal(q.headline.text, 'review the migration');
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('subtitle is suppressed when the opening prompt equals the headline (no duplicate line)', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-subtitle-'));
  try {
    const claude = path.join(h, '.claude');
    const desktopRoot = path.join(h, 'desktop');
    const cwd = '/work/solo';
    writeJson(path.join(claude, 'sessions', '4001.json'), { pid: 4001, sessionId: 'sid-dup', cwd, startedAt: NOW - 3600_000, entrypoint: 'claude-desktop' });
    // Desktop title === opening prompt; with no descriptive branch the headline
    // becomes that title, so the opening-prompt subtitle would duplicate it.
    writeJson(path.join(desktopRoot, 'local_dup.json'), { cliSessionId: 'sid-dup', title: 'Refactor auth flow', titleSource: 'auto', isArchived: false, lastActivityAt: NOW - 30_000 });
    writeJsonl(path.join(claude, 'projects', '-work-solo', 'sid-dup.jsonl'), [
      { type: 'user', message: { role: 'user', content: 'Refactor auth flow' }, timestamp: iso(30_000) },
    ]);
    const board = await buildBoard({
      claudeRoot: claude, codexRoot: path.join(h, '.codex'), desktopRoot, now: NOW,
      isPidAlive: (pid) => pid === 4001,
      resolveRepoBranch: async () => ({ repo: null, branch: 'main' }), // non-descriptive → title wins
      fetchPr: async () => null,
    });
    const w = board.windows.find((x) => x.id === 'cc:4001');
    assert.equal(w.headline.text, 'Refactor auth flow');
    assert.equal(w.subtitle, ''); // not repeated as "开场:Refactor auth flow"
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('findTranscriptPath: ambiguous fallback (same sessionId in 2 project dirs) returns null, not a guess', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-tp-'));
  try {
    const claude = path.join(h, '.claude');
    const sid = 'sid-dup-xyz';
    // Direct encoded-cwd path is absent; the sessionId exists under TWO project dirs.
    writeJsonl(path.join(claude, 'projects', '-a-wrong', `${sid}.jsonl`), [{ type: 'user', message: { role: 'user', content: 'WRONG' } }]);
    writeJsonl(path.join(claude, 'projects', '-z-right', `${sid}.jsonl`), [{ type: 'user', message: { role: 'user', content: 'RIGHT' } }]);
    assert.equal(findTranscriptPath(claude, '/some/unencodable/cwd', sid), null);

    // Unique fallback → resolves.
    const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-tp2-'));
    const claude2 = path.join(h2, '.claude');
    writeJsonl(path.join(claude2, 'projects', '-only', `${sid}.jsonl`), [{ type: 'user', message: { role: 'user', content: 'ONLY' } }]);
    assert.match(findTranscriptPath(claude2, '/x', sid) || '', /-only/);
    fs.rmSync(h2, { recursive: true, force: true });
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('cli session blocked on a permission prompt surfaces needs-you via waitingFor; 忽略 mutes it', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-wf-'));
  try {
    const claude = path.join(h, '.claude');
    // status:"waiting" + waitingFor — exactly what CC writes at a "Do you want to proceed?" prompt.
    writeJson(path.join(claude, 'sessions', '2001.json'), {
      pid: 2001, sessionId: 'sid-perm', cwd: '/work/app', startedAt: NOW - 3600_000,
      status: 'waiting', waitingFor: 'permission prompt', updatedAt: NOW - 5_000, entrypoint: 'cli',
    });
    // Transcript ends on an assistant TEXT block (no "?", no pending tool_use) →
    // awaitingInput is false. waitingFor must be what surfaces the alert.
    writeJsonl(path.join(claude, 'projects', '-work-app', 'sid-perm.jsonl'), [
      { type: 'user', message: { role: 'user', content: '跑一下这个命令' }, timestamp: iso(3600_000) },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '让我先核实一下规格。' }] }, timestamp: iso(5_000) },
    ]);

    const deps = {
      claudeRoot: claude,
      codexRoot: path.join(h, '.codex'),
      now: NOW,
      isPidAlive: (pid) => pid === 2001,
      resolveRepoBranch: async () => ({ repo: 'acme/app', branch: 'feature/x' }),
      fetchPr: async () => null,
    };

    const board = await buildBoard(deps);
    const w = board.windows.find((x) => x.id === 'cc:2001');
    assert.ok(w, 'permission-prompt window present');
    assert.equal(w.awaitingInput, false, 'transcript yields no awaiting signal');
    assert.equal(w.waitingFor, 'permission prompt');
    assert.equal(w.status, 'needs-you', 'waitingFor surfaces needs-you on its own');

    // 忽略: dismiss now → muted to idle.
    const muted = await buildBoard({ ...deps, getDismissedAt: (id) => (id === 'cc:2001' ? NOW : 0) });
    assert.equal(muted.windows.find((x) => x.id === 'cc:2001').status, 'idle');

    // A dismissal from BEFORE the last activity does not mute (new activity re-arms).
    const rearmed = await buildBoard({ ...deps, getDismissedAt: (id) => (id === 'cc:2001' ? NOW - 60_000 : 0) });
    assert.equal(rearmed.windows.find((x) => x.id === 'cc:2001').status, 'needs-you');
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});
