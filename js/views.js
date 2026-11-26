// Режими перегляду «Календар» та «Дашборд прогресу %» (відповідник вкладки «Канбан і Дашборд»)
import {
  STATUS_COLUMNS,
  MONTHS_FULL,
  escapeHtml,
  isTaskOverdue,
  getDeadlineInfo
} from './utils.js';
import { WEEKDAYS } from './notes-meta.js';
import { computeJournalStats, createDefaultJournal } from './day-view.js';

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
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
    const isToday = dateStr === nowInfo.date;
    const dayTasks = (byDate.get(dateStr) || []).slice().sort((a, b) => Number(a.done) - Number(b.done));
    const shown = dayTasks.slice(0, 3);
    const restCount = dayTasks.length - shown.length;

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
      <div class="cal-cell${isToday ? ' is-today' : ''}" data-cal-date="${dateStr}">
        <div class="cal-cell-head">
          <span class="cal-day-num">${d}</span>
          <button type="button" class="cal-add-day" data-action="add-on-date" data-date="${dateStr}" title="Додати задачу на ${dateStr}">+</button>
        </div>
        <div class="cal-cell-list">
          ${itemsHtml}
          ${restCount > 0 ? `<span class="cal-more">+${restCount} ще</span>` : ''}
        </div>
      </div>`);
  }

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

  const rangeDays = state.dashRangeDays === 30 ? 30 : 14;
  const journalCardHtml = renderJournalChartCard(state.journal || createDefaultJournal(), nowInfo.date, rangeDays);

  return `
    <div class="dashboard-view">
      <div class="dash-card dash-hero">
        <div class="dash-hero-head">
          <div>
            <span class="dash-eyebrow">Загальний прогрес (як у «Канбан і Дашборд»)</span>
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

      ${journalCardHtml}

      <div class="dash-bottom-grid">
        <div class="dash-card">
          <h3 class="dash-section-title">Воронка статусів</h3>
          <div class="dash-bars">${statusRowsHtml}</div>
        </div>
        <div class="dash-card">
          <h3 class="dash-section-title">Найближчі та прострочені дедлайни</h3>
          <div class="dash-upcoming-list">${upcomingHtml}</div>
        </div>
      </div>
    </div>`;
}

function renderJournalChartCard(journal, todayStr, rangeDays) {
  const stats = computeJournalStats(journal, todayStr, rangeDays);
  const w = 600;
  const h = 150;
  const padL = 28;
  const padR = 14;
  const padT = 14;
  const padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const n = Math.max(2, stats.points.length);

  const gridLevels = [2, 5, 8, 10];
  const gridHtml = gridLevels.map((lvl) => {
    const y = padT + plotH - ((lvl - 1) / 9) * plotH;
    return `
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="#253246" stroke-dasharray="3 3" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="#5e708a" font-size="10">${lvl}</text>`;
  }).join('');

  const coords = stats.points.map((pt, idx) => {
    const x = padL + (idx / (n - 1)) * plotW;
    const y = pt.rating ? padT + plotH - ((pt.rating - 1) / 9) * plotH : null;
    return { ...pt, x, y };
  });

  const valid = coords.filter((c) => c.y !== null);
  let pathHtml = '';
  if (valid.length >= 2) {
    const linePts = valid.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
    const areaPts = `${valid[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} ${linePts} ${valid[valid.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)}`;
    pathHtml = `
      <polygon points="${areaPts}" fill="rgba(16, 185, 129, 0.14)"/>
      <polyline points="${linePts}" fill="none" stroke="#10b981" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  const dotsHtml = valid.map((c) => `
    <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4" fill="#10b981" stroke="#0c1018" stroke-width="1.5">
      <title>${escapeHtml(c.label)}: ${c.rating}/10</title>
    </circle>`).join('');

  const xLabelStep = rangeDays === 30 ? 5 : 2;
  const xLabelsHtml = coords
    .filter((_, idx) => idx === 0 || idx === coords.length - 1 || idx % xLabelStep === 0)
    .map((c) => `<text x="${c.x.toFixed(1)}" y="${h - 6}" text-anchor="middle" fill="#5e708a" font-size="10">${escapeHtml(c.label)}</text>`)
    .join('');

  const chartBody = stats.ratedCount > 0
    ? `
      <div class="dash-chart-box">
        <svg class="dash-chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Графік оцінки дня 1–10">
          ${gridHtml}
          ${pathHtml}
          ${dotsHtml}
          ${xLabelsHtml}
        </svg>
      </div>`
    : `
      <div class="dash-chart-empty">
        <span>Оцініть день від 1 до 10 у вкладці «День», щоб бачити динаміку.</span>
        <button type="button" class="btn btn-secondary" data-action="jump-day">Перейти в «День»</button>
      </div>`;

  return `
    <div class="dash-card">
      <div class="dash-chart-head">
        <div>
          <h3 class="dash-section-title">Динаміка дня та звичок</h3>
        </div>
        <div class="dash-chart-kpis">
          <span class="dash-mini-kpi">Оцінка: <strong>${stats.avgRating ? `${stats.avgRating} / 10` : '—'}</strong></span>
          <span class="dash-mini-kpi">Звички: <strong>${stats.habitPct}%</strong></span>
          <div class="dash-range-tabs" role="group" aria-label="Період графіка">
            <button type="button" class="dash-range-btn${rangeDays === 14 ? ' is-active' : ''}" data-action="dash-range" data-range="14">14 дн</button>
            <button type="button" class="dash-range-btn${rangeDays === 30 ? ' is-active' : ''}" data-action="dash-range" data-range="30">30 дн</button>
          </div>
        </div>
      </div>
      ${chartBody}
    </div>`;
}
