// Browser entry: polls /api/windows and re-renders. No business logic here —
// rendering lives in the pure, tested render.js module.

import { renderBoard } from './render.js';

const POLL_MS = 5000;
const boardEl = document.getElementById('board');
const updatedEl = document.getElementById('updated');
const modeHintEl = document.getElementById('mode-hint');

let lastOk = null; // ms timestamp of last successful fetch
let lastError = null;

async function poll() {
  try {
    const res = await fetch('/api/windows', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const board = await res.json();
    boardEl.innerHTML = renderBoard(board, Date.now());
    if (modeHintEl) {
      modeHintEl.textContent = board.meta && board.meta.summaryEnabled
        ? '本地只读 · AI 标题:Haiku(走订阅)'
        : '本地只读 · 0 次 LLM 调用';
    }
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

poll();
setInterval(poll, POLL_MS);
setInterval(tickUpdated, 1000);
