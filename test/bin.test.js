import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cc-codex-board.js');

function run(args) {
  return new Promise((resolve) => {
    execFile('node', [BIN, ...args], { encoding: 'utf8', timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr });
    });
  });
}

test('the bin parses and --help prints usage and exits 0', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Usage: cc-codex-board/);
  assert.match(r.stdout, /--summary/);
});

test('an out-of-range --port exits 1 with a friendly message, not a RangeError stack', async () => {
  const r = await run(['--port', '70000']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Invalid port/);
  assert.doesNotMatch(r.stderr, /RangeError|ERR_SOCKET_BAD_PORT/); // no uncaught stack trace
});

test('a non-numeric --port is rejected the same friendly way', async () => {
  const r = await run(['--port', 'abc']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Invalid port/);
  assert.doesNotMatch(r.stderr, /RangeError|ERR_SOCKET_BAD_PORT/);
});
