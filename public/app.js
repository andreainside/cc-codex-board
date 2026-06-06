// Browser entry: polls /api/windows, renders via the pure render.js module,
// and handles view toggles + the summarize/restore action buttons.
import { renderBoard, usageHint } from './render.js';

const POLL_MS = 5000;
const boardEl = document.getElementById('board');
const updatedEl = document.getElementById('updated');
const modeHintEl = document.getElementById('mode-hint');
const archiveBtn = document.getElementById('archive-btn');
const backBtn = document.getElementById('back-btn');
const focusBtn = document.getElementById('focus-btn');
const groupingBtns = [...document.querySelectorAll('[data-grouping]')];

let lastBoard = null;
let lastOk = null;
let lastError = null;
let view = 'main';
let grouping = localStorage.getItem('ccb-grouping') === 'status' ? 'status' : 'repo';
let focus = localStorage.getItem('ccb-focus') === '1';

function syncControls() {
  for (const b of groupingBtns) {
    b.classList.toggle('active', b.dataset.grouping === grouping);
    b.hidden = view === 'archive';
  }
  if (focusBtn) { focusBtn.classList.toggle('active', focus); focusBtn.hidden = view === 'archive'; }
  const n = (lastBoard && lastBoard.archive && lastBoard.archive.count) || 0;
  if (archiveBtn) { archiveBtn.textContent = `🗄 存档 (${n})`; archiveBtn.hidden = view === 'archive'; }
  if (backBtn) backBtn.hidden = view !== 'archive';
}

function render() {
  if (!lastBoard) return;
  boardEl.innerHTML = renderBoard(lastBoard, Date.now(), { view, grouping, focus });
  if (modeHintEl) modeHintEl.textContent = usageHint(lastBoard.meta);
  syncControls();
}

async function poll() {
  try {
    const res = await fetch('/api/windows', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastBoard = await res.json();
    render();
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

async function postAction(path, id) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function findWindow(id) {
  for (const l of [lastBoard.windows || [], (lastBoard.archive && lastBoard.archive.windows) || []]) {
    const w = l.find((x) => x.id === id);
    if (w) return w;
  }
  return null;
}

boardEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !lastBoard) return;
  const { id, action } = btn.dataset;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    if (action === 'summarize') {
      const r = await postAction('/api/summarize', id);
      const w = findWindow(id);
      if (w && r.headline) { w.headline = r.headline; w.summaryTitle = r.title; }
      render();
    } else if (action === 'restore') {
      await postAction('/api/restore', id);
      const arch = lastBoard.archive && lastBoard.archive.windows;
      if (arch) {
        const i = arch.findIndex((x) => x.id === id);
        if (i >= 0) {
          const [w] = arch.splice(i, 1);
          lastBoard.archive.count = arch.length;
          (lastBoard.windows = lastBoard.windows || []).push(w);
          // surface it in repo-grouped view immediately (next poll reconciles order)
          lastBoard.groups = lastBoard.groups || [];
          const key = w.repo || w.cwd || '(unknown)';
          let g = lastBoard.groups.find((gr) => gr.repo === key);
          if (!g) { g = { repo: key, windows: [] }; lastBoard.groups.push(g); }
          g.windows.push(w);
        }
      }
      view = 'main';
      render();
    }
  } catch {
    btn.textContent = '失败';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
  }
});

if (archiveBtn) archiveBtn.addEventListener('click', () => { view = 'archive'; render(); });
if (backBtn) backBtn.addEventListener('click', () => { view = 'main'; render(); });
if (focusBtn) focusBtn.addEventListener('click', () => { focus = !focus; localStorage.setItem('ccb-focus', focus ? '1' : '0'); render(); });
for (const b of groupingBtns) {
  b.addEventListener('click', () => {
    grouping = b.dataset.grouping;
    localStorage.setItem('ccb-grouping', grouping);
    render();
  });
}

poll();
setInterval(poll, POLL_MS);
setInterval(tickUpdated, 1000);
