import { MONTHS_SHORT, MONTHS_FULL, escapeHtml } from './utils.js';
import { parseTaskMeta } from './notes-meta.js';
import { computeJournalStats, computeBestHabitStreak } from './journal-store.js';

const TAG_COLORS = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#38bdf8', '#818cf8', '#ec4899', '#64748b'];

function formatShortDate(ymd) {
  const p = String(ymd || '').split('-').map(Number);
  if (p.length !== 3 || p.some(Number.isNaN)) return ymd || '';
  return `${String(p[2]).padStart(2, '0')}.${String(p[1]).padStart(2, '0')}`;
}

export function renderJournalTrendCard(journal, todayStr, dashRange = '14') {
  const stats = computeJournalStats(journal, todayStr, dashRange);
  const w = 600;
  const h = 150;
  const padL = 28;
  const padR = 14;
  const padT = 14;
  const padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const n = Math.max(2, stats.points.length);

  const gridHtml = [2, 5, 8, 10].map((lvl) => {
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

  const step = Math.max(1, Math.ceil(coords.length / 7));
  const xLabelsHtml = coords
    .filter((_, idx) => idx === 0 || idx === coords.length - 1 || idx % step === 0)
    .map((c) => `<text x="${c.x.toFixed(1)}" y="${h - 6}" text-anchor="middle" fill="#5e708a" font-size="10">${escapeHtml(c.label)}</text>`)
    .join('');

  const chartBody = stats.ratedCount > 0
    ? `
      <div class="dash-chart-box">
        <svg class="dash-chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Графік оцінки дня 1–10">
          ${gridHtml}${pathHtml}${dotsHtml}${xLabelsHtml}
        </svg>
      </div>`
    : `
      <div class="dash-chart-empty">
        <span>Оцініть день від 1 до 10 у вкладці «День», щоб бачити динаміку.</span>
        <button type="button" class="btn btn-secondary" data-action="jump-day">Перейти в «День»</button>
      </div>`;

  const ranges = [
    ['14', '14 дн'],
    ['30', '30 дн'],
    ['month', 'Місяць'],
    ['year', 'Весь рік']
  ];
  const rangeBtns = ranges.map(([k, lbl]) =>
    `<button type="button" class="dash-range-btn${String(dashRange) === k ? ' is-active' : ''}" data-action="dash-range" data-range="${k}">${lbl}</button>`
  ).join('');

  return `
    <div class="dash-card">
      <div class="dash-chart-head">
        <h3 class="dash-section-title">Динаміка дня та звичок</h3>
        <div class="dash-chart-kpis">
          <span class="dash-mini-kpi">Оцінка: <strong>${stats.avgRating ? `${stats.avgRating} / 10` : '—'}</strong></span>
          <span class="dash-mini-kpi">Звички: <strong>${stats.habitPct}%</strong></span>
          <span class="dash-mini-kpi">Записів: <strong>${stats.habitLoggedDays}</strong></span>
          <div class="dash-range-tabs" role="group" aria-label="Період графіка">${rangeBtns}</div>
        </div>
      </div>
      ${chartBody}
    </div>`;
}

function getClosedRecords(allTasks, archivedTasks) {
  const closed = [];
  for (const t of allTasks) {
    if (t.done) closed.push({ date: t.deadline || '', notes: t.notes || '' });
  }
  for (const a of (archivedTasks || [])) {
    closed.push({ date: a.archivedDate || a.deadline || '', notes: a.notes || '' });
  }
  return closed;
}

export function renderTagDonutCard(allTasks, archivedTasks, todayStr, dashTagScope = 'all') {
  const ym = todayStr.slice(0, 7);
  const closed = getClosedRecords(allTasks, archivedTasks).filter((item) => {
    if (dashTagScope !== 'month') return true;
    return !item.date || item.date.startsWith(ym);
  });

  const counts = new Map();
  const labels = new Map();
  let totalTagged = 0;
  for (const item of closed) {
    for (const rawTag of parseTaskMeta(item.notes).tags) {
      const low = rawTag.toLowerCase();
      if (!labels.has(low)) labels.set(low, rawTag);
      counts.set(low, (counts.get(low) || 0) + 1);
      totalTagged++;
    }
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const slices = sorted.slice(0, 7).map(([low, cnt]) => ({ tag: labels.get(low), count: cnt, clickable: true }));
  const restCount = sorted.slice(7).reduce((acc, [, cnt]) => acc + cnt, 0);
  if (restCount > 0) slices.push({ tag: 'Інші', count: restCount, clickable: false });

  const r = 42;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const circlesHtml = slices.map((s, idx) => {
    const seg = totalTagged > 0 ? (s.count / totalTagged) * circ : 0;
    const color = TAG_COLORS[idx % TAG_COLORS.length];
    const el = `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="18" stroke-dasharray="${seg.toFixed(2)} ${(circ - seg).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
    offset += seg;
    return el;
  }).join('');

  const legendHtml = slices.map((s, idx) => {
    const pct = totalTagged > 0 ? Math.round((s.count / totalTagged) * 100) : 0;
    const color = TAG_COLORS[idx % TAG_COLORS.length];
    const tagAttr = s.clickable ? `data-action="jump-tag" data-tag="${escapeHtml(s.tag)}"` : 'disabled';
    return `
      <button type="button" class="donut-legend-row" ${tagAttr}>
        <span class="donut-dot" style="background:${color}"></span>
        <span class="donut-tag-name">${escapeHtml(s.tag)}</span>
        <strong class="donut-tag-val">${s.count} (${pct}%)</strong>
      </button>`;
  }).join('');

  const bodyHtml = slices.length > 0
    ? `
      <div class="dash-donut-layout">
        <svg class="dash-donut-svg" viewBox="0 0 120 120" role="img" aria-label="Розподіл виконаних задач за тегами">
          <circle cx="60" cy="60" r="${r}" fill="none" stroke="#1e293b" stroke-width="18"/>
          ${circlesHtml}
          <text x="60" y="57" text-anchor="middle" fill="#edf2f7" font-size="16" font-weight="700">${closed.length}</text>
          <text x="60" y="71" text-anchor="middle" fill="#8fa0b8" font-size="9">закрито</text>
        </svg>
        <div class="donut-legend">${legendHtml}</div>
      </div>`
    : '<p class="dash-empty">Додавайте #теги (наприклад #zoomex, #weex) до задач, щоб бачити розподіл.</p>';

  return `
    <div class="dash-card">
      <div class="dash-chart-head">
        <h3 class="dash-section-title">Розподіл за #тегами</h3>
        <div class="dash-range-tabs" role="group" aria-label="Період тегів">
          <button type="button" class="dash-range-btn${dashTagScope === 'month' ? ' is-active' : ''}" data-action="dash-tag-scope" data-scope="month">Місяць</button>
          <button type="button" class="dash-range-btn${dashTagScope !== 'month' ? ' is-active' : ''}" data-action="dash-tag-scope" data-scope="all">Увесь час</button>
        </div>
      </div>
      ${bodyHtml}
    </div>`;
}

export function renderRecordsAndExtremesCard(journal, allTasks, archivedTasks) {
  const closed = getClosedRecords(allTasks, archivedTasks);
  const bestStreak = computeBestHabitStreak(journal);
  const byDay = new Map();
  for (const c of closed) {
    if (c.date) byDay.set(c.date, (byDay.get(c.date) || 0) + 1);
  }
  let maxDayCount = 0;
  let maxDayDate = '';
  for (const [d, cnt] of byDay.entries()) {
    if (cnt > maxDayCount || (cnt === maxDayCount && d > maxDayDate)) {
      maxDayCount = cnt;
      maxDayDate = d;
    }
  }

  const rated = Object.values(journal.entries || {}).filter((e) => e && e.rating !== null);
  const bestDays = rated.slice().sort((a, b) => (b.rating - a.rating) || b.date.localeCompare(a.date)).slice(0, 5);
  const worstDays = rated.slice().sort((a, b) => (a.rating - b.rating) || b.date.localeCompare(a.date)).slice(0, 5);

  const renderList = (list, toneCls) => list.length
    ? list.map((e, i) => `
      <button type="button" class="extreme-day-btn" data-action="day-select-jump" data-date="${escapeHtml(e.date)}">
        <span class="extreme-rank">${i + 1}</span>
        <span class="extreme-info">
          <strong>${escapeHtml(formatShortDate(e.date))}</strong>
          ${e.focus ? `<span class="extreme-focus">${escapeHtml(e.focus)}</span>` : ''}
        </span>
        <span class="extreme-score ${toneCls}">${e.rating}/10</span>
      </button>`).join('')
    : '<p class="dash-empty">Поки немає оцінених днів.</p>';

  return `
    <div class="dash-card">
      <h3 class="dash-section-title">Рекорди та Топ-5 днів</h3>
      <div class="dash-records-grid">
        <div class="dash-record-box"><span>Закрито задач</span><strong>${closed.length}</strong><small>разом з Архівом</small></div>
        <div class="dash-record-box"><span>Краща серія звичок</span><strong>${bestStreak > 0 ? `🔥 ${bestStreak} дн` : '0 дн'}</strong><small>безперервно</small></div>
        <div class="dash-record-box"><span>Максимум за день</span><strong>${maxDayCount || '—'}</strong><small>${maxDayDate ? formatShortDate(maxDayDate) : 'немає дат'}</small></div>
      </div>
      <div class="dash-extremes-grid">
        <div class="extremes-col">
          <div class="extremes-title is-good">Топ-5 кращих днів</div>
          <div class="extremes-list">${renderList(bestDays, 'is-good')}</div>
        </div>
        <div class="extremes-col">
          <div class="extremes-title is-bad">Топ-5 гірших днів</div>
          <div class="extremes-list">${renderList(worstDays, 'is-bad')}</div>
        </div>
      </div>
    </div>`;
}

export function renderMonthlySummaryCard(journal, allTasks, archivedTasks, todayStr) {
  const year = todayStr.slice(0, 4);
  const monthsSet = new Set([todayStr.slice(0, 7)]);
  for (const d of Object.keys(journal.entries || {})) {
    if (d.startsWith(year)) monthsSet.add(d.slice(0, 7));
  }
  const closed = getClosedRecords(allTasks, archivedTasks);
  for (const c of closed) {
    if (c.date && c.date.startsWith(year)) monthsSet.add(c.date.slice(0, 7));
  }

  const activeHabits = journal.habits.filter((h) => h.active !== false);
  const activeIds = new Set(activeHabits.map((h) => h.id));
  const sortedMonths = [...monthsSet].sort((a, b) => b.localeCompare(a));

  const rowsHtml = sortedMonths.map((ym) => {
    const mIdx = Number(ym.slice(5, 7)) - 1;
    const monthLabel = `${MONTHS_FULL[mIdx] || ym}`;

    let rSum = 0;
    let rCnt = 0;
    let hDone = 0;
    let hDays = 0;
    for (const [d, entry] of Object.entries(journal.entries || {})) {
      if (!d.startsWith(ym) || !entry) continue;
      if (entry.rating !== null) { rSum += entry.rating; rCnt++; }
      if (entry.doneHabits.length > 0 || entry.rating !== null || entry.focus) {
        hDays++;
        for (const hid of entry.doneHabits) if (activeIds.has(hid)) hDone++;
      }
    }
    const avg = rCnt > 0 ? (rSum / rCnt).toFixed(1) : '—';
    const habitPct = hDays > 0 && activeHabits.length > 0 ? `${Math.min(100, Math.round((hDone / (hDays * activeHabits.length)) * 100))}%` : '—';

    const mClosed = closed.filter((c) => c.date && c.date.startsWith(ym));
    const tagCounts = new Map();
    for (const c of mClosed) {
      for (const tg of parseTaskMeta(c.notes).tags) tagCounts.set(tg, (tagCounts.get(tg) || 0) + 1);
    }
    const topTag = [...tagCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topTagText = topTag ? `${topTag[0]} (${topTag[1]})` : '—';

    return `
      <tr>
        <td><strong>${escapeHtml(monthLabel)}</strong></td>
        <td>${avg}</td>
        <td>${habitPct}</td>
        <td>${mClosed.length}</td>
        <td class="dash-table-tag">${escapeHtml(topTagText)}</td>
      </tr>`;
  }).join('');

  return `
    <div class="dash-card">
      <h3 class="dash-section-title">Підсумок по місяцях · ${escapeHtml(year)}</h3>
      <div class="dash-table-wrap">
        <table class="dash-month-table">
          <thead><tr><th>Місяць</th><th>Оцінка</th><th>Звички</th><th>Закрито</th><th>Топ-тег</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>`;
}
