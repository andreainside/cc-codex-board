# cc-codex-board 优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 cc-codex-board 加 6 项改进:修复「等你」漏报、真实 LLM 用量、每卡手动总结、空闲三段生命周期+恢复、按仓库/按状态切换、「专注」过滤(只看等你+跑着)。

**Architecture:** 后端仍是单 Node 服务(collector + 静态页)。纯模块用 `node --test` TDD。新增两个 POST 端点(总结/恢复),都只读会话 / 改看板内存态,不写用户文件。前端逻辑尽量下沉到纯 `render.js`(可测),`app.js` 仅做 DOM 粘合。

**Tech Stack:** Node ≥18,零依赖,`node --test`;原生 HTML/CSS/JS 前端。

**Spec:** `docs/superpowers/specs/2026-06-06-cc-codex-board-optimizations-design.md`

**Branch:** `feature/optimizations`(已建,spec 已提交)。

---

## Task 1: 修复「等你」漏报(待决 tool_use 信号)

**Files:**
- Modify: `src/cc-transcript.js:157-175`(`extractAwaitingInput`)
- Test: `test/cc-transcript.test.js`

- [ ] **Step 1: Write failing tests**

在 `test/cc-transcript.test.js` 末尾追加(若已有 `extractAwaitingInput` 导入则复用):

```js
import { extractAwaitingInput } from '../src/cc-transcript.js';

const asstText = (t) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const asstTool = (id) => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash' }] } });
const toolResult = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const userText = (t) => ({ type: 'user', message: { role: 'user', content: t } });

test('awaitingInput: assistant text ending in ? → true (unchanged)', () => {
  assert.equal(extractAwaitingInput([asstText('Shall I proceed?')]), true);
});

test('awaitingInput: user replied after the question → false (unchanged)', () => {
  assert.equal(extractAwaitingInput([asstText('Proceed?'), userText('yes')]), false);
});

test('awaitingInput: pending tool_use (awaiting permission) → true', () => {
  assert.equal(extractAwaitingInput([asstText('Running a command'), asstTool('t1')]), true);
});

test('awaitingInput: tool_use resolved by tool_result, normal end → false', () => {
  assert.equal(extractAwaitingInput([asstTool('t1'), toolResult('t1'), asstText('Done.')]), false);
});

test('awaitingInput: user typed a new prompt after an unresolved tool_use → false', () => {
  assert.equal(extractAwaitingInput([asstTool('t1'), userText('do something else')]), false);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/cc-transcript.test.js`
Expected: FAIL — "pending tool_use (awaiting permission) → true" 报 `false !== true`。

- [ ] **Step 3: Replace `extractAwaitingInput`**

把 `src/cc-transcript.js` 中的 `extractAwaitingInput`(约 157-175 行)整体替换为:

```js
/**
 * Best-effort needs-you signal. True when the session is awaiting the user:
 *  (1) the last assistant text ended with a question, OR
 *  (2) a tool call is still pending (no tool_result yet) — i.e. blocked on a
 *      permission / confirmation / plan-approval prompt. deriveStatus gates this
 *      behind !running, so a busy window with an in-flight tool stays "running".
 * Conservative: a real user message after an unresolved tool clears the signal.
 * @param {object[]} lines
 * @returns {boolean}
 */
export function extractAwaitingInput(lines) {
  let last = null; // { role: 'assistant'|'user', text }
  const pendingToolUse = new Set(); // tool_use ids without a later tool_result

  for (const o of lines) {
    if (!o) continue;
    if (o.type === 'assistant' && o.message) {
      const c = o.message.content;
      if (Array.isArray(c)) {
        for (const b of c) if (b && b.type === 'tool_use' && b.id) pendingToolUse.add(b.id);
      }
      const t = messageText(o.message).trim();
      if (t) last = { role: 'assistant', text: t };
    } else if (isUserLine(o)) {
      const c = o.message.content;
      if (Array.isArray(c)) {
        for (const b of c) if (b && b.type === 'tool_result' && b.tool_use_id) pendingToolUse.delete(b.tool_use_id);
      }
      const t = messageText(o.message).trim();
      if (t && !isMetaUserText(t)) {
        last = { role: 'user', text: t };
        pendingToolUse.clear(); // user moved on; no longer blocking on a tool
      }
    }
  }

  if (last && last.role === 'assistant' && /[?？]$/.test(last.text.trimEnd())) return true;
  return pendingToolUse.size > 0;
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --test test/cc-transcript.test.js`
Expected: PASS(含原有用例)。

- [ ] **Step 5: Commit**

```bash
git add src/cc-transcript.js test/cc-transcript.test.js
git commit -m "fix: detect pending tool_use as needs-you (awaiting permission)"
```

---

## Task 2: summarizer 抓取真实 token 用量

**Files:**
- Modify: `src/summarizer.js`(新增 `parseClaudeResult`、用量累加器、改 `runSummary` 用 `--output-format json`)
- Test: `test/summarizer.test.js`

- [ ] **Step 1: Write failing tests**

追加到 `test/summarizer.test.js`:

