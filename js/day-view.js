import { MONTHS_SHORT, MONTHS_FULL, STORAGE_JOURNAL, escapeHtml, saveJson, getTodayLocal, shiftDateStr } from './utils.js';
import { hasValidConfig, enqueueOfflineOrSend } from './api.js';
import { audioFx } from './fx.js';
import {
  DEFAULT_HABITS,
  createDefaultJournal,
  normalizeJournal,
  getOrCreateDayEntry,
  toggleHabitForDate,
  updateDayEntryFields,
  updateMonthFocus,
  addCustomHabit,
  renameCustomHabit,
  toggleHabitActive,
  computeHabitStreak,
  computeJournalStats
} from './journal-store.js';

export { DEFAULT_HABITS, createDefaultJournal, normalizeJournal, computeJournalStats };

function ratingTone(val) {
  return val <= 4 ? 'low' : val <= 7 ? 'mid' : 'high';
}

function formatDayLabel(dateStr, todayStr) {
  const p = dateStr.split('-').map(Number);
  const monthWord = MONTHS_SHORT[(p[1] || 1) - 1] || '';
  if (dateStr === todayStr) return `Сьогодні, ${p[2]} ${monthWord}`;
  if (dateStr === shiftDateStr(todayStr, -1)) return `Вчора, ${p[2]} ${monthWord}`;
  if (dateStr === shiftDateStr(todayStr, 1)) return `Завтра, ${p[2]} ${monthWord}`;
  return `${p[2]} ${monthWord} ${p[0]}`;
}

export function renderFocusBanner(state, nowInfo) {
  const journal = state.journal || createDefaultJournal();
  const todayEntry = journal.entries[nowInfo.date];
  const dayFocus = String(todayEntry?.focus || '').trim();
  const ymKey = nowInfo.date.slice(0, 7);
  const monthFocus = String(journal.monthFocus[ymKey] || '').trim();

  if (state.prefs?.hideFocusBanner) {
    return `
      <div class="focus-banner is-collapsed">
        <button type="button" class="focus-banner-restore" data-action="focus-banner-show">Показати фокус дня</button>
      </div>`;
  }

  const label = dayFocus ? 'Фокус дня' : monthFocus ? 'Фокус місяця' : 'Фокус дня';
  const text = dayFocus || monthFocus || 'Задати головну ціль на сьогодні';
  const isEmpty = !dayFocus && !monthFocus;

  return `
    <div class="focus-banner">
      <button type="button" class="focus-banner-main" data-action="focus-banner-open" title="Відкрити у вкладці «День»">
        <span class="focus-banner-tag">${escapeHtml(label)}</span>
        <span class="focus-banner-text${isEmpty ? ' is-placeholder' : ''}">${escapeHtml(text)}</span>
      </button>
      <button type="button" class="focus-banner-hide" data-action="focus-banner-hide" aria-label="Згорнути фокус" title="Згорнути">&times;</button>
    </div>`;
}

function renderHabitMatrix(journal, dateStr, todayStr) {
  const [year, month] = dateStr.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const ymPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const activeHabits = journal.habits.filter((h) => h.active !== false);

  const dayHeaders = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const cellDate = `${ymPrefix}-${String(d).padStart(2, '0')}`;
    const cls = ['hm-day-btn', cellDate === todayStr ? ' is-today' : '', cellDate === dateStr ? ' is-selected' : ''].join('');
    dayHeaders.push(`<th class="hm-day-head"><button type="button" class="${cls}" data-action="day-select" data-date="${cellDate}" title="Відкрити ${cellDate}">${d}</button></th>`);
  }

  const rowsHtml = activeHabits.map((h) => {
    const cells = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const cellDate = `${ymPrefix}-${String(d).padStart(2, '0')}`;
      const checked = Boolean(journal.entries[cellDate]?.doneHabits.includes(h.id));
      const cls = ['hm-cell-btn', checked ? ' is-checked' : '', cellDate === todayStr ? ' is-today' : '', cellDate === dateStr ? ' is-selected' : ''].join('');
      cells.push(`<td><button type="button" class="${cls}" data-action="toggle-habit-cell" data-date="${cellDate}" data-habit-id="${escapeHtml(h.id)}" aria-label="${escapeHtml(h.name)} ${cellDate}" aria-pressed="${checked}">${checked ? '✓' : ''}</button></td>`);
    }
    return `<tr><th class="hm-habit-col" scope="row">${escapeHtml(h.name)}</th>${cells.join('')}</tr>`;
  }).join('');

  return `
    <section class="day-card day-matrix-card">
      <div class="day-card-head">
        <h3 class="day-card-title">Сітка звичок · ${escapeHtml(MONTHS_FULL[month - 1] || '')} ${year}</h3>
        <span class="day-hint">Число відкриває день · клітинка ставить ✓</span>
      </div>
      <div class="habit-matrix-wrap">
        <table class="habit-matrix">
          <thead><tr><th class="hm-habit-col">Звичка</th>${dayHeaders.join('')}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </section>`;
}

