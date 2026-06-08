import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunners } from '../src/runner.js';

// Build an exec stub: matchers is a list of [predicate(file,args), output].
function execStub(matchers, log) {
  return (file, args) => {
    if (log) log.push([file, ...args]);
    for (const [pred, out] of matchers) {
      if (pred(file, args)) return typeof out === 'function' ? out(file, args) : out;
    }
    throw new Error(`no stub for ${file} ${args.join(' ')}`);
  };
}

test('resolveRepoBranch reads branch + remote and maps to owner/name', async () => {
  const exec = execStub([
    [(f, a) => a.includes('branch'), 'feature/x\n'],
    [(f, a) => a.includes('remote'), 'git@github.com:acme/app.git\n'],
  ]);
  const { resolveRepoBranch } = createRunners({ exec });
  assert.deepEqual(await resolveRepoBranch('/work/app'), { repo: 'acme/app', branch: 'feature/x' });
});

test('resolveRepoBranch returns nulls when cwd is not a git repo', async () => {
  const exec = execStub([[() => true, () => { throw new Error('not a git repository'); }]]);
  const { resolveRepoBranch } = createRunners({ exec });
  assert.deepEqual(await resolveRepoBranch('/tmp'), { repo: null, branch: null });
});

test('fetchPr uses the latest PR number from the transcript and parses status', async () => {
  const log = [];
  const exec = execStub(
    [[(f, a) => f === 'gh' && a[0] === 'pr' && a[1] === 'view', JSON.stringify({
      number: 42, state: 'OPEN', url: 'u42',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }],
      reviews: [], latestReviews: [], reviewRequests: [],
    })]],
    log,
  );
  const { fetchPr } = createRunners({ exec });
  const pr = await fetchPr('acme/app', { branch: 'feature/x', prNumbers: [41, 42] });
  assert.equal(pr.number, 42);
  assert.equal(pr.ciStatus, 'pending');
  assert.ok(log.some((c) => c.includes('42')), 'queried PR 42 (the latest)');
});

test('fetchPr falls back to PR for the current branch when transcript has none', async () => {
  const exec = execStub([
    [(f, a) => a[1] === 'list', JSON.stringify([{ number: 7 }])],
    [(f, a) => a[1] === 'view', JSON.stringify({ number: 7, state: 'OPEN', url: 'u7', statusCheckRollup: [], reviews: [], latestReviews: [], reviewRequests: [] })],
  ]);
  const { fetchPr } = createRunners({ exec });
  const pr = await fetchPr('acme/app', { branch: 'feature/x', prNumbers: [] });
  assert.equal(pr.number, 7);
});

test('fetchPr returns null when no PR can be resolved', async () => {
  const exec = execStub([[(f, a) => a[1] === 'list', '[]']]);
  const { fetchPr } = createRunners({ exec });
  assert.equal(await fetchPr('acme/app', { branch: 'HEAD', prNumbers: [] }), null);
});

test('resolveTerminalTitles maps pid -> terminal tab title via ps + osascript', async () => {
  const exec = execStub([
    [(f, a) => f === 'ps', ' 79437 ttys073\n 31786 ttys003\n'],
    [(f, a) => f === 'osascript' && /is running/.test(a[1]) && /Terminal/.test(a[1]), 'true\n'],
    [(f, a) => f === 'osascript' && /is running/.test(a[1]) && /iTerm2/.test(a[1]), 'false\n'],
    [(f, a) => f === 'osascript' && /tabs of w/.test(a[1]), '/dev/ttys073\t⠐ Implement board\n/dev/ttys003\t✳ Add dedup test\n'],
  ]);
  const { resolveTerminalTitles } = createRunners({ exec, platform: 'darwin' });
  const titles = await resolveTerminalTitles([79437, 31786]);
  assert.equal(titles.get(79437), 'Implement board'); // spinner glyph stripped
  assert.equal(titles.get(31786), 'Add dedup test');
});

test('resolveTerminalTitles is a no-op off macOS', async () => {
  const { resolveTerminalTitles } = createRunners({ exec: () => { throw new Error('should not run'); }, platform: 'linux' });
  const titles = await resolveTerminalTitles([1, 2]);
  assert.equal(titles.size, 0);
});
