import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBoard, formatDuration, relativeTime, statusMeta, escapeHtml, folderLabel } from '../public/render.js';

test('formatDuration renders hours and minutes compactly', () => {
  assert.equal(formatDuration(3 * 3600_000 + 12 * 60_000), '3h12m');
  assert.equal(formatDuration(58 * 60_000), '58m');
  assert.equal(formatDuration(9 * 3600_000), '9h');
  assert.equal(formatDuration(30_000), '<1m');
});

test('relativeTime renders zh-CN relative strings', () => {
  assert.equal(relativeTime(40_000), '刚刚');
  assert.equal(relativeTime(3 * 60_000), '3分钟前');
  assert.equal(relativeTime(2 * 3600_000), '2小时前');
  assert.equal(relativeTime(2 * 86400_000), '2天前');
});

test('statusMeta maps each status to a label and color', () => {
  assert.equal(statusMeta('needs-you').color, '#d11');
  assert.ok(statusMeta('needs-you').label.length > 0);
  assert.equal(statusMeta('running').label, '跑着');
  assert.equal(statusMeta('waiting-ci-review').label, '等CI/复评');
  assert.equal(statusMeta('idle').label, '空闲');
});

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<script>"x"&'), '&lt;script&gt;&quot;x&quot;&amp;');
});

const SAMPLE = {
  generatedAt: Date.parse('2026-06-06T06:14:00.000Z'),
  summary: { total: 3, counts: { 'needs-you': 1, running: 1, 'waiting-ci-review': 0, idle: 1 } },
  groups: [
    {
      repo: 'acme/app',
      windows: [
        {
          id: 'cc:1002', tool: 'CC', label: null, status: 'needs-you',
          title: '修复登录崩溃 bug', branch: 'feature/health/login-crash-fix', pid: 1002,
          currentActivity: '已提 PR,等评审',
          pr: { number: 250, ciStatus: 'pending', reviewStatus: 'pending', codexReview: 'pending', url: 'https://x/250' },
          startedAt: Date.parse('2026-06-06T04:51:00.000Z'), lastActivityAt: Date.parse('2026-06-06T06:13:00.000Z'),
        },
        {
          id: 'cc:1001', tool: 'CC', label: 'Alice', status: 'running',
          title: '<b>build</b> login', branch: 'main', pid: 1001, currentActivity: '加上单元测试',
          pr: null, startedAt: Date.parse('2026-06-06T03:00:00.000Z'), lastActivityAt: Date.parse('2026-06-06T06:13:40.000Z'),
        },
        {
          id: 'codex:abc', tool: 'Codex-local', label: null, status: 'idle',
          title: '设计一体式小盒子', branch: null, pid: null, currentActivity: '等截图',
          pr: null, startedAt: Date.parse('2026-06-06T05:00:00.000Z'), lastActivityAt: Date.parse('2026-06-06T05:10:00.000Z'),
        },
      ],
    },
  ],
};

test('renderBoard renders the summary, repo group, and cards in order', () => {
  const html = renderBoard(SAMPLE, SAMPLE.generatedAt);
  assert.match(html, /3 .{0,4}窗口|3.*窗口/); // total count shown
  assert.match(html, /acme\/app/); // repo group heading
  assert.match(html, /修复登录崩溃 bug/); // needs-you title
  assert.match(html, /feature\/health\/login-crash-fix · pid 1002/); // branch · pid
  assert.match(html, /PR #?250/); // PR number
  assert.match(html, /Codex 本地/); // tool badge for codex-local
  assert.match(html, /Alice/); // friendly label
  // needs-you card appears before the running card
  assert.ok(html.indexOf('修复登录崩溃 bug') < html.indexOf('login'), 'needs-you pinned above running');
});

test('renderCard shows headline, opening-prompt subtitle, window-match title, last message', () => {
  const board = {
    generatedAt: 0, summary: { total: 1, counts: {} }, meta: { summaryEnabled: true },
    groups: [{ repo: 'o/r', windows: [{
      id: 'cc:1', tool: 'CC', entrypoint: 'claude-desktop', status: 'idle',
      headline: { text: '修睡眠占比 bug', source: 'summary' },
      subtitle: '任务:修复晨间睡眠 bug 仓库 ~/proj',
      windowTitle: 'Sleep ratio fix',
      branch: 'feature/health/x', pid: 1002,
      lastMessage: { role: 'assistant', text: '已提 PR,等评审' },
      pr: null, startedAt: 0, lastActivityAt: 0,
    }] }],
  };
  const html = renderBoard(board, 0);
  assert.match(html, /修睡眠占比 bug/); // headline (big title)
  assert.match(html, /任务:修复晨间睡眠/); // opening-prompt subtitle
  assert.match(html, /Sleep ratio fix/); // window-match title (what you see on screen)
  assert.match(html, /CC 桌面/); // terminal vs desktop badge
  assert.match(html, /上一条消息/); // label
  assert.match(html, /已提 PR,等评审/); // last message text
  assert.match(html, /AI/); // assistant role marker
});

test('renderBoard never emits a non-http(s) URL in an href (defense-in-depth)', () => {
  const board = {
    generatedAt: 0,
    summary: { total: 1, counts: {} },
    groups: [{ repo: 'o/r', windows: [{
      id: 'cc:1', tool: 'CC', status: 'idle', title: 't', branch: 'b', pid: 1, currentActivity: '',
      pr: { number: 9, ciStatus: 'none', reviewStatus: 'none', codexReview: 'none', url: "javascript:alert('xss')" },
      startedAt: 0, lastActivityAt: 0,
    }] }],
  };
  const html = renderBoard(board, 0);
  assert.ok(!html.includes('javascript:'), 'javascript: URL must not appear');
  assert.ok(!/href=/.test(html), 'no href rendered for an unsafe URL');
  assert.match(html, /PR #?9/); // still shows the PR number as text
});

test('renderBoard escapes window titles', () => {
  const html = renderBoard(SAMPLE, SAMPLE.generatedAt);
  assert.match(html, /&lt;b&gt;build&lt;\/b&gt; login/);
  assert.ok(!html.includes('<b>build</b> login'));
});

import { formatTokens, usageHint } from '../public/render.js';

test('formatTokens: K/M compaction', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(34_500), '34.5K');
  assert.equal(formatTokens(1_200_000), '1.2M');
});

