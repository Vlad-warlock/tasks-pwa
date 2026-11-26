import {
  STATUS_COLUMNS,
  SPHERES,
  escapeHtml,
  safeSheetUrl,
  renderRichText,
  getTodayLocal,
  isTaskOverdue,
  getDeadlineInfo,
  sortColumnTasks
} from './utils.js';
import { parseTaskMeta, formatRepeatBadge } from './notes-meta.js';
import { hasValidConfig } from './api.js';
import { renderCalendarView, renderDashboardView } from './views.js';

const $ = (id) => document.getElementById(id);

export function setSyncIndicator(mode, title) {
  const dot = $('syncDot');
  if (!dot) return;
  dot.className = 'sync-dot' + (mode ? ` is-${mode}` : '');
  if (title) dot.title = title;
  $('btnRefresh')?.classList.toggle('is-spinning', mode === 'syncing');
}

export function updateLastSyncText(lastSyncAt) {
  const el = $('lastSyncLabel');
  if (!el) return;
  if (!lastSyncAt) {
    el.textContent = 'Не синхронізовано';
    return;
  }
  const dt = new Date(lastSyncAt);
  el.textContent = `Оновлено о ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

export function updatePendingBadge(count) {
  const badge = $('pendingBadge');
  if (!badge) return;
  badge.hidden = count === 0;
  badge.textContent = `У черзі: ${count}`;
}

export function showToast(message, kind = '', actionOpts = null) {
  const stack = $('toastStack');
  if (!stack) return;
  const item = document.createElement('div');
  item.className = 'toast' + (kind ? ` is-${kind}` : '') + (actionOpts ? ' has-action' : '');

  const textSpan = document.createElement('span');
  textSpan.className = 'toast-text';
  textSpan.textContent = message;
  item.appendChild(textSpan);

  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    item.remove();
  };

  if (actionOpts && actionOpts.label && typeof actionOpts.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = actionOpts.label;
    btn.addEventListener('click', () => {
      dismiss();
      actionOpts.onClick();
    });
    item.appendChild(btn);
  }

  stack.appendChild(item);
  timer = setTimeout(dismiss, actionOpts ? 4200 : 3200);
}

export function openModal(id) {
  const el = $(id);
  if (!el) return;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-open'));
}

export function closeModal(id, onAfterClose) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('is-open');
  el.hidden = true;
  if (onAfterClose) onAfterClose();
}

function matchesSearchAndFilters(task, meta, state, nowInfo) {
  if (state.activePriority !== 'Усі' && task.priority !== state.activePriority) return false;
  if (state.activeTag) {
    const hasTag = meta.tags.some((t) => t.toLowerCase() === state.activeTag.toLowerCase());
    if (!hasTag) return false;
  }
  if (state.quickFilter === 'today' && (task.done || task.deadline !== nowInfo.date)) return false;
  if (state.quickFilter === 'overdue' && !isTaskOverdue(task, nowInfo)) return false;

  if (!state.searchQuery) return true;
  const q = state.searchQuery.toLowerCase();
  return (
    String(task.task || '').toLowerCase().includes(q) ||
    String(task.notes || '').toLowerCase().includes(q) ||
    String(task.sphere || '').toLowerCase().includes(q) ||
    String(task.priority || '').toLowerCase().includes(q)
  );
}

function renderSkeletonColumn(status, isActive) {
  return `
    <section class="column${isActive ? ' is-active' : ''}" data-column="${escapeHtml(status)}">
      <div class="column-head">
        <h2 class="column-title"><span class="col-dot" data-col-dot="${escapeHtml(status)}"></span>${escapeHtml(status)}</h2>
        <span class="tab-badge">—</span>
      </div>
      <div class="task-list">
        <div class="skeleton-card"></div>
        <div class="skeleton-card is-short"></div>
      </div>
    </section>`;
}

function renderEmptyColumn(status, state) {
  if (!hasValidConfig(state.config)) {
    return `<div class="empty-state"><p>Таблицю ще не підключено.</p><button type="button" class="btn btn-secondary" data-action="open-settings">Підключити</button></div>`;
  }
  if (state.searchQuery || state.quickFilter !== 'all' || state.activePriority !== 'Усі' || state.activeTag) {
    return `<div class="empty-state"><p>За фільтром задач немає.</p><button type="button" class="btn btn-ghost" data-action="reset-filters">Скинути фільтри</button></div>`;
  }
  const text = status === 'Готово' ? 'Виконаних задач ще немає.' : 'Карток поки немає.';
  return `<div class="empty-state is-compact"><p>${text}</p></div>`;
}

function renderInlineAddComposer(status) {
  if (status === 'Готово') return '';
  return `
    <form class="inline-add-form" data-inline-status="${escapeHtml(status)}">
      <input type="text" class="inline-add-input" name="quickTitle" placeholder="+ Додати картку..." autocomplete="off" aria-label="Швидко додати картку у ${escapeHtml(status)}">
      <button type="submit" class="inline-add-btn">Додати</button>
    </form>`;
}

function renderTaskCard(task, meta, nowInfo) {
  const dl = getDeadlineInfo(task, nowInfo);
  const dlCls = dl.overdue ? ' is-overdue' : dl.urgent ? ' is-urgent' : dl.isToday ? ' is-today' : '';
  const dlHtml = dl.label
    ? `<span class="badge badge-deadline${dlCls}">${escapeHtml(dl.label)}${dl.countdown ? ` · ${escapeHtml(dl.countdown)}` : ''}</span>`
    : '';

  const repText = formatRepeatBadge(meta.repeat);
  const repHtml = repText ? `<span class="badge badge-repeat" title="Повторювана задача">↻ ${escapeHtml(repText)}</span>` : '';

  const totalChecks = meta.checklist.length;
  const doneChecks = meta.checklist.filter((c) => c.done).length;
  const checklistHtml = totalChecks > 0
    ? `
      <div class="card-checklist-bar${doneChecks === totalChecks ? ' is-complete' : ''}">
        <span class="cl-count">✓ ${doneChecks}/${totalChecks}</span>
        <progress class="cl-progress" value="${doneChecks}" max="${totalChecks}"></progress>
      </div>`
    : '';

  // Окремі теги (які не були прямо в реченні cleanNotes) + кнопка 1-клік копії для числових #кодів
  const inlineSet = new Set((meta.cleanNotes.match(/#[a-zA-Zа-яА-ЯіїєґІЇЄҐ0-9_-]{1,28}/g) || []).map((x) => x.toLowerCase()));
  const standaloneTags = meta.tags.filter((t) => !inlineSet.has(t.toLowerCase()));
  const tagsHtml = standaloneTags.map((tag) => {
    const isCode = /^#\d+$/.test(tag);
    const copyBtn = isCode
      ? `<button type="button" class="tag-copy-btn" data-action="copy-code" data-code="${escapeHtml(tag.slice(1))}" title="Скопіювати код ${escapeHtml(tag.slice(1))}">⧉</button>`
      : '';
    return `<span class="tag-chip-wrap"><button type="button" class="tag-chip" data-action="tag-click" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>${copyBtn}</span>`;
  }).join('');

  const opts = STATUS_COLUMNS.map(
    (st) => `<option value="${escapeHtml(st)}"${st === task.status ? ' selected' : ''}>${escapeHtml(st)}</option>`
  ).join('');
  const calCtrl = task.inCalendar
    ? `<span class="cal-synced" title="Додано в Google Календар"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>Календар</span>`
    : `<button type="button" class="cal-btn" data-action="sync-cal" data-row="${task.row}" title="Додати в Google Календар">+ Календар</button>`;

  const notesHtml = meta.cleanNotes ? `<p class="task-notes">${renderRichText(meta.cleanNotes)}</p>` : '';
  const cardStateCls = [
    task.done ? ' is-done' : '',
    dl.overdue ? ' is-overdue-card' : dl.urgent ? ' is-urgent-card' : '',
    meta.pinned && !task.done ? ' is-pinned' : ''
  ].join('');

  return `
    <article class="task-card${cardStateCls}" draggable="true" data-row="${task.row}" data-priority="${escapeHtml(task.priority)}">
      <button type="button" class="task-check" data-action="toggle-done" data-row="${task.row}" aria-label="Перемкнути виконання">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>
      </button>
      <div class="task-main">
        <div class="task-title-row">
          <h3 class="task-title">${escapeHtml(task.task)}</h3>
          ${!task.done ? `<button type="button" class="pin-btn${meta.pinned ? ' is-active' : ''}" data-action="toggle-pin" data-row="${task.row}" title="${meta.pinned ? 'Відкріпити згори' : 'Закріпити згори колонки'}" aria-label="Закріпити">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="${meta.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6"><path d="M9.8 2.2l4 4-1.6 1.6-.9-.9-2.5 2.5.4 2.6-1.2 1.2L5.2 10.4 2.2 13.4l-.6-.6 3-3L1.8 7l1.2-1.2 2.6.4 2.5-2.5-.9-.9 1.6-1.6z"/></svg>
          </button>` : ''}
        </div>
        ${notesHtml}
        ${checklistHtml}
        ${tagsHtml ? `<div class="card-tags-row">${tagsHtml}</div>` : ''}
        <div class="task-meta">
          <span class="badge badge-sphere" data-sphere="${escapeHtml(task.sphere)}">${escapeHtml(task.sphere)}</span>
          ${dlHtml}
          ${repHtml}
          <div class="card-actions-inline">
            ${calCtrl}
            <label class="status-quick" title="Змінити статус">
              <span class="status-quick-label">${escapeHtml(task.status)}<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg></span>
              <select data-action="quick-status" data-row="${task.row}" aria-label="Статус задачі">${opts}</select>
            </label>
          </div>
        </div>
      </div>
    </article>`;
}

export function renderAll(state) {
  const nowInfo = getTodayLocal();
  const metaMap = new Map();
  for (const t of state.tasks) metaMap.set(t.row, parseTaskMeta(t.notes));

  for (const sp of SPHERES) {
    const count = state.tasks.filter((t) => !t.done && (sp === 'Усі' || t.sphere === sp)).length;
    const badge = document.querySelector(`[data-sphere-count="${sp}"]`);
    if (badge) badge.textContent = String(count);
  }

  document.querySelectorAll('#sphereBar .chip').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.sphere === state.activeSphere);
  });

  document.querySelectorAll('#viewSwitcher .view-tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === state.activeView);
  });

  const sheetHref = safeSheetUrl(state.config.sheetUrl);
  const sheetBtn = $('btnOpenSheet');
  if (sheetBtn) {
    sheetBtn.hidden = !sheetHref;
    if (sheetHref) sheetBtn.href = sheetHref;
  }

  const fxBtn = $('btnFxMode');
  if (fxBtn) {
    fxBtn.textContent = state.prefs.fx3d ? 'FX 3D' : 'FX Eco';
    fxBtn.classList.toggle('is-active', Boolean(state.prefs.fx3d));
  }

  const tagFilterEl = $('activeTagChip');
  if (tagFilterEl) {
    tagFilterEl.hidden = !state.activeTag;
    if (state.activeTag) $('activeTagLabel').textContent = state.activeTag;
  }

  const bySphere = state.activeSphere === 'Усі'
    ? state.tasks
    : state.tasks.filter((t) => t.sphere === state.activeSphere);

  const active = bySphere.filter((t) => !t.done);
  const todayCount = active.filter((t) => t.deadline === nowInfo.date).length;
  const overdueCount = active.filter((t) => isTaskOverdue(t, nowInfo)).length;

  $('statActive').textContent = String(active.length);
  $('statToday').textContent = String(todayCount);
  $('statOverdue').textContent = String(overdueCount);

  $('statTodayPill').classList.toggle('is-filter-active', state.quickFilter === 'today');
  $('statOverduePill').classList.toggle('has-overdue', overdueCount > 0);
  $('statOverduePill').classList.toggle('is-filter-active', state.quickFilter === 'overdue');

  const clearBtn = $('btnClearSearch');
  if (clearBtn) clearBtn.hidden = !state.searchQuery;

  const filtered = bySphere.filter((t) => matchesSearchAndFilters(t, metaMap.get(t.row), state, nowInfo));

  // Мобільні вкладки статусу потрібні лише в режимі «Дошка»
  $('statusTabs').classList.toggle('is-view-hidden', state.activeView !== 'board');
  document.querySelectorAll('#statusTabs .status-tab').forEach((tab) => {
    const st = tab.dataset.status;
    tab.classList.toggle('is-active', st === state.activeStatus);
    const countEl = tab.querySelector('[data-status-count]');
    if (countEl) countEl.textContent = String(filtered.filter((t) => t.status === st).length);
  });

  updatePendingBadge(state.pendingQueue.length);

  const board = $('board');
  board.dataset.viewMode = state.activeView;

  if (state.activeView === 'calendar') {
    board.innerHTML = renderCalendarView(filtered, state, nowInfo);
    return;
  }
  if (state.activeView === 'dashboard') {
    board.innerHTML = renderDashboardView(state.tasks, state, nowInfo);
    return;
  }

  if (state.isInitialLoading && state.tasks.length === 0) {
    board.innerHTML = STATUS_COLUMNS.map((st) => renderSkeletonColumn(st, st === state.activeStatus)).join('');
    return;
  }

  board.innerHTML = STATUS_COLUMNS.map((status) => {
    const colTasks = sortColumnTasks(
      filtered.filter((t) => t.status === status),
      status,
      (t) => metaMap.get(t.row)?.pinned
    );
    const cardsHtml = colTasks.length
      ? `<div class="task-list">${colTasks.map((t) => renderTaskCard(t, metaMap.get(t.row), nowInfo)).join('')}</div>`
      : renderEmptyColumn(status, state);

    const headAction = status === 'Готово' && colTasks.length > 0
      ? `<button type="button" class="col-head-btn is-archive" data-action="archive-done" title="Перенести виконані в аркуш «Архів»">Архів (${colTasks.length})</button>`
      : status !== 'Готово'
        ? `<button type="button" class="col-head-btn" data-action="focus-inline-add" data-status="${escapeHtml(status)}" title="Швидко додати картку">+</button>`
        : '';

    return `
      <section class="column${status === state.activeStatus ? ' is-active' : ''}" data-column="${escapeHtml(status)}" data-drop-status="${escapeHtml(status)}">
        <div class="column-head">
          <h2 class="column-title">
            <span class="col-dot" data-col-dot="${escapeHtml(status)}"></span>
            <span>${escapeHtml(status)}</span>
            <span class="tab-badge">${colTasks.length}</span>
          </h2>
          ${headAction}
        </div>
        ${cardsHtml}
        ${renderInlineAddComposer(status)}
      </section>`;
  }).join('');
}