```js
import { parseClaudeResult, createSummarizer } from '../src/summarizer.js';

test('parseClaudeResult: parses JSON result + usage', () => {
  const stdout = JSON.stringify({
    result: '修复登录态刷新',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
  });
  const r = parseClaudeResult(stdout, { maxLen: 24 });
  assert.equal(r.title, '修复登录态刷新');
  assert.equal(r.usage.inputTokens, 150);
  assert.equal(r.usage.outputTokens, 20);
  assert.equal(r.usage.costUsd, 0.0123);
});

test('parseClaudeResult: non-JSON falls back to plain title, no usage', () => {
  const r = parseClaudeResult('just a title\n', { maxLen: 24 });
  assert.equal(r.title, 'just a title');
  assert.equal(r.usage, null);
});

test('summarizer accumulates usage across calls', async () => {
  const stdout = JSON.stringify({ result: 'x', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } });
  const s = createSummarizer({ enabled: true, exec: async () => stdout, retryBackoffMs: 0 });
  await s.schedule({ id: 'a', status: 'idle', lastActivityAt: 1, title: 't' });
  await s.schedule({ id: 'b', status: 'idle', lastActivityAt: 2, title: 't' });
  const u = s.getUsage();
  assert.equal(u.calls, 2);
  assert.equal(u.inputTokens, 20);
  assert.equal(u.outputTokens, 10);
  assert.ok(Math.abs(u.costUsd - 0.02) < 1e-9);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/summarizer.test.js`
Expected: FAIL — `parseClaudeResult is not a function` / `s.getUsage is not a function`。

- [ ] **Step 3: Implement**

在 `src/summarizer.js`,`parseSummaryOutput` 之后新增导出函数:

```js
/**
 * Parse `claude -p --output-format json` stdout into { title, usage }.
 * Falls back to treating stdout as a plain-text title (usage:null) if not JSON.
 * @param {string} stdout
 * @param {{maxLen?:number}} [opts]
 */
export function parseClaudeResult(stdout, opts = {}) {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  if (!stdout) return { title: '', usage: null };
  let obj = null;
  try { obj = JSON.parse(stdout); } catch { obj = null; }
  if (obj && typeof obj === 'object' && (typeof obj.result === 'string' || obj.usage)) {
    const u = obj.usage || {};
    const usage = {
      inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      outputTokens: u.output_tokens || 0,
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0,
    };
    return { title: parseSummaryOutput(obj.result || '', { maxLen }), usage };
  }
  return { title: parseSummaryOutput(stdout, { maxLen }), usage: null };
}
```

在 `createSummarizer` 内,`let active = 0;` 之后新增累加器:

```js
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  function recordUsage(usage) {
    totals.calls += 1;
    if (usage) {
      totals.inputTokens += usage.inputTokens || 0;
      totals.outputTokens += usage.outputTokens || 0;
      totals.costUsd += usage.costUsd || 0;
    }
  }
  function getUsage() { return { ...totals }; }
```

把 `runSummary` 里这三行:

```js
      const args = ['-p', '--model', model, buildSummaryPrompt(window)];
      const stdout = await exec('claude', args, timeoutMs);
      const title = parseSummaryOutput(stdout, { maxLen });
```

替换为:

```js
      const args = ['-p', '--output-format', 'json', '--model', model, buildSummaryPrompt(window)];
      const stdout = await exec('claude', args, timeoutMs);
      const { title, usage } = parseClaudeResult(stdout, { maxLen });
      recordUsage(usage);
```

把 `createSummarizer` 的返回:

```js
  return { enabled, getTitle, schedule };
```

改为:

```js
  return { enabled, getTitle, schedule, getUsage };
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --test test/summarizer.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/summarizer.js test/summarizer.test.js
git commit -m "feat: capture and accumulate LLM token usage via --output-format json"
```

---

## Task 3: summarizer 手动总结 `summarizeNow`

**Files:**
- Modify: `src/summarizer.js`(新增 `summarizeNow`)
- Test: `test/summarizer.test.js`

- [ ] **Step 1: Write failing tests**

追加:

```js
test('summarizeNow ignores enabled + running gating', async () => {
  let calls = 0;
  const stdout = JSON.stringify({ result: '手动标题', usage: { input_tokens: 1, output_tokens: 1 } });
  const s = createSummarizer({ enabled: false, exec: async () => { calls += 1; return stdout; } });
  const t = await s.summarizeNow({ id: 'x', status: 'running', lastActivityAt: 1, title: 't' });
  assert.equal(t, '手动标题');
  assert.equal(calls, 1);
  assert.equal(s.getUsage().calls, 1);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/summarizer.test.js`
Expected: FAIL — `s.summarizeNow is not a function`。

- [ ] **Step 3: Implement**

在 `createSummarizer` 内,`schedule` 函数之后新增:

```js
  /**
   * Manual on-demand summary: bypasses enabled / running / turn-gating / backoff.
   * Still dedupes via inflight. The click itself is the user's consent, so this
   * runs even when auto-summary (enabled) is off.
   */
  async function summarizeNow(window) {
    if (inflight.has(window.id)) return getTitle(window);
    return runSummary(window);
  }
```

把返回行改为:

```js
  return { enabled, getTitle, schedule, summarizeNow, getUsage };
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --test test/summarizer.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/summarizer.js test/summarizer.test.js
git commit -m "feat: summarizeNow() for on-demand manual summaries"
```

---

## Task 4: config 新增空闲阈值标志

**Files:**
- Modify: `src/config.js`(DEFAULTS + resolveConfig)
- Test: `test/config.test.js`

