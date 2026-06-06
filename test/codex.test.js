import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRollout,
  isSubagentRollout,
  extractCodexTitle,
  extractCodexActivity,
  extractCodexStatus,
  extractCodexLastActivityAt,
  parseSessionIndex,
  parseRolloutFilename,
  summarizeRollout,
} from '../src/codex.js';

function jl(...objs) {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

function userMsg(ts, text) {
  return { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
}
function agentMsg(ts, text) {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message: text } };
}

test('parseRollout returns session_meta payload and parsed lines', () => {
  const text = jl(
    { timestamp: '2026-06-06T06:09:55.074Z', type: 'session_meta', payload: { id: 'abc', cwd: '/Users/dev/proj', thread_source: 'user' } },
    { timestamp: '2026-06-06T06:09:55.076Z', type: 'event_msg', payload: { type: 'task_started' } },
  );
  const r = parseRollout(text);
  assert.equal(r.meta.id, 'abc');
  assert.equal(r.meta.cwd, '/Users/dev/proj');
  assert.equal(r.lines.length, 2);
});

test('isSubagentRollout flags guardian/subagent rollouts and passes user threads', () => {
  assert.equal(isSubagentRollout({ thread_source: 'user', source: 'vscode' }), false);
  assert.equal(isSubagentRollout({ thread_source: 'subagent', source: { subagent: { other: 'guardian' } } }), true);
  assert.equal(isSubagentRollout({ source: { subagent: { other: 'compact' } } }), true);
  assert.equal(isSubagentRollout({}), false);
});

test('extractCodexTitle returns the first user prompt, skipping <environment_context>', () => {
  const lines = parseRollout(
    jl(
      { type: 'session_meta', payload: { cwd: '/x' } },
      userMsg('2026-06-06T05:15:59.361Z', '<environment_context>\n  <cwd>/Users/dev/proj</cwd>\n</environment_context>'),
      userMsg('2026-06-06T05:15:59.367Z', 'review review feature/x 本地提交 abc1234'),
    ),
  ).lines;
  assert.equal(extractCodexTitle(lines), 'review review feature/x 本地提交 abc1234');
});

test('extractCodexActivity returns the latest real user prompt', () => {
  const lines = parseRollout(
    jl(
      userMsg('2026-06-06T05:15:59.367Z', 'first task'),
      agentMsg('2026-06-06T05:16:30.000Z', 'working...'),
      userMsg('2026-06-06T05:20:00.000Z', '等 Apple Health 截图再继续'),
    ),
  ).lines;
  assert.equal(extractCodexActivity(lines), '等 Apple Health 截图再继续');
});

test('extractCodexStatus is running after task_started, idle after task_complete', () => {
  const running = parseRollout(jl(agentMsg('t', 'x'), { type: 'event_msg', payload: { type: 'task_started' } })).lines;
  assert.equal(extractCodexStatus(running), 'running');
  const idle = parseRollout(
    jl({ type: 'event_msg', payload: { type: 'task_started' } }, agentMsg('t', 'done'), { type: 'event_msg', payload: { type: 'task_complete' } }),
  ).lines;
  assert.equal(extractCodexStatus(idle), 'idle');
});

test('extractCodexLastActivityAt returns max timestamp in ms', () => {
  const lines = parseRollout(jl(userMsg('2026-06-06T05:00:00.000Z', 'a'), agentMsg('2026-06-06T05:30:00.000Z', 'b'))).lines;
  assert.equal(extractCodexLastActivityAt(lines), Date.parse('2026-06-06T05:30:00.000Z'));
});

test('parseSessionIndex maps id to thread name and updated time', () => {
  const text = jl(
    { id: '019e98ae', thread_name: '检查 #245 CI 失败原因', updated_at: '2026-06-05T16:47:40.907874Z' },
    { id: '019e9b8c', thread_name: 'Review #250', updated_at: '2026-06-06T06:09:00.354930Z' },
  );
  const idx = parseSessionIndex(text);
  assert.equal(idx.get('019e98ae').threadName, '检查 #245 CI 失败原因');
  assert.equal(idx.get('019e9b8c').threadName, 'Review #250');
});

test('parseRolloutFilename extracts start time (ms) and conversation id', () => {
  const r = parseRolloutFilename('rollout-2026-06-06T14-09-54-019e9b8d-6326-7593-8279-de839401873f.jsonl');
  assert.equal(r.startedAt, Date.parse('2026-06-06T14:09:54'));
  assert.equal(r.id, '019e9b8d-6326-7593-8279-de839401873f');
});

test('summarizeRollout composes fields and marks subagent rollouts', () => {
  const text = jl(
    { timestamp: '2026-06-06T06:09:55.000Z', type: 'session_meta', payload: { id: 'abc', cwd: '/Users/dev/proj', thread_source: 'user' } },
    userMsg('2026-06-06T06:10:00.000Z', '设计一体式小盒子'),
    { type: 'event_msg', payload: { type: 'task_complete' } },
  );
  const s = summarizeRollout(text);
  assert.equal(s.isSubagent, false);
  assert.equal(s.cwd, '/Users/dev/proj');
  assert.equal(s.title, '设计一体式小盒子');
  assert.equal(s.status, 'idle');
  assert.equal(s.id, 'abc');
});
