import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoFromRemoteUrl } from '../src/repo.js';

test('parses scp-style git@ github remotes', () => {
  assert.equal(repoFromRemoteUrl('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(repoFromRemoteUrl('git@github.com:acme/app'), 'acme/app');
});

test('parses https github remotes with and without .git', () => {
  assert.equal(repoFromRemoteUrl('https://github.com/acme/app.git'), 'acme/app');
  assert.equal(repoFromRemoteUrl('https://github.com/acme/app'), 'acme/app');
});

test('parses ssh:// github remotes', () => {
  assert.equal(repoFromRemoteUrl('ssh://git@github.com/o/r.git'), 'o/r');
});

test('returns null for empty or non-github remotes', () => {
  assert.equal(repoFromRemoteUrl(''), null);
  assert.equal(repoFromRemoteUrl(null), null);
  assert.equal(repoFromRemoteUrl('https://gitlab.com/o/r.git'), null);
});