- [ ] **Step 1: Write failing tests**

追加到 `test/config.test.js`:

```js
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
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — `idleArchiveMs` undefined。

- [ ] **Step 3: Implement**

在 `DEFAULTS` 里,`titleMax: 90,` 之后加:

```js
  idleArchiveMs: 4 * 3600_000, // idle ≥ this ⇒ move to archive view
  idleDropMs: 30 * 3600_000, // idle ≥ this ⇒ dropped entirely (0 = never)
```

在 `resolveConfig` 里,`const c = { ...DEFAULTS, ...fileConfig };` 之后加(在 flag 覆盖之前):

```js
  if (fileConfig.idleArchiveHours != null) c.idleArchiveMs = Number(fileConfig.idleArchiveHours) * 3600_000;
  if (fileConfig.idleDropHours != null) c.idleDropMs = Number(fileConfig.idleDropHours) * 3600_000;
```

在 flag 覆盖段(其它 `if (flags...)` 旁)加:

```js
  if (flags['idle-archive'] != null) c.idleArchiveMs = Number(flags['idle-archive']) * 3600_000;
  if (flags['idle-drop'] != null) c.idleDropMs = Number(flags['idle-drop']) * 3600_000;
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: --idle-archive / --idle-drop config (hours; 0 disables)"
```

---

## Task 5: collector 空闲生命周期分桶 + 存档 + 用量 meta

**Files:**
- Modify: `src/collector.js`(`NOOP_SUMMARIZER`、`buildBoard` deps + 分桶 + 返回)
- Test: `test/collector-helpers.test.js`(新建分桶单测)+ 现有 `test/collector.integration.test.js` 仍需绿

- [ ] **Step 1: Write failing test**

新建 `test/collector-lifecycle.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard } from '../src/collector.js';

const H = 3600_000;
const NOW = 1_000_000_000_000;

// A CC window that is idle, with lastActivityAt `ageH` hours ago.
function idleCc(id, ageH) {
  return { pid: Number(id.split(':')[1]), id };
}

async function build(extra = {}) {
  // Inject a fake collector path by stubbing claude/codex roots off and feeding
  // windows through a minimal monkey of buildBoard deps is not possible directly;
  // instead drive via the real collectors using temp dirs is heavy. We test the
  // zone logic by calling buildBoard with empty roots + a summarizer that yields
  // nothing, then asserting structure. Lifecycle math is covered through the
  // integration fixture; here we assert the payload SHAPE (archive present).
  return buildBoard({
    claudeRoot: null,
    codexRoot: null,
    now: NOW,
    isPidAlive: () => true,
    resolveRepoBranch: async () => ({ repo: null, branch: null }),
    fetchPr: async () => null,
    ...extra,
  });
}

test('buildBoard payload includes meta.llmUsage and archive bucket', async () => {
  const board = await build();
  assert.ok(board.meta && board.meta.llmUsage, 'meta.llmUsage present');
  assert.equal(board.meta.llmUsage.calls, 0);
  assert.ok(board.archive && Array.isArray(board.archive.windows), 'archive bucket present');
  assert.equal(board.archive.count, 0);
});
```

> 注:精确的 4h/30h 分桶数学用 Task 5b 的纯函数单测覆盖(见下),避免在 buildBoard 里搭真实 fs 夹具。

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/collector-lifecycle.test.js`
Expected: FAIL — `board.archive` undefined / `board.meta.llmUsage` undefined。

- [ ] **Step 3: Implement buildBoard changes**

(a) `NOOP_SUMMARIZER`(约 14 行)改为:

```js
const NOOP_SUMMARIZER = {
  enabled: false,
  getTitle: () => null,
  schedule: () => null,
  summarizeNow: async () => null,
  getUsage: () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
};
```

(b) `buildBoard` 的 deps 解构里追加(在 `labels = {}` 旁):

```js
    idleArchiveMs = 4 * 3600_000,
    idleDropMs = 30 * 3600_000,
    getRestoredAt = () => 0,
```

(c) Codex 采集放宽到 30h。把:

```js
  const codex = codexRoot
    ? collectCodexWindows({ codexRoot, now, activeWindowMs: codexActiveWindowMs, titleMax })
    : [];
```

改为:

```js
  const codexCollectMs = idleDropMs > 0 ? Math.max(codexActiveWindowMs, idleDropMs) : 7 * 24 * 3600_000;
  const codex = codexRoot
    ? collectCodexWindows({ codexRoot, now, activeWindowMs: codexCollectMs, titleMax })
    : [];
```

(d) 把"schedule 循环 + 排序 + 分组 + return"整段(约 335-365 行,从 `// Kick off summaries` 到函数末尾的 `return {...}`)替换为:

