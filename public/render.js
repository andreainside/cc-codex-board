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

function renderCard(w, now) {
  const meta = statusMeta(w.status);
  const dur = formatDuration((now ?? Date.now()) - (w.startedAt ?? now));
  const last = w.lastActivityAt ? relativeTime((now ?? Date.now()) - w.lastActivityAt) : '';
  const timeline = `🕐 开始 ${clock(w.startedAt)} · 运行 ${dur}${last ? ` · 活动 ${last}` : ''}`;

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
      ${subtitle}
      ${winLine}
      <div class="loc">${locationLine(w)}</div>
      ${lastMsg}
      ${prRow(w.pr)}
      <div class="timeline">${escapeHtml(timeline)}</div>
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

/**
 * Render the whole board to an HTML string.
 * @param {object} board the /api/windows payload
 * @param {number} [now]
 */
export function renderBoard(board, now) {
  if (!board || !board.summary) return '<div class="empty">没有数据</div>';
  const t = now ?? board.generatedAt ?? Date.now();
  const groups = (board.groups || [])
    .map(
      (g) => `
      <section class="group">
        <h2 class="repo">${escapeHtml(g.repo)}</h2>
        <div class="grid">${g.windows.map((w) => renderCard(w, t)).join('')}</div>
      </section>`,
    )
    .join('');
  const empty = (board.summary.total || 0) === 0 ? '<div class="empty">没有检测到活跃的 CC / Codex 窗口</div>' : '';
  return summaryBar(board.summary) + groups + empty;
}
