// Режими перегляду «Календар» та «Дашборд прогресу %» (відповідник вкладки «Канбан і Дашборд»)
import {
  STATUS_COLUMNS,
  MONTHS_FULL,
  MONTHS_SHORT,
  escapeHtml,
  isTaskOverdue,
  getDeadlineInfo
} from './utils.js';
import { WEEKDAYS } from './notes-meta.js';
import { createDefaultJournal } from './day-view.js';
import {
  renderJournalTrendCard,
  renderTagDonutCard,
  renderRecordsAndExtremesCard,
  renderMonthlySummaryCard
} from './analytics.js';

export function renderCalendarView(filteredTasks, state, nowInfo) {
  const year = state.calYear;
  const month = state.calMonth;
  const firstDay = new Date(year, month, 1);
  const startIsoWeekday = firstDay.getDay() === 0 ? 7 : firstDay.getDay(); // 1 (Пн) .. 7 (Нд)
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const byDate = new Map();
  const unscheduled = [];

  for (const t of filteredTasks) {
    if (!t.deadline) {
      if (!t.done) unscheduled.push(t);
      continue;
    }
    if (!byDate.has(t.deadline)) byDate.set(t.deadline, []);
    byDate.get(t.deadline).push(t);
  }

  const cells = [];
  for (let i = 1; i < startIsoWeekday; i++) {
    cells.push('<div class="cal-cell is-pad"></div>');
  }

  const pad = (n) => String(n).padStart(2, '0');
  const selectedDate = state.calSelectedDate || nowInfo.date;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
    const isToday = dateStr === nowInfo.date;
    const isSelected = dateStr === selectedDate;
    const dayTasks = (byDate.get(dateStr) || []).slice().sort((a, b) => Number(a.done) - Number(b.done));
    const shown = dayTasks.slice(0, 3);
    const restCount = dayTasks.length - shown.length;

    const dotsHtml = dayTasks.slice(0, 4).map((t) => {
      const overdue = isTaskOverdue(t, nowInfo);
      const cls = t.done ? ' is-done' : overdue ? ' is-overdue' : '';
      return `<span class="cal-dot${cls}" data-sphere="${escapeHtml(t.sphere)}"></span>`;
    }).join('');

    const itemsHtml = shown.map((t) => {
      const overdue = isTaskOverdue(t, nowInfo);
      const cls = t.done ? ' is-done' : overdue ? ' is-overdue' : '';
      return `
        <button type="button" class="cal-task-chip${cls}" data-action="open-task" data-row="${t.row}" data-sphere="${escapeHtml(t.sphere)}" title="${escapeHtml(t.task)}">
          ${t.time ? `<span class="cal-chip-time">${escapeHtml(t.time)}</span>` : ''}
          <span class="cal-chip-title">${escapeHtml(t.task)}</span>
        </button>`;
    }).join('');

    cells.push(`
      <div class="cal-cell${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}" data-action="cal-select-day" data-date="${dateStr}">
        <div class="cal-cell-head">
          <span class="cal-day-num">${d}</span>
          <button type="button" class="cal-add-day" data-action="add-on-date" data-date="${dateStr}" title="Додати задачу на ${dateStr}">+</button>
        </div>
        <div class="cal-dots" aria-hidden="true">${dotsHtml}</div>
        <div class="cal-cell-list">
          ${itemsHtml}
          ${restCount > 0 ? `<span class="cal-more">+${restCount} ще</span>` : ''}
        </div>
      </div>`);
  }

  const selParts = selectedDate.split('-').map(Number);
  const selTitle = selParts.length === 3
    ? `${selectedDate === nowInfo.date ? 'Сьогодні, ' : ''}${selParts[2]} ${MONTHS_SHORT[(selParts[1] || 1) - 1] || ''}`
    : selectedDate;
  const selTasks = (byDate.get(selectedDate) || []).slice().sort((a, b) => Number(a.done) - Number(b.done));
  const agendaListHtml = selTasks.length
    ? selTasks.map((t) => {
      const dl = getDeadlineInfo(t, nowInfo);
      const cls = [t.done ? ' is-done' : '', dl.overdue ? ' is-overdue' : ''].join('');
      return `
        <div class="cal-agenda-item${cls}" data-action="open-task" data-row="${t.row}" data-sphere="${escapeHtml(t.sphere)}">
          <button type="button" class="task-check" data-action="toggle-done" data-row="${t.row}" aria-label="Перемкнути виконання">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>
          </button>
          <div class="cal-agenda-main">
            <span class="cal-agenda-title">${escapeHtml(t.task)}</span>
            <div class="cal-agenda-meta">
              <span class="badge badge-sphere" data-sphere="${escapeHtml(t.sphere)}">${escapeHtml(t.sphere)}</span>
              ${t.time ? `<span class="badge">${escapeHtml(t.time)}</span>` : ''}
              ${dl.overdue ? '<span class="badge badge-deadline is-overdue">прострочено</span>' : ''}
            </div>
          </div>
        </div>`;
    }).join('')
    : '<p class="dash-empty">На цей день задач немає.</p>';

  const agendaHtml = `
    <section class="cal-mobile-agenda" aria-label="Задачі обраного дня">
      <div class="cal-agenda-head">
        <h3 class="cal-agenda-title-head">${escapeHtml(selTitle)} <span class="tab-badge">${selTasks.length}</span></h3>
        <button type="button" class="btn btn-primary cal-agenda-add" data-action="add-on-date" data-date="${escapeHtml(selectedDate)}">+ Задача</button>
      </div>
      <div class="cal-agenda-list">${agendaListHtml}</div>
    </section>`;

  const unscheduledHtml = unscheduled.length
    ? `
      <div class="cal-unscheduled">
        <h3 class="cal-sub-title">Активні без дати дедлайну (${unscheduled.length})</h3>
        <div class="cal-unscheduled-chips">
          ${unscheduled.map((t) => `<button type="button" class="cal-task-chip" data-action="open-task" data-row="${t.row}" data-sphere="${escapeHtml(t.sphere)}">${escapeHtml(t.task)}</button>`).join('')}
        </div>
      </div>`
    : '';

  return `
    <div class="calendar-view">
      <div class="cal-toolbar">
        <div class="cal-nav-group">
          <button type="button" class="icon-btn" data-action="cal-prev" aria-label="Попередній місяць">&lsaquo;</button>
          <h2 class="cal-month-title">${escapeHtml(MONTHS_FULL[month])} ${year}</h2>
          <button type="button" class="icon-btn" data-action="cal-next" aria-label="Наступний місяць">&rsaquo;</button>
        </div>
        <button type="button" class="btn btn-ghost" data-action="cal-today">Сьогодні</button>
      </div>

      <div class="cal-weekdays">
        ${WEEKDAYS.map((w) => `<div class="cal-wd-head">${w}</div>`).join('')}
      </div>
      <div class="cal-grid">${cells.join('')}</div>
      ${agendaHtml}
      ${unscheduledHtml}
    </div>`;
}

