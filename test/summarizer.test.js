import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryPrompt, parseSummaryOutput, createSummarizer, parseClaudeResult } from '../src/summarizer.js';

test('buildSummaryPrompt includes the opening request and latest activity, bounded', () => {
  const p = buildSummaryPrompt({ title: '修复登录 bug', currentActivity: '加上单元测试', lastMessage: { role: 'assistant', text: '测试通过了' } });
  assert.match(p, /修复登录 bug/);
  assert.match(p, /加上单元测试/);
  assert.ok(p.length < 2000, 'prompt is bounded');
});

test('parseSummaryOutput trims, takes first line, strips quotes, truncates', () => {
  assert.equal(parseSummaryOutput('  "Fix login bug"\nextra\n'), 'Fix login bug');
  assert.equal(parseSummaryOutput('修复睡眠占比'), '修复睡眠占比');
  assert.equal(parseSummaryOutput(''), '');
  assert.equal(parseSummaryOutput('x'.repeat(100), { maxLen: 24 }).length, 24);
});

function makeExec(log, output = 'AI 标题') {
  return async (file, args) => {
    log.push([file, ...args]);
    return output;
  };
}

test('schedule triggers a summary on first sight of an idle window and caches it', async () => {
  const log = [];
  const s = createSummarizer({ enabled: true, model: 'claude-haiku-4-5', exec: makeExec(log, '修睡眠 bug') });
  const w = { id: 'cc:1', status: 'idle', lastActivityAt: 100, title: 't', currentActivity: 'a' };
  assert.equal(s.getTitle(w), null);
  const title = await s.schedule(w);
  assert.equal(title, '修睡眠 bug');
  assert.equal(s.getTitle(w), '修睡眠 bug');
  assert.equal(log.length, 1);
  assert.equal(log[0][0], 'claude');
  assert.ok(log[0].includes('claude-haiku-4-5'));
});

test('schedule does NOT summarize a running window', async () => {
  const log = [];
  const s = createSummarizer({ enabled: true, exec: makeExec(log) });
  const res = s.schedule({ id: 'cc:2', status: 'running', lastActivityAt: 1, title: 't', currentActivity: 'a' });
  assert.equal(res, null);
  assert.equal(log.length, 0);
});

test('schedule summarizes on the running→idle transition', async () => {
  const log = [];
  const s = createSummarizer({ enabled: true, exec: makeExec(log) });
  const id = 'cc:3';
  s.schedule({ id, status: 'running', lastActivityAt: 1, title: 't', currentActivity: 'a' }); // running: no-op
  assert.equal(log.length, 0);
  await s.schedule({ id, status: 'idle', lastActivityAt: 2, title: 't', currentActivity: 'a2' }); // transition
  assert.equal(log.length, 1);
});

test('schedule does not re-summarize while the signature is unchanged', async () => {
  const log = [];
  const s = createSummarizer({ enabled: true, exec: makeExec(log) });
  const w = { id: 'cc:4', status: 'idle', lastActivityAt: 5, title: 't', currentActivity: 'a' };
  await s.schedule(w);
  const again = s.schedule({ ...w }); // same lastActivityAt → cached
  assert.equal(again, null);
  assert.equal(log.length, 1);
});

test('a new turn (new lastActivityAt) re-summarizes after going idle again', async () => {
  const log = [];
  const s = createSummarizer({ enabled: true, exec: makeExec(log) });
  const id = 'cc:5';
  await s.schedule({ id, status: 'idle', lastActivityAt: 1, title: 't', currentActivity: 'a' });
  s.schedule({ id, status: 'running', lastActivityAt: 2, title: 't', currentActivity: 'b' });
  await s.schedule({ id, status: 'idle', lastActivityAt: 3, title: 't', currentActivity: 'b' });
  assert.equal(log.length, 2);
});

test('exec failure leaves no cached title and does not throw', async () => {
  const s = createSummarizer({ enabled: true, exec: async () => { throw new Error('claude not found'); } });
  const w = { id: 'cc:6', status: 'idle', lastActivityAt: 1, title: 't', currentActivity: 'a' };
  const title = await s.schedule(w);
  assert.equal(title, null);
  assert.equal(s.getTitle(w), null);
});

test('a window shed by the concurrency cap is retried on a later refresh', async () => {
  const resolvers = [];
  const exec = () => new Promise((r) => resolvers.push(() => r(`T${resolvers.length}`)));
  const s = createSummarizer({ enabled: true, exec, concurrency: 1 });
  const w1 = { id: 'cc:a', status: 'idle', lastActivityAt: 1, title: 't', currentActivity: 'a' };
  const w2 = { id: 'cc:b', status: 'idle', lastActivityAt: 1, title: 't', currentActivity: 'b' };
  const p1 = s.schedule(w1);
  assert.ok(p1, 'first window starts');
  assert.equal(s.schedule(w2), null, 'second window shed by the cap');
  resolvers[0]();
  await p1;
  const p2 = s.schedule(w2); // slot is free now — retried without any status edge
  assert.ok(p2, 'shed window retried on a later refresh');
  resolvers[1]();
  await p2;
  assert.ok(s.getTitle(w2) !== null);
});

test('a failed summary is not retried until the backoff elapses', async () => {
  let calls = 0;
  let clock = 1000;
  const s = createSummarizer({ enabled: true, exec: async () => { calls += 1; throw new Error('x'); }, now: () => clock, retryBackoffMs: 1000 });
  const w = { id: 'cc:c', status: 'idle', lastActivityAt: 1, title: 't', currentActivity: 'a' };
  await s.schedule(w);
  assert.equal(calls, 1);
  assert.equal(s.schedule(w), null, 'within backoff: no retry');
  assert.equal(calls, 1);
  clock += 1500;
  await s.schedule(w);
  assert.equal(calls, 2, 'after backoff: retried');
});

test('disabled summarizer never execs', async () => {
  const log = [];
  const s = createSummarizer({ enabled: false, exec: makeExec(log) });
  assert.equal(s.schedule({ id: 'cc:7', status: 'idle', lastActivityAt: 1, title: 't' }), null);
  assert.equal(log.length, 0);
});

// Task 2: capture real token usage

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
