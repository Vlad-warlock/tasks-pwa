import {
  STATUS_COLUMNS,
  SPHERES,
  PRIORITIES,
  STORAGE_JOURNAL,
  escapeHtml,
  saveJson,
  reconcileClientDoneStatus,
  getTodayLocal
} from './utils.js';
import { parseTaskMeta, serializeTaskMeta, extractTags } from './notes-meta.js';
import {
  getOrCreateDayEntry,
  updateDayEntryFields,
  updateMonthFocus,
  updateMonthReview,
  addCustomHabit,
  renameCustomHabit,
  toggleHabitActive
} from './journal-store.js';
import { enqueueOfflineOrSend } from './api.js';

function findHabitByAction(habits, action) {
  const list = Array.isArray(habits) ? habits : [];
  if (action.habitId) {
    const byId = list.find((h) => h.id === action.habitId);
    if (byId) return byId;
  }
  if (action.habitName) {
    const needle = String(action.habitName).trim().toLowerCase();
    return list.find((h) => String(h.name || '').trim().toLowerCase() === needle) || null;
  }
  return null;
}

export function buildAiContextPayload(state) {
  const tasks = (state.tasks || []).slice(0, 100).map((t) => ({
    row: t.row,
    task: t.task,
    sphere: t.sphere,
    status: t.status,
    priority: t.priority,
    deadline: t.deadline || '',
    time: t.time || '',
    done: Boolean(t.done),
    notes: String(t.notes || '').slice(0, 240)
  }));

  const j = state.journal || { habits: [], monthFocus: {}, monthReview: {}, entries: {} };
  const today = getTodayLocal().date;
  const keepDates = new Set([today, state.dayDate].filter(Boolean));
  Object.keys(j.entries || {}).sort().reverse().slice(0, 5).forEach((d) => keepDates.add(d));
  const entries = {};
  for (const d of keepDates) {
    if (j.entries && j.entries[d]) entries[d] = j.entries[d];
  }

  return {
    dayDate: state.dayDate || today,
    tasks,
    journal: {
      habits: j.habits || [],
      monthFocus: j.monthFocus || {},
      monthReview: j.monthReview || {},
      entries
    }
  };
}