export function renderDashboardView(allTasks, state, nowInfo) {
  const scoped = state.activeSphere === 'Усі'
    ? allTasks
    : allTasks.filter((t) => t.sphere === state.activeSphere);

  const total = scoped.length;
  const doneCount = scoped.filter((t) => t.done).length;
  const active = scoped.filter((t) => !t.done);
  const todayCount = active.filter((t) => t.deadline === nowInfo.date).length;
  const overdueCount = active.filter((t) => isTaskOverdue(t, nowInfo)).length;
  const progressPct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const sphereNames = ['Крипта', 'Навчання', 'Життя'];
  const sphereCardsHtml = sphereNames.map((sp) => {
    const spAll = allTasks.filter((t) => t.sphere === sp);
    const spDone = spAll.filter((t) => t.done).length;
    const spActive = spAll.length - spDone;
    const spOverdue = spAll.filter((t) => isTaskOverdue(t, nowInfo)).length;
    const spPct = spAll.length > 0 ? Math.round((spDone / spAll.length) * 100) : 0;
    return `
      <div class="dash-card dash-sphere-card" data-action="jump-sphere" data-sphere="${escapeHtml(sp)}" role="button" tabindex="0">
        <div class="dash-card-top">
          <span class="badge badge-sphere" data-sphere="${escapeHtml(sp)}">${escapeHtml(sp)}</span>
          <strong class="dash-pct">${spPct}%</strong>
        </div>
        <div class="dash-sphere-nums">
          <span>Активні: <strong>${spActive}</strong></span>
          <span>Виконано: <strong>${spDone}</strong></span>
          ${spOverdue > 0 ? `<span class="dash-warn">Прострочено: ${spOverdue}</span>` : ''}
        </div>
        <progress class="dash-progress" data-sphere-prog="${escapeHtml(sp)}" value="${spPct}" max="100"></progress>
      </div>`;
  }).join('');

  const statusRowsHtml = STATUS_COLUMNS.map((st) => {
    const cnt = scoped.filter((t) => t.status === st).length;
    const pct = total > 0 ? Math.round((cnt / total) * 100) : 0;
    return `
      <div class="dash-bar-row">
        <div class="dash-bar-meta">
          <span><span class="col-dot" data-col-dot="${escapeHtml(st)}"></span> ${escapeHtml(st)}</span>
          <strong>${cnt}</strong>
        </div>
        <progress class="dash-progress" value="${pct}" max="100"></progress>
      </div>`;
  }).join('');

  const upcoming = active
    .filter((t) => Boolean(t.deadline))
    .sort((a, b) => (a.deadline + (a.time || '99:99')).localeCompare(b.deadline + (b.time || '99:99')))
    .slice(0, 6);

  const upcomingHtml = upcoming.length
    ? upcoming.map((t) => {
      const dl = getDeadlineInfo(t, nowInfo);
      const cls = dl.overdue ? ' is-overdue' : dl.urgent ? ' is-urgent' : '';
      return `
        <button type="button" class="dash-upcoming-item" data-action="open-task" data-row="${t.row}">
          <span class="badge badge-sphere" data-sphere="${escapeHtml(t.sphere)}">${escapeHtml(t.sphere)}</span>
          <span class="dash-up-title">${escapeHtml(t.task)}</span>
          <span class="badge badge-deadline${cls}">${escapeHtml(dl.label)}${dl.countdown ? ` · ${escapeHtml(dl.countdown)}` : ''}</span>
        </button>`;
    }).join('')
    : '<p class="dash-empty">Немає активних задач із призначеним дедлайном.</p>';

  const journal = state.journal || createDefaultJournal();
  const archivedTasks = state.archivedTasks || [];
  const dashRange = state.dashRange || '14';
  const dashTagScope = state.dashTagScope || 'all';

  return `
    <div class="dashboard-view">
      <div class="dash-card dash-hero">
        <div class="dash-hero-head">
          <div>
            <span class="dash-eyebrow">Загальний прогрес (разом з Архівом: ${archivedTasks.length})</span>
            <h2 class="dash-hero-val">${progressPct}% <small>виконано (${doneCount} з ${total})</small></h2>
          </div>
          <div class="dash-kpis">
            <div class="dash-kpi"><span>Активні</span><strong>${active.length}</strong></div>
            <div class="dash-kpi is-sky"><span>На сьогодні</span><strong>${todayCount}</strong></div>
            <div class="dash-kpi${overdueCount > 0 ? ' is-danger' : ''}"><span>Прострочено</span><strong>${overdueCount}</strong></div>
            <div class="dash-kpi is-green"><span>Виконано</span><strong>${doneCount}</strong></div>
          </div>
        </div>
        <progress class="dash-progress is-large" value="${progressPct}" max="100"></progress>
      </div>

      <div class="dash-spheres-grid">${sphereCardsHtml}</div>

      ${renderJournalTrendCard(journal, nowInfo.date, dashRange)}

      <div class="dash-bottom-grid">
        ${renderTagDonutCard(allTasks, archivedTasks, nowInfo.date, dashTagScope)}
        <div class="dash-card">
          <h3 class="dash-section-title">Воронка статусів</h3>
          <div class="dash-bars">${statusRowsHtml}</div>
        </div>
      </div>

      ${renderRecordsAndExtremesCard(journal, allTasks, archivedTasks)}

      <div class="dash-bottom-grid">
        ${renderMonthlySummaryCard(journal, allTasks, archivedTasks, nowInfo.date)}
        <div class="dash-card">
          <h3 class="dash-section-title">Найближчі та прострочені дедлайни</h3>
          <div class="dash-upcoming-list">${upcomingHtml}</div>
        </div>
      </div>
    </div>`;
}
