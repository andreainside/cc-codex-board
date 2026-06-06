// Pure rendering for the board. Imported both by the browser (app.js) and by
// the Node test suite, so it must not touch the DOM or any browser globals.
// All display text comes from the API payload — never an AI summary.

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Compact running duration: "3h12m", "58m", "9h", "<1m". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** zh-CN relative time from a delta in ms: "刚刚", "3分钟前", "2小时前", "2天前". */
export function relativeTime(deltaMs) {
  if (!Number.isFinite(deltaMs)) return '';
  if (deltaMs < 60_000) return '刚刚';
  const min = Math.floor(deltaMs / 60_000);
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

const STATUS_META = {
  'needs-you': { label: '等你', color: '#d11' },
  running: { label: '跑着', color: '#06c' },
  'waiting-ci-review': { label: '等CI/复评', color: '#c80' },
  idle: { label: '空闲', color: '#999' },
};

export function statusMeta(status) {
  return STATUS_META[status] || { label: status || '?', color: '#999' };
}

/** Compact token count: "950", "34.5K", "1.2M". */
export function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** Top-bar mode/usage hint from board.meta. Honest "0 次" until a call happens. */
export function usageHint(meta) {
  const u = (meta && meta.llmUsage) || { calls: 0 };
  if (!u.calls) {
    return meta && meta.summaryEnabled
      ? '本地只读 · AI 标题:Haiku(走订阅)· 0 次调用'
      : '本地只读 · 0 次 LLM 调用';
  }
  const tok = formatTokens((u.inputTokens || 0) + (u.outputTokens || 0));
  const cost = u.costUsd ? ` · $${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}` : '';
  return `本地只读 · ${u.calls} 次调用 · ${tok} tok${cost}`;
}

function toolBadge(tool, label, entrypoint) {
  let text = tool;
  if (tool === 'CC') {
    if (entrypoint === 'cli') text = 'CC 终端';
    else if (entrypoint === 'claude-desktop') text = 'CC 桌面';
    else text = 'CC';
  } else if (tool === 'Codex-local') text = 'Codex 本地';
  else if (tool === 'Codex-cloud') text = 'Codex 云';
  if (label) text += ` · ${label}`;
  const cls = tool && tool.startsWith('Codex') ? 'badge badge-codex' : 'badge badge-cc';
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function clock(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const CI_ICON = { pass: '✅', fail: '❌', pending: '⏳', none: '—' };
const REVIEW_ICON = { approved: '✅', changes: '🔁', pending: '⏳', none: '—' };
const CODEX_ICON = { done: '✅', pending: '⏳', none: '—' };

function safeHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

function prRow(pr) {
  if (!pr || pr.number == null) return '';
  const parts = [];
  const url = safeHttpUrl(pr.url); // only http(s) — never javascript:/data:
  const num = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">PR #${pr.number}</a>`
    : `PR #${pr.number}`;
  parts.push(num);
  parts.push(`<span>CI ${CI_ICON[pr.ciStatus] || '—'}</span>`);
  if (pr.reviewStatus && pr.reviewStatus !== 'none') parts.push(`<span>评审 ${REVIEW_ICON[pr.reviewStatus] || '—'}</span>`);
  if (pr.codexReview && pr.codexReview !== 'none') parts.push(`<span>Codex ${CODEX_ICON[pr.codexReview] || '—'}</span>`);
  return `<div class="pr-row">${parts.join(' ')}</div>`;
}

function locationLine(w) {
  const bits = [];
  if (w.branch && w.branch !== 'HEAD') bits.push(escapeHtml(w.branch));
  else if (w.tool && w.tool.startsWith('Codex')) bits.push('~/.codex');
  if (w.pid != null) bits.push(`pid ${w.pid}`);
  return bits.join(' · ');
}

function renderCard(w, now, opts = {}) {
  const meta = statusMeta(w.status);
  const dur = formatDuration((now ?? Date.now()) - (w.startedAt ?? now));
  const last = w.lastActivityAt ? relativeTime((now ?? Date.now()) - w.lastActivityAt) : '';
  const timeline = `🕐 开始 ${clock(w.startedAt)} · 运行 ${dur}${last ? ` · 活动 ${last}` : ''}`;

  const idleLine = opts.archive && w.lastActivityAt
    ? `<div class="idle-age">已空闲 ${formatDuration((now ?? Date.now()) - w.lastActivityAt)}</div>`
    : '';
  const sumBtn = `<button class="act" data-id="${escapeHtml(w.id)}" data-action="summarize">✨ 总结</button>`;
  const restoreBtn = opts.archive
    ? `<button class="act" data-id="${escapeHtml(w.id)}" data-action="restore">↩ 恢复</button>`
    : '';

  const notes = opts.notes || {};
  const session = escapeHtml(w.sessionId || '');
  const noteText = (w.sessionId && notes[w.sessionId]) || '';
  const noteHtml = noteText
    ? `<div class="note" data-session="${session}"><span class="note-text">📝 ${escapeHtml(noteText)}</span><button class="note-edit" data-action="note" data-session="${session}">✎</button></div>`
    : `<div class="note empty" data-session="${session}"><button class="note-add" data-action="note" data-session="${session}">📝 备注…</button></div>`;

  // 1) headline — "what it's doing" (AI summary / PR title / branch / window title / opening prompt)
  const headline = (w.headline && w.headline.text) || w.title || '(尚无提问)';
  const isWinHeadline = w.headline && w.headline.source === 'windowtitle';
  // 2) subtitle — the opening prompt, only when it isn't already the headline
  const subtitle = w.subtitle ? `<div class="subtitle">开场:${escapeHtml(w.subtitle)}</div>` : '';
  // 3) window-match line — the title shown on the user's screen (match card↔window).
  //    Skipped when the window title is already the headline (would duplicate).
  const winLine = w.windowTitle && !isWinHeadline ? `<div class="winmatch">🖥 ${escapeHtml(w.windowTitle)}</div>` : '';
  // last message — literal latest turn, with who said it
  const lm = w.lastMessage || (w.currentActivity ? { role: 'user', text: w.currentActivity } : null);
  const lastMsg = lm && lm.text
    ? `<div class="last">上一条消息 · ${lm.role === 'assistant' ? 'AI' : '你'}:"${escapeHtml(lm.text)}"</div>`
    : '';

  return `
    <div class="card status-${escapeHtml(w.status)}" data-id="${escapeHtml(w.id)}" style="border-left-color:${meta.color}">
      <div class="card-top">
        ${toolBadge(w.tool, w.label, w.entrypoint)}
        <span class="status" style="color:${meta.color}">● ${escapeHtml(meta.label)}</span>
      </div>
      <div class="title">${isWinHeadline ? '🖥 ' : ''}${escapeHtml(headline)}</div>
      ${noteHtml}
      ${subtitle}
      ${winLine}
      <div class="loc">${locationLine(w)}</div>
      ${lastMsg}
      ${prRow(w.pr)}
      <div class="timeline">${escapeHtml(timeline)}</div>
      ${idleLine}
      <div class="actions">${sumBtn}${restoreBtn}</div>
    </div>`;
}

function summaryBar(summary) {
  const c = summary.counts || {};
  const seg = (key) => `<span class="seg" style="color:${statusMeta(key).color}">● ${c[key] || 0} ${statusMeta(key).label}</span>`;
  return `
    <div class="summary">
      <strong>${summary.total || 0} 个窗口</strong>
      ${seg('needs-you')}${seg('running')}${seg('waiting-ci-review')}${seg('idle')}
    </div>`;
}

/** Short, readable folder label from a cwd: last 1–2 path segments. */
export function folderLabel(cwd) {
  if (!cwd) return '(unknown)';
  const segs = String(cwd).split('/').filter(Boolean);
  return segs.slice(-2).join('/') || String(cwd);
}

// Sub-group a repo's windows by cwd. ≤1 distinct cwd → flat grid; otherwise
// one 📁 sub-section per folder, in window order (already status-sorted).
function groupByFolder(windows, now, cardOpts) {
  const byCwd = new Map();
  for (const w of windows) {
    const key = w.cwd || '(unknown)';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(w);
  }
  if (byCwd.size <= 1) {
    return `<div class="grid">${windows.map((w) => renderCard(w, now, cardOpts)).join('')}</div>`;
  }
  return [...byCwd.entries()]
    .map(
      ([cwd, ws]) => `
      <div class="subgroup">
        <h3 class="folder">📁 ${escapeHtml(folderLabel(cwd))}</h3>
        <div class="grid">${ws.map((w) => renderCard(w, now, cardOpts)).join('')}</div>
      </div>`,
    )
    .join('');
}

function groupByStatus(windows, now, cardOpts = {}, focus = false) {
  const order = ['needs-you', 'running', 'waiting-ci-review', 'idle'];
  const shown = (status) => !focus || status === 'needs-you' || status === 'running';
  return order
    .map((status) => {
      const ws = (windows || []).filter((w) => w.status === status);
      const m = statusMeta(status);
      // Focus mode keeps the real count but collapses the cards of hidden statuses.
      const collapsed = focus && !shown(status) && ws.length > 0;
      const head = `<h2 class="repo${collapsed ? ' collapsed' : ''}" style="color:${m.color}">● ${escapeHtml(m.label)} (${ws.length})${collapsed ? ' · 已收起' : ''}</h2>`;
      const grid = ws.length && shown(status) ? `<div class="grid">${ws.map((w) => renderCard(w, now, cardOpts)).join('')}</div>` : '';
      return `<section class="group">${head}${grid}</section>`;
    })
    .join('');
}

/**
 * Render the whole board to an HTML string.
 * @param {object} board the /api/windows payload
 * @param {number} [now]
 * @param {{view?:string, grouping?:string, focus?:boolean}} [opts]
 */
export function renderBoard(board, now, opts = {}) {
  if (!board || (!board.summary && !board.archive)) return '<div class="empty">没有数据</div>';
  const t = now ?? board.generatedAt ?? Date.now();
  const view = opts.view || 'main';
  const grouping = opts.grouping || 'repo';
  const focus = !!opts.focus; // when on: only needs-you + running

  const cardOpts = { notes: opts.notes || {} };

  if (view === 'archive') {
    const ws = (board.archive && board.archive.windows) || [];
    if (!ws.length) return '<div class="empty">存档为空</div>';
    return `<section class="group"><div class="grid">${ws.map((w) => renderCard(w, t, { archive: true, notes: opts.notes || {} })).join('')}</div></section>`;
  }

  const keep = (w) => !focus || w.status === 'needs-you' || w.status === 'running';
  const bar = board.summary ? summaryBar(board.summary) : '';
  let body;
  if (grouping === 'status') {
    body = groupByStatus(board.windows || [], t, cardOpts, focus);
  } else {
    body = (board.groups || [])
      .map((g) => ({ repo: g.repo, windows: (g.windows || []).filter(keep) }))
      .filter((g) => g.windows.length)
      .map(
        (g) => `
      <section class="group">
        <h2 class="repo">${escapeHtml(g.repo)}</h2>
        ${groupByFolder(g.windows, t, cardOpts)}
      </section>`,
      )
      .join('');
  }
  const visible = (board.windows || []).filter(keep).length;
  let empty = '';
  if (board.summary && (board.summary.total || 0) === 0) empty = '<div class="empty">没有检测到活跃的 CC / Codex 窗口</div>';
  else if (focus && visible === 0) empty = '<div class="empty">专注模式:当前没有「等你 / 跑着」的窗口</div>';
  return bar + body + empty;
}