function renderTaskCreateCard(d, idx) {
  const activeStatuses = STATUS_COLUMNS.filter((s) => s !== 'Готово');
  const sphereOpts = SPHERES.filter((s) => s !== 'Усі')
    .map((s) => `<option value="${escapeHtml(s)}"${s === d.sphere ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
  const statusOpts = activeStatuses
    .map((s) => `<option value="${escapeHtml(s)}"${s === d.status ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
  const prioOpts = PRIORITIES.filter((p) => p !== 'Усі')
    .map((p) => `<option value="${escapeHtml(p)}"${p === d.priority ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('');

  const metaBadges = [
    d.deadline ? `<span class="badge badge-deadline">${escapeHtml(d.deadline)}${d.time ? `, ${escapeHtml(d.time)}` : ''}</span>` : '',
    d.checklist?.length ? `<span class="badge">✓ ${d.checklist.length} крок.</span>` : '',
    d.pinned ? '<span class="badge">📌 Закріплено</span>' : ''
  ].filter(Boolean).join('');

  return `
    <div class="voice-draft-card ai-action-card is-create" data-ai-idx="${idx}">
      <div class="ai-action-head">
        <span class="ai-action-badge is-create">Створити</span>
        <button type="button" class="cl-remove-btn" data-ai-del="${idx}" aria-label="Прибрати дію">&times;</button>
      </div>
      <div class="vd-head">
        <input type="text" class="vd-title-input" data-vd-title="${idx}" value="${escapeHtml(d.task)}" aria-label="Назва задачі">
      </div>
      <div class="vd-selects">
        <select data-vd-sphere="${idx}" aria-label="Сфера">${sphereOpts}</select>
        <select data-vd-status="${idx}" aria-label="Статус">${statusOpts}</select>
        <select data-vd-prio="${idx}" aria-label="Пріоритет">${prioOpts}</select>
      </div>
      ${metaBadges ? `<div class="vd-meta">${metaBadges}</div>` : ''}
      ${d.notes ? `<p class="vd-notes">${escapeHtml(d.notes)}</p>` : ''}
    </div>`;
}

function buildUpdateDiffLines(a, t) {
  const lines = [];
  if (a.task && a.task !== t?.task) lines.push(`Назва: «${t?.task || ''}» → «${a.task}»`);
  if (a.status && a.status !== t?.status) lines.push(`Колонка: ${t?.status || '—'} → ${a.status}`);
  if (a.sphere && a.sphere !== t?.sphere) lines.push(`Сфера: ${t?.sphere || '—'} → ${a.sphere}`);
  if (a.priority && a.priority !== t?.priority) lines.push(`Пріоритет: ${t?.priority || '—'} → ${a.priority}`);
  if (a.clearDeadline) lines.push('Дедлайн: прибрати');
  else if (a.deadline && a.deadline !== t?.deadline) lines.push(`Дедлайн: ${t?.deadline || '—'} → ${a.deadline}`);
  if (a.clearTime) lines.push('Час: прибрати');
  else if (a.time && a.time !== t?.time) lines.push(`Час: ${t?.time || '—'} → ${a.time}`);
  if (a.clearNotes) lines.push('Нотатки: очистити');
  else if (a.notesAppend) lines.push(`Додати в нотатки: «${a.notesAppend}»`);
  else if (a.notes) lines.push(`Нові нотатки: «${a.notes}»`);
  if (a.checklistAdd?.length) lines.push(`+ Чекліст: ${a.checklistAdd.join(', ')}`);
  if (a.checklistToggle?.length) lines.push(`✓ Перемкнути кроки: ${a.checklistToggle.join(', ')}`);
  if (a.checklistRemove?.length) lines.push(`− Прибрати кроки: ${a.checklistRemove.join(', ')}`);
  if (a.hasPinnedChange) lines.push(a.pinned ? 'Закріпити картку' : 'Відкріпити картку');
  if (!lines.length && a.summary) lines.push(a.summary);
  return lines;
}

function buildJournalDiffLines(a, state) {
  const lines = [];
  if (a.type === 'journal_day') {
    if (a.clearFocus) lines.push('Фокус дня: очистити');
    else if (a.focus) lines.push(`Фокус дня: «${a.focus}»`);
    if (a.clearRating) lines.push('Оцінка дня: скинути');
    else if (a.rating) lines.push(`Оцінка дня: ${a.rating}/10`);
    if (a.habitsMarkDone?.length) lines.push(`Звички (+): ${a.habitsMarkDone.join(', ')}`);
    if (a.habitsMarkUndone?.length) lines.push(`Звички (−): ${a.habitsMarkUndone.join(', ')}`);
    if (a.clearWins) lines.push('Що вдалося: очистити');
    else if (a.wins) lines.push(`Що вдалося: «${a.wins}»`);
    if (a.clearBlockers) lines.push('Що заважало: очистити');
    else if (a.blockers) lines.push(`Що заважало: «${a.blockers}»`);
  } else if (a.type === 'journal_month') {
    if (a.clearMonthFocus) lines.push('Фокус місяця: очистити');
    else if (a.monthFocus) lines.push(`Фокус місяця: «${a.monthFocus}»`);
    if (a.clearMonthReview) lines.push('Підсумки місяця: очистити');
    else if (a.monthReview) lines.push(`Підсумки місяця: «${a.monthReview}»`);
  } else {
    const existing = findHabitByAction(state.journal?.habits, a);
    if (a.type === 'habit_create') lines.push(`Нова звичка: «${a.habitName}»`);
    if (a.type === 'habit_rename') lines.push(`Перейменувати «${existing?.name || a.habitId}» → «${a.habitName}»`);
    if (a.type === 'habit_toggle') lines.push(`${a.active ? 'Активувати' : 'Приховати'} звичку «${existing?.name || a.habitName || a.habitId}»`);
    if (a.type === 'habit_delete') lines.push(`Видалити звичку «${existing?.name || a.habitName || a.habitId}»`);
  }
  return lines.length ? lines : [a.summary || 'Оновити'];
}

export function renderAiActionCards(actions, state) {
  if (!actions.length) {
    return '<div class="ai-reply-empty">Змін на дошці не планується — це лише інформаційна відповідь.</div>';
  }

  return actions.map((a, idx) => {
    if (a.type === 'task_create') return renderTaskCreateCard(a, idx);

    let kindClass = 'is-update';
    let badgeText = 'Змінити';
    let titleText = a.summary || 'Дія';
    let lines = [];

    if (a.type === 'task_update' || a.type === 'task_done' || a.type === 'task_delete') {
      const target = (state.tasks || []).find((t) => t.row === Number(a.row));
      titleText = target ? target.task : (a.summary || `Задача #${a.row}`);
      if (a.type === 'task_delete') {
        kindClass = 'is-delete';
        badgeText = 'Видалити';
        lines = [target ? `Сфера: ${target.sphere} · ${target.status}` : 'Задачу не знайдено на дошці'];
      } else if (a.type === 'task_done') {
        kindClass = a.done ? 'is-done' : 'is-update';
        badgeText = a.done ? 'Виконано' : 'В роботу';
        lines = [a.done ? 'Позначити виконаною та перенести в Готово' : 'Повернути в активні задачі'];
      } else {
        lines = target ? buildUpdateDiffLines(a, target) : ['Задачу не знайдено на дошці'];
      }
    } else {
      kindClass = a.type === 'habit_delete' ? 'is-delete' : 'is-journal';
      badgeText = a.type === 'journal_day'
        ? `Щоденник · ${a.date}`
        : a.type === 'journal_month'
          ? `Місяць · ${a.ym}`
          : (a.type === 'habit_delete' ? 'Видалити звичку' : 'Звичка');
      titleText = a.summary || badgeText;
      lines = buildJournalDiffLines(a, state);
    }

    const diffHtml = lines.map((line) => `<div class="ai-diff-item">${escapeHtml(line)}</div>`).join('');
    return `
      <div class="voice-draft-card ai-action-card ${kindClass}" data-ai-idx="${idx}">
        <div class="ai-action-head">
          <span class="ai-action-badge ${kindClass}">${escapeHtml(badgeText)}</span>
          <button type="button" class="cl-remove-btn" data-ai-del="${idx}" aria-label="Прибрати дію">&times;</button>
        </div>
        <div class="ai-action-title">${escapeHtml(titleText)}</div>
        ${diffHtml ? `<div class="ai-diff-list">${diffHtml}</div>` : ''}
      </div>`;
  }).join('');
}