```js
  // Idle lifecycle: bucket idle windows by effective idle age.
  // effectiveActivity = max(real activity, manual restore time).
  const effectiveActivity = (w) => Math.max(w.lastActivityAt || 0, w.startedAt || 0, getRestoredAt(w.id) || 0);
  const zoneFor = (w) => {
    if (w.status !== 'idle') return 'main';
    if (!idleArchiveMs) return 'main';
    const age = now - effectiveActivity(w);
    if (age < idleArchiveMs) return 'main';
    if (idleDropMs && age > idleDropMs) return 'dropped';
    return 'archive';
  };
  const mainWindows = [];
  const archiveWindows = [];
  for (const w of windows) {
    const z = zoneFor(w);
    if (z === 'main') mainWindows.push(w);
    else if (z === 'archive') archiveWindows.push(w);
    // 'dropped' → omitted from the payload entirely
  }

  // Auto-summaries only for main windows (don't spend calls on stale/archived).
  for (const w of mainWindows) {
    const p = summarizer.schedule(w);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  mainWindows.sort(compareWindows);

  // Group main by repo; group order = best status priority within it, then name.
  const groupMap = new Map();
  for (const w of mainWindows) {
    const key = w.repo || w.cwd || '(unknown)';
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(w);
  }
  const groups = [...groupMap.entries()]
    .map(([repo, ws]) => ({
      repo,
      windows: ws.sort(compareWindows),
      topPriority: Math.min(...ws.map((w) => STATUS_PRIORITY[w.status] ?? 99)),
    }))
    .sort((a, b) => a.topPriority - b.topPriority || a.repo.localeCompare(b.repo));

  // Archive: most-recent activity first (review timeline).
  archiveWindows.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

  return {
    generatedAt: now,
    meta: { summaryEnabled: !!summarizer.enabled, llmUsage: summarizer.getUsage() },
    summary: summarize(mainWindows),
    windows: mainWindows,
    groups,
    archive: { count: archiveWindows.length, windows: archiveWindows },
  };
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --test test/collector-lifecycle.test.js test/collector.integration.test.js`
Expected: PASS(集成测试若断言旧返回字段仍存在则照常通过;新增 `archive` 不破坏)。

> 若集成测试断言了"空闲窗口出现在 groups 里"且其夹具空闲 >4h,需在该测试里传 `idleArchiveMs: Infinity` 或把夹具时间改近,使其留在 main。实现时按实际报错微调夹具时间戳。

- [ ] **Step 5: Commit**

```bash
git add src/collector.js test/collector-lifecycle.test.js
git commit -m "feat: idle lifecycle buckets (main/archive/dropped) + llmUsage meta"
```

---

## Task 5b: 分桶纯函数单测(锁死 4h/30h 数学)

**Files:**
- Modify: `src/collector.js`(导出 `classifyZone` 纯函数,供 buildBoard 复用 + 单测)
- Test: `test/collector-lifecycle.test.js`

- [ ] **Step 1: Write failing tests**

追加到 `test/collector-lifecycle.test.js`:

```js
import { classifyZone } from '../src/collector.js';

const opts = { now: NOW, idleArchiveMs: 4 * H, idleDropMs: 30 * H, getRestoredAt: () => 0 };
const w = (status, ageH) => ({ id: 'x', status, lastActivityAt: NOW - ageH * H, startedAt: NOW - ageH * H });

test('classifyZone: idle 1h → main', () => assert.equal(classifyZone(w('idle', 1), opts), 'main'));
test('classifyZone: idle 5h → archive', () => assert.equal(classifyZone(w('idle', 5), opts), 'archive'));
test('classifyZone: idle 31h → dropped', () => assert.equal(classifyZone(w('idle', 31), opts), 'dropped'));
test('classifyZone: needs-you 40h → main', () => assert.equal(classifyZone(w('needs-you', 40), opts), 'main'));
test('classifyZone: running → main', () => assert.equal(classifyZone(w('running', 99), opts), 'main'));
test('classifyZone: restored 5h-idle → main', () => {
  const o = { ...opts, getRestoredAt: () => NOW };
  assert.equal(classifyZone(w('idle', 5), o), 'main');
});
test('classifyZone: idleArchiveMs=0 → always main', () => {
  assert.equal(classifyZone(w('idle', 99), { ...opts, idleArchiveMs: 0 }), 'main');
});
test('classifyZone: idleDropMs=0 → never dropped', () => {
  assert.equal(classifyZone(w('idle', 99), { ...opts, idleDropMs: 0 }), 'archive');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/collector-lifecycle.test.js`
Expected: FAIL — `classifyZone is not a function`。

- [ ] **Step 3: Extract `classifyZone` and reuse it**

在 `src/collector.js`(`encodeCwd` 附近)新增导出:

```js
/**
 * Decide which zone a window belongs to by effective idle age.
 * @param {{id:string,status:string,lastActivityAt?:number,startedAt?:number}} w
 * @param {{now:number,idleArchiveMs:number,idleDropMs:number,getRestoredAt:(id:string)=>number}} opts
 * @returns {'main'|'archive'|'dropped'}
 */
export function classifyZone(w, opts) {
  if (w.status !== 'idle') return 'main';
  if (!opts.idleArchiveMs) return 'main';
  const eff = Math.max(w.lastActivityAt || 0, w.startedAt || 0, opts.getRestoredAt(w.id) || 0);
  const age = opts.now - eff;
  if (age < opts.idleArchiveMs) return 'main';
  if (opts.idleDropMs && age > opts.idleDropMs) return 'dropped';
  return 'archive';
}
```

在 `buildBoard` 里删除 Task 5 加的内联 `effectiveActivity` + `zoneFor`,改用:

```js
  const zoneOpts = { now, idleArchiveMs, idleDropMs, getRestoredAt };
  const mainWindows = [];
  const archiveWindows = [];
  for (const w of windows) {
    const z = classifyZone(w, zoneOpts);
    if (z === 'main') mainWindows.push(w);
    else if (z === 'archive') archiveWindows.push(w);
  }
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --test test/collector-lifecycle.test.js`
Expected: PASS(8 个 classifyZone 用例 + 之前的 payload-shape 用例)。

- [ ] **Step 5: Commit**

```bash
git add src/collector.js test/collector-lifecycle.test.js
git commit -m "refactor: extract classifyZone pure fn + lock 4h/30h math"
```

---

## Task 6: 端点 `POST /api/summarize` 与 `POST /api/restore`

**Files:**
- Modify: `src/server.js`(`createRequestHandler`、`createBoardProvider`、`createServer`、import)
- Test: `test/server.test.js`

- [ ] **Step 1: Write failing tests**

在 `test/server.test.js` 加一个 POST helper 和用例:

```js
async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

test('POST /api/summarize returns headline', async () => {
  const handler = createRequestHandler({
    getBoard: async () => ({ windows: [{ id: 'cc:1' }], archive: { windows: [] } }),
    summarizeWindow: async (id) => ({ id, title: 'hi', headline: { text: 'hi', source: 'summary' } }),
  });
  const { server, port } = await startServer(handler);
  try {
    const r = await post(port, '/api/summarize', { id: 'cc:1' });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).headline.text, 'hi');
  } finally { server.close(); }
});

test('POST /api/summarize unknown id → 404', async () => {
  const handler = createRequestHandler({ getBoard: async () => ({}), summarizeWindow: async () => null });
  const { server, port } = await startServer(handler);
  try {
    const r = await post(port, '/api/summarize', { id: 'nope' });
    assert.equal(r.status, 404);
  } finally { server.close(); }
});

test('GET /api/summarize → 405', async () => {
  const handler = createRequestHandler({ getBoard: async () => ({}), summarizeWindow: async () => null });
  const { server, port } = await startServer(handler);
  try {
    const r = await get(port, '/api/summarize');
    assert.equal(r.status, 405);
  } finally { server.close(); }
});

test('POST /api/restore → ok', async () => {
  const handler = createRequestHandler({ getBoard: async () => ({}), restoreWindow: async (id) => ({ id, ok: true }) });
  const { server, port } = await startServer(handler);
  try {
    const r = await post(port, '/api/restore', { id: 'cc:1' });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, true);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — summarize 返回 404/HTML(端点未实现)。

- [ ] **Step 3: Implement**

(a) `src/server.js` 顶部 import 加:

```js
import { chooseHeadline } from './headline.js';
```

(b) 在 `sendJson` 之后新增:

```js
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}
```

(c) `createRequestHandler` 签名改为:

```js
export function createRequestHandler({ getBoard, summarizeWindow = null, restoreWindow = null, publicDir = DEFAULT_PUBLIC }) {
```

在 `handle` 内,`/api/windows` 分支之后、静态文件之前插入:

```js
    if (pathname === '/api/summarize' || pathname === '/api/restore') {
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
      const body = await readJsonBody(req);
      const id = body && typeof body.id === 'string' ? body.id : null;
      if (!id) { sendJson(res, 400, { error: 'missing id' }); return; }
      const fn = pathname === '/api/summarize' ? summarizeWindow : restoreWindow;
      try {
        const result = fn ? await fn(id) : null;
        if (!result) { sendJson(res, 404, { error: 'unknown window' }); return; }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: String((err && err.message) || err) });
      }
      return;
    }
```

(d) `createBoardProvider`:在 `const summarizer = createSummarizer(...)` 之后加:

```js
  const restoredAt = new Map(); // id -> ms; manual restore resets the idle clock
```

`build` 的入参加:

```js
      idleArchiveMs: config.idleArchiveMs,
      idleDropMs: config.idleDropMs,
      getRestoredAt: (id) => restoredAt.get(id) || 0,
```

在 `const getBoard = memoizeAsync(...)` 之后、`return { getBoard };` 之前加:

```js
  async function summarizeWindow(id) {
    const board = await getBoard();
    const all = [...(board.windows || []), ...((board.archive && board.archive.windows) || [])];
    const w = all.find((x) => x.id === id);
    if (!w) return null;
    const title = await summarizer.summarizeNow(w);
    if (!title) return { id, title: null, headline: w.headline };
    return { id, title, headline: chooseHeadline({ ...w, summaryTitle: title }) };
  }

  async function restoreWindow(id) {
    const board = await getBoard();
    const all = [...(board.windows || []), ...((board.archive && board.archive.windows) || [])];
    if (!all.some((x) => x.id === id)) return null;
    restoredAt.set(id, Date.now());
    // prune stale restore markers
    const cutoff = Date.now() - (config.idleDropMs || 30 * 3600_000);
    for (const [k, v] of restoredAt) if (v < cutoff) restoredAt.delete(k);
    return { id, ok: true };
  }
```

把 `return { getBoard };` 改为:

```js
  return { getBoard, summarizeWindow, restoreWindow };