function renderJournalHistory(journal, selectedDate, todayStr) {
  const activeCount = Math.max(1, journal.habits.filter((h) => h.active !== false).length);
  const items = Object.values(journal.entries || {})
    .filter((e) => e && (e.focus || e.wins || e.blockers || e.rating !== null || (e.doneHabits && e.doneHabits.length > 0)))
    .sort((a, b) => b.date.localeCompare(a.date));

  const bodyHtml = items.length
    ? items.map((e) => {
      const doneCnt = Array.isArray(e.doneHabits) ? e.doneHabits.length : 0;
      const lines = [];
      if (e.focus) lines.push(`<div class="history-line"><strong>Фокус:</strong> ${escapeHtml(e.focus)}</div>`);
      if (e.wins) lines.push(`<div class="history-line"><strong>Вдалося:</strong> ${escapeHtml(e.wins)}</div>`);
      if (e.blockers) lines.push(`<div class="history-line"><strong>Заважало:</strong> ${escapeHtml(e.blockers)}</div>`);
      const ratingBadge = e.rating
        ? `<span class="day-rating-pill" data-tone="${ratingTone(e.rating)}">${e.rating}/10</span>`
        : '';
      return `
        <button type="button" class="history-item${e.date === selectedDate ? ' is-selected' : ''}" data-action="day-select" data-date="${escapeHtml(e.date)}">
          <div class="history-head">
            <strong class="history-date">${escapeHtml(formatDayLabel(e.date, todayStr))}</strong>
            <div class="history-meta">
              <span class="tab-badge">✓ ${doneCnt}/${activeCount}</span>
              ${ratingBadge}
            </div>
          </div>
          ${lines.length ? `<div class="history-lines">${lines.join('')}</div>` : ''}
        </button>`;
    }).join('')
    : '<p class="dash-empty">Записів за інші дні поки немає.</p>';

  return `
    <section class="day-card day-history-card">
      <div class="day-card-head">
        <h3 class="day-card-title">Історія записів <span class="tab-badge">${items.length}</span></h3>
        <span class="day-hint">Клік відкриває день для перегляду й правки</span>
      </div>
      <div class="day-history-list">${bodyHtml}</div>
    </section>`;
}