function mergeTaskNotes(existingNotes, a) {
  const meta = parseTaskMeta(existingNotes);
  if (a.clearNotes) {
    meta.cleanNotes = '';
    meta.tags = [];
  } else if (a.notes) {
    meta.cleanNotes = a.notes;
    meta.tags = extractTags(a.notes);
  } else if (a.notesAppend) {
    meta.cleanNotes = meta.cleanNotes ? `${meta.cleanNotes}\n${a.notesAppend}` : a.notesAppend;
    meta.tags = [...new Set([...meta.tags, ...extractTags(a.notesAppend)])];
  }

  for (const item of a.checklistRemove || []) {
    const q = item.toLowerCase();
    meta.checklist = meta.checklist.filter((c) => !c.text.toLowerCase().includes(q));
  }
  for (const item of a.checklistToggle || []) {
    const q = item.toLowerCase();
    meta.checklist.forEach((c) => { if (c.text.toLowerCase().includes(q)) c.done = !c.done; });
  }
  for (const item of a.checklistAdd || []) {
    const exists = meta.checklist.some((c) => c.text.toLowerCase() === item.toLowerCase());
    if (!exists) meta.checklist.push({ done: false, text: item });
  }
  if (a.hasPinnedChange) meta.pinned = Boolean(a.pinned);
  return serializeTaskMeta(meta);
}