```

(e) `createServer` 改为:

```js
export function createServer(config) {
  const { getBoard, summarizeWindow, restoreWindow } = createBoardProvider(config);
  const handler = createRequestHandler({ getBoard, summarizeWindow, restoreWindow });
  return http.createServer(handler);
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --test test/server.test.js`
Expected: PASS(含原有 5 个用例)。

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: POST /api/summarize + /api/restore endpoints"
```

---

## Task 7: render.js — 用量 hint、token 格式化、按状态分组、存档视图、卡片按钮

**Files:**
- Modify: `public/render.js`
- Test: `test/render.test.js`

- [ ] **Step 1: Write failing tests**

追加到 `test/render.test.js`:

```js
import { renderBoard, formatTokens, usageHint } from '../public/render.js';

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
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/render.test.js`
Expected: FAIL — `formatTokens is not a function` 等。

- [ ] **Step 3: Implement**

在 `public/render.js`,`statusMeta` 之后新增导出:

```js
/** Compact token count: "950", "34.5K", "1.2M". */
export function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** Top-bar mode/usage hint from board.meta. Honest "0 次" until a call happens. */
export function usageHint(meta) {
  const u = (meta && meta.llmUsage) || { calls: 0 };
  if (!u.calls) {
    return meta && meta.summaryEnabled
      ? '本地只读 · AI 标题:Haiku(走订阅)· 0 次调用'
      : '本地只读 · 0 次 LLM 调用';
  }
  const tok = formatTokens((u.inputTokens || 0) + (u.outputTokens || 0));
  const cost = u.costUsd ? ` · $${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}` : '';
  return `本地只读 · ${u.calls} 次调用 · ${tok} tok${cost}`;
}
```

把 `renderCard(w, now)` 签名改为 `renderCard(w, now, opts = {})`,在它内部 `const timeline = ...;` 之后加:

```js
  const idleLine = opts.archive && w.lastActivityAt
    ? `<div class="idle-age">已空闲 ${formatDuration((now ?? Date.now()) - w.lastActivityAt)}</div>`
    : '';
  const sumBtn = `<button class="act" data-id="${escapeHtml(w.id)}" data-action="summarize">✨ 总结</button>`;
  const restoreBtn = opts.archive
    ? `<button class="act" data-id="${escapeHtml(w.id)}" data-action="restore">↩ 恢复</button>`
    : '';
```

把 renderCard 的 `return` 模板末尾(`<div class="timeline">...` 行之后、闭合 `</div>` 之前)改为:

```js
      <div class="timeline">${escapeHtml(timeline)}</div>
      ${idleLine}
      <div class="actions">${sumBtn}${restoreBtn}</div>
    </div>`;
```

在 `summaryBar` 之后新增:

```js
function groupByStatus(windows, now) {
  const order = ['needs-you', 'running', 'waiting-ci-review', 'idle'];
  return order
    .map((status) => {
      const ws = (windows || []).filter((w) => w.status === status);
      const m = statusMeta(status);
      const head = `<h2 class="repo" style="color:${m.color}">● ${escapeHtml(m.label)} (${ws.length})</h2>`;
      const grid = ws.length ? `<div class="grid">${ws.map((w) => renderCard(w, now)).join('')}</div>` : '';
      return `<section class="group">${head}${grid}</section>`;
    })
    .join('');
}
```

把 `renderBoard` 整体替换为:

```js
export function renderBoard(board, now, opts = {}) {
  if (!board || (!board.summary && !board.archive)) return '<div class="empty">没有数据</div>';
  const t = now ?? board.generatedAt ?? Date.now();
  const view = opts.view || 'main';
  const grouping = opts.grouping || 'repo';
  const focus = !!opts.focus; // when on: only needs-you + running

  if (view === 'archive') {
    const ws = (board.archive && board.archive.windows) || [];
    if (!ws.length) return '<div class="empty">存档为空</div>';
    return `<section class="group"><div class="grid">${ws.map((w) => renderCard(w, t, { archive: true })).join('')}</div></section>`;
  }

  const keep = (w) => !focus || w.status === 'needs-you' || w.status === 'running';
  const bar = board.summary ? summaryBar(board.summary) : '';
  let body;
  if (grouping === 'status') {
    body = groupByStatus((board.windows || []).filter(keep), t);
  } else {
    body = (board.groups || [])
      .map((g) => ({ repo: g.repo, windows: (g.windows || []).filter(keep) }))
      .filter((g) => g.windows.length)
      .map(
        (g) => `
      <section class="group">
        <h2 class="repo">${escapeHtml(g.repo)}</h2>
        <div class="grid">${g.windows.map((w) => renderCard(w, t)).join('')}</div>
      </section>`,
      )
      .join('');
  }
  const visible = (board.windows || []).filter(keep).length;
  let empty = '';
  if (board.summary && (board.summary.total || 0) === 0) empty = '<div class="empty">没有检测到活跃的 CC / Codex 窗口</div>';
  else if (focus && visible === 0) empty = '<div class="empty">专注模式:当前没有「等你 / 跑着」的窗口</div>';
  return bar + body + empty;
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --test test/render.test.js`
Expected: PASS(含原有用例)。

- [ ] **Step 5: Commit**

```bash
git add public/render.js test/render.test.js
git commit -m "feat: status grouping, archive view, card buttons, usage hint"
```

---

## Task 8: 前端粘合 — 控件、视图状态、按钮交互(`app.js` / `index.html` / `styles.css`)

> 纯逻辑已在 Task 7 测过;本任务是 DOM/fetch 粘合,用手动验收(无单测)。

**Files:**
- Modify: `public/index.html`、`public/app.js`、`public/styles.css`

- [ ] **Step 1: index.html 加控件条**

在 `</header>` 之后、`<main id="board" ...>` 之前插入:

```html
    <nav class="controls">
      <button data-grouping="repo" class="seg active">按仓库</button>
      <button data-grouping="status" class="seg">按状态</button>
      <button id="focus-btn" class="seg">专注</button>
      <span class="spacer"></span>
      <button id="back-btn" class="seg" hidden>← 返回</button>
      <button id="archive-btn" class="seg">🗄 存档 (0)</button>
    </nav>
```

- [ ] **Step 2: 重写 app.js**

把 `public/app.js` 全文替换为:

```js
// Browser entry: polls /api/windows, renders via the pure render.js module,
// and handles view toggles + the summarize/restore action buttons.
import { renderBoard, usageHint } from './render.js';

const POLL_MS = 5000;
const boardEl = document.getElementById('board');
const updatedEl = document.getElementById('updated');
const modeHintEl = document.getElementById('mode-hint');
const archiveBtn = document.getElementById('archive-btn');
const backBtn = document.getElementById('back-btn');
const focusBtn = document.getElementById('focus-btn');
const groupingBtns = [...document.querySelectorAll('[data-grouping]')];

let lastBoard = null;
let lastOk = null;
let lastError = null;
let view = 'main';
let grouping = localStorage.getItem('ccb-grouping') === 'status' ? 'status' : 'repo';
let focus = localStorage.getItem('ccb-focus') === '1';

function syncControls() {
  for (const b of groupingBtns) {
    b.classList.toggle('active', b.dataset.grouping === grouping);
    b.hidden = view === 'archive';
  }
  if (focusBtn) { focusBtn.classList.toggle('active', focus); focusBtn.hidden = view === 'archive'; }
  const n = (lastBoard && lastBoard.archive && lastBoard.archive.count) || 0;
  if (archiveBtn) { archiveBtn.textContent = `🗄 存档 (${n})`; archiveBtn.hidden = view === 'archive'; }
  if (backBtn) backBtn.hidden = view !== 'archive';
}

function render() {
  if (!lastBoard) return;
  boardEl.innerHTML = renderBoard(lastBoard, Date.now(), { view, grouping, focus });
  if (modeHintEl) modeHintEl.textContent = usageHint(lastBoard.meta);
  syncControls();
}

async function poll() {
  try {
    const res = await fetch('/api/windows', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastBoard = await res.json();
    render();
    lastOk = Date.now();
    lastError = null;
  } catch (err) {
    lastError = err;
  }
  tickUpdated();
}

function tickUpdated() {
  if (lastError && lastOk == null) {
    updatedEl.textContent = '⚠ 无法连接看板服务';
    updatedEl.className = 'updated err';
    return;
  }
  if (lastOk == null) return;
  const secs = Math.round((Date.now() - lastOk) / 1000);
  const suffix = lastError ? ' · ⚠ 刷新失败' : '';
  updatedEl.textContent = `⟳ 每 ${POLL_MS / 1000}s · ${secs}s 前更新${suffix}`;
  updatedEl.className = lastError ? 'updated warn' : 'updated';
}

async function postAction(path, id) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function findWindow(id) {
  for (const l of [lastBoard.windows || [], (lastBoard.archive && lastBoard.archive.windows) || []]) {
    const w = l.find((x) => x.id === id);
    if (w) return w;
  }
  return null;
}

boardEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !lastBoard) return;
  const { id, action } = btn.dataset;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    if (action === 'summarize') {
      const r = await postAction('/api/summarize', id);
      const w = findWindow(id);
      if (w && r.headline) { w.headline = r.headline; w.summaryTitle = r.title; }
      render();
    } else if (action === 'restore') {
      await postAction('/api/restore', id);
      const arch = lastBoard.archive && lastBoard.archive.windows;
      if (arch) {
        const i = arch.findIndex((x) => x.id === id);
        if (i >= 0) {
          const [w] = arch.splice(i, 1);
          lastBoard.archive.count = arch.length;
          (lastBoard.windows = lastBoard.windows || []).push(w);
        }
      }
      view = 'main';
      render();
    }
  } catch {
    btn.textContent = '失败';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
  }
});

