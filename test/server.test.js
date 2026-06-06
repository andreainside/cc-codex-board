import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequestHandler } from '../src/server.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body, type: res.headers.get('content-type') };
}

test('GET /api/windows returns the board as JSON', async () => {
  const board = { generatedAt: 123, summary: { total: 1, counts: {} }, windows: [{ id: 'cc:1' }], groups: [] };
  const handler = createRequestHandler({ getBoard: async () => board });
  const { server, port } = await startServer(handler);
  try {
    const r = await get(port, '/api/windows');
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/json/);
    assert.deepEqual(JSON.parse(r.body), board);
  } finally {
    server.close();
  }
});

test('GET /api/windows returns 500 with JSON error when the board build throws', async () => {
  const handler = createRequestHandler({ getBoard: async () => { throw new Error('boom'); } });
  const { server, port } = await startServer(handler);
  try {
    const r = await get(port, '/api/windows');
    assert.equal(r.status, 500);
    assert.match(r.type, /application\/json/);
    assert.ok(JSON.parse(r.body).error);
  } finally {
    server.close();
  }
});

test('GET / serves the dashboard HTML', async () => {
  const handler = createRequestHandler({ getBoard: async () => ({}) });
  const { server, port } = await startServer(handler);
  try {
    const r = await get(port, '/');
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
    assert.match(r.body, /cc-codex-board|看板|<!doctype html>/i);
  } finally {
    server.close();
  }
});

test('path traversal outside public/ is rejected', async () => {
  const handler = createRequestHandler({ getBoard: async () => ({}) });
  const { server, port } = await startServer(handler);
  try {
    const r = await get(port, '/../../../../etc/passwd');
    assert.ok(r.status === 403 || r.status === 404, `expected 403/404 got ${r.status}`);
  } finally {
    server.close();
  }
});

test('a symlink inside public/ pointing outside is not served', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pub-'));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html>ok');
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'TOP SECRET');
  fs.symlinkSync(secret, path.join(pub, 'leak')); // escape via symlink

  const handler = createRequestHandler({ getBoard: async () => ({}), publicDir: pub });
  const { server, port } = await startServer(handler);
  try {
    const r = await get(port, '/leak');
    assert.ok(r.status === 403 || r.status === 404, `expected 403/404 got ${r.status}`);
    assert.ok(!r.body.includes('TOP SECRET'), 'secret content must not leak');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test('POST /api/summarize with oversized body returns 400 (no hang)', async () => {
  const handler = createRequestHandler({ getBoard: async () => ({}), summarizeWindow: async () => null });
  const { server, port } = await startServer(handler);
  try {
    const big = 'x'.repeat(100 * 1024); // > 64KB
    const res = await fetch(`http://127.0.0.1:${port}/api/summarize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: big }),
    });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});