test('usageHint: zero calls → honest 0', () => {
  assert.equal(usageHint({ summaryEnabled: false, llmUsage: { calls: 0 } }), '本地只读 · 0 次 LLM 调用');
});

test('usageHint: nonzero → calls + tokens + cost', () => {
  const h = usageHint({ llmUsage: { calls: 12, inputTokens: 30_000, outputTokens: 4_500, costUsd: 0.02 } });
  assert.match(h, /12 次调用/);
  assert.match(h, /34\.5K tok/);
  assert.match(h, /\$0\.02/);
});

test('renderBoard grouping=status puts needs-you section first with counts', () => {
  const board = {
    summary: { total: 2, counts: {} },
    windows: [
      { id: 'a', tool: 'CC', status: 'idle', title: 'x' },
      { id: 'b', tool: 'CC', status: 'needs-you', title: 'y' },
    ],
    groups: [], archive: { windows: [] },
  };
  const html = renderBoard(board, Date.now(), { grouping: 'status' });
  const needsIdx = html.indexOf('等你');
  const idleIdx = html.indexOf('空闲');
  assert.ok(needsIdx >= 0 && idleIdx >= 0 && needsIdx < idleIdx, 'needs-you before idle');
});

test('renderBoard view=archive renders idle-age + restore button', () => {
  const board = { archive: { windows: [{ id: 'c', tool: 'CC', status: 'idle', title: 'z', lastActivityAt: Date.now() - 5 * 3600_000 }] } };
  const html = renderBoard(board, Date.now(), { view: 'archive' });
  assert.match(html, /已空闲/);
  assert.match(html, /data-action="restore"/);
});

test('cards carry a summarize button', () => {
  const board = { summary: { total: 1, counts: {} }, groups: [{ repo: 'r', windows: [{ id: 'a', tool: 'CC', status: 'idle', title: 'x' }] }], windows: [], archive: { windows: [] } };
  assert.match(renderBoard(board, Date.now()), /data-action="summarize"/);
});

test('only needs-you cards carry a 忽略 (dismiss) button', () => {
  const mk = (status) => ({ summary: { total: 1, counts: {} }, groups: [{ repo: 'r', windows: [{ id: 'a', tool: 'CC', status, title: 'x' }] }], windows: [], archive: { windows: [] } });
  assert.match(renderBoard(mk('needs-you'), Date.now()), /data-action="dismiss"[^>]*>忽略</);
  assert.doesNotMatch(renderBoard(mk('idle'), Date.now()), /data-action="dismiss"/);
  assert.doesNotMatch(renderBoard(mk('running'), Date.now()), /data-action="dismiss"/);
});

