import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBoard, formatDuration, relativeTime, statusMeta, escapeHtml } from '../public/render.js';

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
