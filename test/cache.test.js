import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoizeAsync } from '../src/cache.js';

test('memoizeAsync caches results within the TTL window', async () => {
  let calls = 0;
  let clock = 1000;
  const fn = memoizeAsync(async (x) => { calls += 1; return x * 2; }, { ttlMs: 100, now: () => clock });

  assert.equal(await fn(5), 10);
  assert.equal(await fn(5), 10);
  assert.equal(calls, 1, 'second call within TTL is served from cache');

  clock += 150; // past TTL
  assert.equal(await fn(5), 10);
  assert.equal(calls, 2, 'call after TTL re-invokes');
});

test('memoizeAsync keys distinct arguments separately', async () => {
  let calls = 0;
  const fn = memoizeAsync(async (x) => { calls += 1; return x; }, { ttlMs: 1000, now: () => 0 });
  await fn('a');
  await fn('b');
  await fn('a');
  assert.equal(calls, 2);
});

test('memoizeAsync does not cache rejections', async () => {
  let calls = 0;
  const fn = memoizeAsync(
    async () => { calls += 1; if (calls === 1) throw new Error('boom'); return 'ok'; },
    { ttlMs: 10_000, now: () => 0 },
  );
  await assert.rejects(fn(), /boom/);
  assert.equal(await fn(), 'ok', 'a rejected call is retried, not cached');
  assert.equal(calls, 2);
});