test('renderBoard focus shows only needs-you + running (repo & status)', () => {
  const ws = [
    { id: 'a', tool: 'CC', status: 'needs-you', title: 'A' },
    { id: 'b', tool: 'CC', status: 'idle', title: 'B' },
    { id: 'c', tool: 'CC', status: 'waiting-ci-review', title: 'C' },
    { id: 'd', tool: 'CC', status: 'running', title: 'D' },
  ];
  const board = { summary: { total: 4, counts: {} }, windows: ws, groups: [{ repo: 'r', windows: ws }], archive: { windows: [] } };
  const repo = renderBoard(board, Date.now(), { focus: true });
  assert.ok(repo.includes('data-id="a"') && repo.includes('data-id="d"'), 'keeps needs-you + running');
  assert.ok(!repo.includes('data-id="b"') && !repo.includes('data-id="c"'), 'hides idle + waiting');
  const status = renderBoard(board, Date.now(), { grouping: 'status', focus: true });
  assert.ok(status.includes('data-id="a"') && status.includes('data-id="d"'));
  assert.ok(!status.includes('data-id="b"') && !status.includes('data-id="c"'));
});

test('renderBoard focus keeps real status counts, only collapses the cards', () => {
  const ws = [
    { id: 'a', tool: 'CC', status: 'needs-you', title: 'A' },
    { id: 'b', tool: 'CC', status: 'idle', title: 'B' },
    { id: 'b2', tool: 'CC', status: 'idle', title: 'B2' },
    { id: 'c', tool: 'CC', status: 'waiting-ci-review', title: 'C' },
    { id: 'd', tool: 'CC', status: 'running', title: 'D' },
  ];
  const board = { summary: { total: 5, counts: {} }, windows: ws, groups: [{ repo: 'r', windows: ws }], archive: { windows: [] } };
  const status = renderBoard(board, Date.now(), { grouping: 'status', focus: true });
  // real counts preserved in the section headers (not zeroed)
  assert.match(status, /空闲 \(2\)/);
  assert.match(status, /等CI\/复评 \(1\)/);
  assert.ok(!status.includes('空闲 (0)'), 'idle count must show the real number, not 0');
  // cards for hidden statuses are collapsed, with a hint
  assert.ok(!status.includes('data-id="b"') && !status.includes('data-id="b2"') && !status.includes('data-id="c"'));
  assert.match(status, /已收起/);
  // needs-you + running cards still shown
  assert.ok(status.includes('data-id="a"') && status.includes('data-id="d"'));
});

test('renderBoard threads notes; card shows note + data-session', () => {
  const board = { summary: { total: 1, counts: {} }, windows: [], groups: [{ repo: 'r', windows: [{ id: 'cc:1', sessionId: 's1', tool: 'CC', status: 'idle', title: 'x' }] }], archive: { windows: [] } };
  const html = renderBoard(board, Date.now(), { notes: { s1: '等 Bob review' } });
  assert.match(html, /等 Bob review/);
  assert.match(html, /data-session="s1"/);
  assert.match(html, /data-action="note"/);
});

test('renderBoard shows note placeholder when no note', () => {
  const board = { summary: { total: 1, counts: {} }, windows: [], groups: [{ repo: 'r', windows: [{ id: 'cc:1', sessionId: 's2', tool: 'CC', status: 'idle', title: 'x' }] }], archive: { windows: [] } };
  const html = renderBoard(board, Date.now(), { notes: {} });
  assert.match(html, /备注…/);
  assert.match(html, /data-session="s2"/);
});

test('folderLabel returns last two path segments', () => {
  assert.equal(folderLabel('/a/b/c/worktrees/x'), 'worktrees/x');
  assert.equal(folderLabel('/only'), 'only');
});

test('renderBoard repo view sub-groups by folder when >1 cwd', () => {
  const ws = [
    { id: 'cc:1', sessionId: 's1', tool: 'CC', status: 'idle', title: 'A', cwd: '/Users/me/proj/worktrees/feat-a' },
    { id: 'cc:2', sessionId: 's2', tool: 'CC', status: 'idle', title: 'B', cwd: '/Users/me/proj/main' },
  ];
  const board = { summary: { total: 2, counts: {} }, windows: ws, groups: [{ repo: 'r', windows: ws }], archive: { windows: [] } };
  const html = renderBoard(board, Date.now());
  assert.match(html, /worktrees\/feat-a/);
  assert.match(html, /proj\/main/);
  assert.match(html, /class="folder"/);
});

test('renderBoard repo view stays flat with a single cwd', () => {
  const ws = [
    { id: 'cc:1', sessionId: 's1', tool: 'CC', status: 'idle', title: 'A', cwd: '/Users/me/proj/main' },
    { id: 'cc:2', sessionId: 's2', tool: 'CC', status: 'running', title: 'B', cwd: '/Users/me/proj/main' },
  ];
  const board = { summary: { total: 2, counts: {} }, windows: ws, groups: [{ repo: 'r', windows: ws }], archive: { windows: [] } };
  const html = renderBoard(board, Date.now());
  assert.ok(!html.includes('class="folder"'), 'no folder sub-header for a single cwd');
});