if (archiveBtn) archiveBtn.addEventListener('click', () => { view = 'archive'; render(); });
if (backBtn) backBtn.addEventListener('click', () => { view = 'main'; render(); });
if (focusBtn) focusBtn.addEventListener('click', () => { focus = !focus; localStorage.setItem('ccb-focus', focus ? '1' : '0'); render(); });
for (const b of groupingBtns) {
  b.addEventListener('click', () => {
    grouping = b.dataset.grouping;
    localStorage.setItem('ccb-grouping', grouping);
    render();
  });
}

poll();
setInterval(poll, POLL_MS);
setInterval(tickUpdated, 1000);
```

- [ ] **Step 3: styles.css 追加样式**

在 `public/styles.css` 末尾追加:

```css
.controls { display: flex; align-items: center; gap: 8px; padding: 8px 16px; }
.controls .spacer { flex: 1; }
.seg {
  font: inherit; font-size: 13px; padding: 4px 10px; border: 1px solid #ccc;
  background: #fff; border-radius: 6px; cursor: pointer; color: #333;
}
.seg.active { background: #06c; color: #fff; border-color: #06c; }
.seg[hidden] { display: none; }
.actions { display: flex; gap: 8px; margin-top: 8px; }
.act {
  font: inherit; font-size: 12px; padding: 3px 8px; border: 1px solid #ddd;
  background: #fafafa; border-radius: 6px; cursor: pointer; color: #444;
}
.act:hover { background: #f0f0f0; }
.act:disabled { opacity: 0.6; cursor: default; }
.idle-age { font-size: 12px; color: #999; margin-top: 4px; }
```

- [ ] **Step 4: Manual verification**

```bash
node bin/cc-codex-board.js --open
```
人工核对:
- 顶栏出现「按仓库 / 按状态」+「🗄 存档 (N)」;点「按状态」→ 卡片按状态分 4 段且 needs-you 在前;刷新后保持(localStorage)。
- 点「存档」→ 整页变存档列表,卡片有「已空闲 Xh」+「↩ 恢复」;点「← 返回」回主视图。
- 任一卡点「✨ 总结」→ 转圈后标题更新;顶栏「N 次调用 · tok · $」随之变化(没开 --summary 也生效)。
- 存档卡点「↩ 恢复」→ 卡片立即回主视图。
- 点「专注」→ 只剩 等你 + 跑着 的卡片(空闲、等CI/复评 都消失);再点取消;刷新后保持(localStorage)。

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/index.html public/styles.css
git commit -m "feat: view toggle, archive view, summarize/restore buttons (frontend)"
```

---

## Task 9: 文档 + 版本 + bin help

**Files:**
- Modify: `bin/cc-codex-board.js`(help 文本)、`README.md`、`SPEC.md`、`package.json`
- Test: `test/bin.test.js`(若断言 help 内容)

- [ ] **Step 1: bin help 加两个标志**

在 `bin/cc-codex-board.js` 的 help 文本里,`--open` 行之前加:

```
  --idle-archive <h>   Idle windows older than h hours move to the archive view
                       (default 4; 0 disables the archive)
  --idle-drop <h>      Idle windows older than h hours are dropped entirely
                       (default 30; 0 keeps them forever)
```

- [ ] **Step 2: package.json bump 版本**

把 `"version": "0.1.0",` 改为 `"version": "0.2.0",`。

- [ ] **Step 3: README + SPEC**

README:
- 「What it shows」补:每卡 `✨ 总结` 手动 AI 标题(按需,点=授权,即使没开 `--summary`);空闲 >4h 进「🗄 存档」视图(可 `↩ 恢复`),>30h 丢弃;主视图可「按仓库 / 按状态」切换、「专注」一键只看 等你+跑着;顶栏显示真实 LLM 用量。
- Configuration 表加 `--idle-archive` / `--idle-drop`。
- 末尾加一段 `## Changelog` → `### 0.2.0`:列这 5 项。
- 「Run it」下补一句:升级 = 重启 `npx github:...`(自动拉最新);clone 用户 `git pull`。

SPEC.md:
- 「Non-goals: No actions」改措辞:除两个明确的本地动作(手动总结 / 从存档恢复,均不写 transcript/repo)外只读。
- Status taxonomy / Layout 段补:needs-you 现也由"待决 tool_use"触发;空闲生命周期(主/存档/丢弃)+ 顶栏用量。

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add bin/cc-codex-board.js README.md SPEC.md package.json
git commit -m "docs: v0.2.0 — flags, buttons, archive, usage, needs-you fix"
```

---

## Self-Review(对照 spec)

**Spec coverage:**
- ① 空闲生命周期 + 恢复 → Task 4(config)/5/5b(分桶 + 存档)/6(restore 端点)/7(存档视图 + 恢复按钮)/8(粘合)。✅
- ② 每卡手动总结 → Task 3(summarizeNow)/6(summarize 端点)/7(按钮)/8(交互)。✅
- ③ 顶栏真实用量 → Task 2(抓 usage)/5(meta.llmUsage)/7(usageHint+formatTokens)/8(渲染)。✅
- ④ 按仓库/按状态 → Task 7(groupByStatus)/8(控件+localStorage)。✅
- ⑤ needs-you 修复 → Task 1。✅(实现期按 spec「落地数据」补一个真实权限-提示 fixture)
- ⑥ 「专注」过滤(只看 等你+跑着)→ Task 7(renderBoard focus + 单测)/8(专注按钮 + `ccb-focus`)。✅

**Type consistency:** payload `{ meta.llmUsage{calls,inputTokens,outputTokens,costUsd}, windows, groups, archive{count,windows} }` 在 collector(产出)、server(查找)、render(消费)、app(消费)四处一致;`summarizer` 接口 `{enabled,getTitle,schedule,summarizeNow,getUsage}` 在 NOOP/真实实例/collector/server 一致;`classifyZone(w, {now,idleArchiveMs,idleDropMs,getRestoredAt})` 在单测与 buildBoard 一致。

**Placeholder scan:** 无 TBD/TODO;每个代码步骤含完整代码。唯一"实现期补"项是 Task 1 的真实 fixture(spec 已说明当前快照抓不到 awaiting 态),其余逻辑已用合成 line 数组测到。