export function applyAiActions(actions, ctx) {
  const { state, saveCache, render, syncCallbacks, nextTempRow } = ctx;
  const list = Array.isArray(actions) ? actions : [];
  const updatesAndDone = list.filter((a) => a.type === 'task_update' || a.type === 'task_done');
  const deletes = list.filter((a) => a.type === 'task_delete').sort((a, b) => Number(b.row) - Number(a.row));
  const creates = list.filter((a) => a.type === 'task_create' && String(a.task || '').trim());
  const journalDays = list.filter((a) => a.type === 'journal_day');
  const journalMeta = list.filter((a) => a.type === 'journal_month' || a.type.startsWith('habit_'));

  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;
  let journalCount = 0;

  for (const a of updatesAndDone) {
    const t = state.tasks.find((x) => x.row === Number(a.row));
    if (!t) continue;
    const expectedTask = t.task;

    if (a.type === 'task_done') {
      const next = reconcileClientDoneStatus(Boolean(a.done), t.status, t.done, t.status, 'done');
      t.done = next.done;
      t.status = next.status;
    } else {
      if (a.task) t.task = a.task;
      if (a.sphere) t.sphere = a.sphere;
      if (a.priority) t.priority = a.priority;
      if (a.clearDeadline) t.deadline = '';
      else if (a.deadline) t.deadline = a.deadline;
      if (a.clearTime) t.time = '';
      else if (a.time) t.time = a.time;
      if (a.status && a.status !== t.status) {
        const next = reconcileClientDoneStatus(t.done, a.status, t.done, t.status, 'status');
        t.done = next.done;
        t.status = next.status;
      }
      t.notes = mergeTaskNotes(t.notes, a);
    }

    updatedCount++;
    enqueueOfflineOrSend(state, {
      action: 'update',
      targetRow: t.row,
      expectedTask,
      fields: {
        done: t.done,
        sphere: t.sphere,
        task: t.task,
        status: t.status,
        priority: t.priority,
        deadline: t.deadline,
        time: t.time,
        notes: t.notes
      }
    }, syncCallbacks);
  }

  for (const a of deletes) {
    const idx = state.tasks.findIndex((x) => x.row === Number(a.row));
    if (idx === -1) continue;
    const t = state.tasks[idx];
    const expectedTask = t.task;
    state.tasks.splice(idx, 1);
    deletedCount++;
    enqueueOfflineOrSend(state, { action: 'delete', targetRow: t.row, expectedTask }, syncCallbacks);
  }

  for (const d of creates) {
    const serializedNotes = serializeTaskMeta({
      cleanNotes: d.notes || '',
      checklist: (d.checklist || []).map((text) => ({ done: false, text })),
      tags: extractTags(d.notes || ''),
      pinned: Boolean(d.pinned),
      repeat: { type: 'none', value: '' }
    });
    const newTask = {
      row: nextTempRow(),
      done: false,
      sphere: d.sphere || 'Життя',
      task: d.task.trim(),
      status: d.status || 'Фокус',
      priority: d.priority || 'Середній',
      deadline: d.deadline || '',
      time: d.time || '',
      notes: serializedNotes,
      inCalendar: false
    };
    state.tasks.push(newTask);
    createdCount++;
    enqueueOfflineOrSend(state, {
      action: 'create',
      fields: {
        sphere: newTask.sphere,
        task: newTask.task,
        status: newTask.status,
        priority: newTask.priority,
        deadline: newTask.deadline,
        time: newTask.time,
        notes: serializedNotes,
        addToCalendar: false
      }
    }, syncCallbacks);
  }

  const touchedDayDates = new Set();
  for (const a of journalDays) {
    const targetDate = a.date || getTodayLocal().date;
    const entry = getOrCreateDayEntry(state.journal, targetDate);
    const patch = {};
    if (a.clearFocus) patch.focus = '';
    else if (a.focus) patch.focus = a.focus;
    if (a.clearRating) patch.rating = null;
    else if (a.rating) patch.rating = a.rating;
    if (a.clearWins) patch.wins = '';
    else if (a.wins) patch.wins = a.wins;
    if (a.clearBlockers) patch.blockers = '';
    else if (a.blockers) patch.blockers = a.blockers;
    if (Object.keys(patch).length) updateDayEntryFields(state.journal, targetDate, patch);

    for (const hRef of a.habitsMarkDone || []) {
      const h = findHabitByAction(state.journal.habits, { habitId: hRef, habitName: hRef });
      if (h && !entry.doneHabits.includes(h.id)) entry.doneHabits.push(h.id);
    }
    for (const hRef of a.habitsMarkUndone || []) {
      const h = findHabitByAction(state.journal.habits, { habitId: hRef, habitName: hRef });
      if (h) entry.doneHabits = entry.doneHabits.filter((id) => id !== h.id);
    }
    touchedDayDates.add(targetDate);
    journalCount++;
  }

  for (const d of touchedDayDates) {
    const e = getOrCreateDayEntry(state.journal, d);
    enqueueOfflineOrSend(state, {
      action: 'saveJournalDay',
      fields: { date: d, rating: e.rating, focus: e.focus, doneHabits: e.doneHabits, wins: e.wins, blockers: e.blockers }
    }, syncCallbacks);
  }

  let metaChanged = false;
  for (const a of journalMeta) {
    if (a.type === 'journal_month') {
      if (a.clearMonthFocus) { updateMonthFocus(state.journal, a.ym, ''); metaChanged = true; journalCount++; }
      else if (a.monthFocus) { updateMonthFocus(state.journal, a.ym, a.monthFocus); metaChanged = true; journalCount++; }
      if (a.clearMonthReview) { updateMonthReview(state.journal, a.ym, ''); metaChanged = true; journalCount++; }
      else if (a.monthReview) { updateMonthReview(state.journal, a.ym, a.monthReview); metaChanged = true; journalCount++; }
    } else if (a.type === 'habit_create') {
      if (addCustomHabit(state.journal, a.habitName)) { metaChanged = true; journalCount++; }
    } else if (a.type === 'habit_rename') {
      const h = findHabitByAction(state.journal.habits, a);
      if (h && renameCustomHabit(state.journal, h.id, a.habitName)) { metaChanged = true; journalCount++; }
    } else if (a.type === 'habit_toggle') {
      const h = findHabitByAction(state.journal.habits, a);
      if (h && (h.active !== false) !== Boolean(a.active) && toggleHabitActive(state.journal, h.id)) {
        metaChanged = true;
        journalCount++;
      }
    } else if (a.type === 'habit_delete') {
      const h = findHabitByAction(state.journal.habits, a);
      const activeCount = state.journal.habits.filter((x) => x.active !== false).length;
      if (h && (h.active === false || activeCount > 1)) {
        state.journal.habits = state.journal.habits.filter((x) => x.id !== h.id);
        metaChanged = true;
        journalCount++;
      }
    }
  }

  if (metaChanged) {
    enqueueOfflineOrSend(state, {
      action: 'saveJournalMeta',
      fields: {
        habits: state.journal.habits,
        monthFocus: state.journal.monthFocus,
        monthReview: state.journal.monthReview || {}
      }
    }, syncCallbacks);
  }

  if (window.innerWidth < 960 && createdCount === 1 && !updatedCount && !deletedCount && creates[0]) {
    state.activeStatus = creates[0].status;
  }
  saveCache();
  saveJson(STORAGE_JOURNAL, state.journal);
  render();

  return {
    appliedCount: createdCount + updatedCount + deletedCount + journalCount,
    createdCount,
    updatedCount,
    deletedCount,
    journalCount
  };
}