export function renderDayView(state, nowInfo) {
  const journal = state.journal || createDefaultJournal();
  const dateStr = state.dayDate || nowInfo.date;
  const ymKey = dateStr.slice(0, 7);
  const monthIdx = Number(ymKey.split('-')[1]) - 1;
  const monthTitle = MONTHS_FULL[monthIdx] || '';
  const entry = journal.entries[dateStr] || { date: dateStr, rating: null, focus: '', doneHabits: [], wins: '', blockers: '' };
  const monthFocusVal = journal.monthFocus[ymKey] || '';

  const activeHabits = journal.habits.filter((h) => h.active !== false);
  const doneSet = new Set(entry.doneHabits || []);
  const doneCount = activeHabits.filter((h) => doneSet.has(h.id)).length;

  const editorHtml = state.dayEditHabits
    ? `
      <div class="habit-editor">
        ${journal.habits.map((h) => `
          <div class="habit-edit-row">
            <input type="text" class="habit-rename-input" data-habit-rename="${escapeHtml(h.id)}" value="${escapeHtml(h.name)}" maxlength="60" aria-label="Назва звички">
            <button type="button" class="btn btn-ghost habit-vis-btn" data-action="toggle-habit-active" data-habit-id="${escapeHtml(h.id)}">
              ${h.active !== false ? 'Сховати' : 'Показати'}
            </button>
          </div>`).join('')}
        <form class="habit-add-form">
          <input type="text" name="habitName" placeholder="Нова звичка..." maxlength="60" autocomplete="off">
          <button type="submit" class="btn btn-primary">Додати</button>
        </form>
      </div>`
    : '';

  const habitsListHtml = activeHabits.map((h) => {
    const isDone = doneSet.has(h.id);
    const streak = computeHabitStreak(journal.entries, h.id, nowInfo.date);
    return `
      <button type="button" class="habit-row${isDone ? ' is-done' : ''}" data-action="toggle-habit" data-habit-id="${escapeHtml(h.id)}" aria-pressed="${isDone}">
        <span class="habit-check" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>
        </span>
        <span class="habit-name">${escapeHtml(h.name)}</span>
        <span class="habit-streak${streak >= 3 ? ' is-hot' : streak === 0 ? ' is-zero' : ''}">${streak > 0 ? `🔥 ${streak} дн` : '0 дн'}</span>
      </button>`;
  }).join('');

  const ratingButtonsHtml = Array.from({ length: 10 }, (_, idx) => {
    const n = idx + 1;
    const isActive = entry.rating === n;
    return `<button type="button" class="rating-btn${isActive ? ' is-active' : ''}" data-tone="${ratingTone(n)}" data-action="set-day-rating" data-rating="${n}" aria-pressed="${isActive}">${n}</button>`;
  }).join('');

  return `
    <div class="day-view">
      <div class="day-toolbar">
        <div class="day-nav-group">
          <button type="button" class="icon-btn" data-action="day-prev" aria-label="Попередній день">&lsaquo;</button>
          <h2 class="day-date-title">${escapeHtml(formatDayLabel(dateStr, nowInfo.date))}</h2>
          <button type="button" class="icon-btn" data-action="day-next" aria-label="Наступний день">&rsaquo;</button>
          <input type="date" class="day-date-picker" value="${escapeHtml(dateStr)}" aria-label="Обрати дату">
        </div>
        <div class="day-toolbar-right">
          ${dateStr !== nowInfo.date ? '<button type="button" class="btn btn-ghost day-today-btn" data-action="day-today">Сьогодні</button>' : ''}
          <span class="day-save-hint">Автозбереження</span>
        </div>
      </div>

      <section class="day-card day-focus-card">
        <div class="day-card-head">
          <h3 class="day-card-title">Головний фокус</h3>
          <span class="day-hint">2–3 хвилини на день</span>
        </div>
        <div class="day-focus-grid">
          <div class="field">
            <label for="dayMonthFocusInput">Фокус місяця (${escapeHtml(monthTitle)})</label>
            <input type="text" id="dayMonthFocusInput" data-day-field="monthFocus" data-ym="${ymKey}" value="${escapeHtml(monthFocusVal)}" placeholder="1 головна ціль на місяць..." autocomplete="off">
          </div>
          <div class="field">
            <label for="dayFocusInput">Фокус дня</label>
            <input type="text" id="dayFocusInput" data-day-field="focus" value="${escapeHtml(entry.focus)}" placeholder="Найголовніший результат на сьогодні..." autocomplete="off">
          </div>
        </div>
      </section>

      <div class="day-columns-grid">
        <section class="day-card day-habits-card">
          <div class="day-card-head">
            <h3 class="day-card-title">Трекер звичок <span class="tab-badge">${doneCount}/${activeHabits.length}</span></h3>
            <button type="button" class="pill-btn${state.dayEditHabits ? ' is-active' : ''}" data-action="toggle-habit-editor">
              ${state.dayEditHabits ? 'Готово' : 'Налаштувати'}
            </button>
          </div>
          ${editorHtml}
          <div class="habits-list">${habitsListHtml}</div>
        </section>

        <section class="day-card day-review-card">
          <div class="day-card-head">
            <h3 class="day-card-title">Вечірній підсумок дня</h3>
            ${entry.rating ? `<span class="day-rating-pill" data-tone="${ratingTone(entry.rating)}">${entry.rating}/10</span>` : '<span class="day-hint">Оцініть день 1–10</span>'}
          </div>
          <div class="rating-grid" role="group" aria-label="Оцінка дня від 1 до 10">${ratingButtonsHtml}</div>
          <div class="field">
            <label for="dayWinsInput">Що вдалося</label>
            <textarea id="dayWinsInput" rows="2" data-day-field="wins" placeholder="1–2 головні перемоги або виконані кроки...">${escapeHtml(entry.wins)}</textarea>
          </div>
          <div class="field">
            <label for="dayBlockersInput">Що заважало</label>
            <textarea id="dayBlockersInput" rows="2" data-day-field="blockers" placeholder="Де злився фокус або що варто змінити завтра...">${escapeHtml(entry.blockers)}</textarea>
          </div>
        </section>
      </div>

      ${renderHabitMatrix(journal, dateStr, nowInfo.date)}
      ${renderJournalHistory(journal, dateStr, nowInfo.date)}
    </div>`;
}

