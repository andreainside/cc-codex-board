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

test('tolerates a trailing slash on the remote URL', () => {
  assert.equal(repoFromRemoteUrl('https://github.com/acme/app.git/'), 'acme/app');
  assert.equal(repoFromRemoteUrl('https://github.com/acme/app/'), 'acme/app');
  assert.equal(repoFromRemoteUrl('git@github.com:acme/app.git/'), 'acme/app');
});

test('parses HTTPS remotes with embedded credentials (CI / PAT)', () => {
  assert.equal(repoFromRemoteUrl('https://x-access-token:ghp_abc@github.com/acme/app.git'), 'acme/app');
  assert.equal(repoFromRemoteUrl('https://user@github.com/acme/app.git'), 'acme/app');
});

test('parses github remotes that include a port', () => {
  assert.equal(repoFromRemoteUrl('ssh://git@github.com:22/o/r.git'), 'o/r');
  assert.equal(repoFromRemoteUrl('https://github.com:443/acme/app.git'), 'acme/app');
});
