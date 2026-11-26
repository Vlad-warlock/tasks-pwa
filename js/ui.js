import {
  STATUS_COLUMNS,
  SPHERES,
  escapeHtml,
  linkifyNotes,
  getTodayLocal,
  isTaskOverdue,
  formatDeadlineLabel,
  sortColumnTasks
} from './utils.js';
import { hasValidConfig } from './api.js';

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

function matchesSearch(task, query) {
  if (!query) return true;
  const q = query.toLowerCase();
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
        <div class="skeleton-card"></div>
      </div>
    </section>`;
}

function renderEmptyColumn(status, state) {
  if (!hasValidConfig(state.config)) {
    return `<div class="empty-state"><p>Таблицю ще не підключено.</p><button type="button" class="btn btn-secondary" data-action="open-settings">Відкрити налаштування</button></div>`;
  }
  if (state.searchQuery || state.quickFilter !== 'all') {
    return `<div class="empty-state"><p>За поточним фільтром тут порожньо.</p><button type="button" class="btn btn-ghost" data-action="reset-filters">Скинути фільтри</button></div>`;
  }
  const text = status === 'Готово'
    ? 'Виконаних задач у цій вибірці ще немає.'
    : `У колонці «${escapeHtml(status)}» зараз порожньо.`;
  return `<div class="empty-state"><p>${text}</p></div>`;
}

function renderTaskCard(task, nowInfo) {
  const overdue = isTaskOverdue(task, nowInfo);
  const isToday = !task.done && !overdue && task.deadline === nowInfo.date;
  const dlLabel = formatDeadlineLabel(task.deadline, task.time, nowInfo.date);
  const dlHtml = dlLabel
    ? `<span class="badge badge-deadline${overdue ? ' is-overdue' : isToday ? ' is-today' : ''}">${escapeHtml(dlLabel)}</span>`
    : '';
  const opts = STATUS_COLUMNS.map(
    (st) => `<option value="${escapeHtml(st)}"${st === task.status ? ' selected' : ''}>${escapeHtml(st)}</option>`
  ).join('');
  const calCtrl = task.inCalendar
    ? `<span class="cal-synced" title="Додано в Google Календар"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>Календар</span>`
    : `<button type="button" class="cal-btn" data-action="sync-cal" data-row="${task.row}" title="Додати в Google Календар">+ Календар</button>`;

  const notesHtml = task.notes ? `<p class="task-notes">${linkifyNotes(task.notes)}</p>` : '';

  return `
    <article class="task-card${task.done ? ' is-done' : ''}${overdue ? ' is-overdue-card' : ''}" draggable="true" data-row="${task.row}" data-priority="${escapeHtml(task.priority)}">
      <button type="button" class="task-check" data-action="toggle-done" data-row="${task.row}" aria-label="Перемкнути виконання">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>
      </button>
      <div class="task-main">
        <div class="task-title-row"><h3 class="task-title">${escapeHtml(task.task)}</h3></div>
        ${notesHtml}
        <div class="task-meta">
          <span class="badge badge-sphere" data-sphere="${escapeHtml(task.sphere)}">${escapeHtml(task.sphere)}</span>
          ${dlHtml}
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

  for (const sp of SPHERES) {
    const count = state.tasks.filter((t) => !t.done && (sp === 'Усі' || t.sphere === sp)).length;
    const badge = document.querySelector(`[data-sphere-count="${sp}"]`);
    if (badge) badge.textContent = String(count);
  }

  document.querySelectorAll('#sphereBar .chip').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.sphere === state.activeSphere);
  });

  const bySphere = state.activeSphere === 'Усі'
    ? state.tasks
    : state.tasks.filter((t) => t.sphere === state.activeSphere);

  const active = bySphere.filter((t) => !t.done);
  const todayCount = active.filter((t) => t.deadline === nowInfo.date).length;
  const overdueCount = active.filter((t) => isTaskOverdue(t, nowInfo)).length;

  $('statActive').textContent = String(active.length);
  $('statToday').textContent = String(todayCount);
  $('statOverdue').textContent = String(overdueCount);

  $('statActivePill').classList.toggle('is-filter-active', state.quickFilter === 'all' && false);
  $('statTodayPill').classList.toggle('is-filter-active', state.quickFilter === 'today');
  $('statOverduePill').classList.toggle('has-overdue', overdueCount > 0);
  $('statOverduePill').classList.toggle('is-filter-active', state.quickFilter === 'overdue');

  const clearBtn = $('btnClearSearch');
  if (clearBtn) clearBtn.hidden = !state.searchQuery;

  const filtered = bySphere.filter((t) => {
    if (state.quickFilter === 'today' && (t.done || t.deadline !== nowInfo.date)) return false;
    if (state.quickFilter === 'overdue' && !isTaskOverdue(t, nowInfo)) return false;
    return matchesSearch(t, state.searchQuery);
  });

  document.querySelectorAll('#statusTabs .status-tab').forEach((tab) => {
    const st = tab.dataset.status;
    tab.classList.toggle('is-active', st === state.activeStatus);
    const countEl = tab.querySelector('[data-status-count]');
    if (countEl) countEl.textContent = String(filtered.filter((t) => t.status === st).length);
  });

  updatePendingBadge(state.pendingQueue.length);

  if (state.isInitialLoading && state.tasks.length === 0) {
    $('board').innerHTML = STATUS_COLUMNS.map((st) => renderSkeletonColumn(st, st === state.activeStatus)).join('');
    return;
  }

  $('board').innerHTML = STATUS_COLUMNS.map((status) => {
    const colTasks = sortColumnTasks(filtered.filter((t) => t.status === status), status);
    const cardsHtml = colTasks.length
      ? `<div class="task-list">${colTasks.map((t) => renderTaskCard(t, nowInfo)).join('')}</div>`
      : renderEmptyColumn(status, state);
    return `
      <section class="column${status === state.activeStatus ? ' is-active' : ''}" data-column="${escapeHtml(status)}" data-drop-status="${escapeHtml(status)}">
        <div class="column-head">
          <h2 class="column-title"><span class="col-dot" data-col-dot="${escapeHtml(status)}"></span>${escapeHtml(status)}</h2>
          <span class="tab-badge">${colTasks.length}</span>
        </div>
        ${cardsHtml}
      </section>`;
  }).join('');
}