export function createDayEventController(board, appCtx) {
  const { state, render, syncCallbacks, onToast } = appCtx;
  const saveJournal = () => saveJson(STORAGE_JOURNAL, state.journal);
  let dayTimer = null;
  let metaTimer = null;

  function sendDay(dateStr) {
    if (!hasValidConfig(state.config)) return;
    const e = getOrCreateDayEntry(state.journal, dateStr);
    enqueueOfflineOrSend(state, {
      action: 'saveJournalDay',
      fields: { date: dateStr, rating: e.rating, focus: e.focus, doneHabits: e.doneHabits, wins: e.wins, blockers: e.blockers }
    }, syncCallbacks);
  }

  function sendMeta() {
    if (!hasValidConfig(state.config)) return;
    enqueueOfflineOrSend(state, {
      action: 'saveJournalMeta',
      fields: { habits: state.journal.habits, monthFocus: state.journal.monthFocus }
    }, syncCallbacks);
  }

  function flush() {
    if (dayTimer) { clearTimeout(dayTimer); dayTimer = null; sendDay(state.dayDate); }
    if (metaTimer) { clearTimeout(metaTimer); metaTimer = null; sendMeta(); }
  }

  board.addEventListener('submit', (e) => {
    const habitForm = e.target.closest('.habit-add-form');
    if (!habitForm) return;
    e.preventDefault();
    const inp = habitForm.querySelector('input[name="habitName"]');
    if (inp && addCustomHabit(state.journal, inp.value)) {
      inp.value = ''; saveJournal(); audioFx.playClick(); render(); sendMeta();
    }
  });

  board.addEventListener('change', (e) => {
    const picker = e.target.closest('.day-date-picker');
    if (!picker || !/^\d{4}-\d{2}-\d{2}$/.test(picker.value)) return;
    flush();
    state.dayDate = picker.value;
    audioFx.playClick();
    render();
  });

  board.addEventListener('input', (e) => {
    const dayField = e.target.closest('[data-day-field]');
    if (dayField) {
      const key = dayField.dataset.dayField;
      if (key === 'monthFocus') {
        updateMonthFocus(state.journal, dayField.dataset.ym, dayField.value);
        saveJournal();
        clearTimeout(metaTimer);
        metaTimer = setTimeout(() => { metaTimer = null; sendMeta(); }, 600);
      } else {
        updateDayEntryFields(state.journal, state.dayDate, { [key]: dayField.value });
        saveJournal();
        const targetDate = state.dayDate;
        clearTimeout(dayTimer);
        dayTimer = setTimeout(() => { dayTimer = null; sendDay(targetDate); }, 600);
      }
      return;
    }
    const renameInp = e.target.closest('[data-habit-rename]');
    if (renameInp && renameCustomHabit(state.journal, renameInp.dataset.habitRename, renameInp.value)) {
      saveJournal();
      clearTimeout(metaTimer);
      metaTimer = setTimeout(() => { metaTimer = null; sendMeta(); }, 600);
    }
  });

  board.addEventListener('focusout', (e) => {
    if (e.target.closest('[data-day-field], [data-habit-rename]')) flush();
  });

  function handleAction(act, actEl) {
    if (act === 'day-prev' || act === 'day-next' || act === 'day-today' || act === 'day-select') {
      flush();
      if (act === 'day-today') state.dayDate = getTodayLocal().date;
      else if (act === 'day-select' && actEl.dataset.date) {
        state.dayDate = actEl.dataset.date;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else state.dayDate = shiftDateStr(state.dayDate, act === 'day-prev' ? -1 : 1);
      audioFx.playClick();
      return render();
    }
    if (act === 'toggle-habit' || act === 'toggle-habit-cell') {
      const targetDate = actEl.dataset.date || state.dayDate;
      toggleHabitForDate(state.journal, targetDate, actEl.dataset.habitId);
      saveJournal(); audioFx.playClick(); render();
      return sendDay(targetDate);
    }
    if (act === 'set-day-rating') {
      const val = Number(actEl.dataset.rating);
      const cur = getOrCreateDayEntry(state.journal, state.dayDate);
      updateDayEntryFields(state.journal, state.dayDate, { rating: cur.rating === val ? null : val });
      saveJournal(); audioFx.playClick(); render();
      return sendDay(state.dayDate);
    }
    if (act === 'toggle-habit-editor') { state.dayEditHabits = !state.dayEditHabits; audioFx.playClick(); return render(); }
    if (act === 'toggle-habit-active') {
      if (toggleHabitActive(state.journal, actEl.dataset.habitId)) { saveJournal(); audioFx.playClick(); render(); sendMeta(); }
      else if (onToast) onToast('Залиште хоча б одну активну звичку', 'error');
      return;
    }
    if (act === 'dash-range') { state.dashRangeDays = Number(actEl.dataset.range) === 30 ? 30 : 14; audioFx.playClick(); return render(); }
    if (act === 'jump-day') { state.activeView = 'day'; state.dayDate = getTodayLocal().date; audioFx.playClick(); return render(); }
  }

  return { flush, handleAction };
}
