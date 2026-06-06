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
