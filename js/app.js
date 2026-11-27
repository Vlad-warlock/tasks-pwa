import {
  STORAGE_CONFIG,
  STORAGE_CACHE,
  STORAGE_PREFS,
  STORAGE_JOURNAL,
  loadJson,
  saveJson,
  safeSheetUrl,
  copyToClipboard,
  getTodayLocal,
  getOffsetDateStr,
  normalizeStatus,
  reconcileClientDoneStatus
} from './utils.js';
import { normalizeJournal, createDayEventController } from './day-view.js';
import { parseTaskMeta, serializeTaskMeta } from './notes-meta.js';
import { audioFx, initTactile3D } from './fx.js';
import { initTimersDock } from './timers-dock.js';
import {
  apiListTasks,
  hasValidConfig,
  loadPendingQueue,
  enqueueOfflineOrSend,
  flushQueue
} from './api.js';
import {
  setSyncIndicator,
  updateLastSyncText,
  updatePendingBadge,
  showToast,
  openModal,
  closeModal,
  renderAll
} from './ui.js';
import { initMobileUx } from './mobile-ux.js';
import { initVoice, openAiAssistant, closeVoiceModal } from './voice.js';
import {
  initModals,
  openTaskModal,
  openSettingsModal,
  deleteTaskWithUndo,
  resetDeleteConfirm,
  resetLogoutConfirm
} from './modals.js';

const $ = (id) => document.getElementById(id);
const nowInit = new Date();
const initViewParam = new URLSearchParams(window.location.search).get('view');

const state = {
  config: loadJson(STORAGE_CONFIG, { url: '', pin: '', sheetUrl: '' }),
  prefs: loadJson(STORAGE_PREFS, { soundEnabled: true, fx3d: true }),
  tasks: [],
  archivedTasks: [],
  pendingQueue: loadPendingQueue(),
  lastSyncAt: null,
  hasGeminiKey: false,
  telegram: { hasToken: false, chatId: '', enabled: false },
  isInitialLoading: false,
  activeView: ['day', 'board', 'calendar', 'dashboard'].includes(initViewParam) ? initViewParam : 'board',
  activeSphere: 'Усі',
  activePriority: 'Усі',
  activeTag: '',
  activeStatus: 'Фокус',
  showDoneDesktop: false,
  calYear: nowInit.getFullYear(),
  calMonth: nowInit.getMonth(),
  calSelectedDate: getTodayLocal().date,
  journal: normalizeJournal(loadJson(STORAGE_JOURNAL, null)),
  dayDate: getTodayLocal().date,
  dayEditHabits: false,
  mobileDayOpen: { month: false, matrix: false, history: false },
  dashRange: '14',
  dashTagScope: 'all',
  quickFilter: 'all',
  searchQuery: '',
  editingRow: null,
  modalChecklist: [],
  deleteConfirmTimer: null,
  logoutConfirmTimer: null,
  archiveConfirmTimer: null,
  inFlightCount: 0
};

let tempRowSeq = -1;
let draggedRow = null;
const pendingDeleteTimers = new Map();

const saveCache = () => saveJson(STORAGE_CACHE, { tasks: state.tasks, archivedTasks: state.archivedTasks, lastSyncAt: state.lastSyncAt, hasGeminiKey: state.hasGeminiKey, telegram: state.telegram });
const saveJournalCache = () => saveJson(STORAGE_JOURNAL, state.journal);
const render = () => renderAll(state);
const findTaskByRow = (row) => state.tasks.find((t) => t.row === Number(row));

function updateStoredSheetUrl(nextSheetUrl) {
  const clean = safeSheetUrl(nextSheetUrl);
  if (!clean || state.config.sheetUrl === clean) return;
  state.config.sheetUrl = clean;
  saveJson(STORAGE_CONFIG, state.config);
}

const syncCallbacks = {
  onSyncIndicator: setSyncIndicator,
  onToast: (msg, kind) => showToast(msg, kind),
  onQueueChange: () => updatePendingBadge(state.pendingQueue.length),
  onSheetUrl: (url) => updateStoredSheetUrl(url),
  onOfflineQueued: () => {
    setSyncIndicator('error', `Офлайн: у черзі ${state.pendingQueue.length}`);
    showToast('Збережено в офлайн-чергу. Синхронізується при появі мережі.');
  },
  onTasksUpdated: () => {
    saveCache();
    render();
    updateLastSyncText(state.lastSyncAt);
  },
  onJournalUpdated: (journal) => {
    const editingDay = document.activeElement?.closest('[data-day-field], [data-habit-rename]');
    if (journal && !editingDay) state.journal = normalizeJournal(journal);
    saveJournalCache();
    if (!editingDay) render();
  },
  onArchivedUpdated: (archived) => {
    if (Array.isArray(archived)) { state.archivedTasks = archived; saveCache(); render(); }
  }
};

const appCtx = {
  state,
  saveCache,
  render,
  ensureConfigured,
  refreshFromServer,
  syncCallbacks,
  nextTempRow: () => tempRowSeq--,
  pendingDeleteTimers
};

function ensureConfigured() {
  if (hasValidConfig(state.config)) return true;
  openSettingsModal(appCtx);
  showToast('Спочатку підключіть таблицю у налаштуваннях', 'error');
  return false;
}

async function refreshFromServer(silent = false) {
  if (!hasValidConfig(state.config)) {
    openSettingsModal(appCtx);
    return false;
  }
  if (!navigator.onLine) {
    setSyncIndicator('error', 'Офлайн: показано збережений кеш');
    if (!silent) showToast('Офлайн: показано кешовані задачі', 'error');
    return false;
  }

  if (state.pendingQueue.length > 0) await flushQueue(state, syncCallbacks);
  setSyncIndicator('syncing', 'Оновлення даних...');
  try {
    const { tasks: fresh, archived, sheetUrl, hasGeminiKey, telegram, journal } = await apiListTasks(state.config);
    if (sheetUrl) updateStoredSheetUrl(sheetUrl);
    state.hasGeminiKey = Boolean(hasGeminiKey);
    if (telegram) state.telegram = telegram;
    state.isInitialLoading = false;
    if (state.inFlightCount === 0 && state.pendingQueue.length === 0) {
      state.tasks = fresh;
      if (Array.isArray(archived)) state.archivedTasks = archived;
      if (journal) { state.journal = normalizeJournal(journal); saveJournalCache(); }
      state.lastSyncAt = Date.now();
      saveCache();
      render();
    }
    setSyncIndicator('ok', 'Синхронізовано');
    updateLastSyncText(state.lastSyncAt);
    if (!silent) showToast('Список задач оновлено', 'success');
    return true;
  } catch (err) {
    state.isInitialLoading = false;
    render();
    setSyncIndicator('error', err.message || 'Помилка з’єднання');
    showToast(err.message || 'Не вдалося завантажити задачі', 'error');
    return false;
  }
}

/* ======================== Операції на дошці ======================== */

function toggleTaskDone(row) {
  if (!ensureConfigured()) return;
  const target = findTaskByRow(row);
  if (!target) return;

  const prevDone = target.done;
  const prevStatus = target.status;
  const expectedTask = target.task;
  const next = reconcileClientDoneStatus(!prevDone, prevStatus, prevDone, prevStatus, 'done');

  target.done = next.done;
  target.status = next.status;
  saveCache(); render();
  if (next.done) audioFx.playSuccess(); else audioFx.playClick();

  enqueueOfflineOrSend(state, { action: 'update', targetRow: row, expectedTask, fields: { done: next.done } }, syncCallbacks);

  if (next.done) {
    showToast(`Виконано: ${expectedTask}`, 'success', {
      label: 'Скасувати',
      onClick: () => {
        const cur = findTaskByRow(row) || state.tasks.find((t) => t.task === expectedTask);
        if (!cur) return;
        cur.done = prevDone; cur.status = prevStatus;
        saveCache(); render(); audioFx.playClick();
        enqueueOfflineOrSend(state, { action: 'update', targetRow: cur.row, expectedTask: cur.task, fields: { done: prevDone, status: prevStatus } }, syncCallbacks);
      }
    });
  }
}

function toggleTaskPin(row) {
  if (!ensureConfigured()) return;
  const target = findTaskByRow(row);
  if (!target) return;
  const meta = parseTaskMeta(target.notes);
  meta.pinned = !meta.pinned;
  target.notes = serializeTaskMeta(meta);
  saveCache(); render(); audioFx.playClick();
  enqueueOfflineOrSend(state, { action: 'update', targetRow: row, expectedTask: target.task, fields: { notes: target.notes } }, syncCallbacks);
}

function quickChangeStatus(row, newStatus) {
  if (!ensureConfigured()) return;
  const target = findTaskByRow(row);
  if (!target || target.status === newStatus) return;

  const expectedTask = target.task;
  const next = reconcileClientDoneStatus(target.done, newStatus, target.done, target.status, 'status');
  target.done = next.done;
  target.status = next.status;
  saveCache(); render();
  if (next.done) audioFx.playSuccess(); else audioFx.playClick();

  enqueueOfflineOrSend(state, { action: 'update', targetRow: row, expectedTask, fields: { status: next.status } }, syncCallbacks);
}

function handleInlineQuickCreate(status, rawTitle) {
  if (!ensureConfigured()) return;
  const taskTitle = String(rawTitle || '').trim();
  if (!taskTitle) return;

  const sphere = state.activeSphere !== 'Усі' ? state.activeSphere : 'Життя';
  const priority = state.activePriority !== 'Усі' ? state.activePriority : 'Середній';
  const notes = state.activeTag || '';
  const deadline = state.quickFilter === 'today' ? getOffsetDateStr(0) : '';

  state.tasks.push({ row: tempRowSeq--, done: false, sphere, task: taskTitle, status, priority, deadline, time: '', notes, inCalendar: false });
  saveCache(); render(); audioFx.playClick();
  document.querySelector(`.inline-add-form[data-inline-status="${CSS.escape(status)}"] .inline-add-input`)?.focus();

  enqueueOfflineOrSend(state, {
    action: 'create',
    fields: { sphere, task: taskTitle, status, priority, deadline, time: '', notes, addToCalendar: false },
    successText: 'Картку додано'
  }, syncCallbacks);
}

function handleArchiveDoneClick(btnEl) {
  if (!ensureConfigured()) return;
  if (!btnEl.classList.contains('is-confirming')) {
    btnEl.classList.add('is-confirming');
    btnEl.textContent = 'Точно в Архів?';
    if (state.archiveConfirmTimer) clearTimeout(state.archiveConfirmTimer);
    state.archiveConfirmTimer = setTimeout(render, 3200);
    return;
  }
  const doneCount = state.tasks.filter((t) => t.done).length;
  if (!doneCount) return;
  state.tasks = state.tasks.filter((t) => !t.done);
  saveCache(); render(); audioFx.playSuccess();
  enqueueOfflineOrSend(state, { action: 'archiveDone', fields: {}, successText: `Перенесено в аркуш «Архів»: ${doneCount}` }, syncCallbacks);
}

function syncCardToCalendar(row) {
  if (!ensureConfigured()) return;
  const target = findTaskByRow(row);
  if (!target || target.inCalendar) return;
  if (!target.deadline) {
    openTaskModal(appCtx, target, { focusDeadline: true });
    return showToast('Вкажіть дедлайн, щоб додати задачу в Календар', 'error');
  }
  target.inCalendar = true;
  saveCache(); render(); audioFx.playClick();
  enqueueOfflineOrSend(state, { action: 'syncCalendar', targetRow: row, expectedTask: target.task, fields: {}, successText: 'Подію створено в Google Календарі' }, syncCallbacks);
}

/* ======================== Події, DnD та клавіатура ======================== */

function bindEvents() {
  const board = $('board');
  const dayCtrl = createDayEventController(board, { state, render, syncCallbacks, onToast: showToast });

  $('viewSwitcher').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) { dayCtrl.flush(); audioFx.playClick(); state.activeView = btn.dataset.view; render(); }
  });
  $('focusBannerSlot')?.addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-action]');
    if (!actEl) return;
    const act = actEl.dataset.action;
    if (act === 'focus-banner-open') {
      state.activeView = 'day'; state.dayDate = getTodayLocal().date; audioFx.playClick(); render();
      $('dayFocusInput')?.focus();
    } else if (act === 'focus-banner-hide' || act === 'focus-banner-show') {
      state.prefs.hideFocusBanner = act === 'focus-banner-hide';
      saveJson(STORAGE_PREFS, state.prefs); render();
    }
  });
  $('sphereBar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sphere]');
    if (btn) { audioFx.playClick(); state.activeSphere = btn.dataset.sphere; render(); }
  });
  $('statusTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-status]');
    if (btn) { audioFx.playClick(); state.activeStatus = btn.dataset.status; render(); }
  });
  $('filterPriority').addEventListener('change', (e) => { state.activePriority = e.target.value; render(); });
  $('btnClearTag').addEventListener('click', () => { state.activeTag = ''; render(); });

  $('statActivePill').addEventListener('click', () => { state.quickFilter = 'all'; render(); });
  $('statTodayPill').addEventListener('click', () => { state.quickFilter = state.quickFilter === 'today' ? 'all' : 'today'; render(); });
  $('statOverduePill').addEventListener('click', () => { state.quickFilter = state.quickFilter === 'overdue' ? 'all' : 'overdue'; render(); });

  $('btnFxMode').addEventListener('click', () => {
    state.prefs.fx3d = !state.prefs.fx3d;
    saveJson(STORAGE_PREFS, state.prefs);
    audioFx.playClick();
    render();
  });

  $('fieldSearch').addEventListener('input', (e) => { state.searchQuery = e.target.value.trim(); render(); });
  $('btnClearSearch').addEventListener('click', () => { $('fieldSearch').value = ''; state.searchQuery = ''; render(); $('fieldSearch').focus(); });

  board.addEventListener('submit', (e) => {
    const form = e.target.closest('.inline-add-form');
    if (!form) return;
    e.preventDefault();
    const inp = form.querySelector('.inline-add-input');
    if (inp && inp.value.trim()) handleInlineQuickCreate(form.dataset.inlineStatus, inp.value);
  });

  board.addEventListener('click', async (e) => {
    if (e.target.closest('.note-link') || e.target.closest('.inline-add-form')) return;
    const actEl = e.target.closest('[data-action]');
    if (actEl) {
      e.stopPropagation();
      const act = actEl.dataset.action;
      if (act === 'open-settings') openSettingsModal(appCtx);
      else if (act === 'reset-filters') { state.quickFilter = 'all'; state.activePriority = 'Усі'; state.activeTag = ''; state.searchQuery = ''; $('filterPriority').value = 'Усі'; $('fieldSearch').value = ''; render(); }
      else if (act === 'toggle-done') toggleTaskDone(Number(actEl.dataset.row));
      else if (act === 'toggle-pin') toggleTaskPin(Number(actEl.dataset.row));
      else if (act === 'sync-cal') syncCardToCalendar(Number(actEl.dataset.row));
      else if (act === 'tag-click') { state.activeTag = state.activeTag === actEl.dataset.tag ? '' : actEl.dataset.tag; audioFx.playClick(); render(); }
      else if (act === 'copy-code') { if (await copyToClipboard(actEl.dataset.code)) { audioFx.playClick(); showToast(`Скопійовано: ${actEl.dataset.code}`, 'success'); } }
      else if (act === 'focus-inline-add') board.querySelector(`.inline-add-form[data-inline-status="${CSS.escape(actEl.dataset.status)}"] .inline-add-input`)?.focus();
      else if (act === 'archive-done') handleArchiveDoneClick(actEl);
      else if (act === 'quick-delete') deleteTaskWithUndo(appCtx, Number(actEl.dataset.row));
      else if (act === 'open-task') openTaskModal(appCtx, findTaskByRow(Number(actEl.dataset.row)));
      else if (act === 'add-on-date') openTaskModal(appCtx, null, { defaultDate: actEl.dataset.date });
      else if (act === 'cal-select-day') { state.calSelectedDate = actEl.dataset.date; audioFx.playClick(); render(); }
      else if (act === 'cal-prev' || act === 'cal-next') {
        if (act === 'cal-prev') { if (--state.calMonth < 0) { state.calMonth = 11; state.calYear--; } }
        else { if (++state.calMonth > 11) { state.calMonth = 0; state.calYear++; } }
        const ym = `${state.calYear}-${String(state.calMonth + 1).padStart(2, '0')}`;
        const today = getTodayLocal().date;
        if (!state.calSelectedDate?.startsWith(ym)) state.calSelectedDate = today.startsWith(ym) ? today : `${ym}-01`;
        render();
      }
      else if (act === 'cal-today') { const d = new Date(); state.calYear = d.getFullYear(); state.calMonth = d.getMonth(); state.calSelectedDate = getTodayLocal().date; render(); }
      else if (act === 'jump-sphere') { state.activeSphere = actEl.dataset.sphere; state.activeView = 'board'; audioFx.playClick(); render(); }
      else if (act === 'jump-tag') { state.activeTag = actEl.dataset.tag || ''; state.activeView = 'board'; audioFx.playClick(); render(); }
      else if (act === 'toggle-done-drawer') { state.showDoneDesktop = !state.showDoneDesktop; audioFx.playClick(); render(); }
      else dayCtrl.handleAction(act, actEl);
      return;
    }
    if (e.target.closest('.status-quick')) { e.stopPropagation(); return; }
    const card = e.target.closest('.task-card');
    if (card) openTaskModal(appCtx, findTaskByRow(Number(card.dataset.row)));
  });

  board.addEventListener('change', (e) => {
    const select = e.target.closest('[data-action="quick-status"]');
    if (select) { e.stopPropagation(); quickChangeStatus(Number(select.dataset.row), select.value); }
  });

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.task-card');
    if (!card) return;
    draggedRow = Number(card.dataset.row);
    card.classList.add('is-dragging');
    e.dataTransfer?.setData('text/plain', String(draggedRow));
  });
  board.addEventListener('dragend', (e) => {
    e.target.closest('.task-card')?.classList.remove('is-dragging');
    draggedRow = null;
    board.querySelectorAll('.column.is-drop-target').forEach((c) => c.classList.remove('is-drop-target'));
  });
  board.addEventListener('dragover', (e) => {
    const col = draggedRow !== null ? e.target.closest('.column[data-drop-status]') : null;
    if (!col) return;
    e.preventDefault();
    board.querySelectorAll('.column.is-drop-target').forEach((c) => { if (c !== col) c.classList.remove('is-drop-target'); });
    col.classList.add('is-drop-target');
  });
  board.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.column[data-drop-status]');
    if (col && !col.contains(e.relatedTarget)) col.classList.remove('is-drop-target');
  });
  board.addEventListener('drop', (e) => {
    const col = e.target.closest('.column[data-drop-status]');
    if (!col || draggedRow === null) return;
    e.preventDefault();
    col.classList.remove('is-drop-target');
    quickChangeStatus(draggedRow, col.dataset.dropStatus);
    draggedRow = null;
  });

  $('btnAdd').addEventListener('click', () => openTaskModal(appCtx, null));
  $('btnRefresh').addEventListener('click', () => refreshFromServer(false));
  $('btnRefreshMobile')?.addEventListener('click', () => { closeModal('settingsModal', () => resetLogoutConfirm(state)); refreshFromServer(false); });
  document.querySelector('.brand')?.addEventListener('click', () => { if (window.innerWidth <= 720) refreshFromServer(false); });
  $('btnSettings').addEventListener('click', () => openSettingsModal(appCtx));
  initMobileUx({ state, render, dayCtrl, openModal, closeModal });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('voiceModal').hidden) return closeVoiceModal();
      if (!$('filterModal').hidden) return closeModal('filterModal');
      if (!$('taskModal').hidden) return closeModal('taskModal', () => resetDeleteConfirm(state));
      if (!$('settingsModal').hidden) return closeModal('settingsModal', () => resetLogoutConfirm(state));
      if (state.searchQuery) { $('fieldSearch').value = ''; state.searchQuery = ''; render(); }
      return;
    }
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!$('taskModal').hidden || !$('settingsModal').hidden || !$('voiceModal').hidden) return;
    if (e.key === '/') { e.preventDefault(); $('fieldSearch').focus(); }
    else if (e.code === 'KeyN') { e.preventDefault(); openTaskModal(appCtx, null); }
    else if (e.code === 'KeyV') { e.preventDefault(); openAiAssistant(); }
    else if (e.code === 'KeyR') { e.preventDefault(); refreshFromServer(false); }
  });

  window.addEventListener('online', () => { showToast('З’єднання відновлено', 'success'); refreshFromServer(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && hasValidConfig(state.config) && navigator.onLine) {
      if (!state.lastSyncAt || (Date.now() - state.lastSyncAt > 20000) || state.pendingQueue.length > 0) refreshFromServer(true);
    }
  });
}

function init() {
  audioFx.setEnabled(state.prefs.soundEnabled !== false);
  initTactile3D(() => state.prefs.fx3d !== false);
  initTimersDock({ onNotify: showToast });
  initModals(appCtx);
  initVoice(appCtx);

  const cached = loadJson(STORAGE_CACHE, null);
  if (cached && Array.isArray(cached.tasks)) {
    state.tasks = cached.tasks.map((t) => ({ ...t, status: normalizeStatus(t.status, t.done ? 'Готово' : 'Sort') }));
    state.archivedTasks = Array.isArray(cached.archivedTasks) ? cached.archivedTasks : [];
    state.lastSyncAt = cached.lastSyncAt || null;
    state.hasGeminiKey = Boolean(cached.hasGeminiKey);
    if (cached.telegram) state.telegram = cached.telegram;
  }
  if (hasValidConfig(state.config) && state.tasks.length === 0) state.isInitialLoading = true;

  bindEvents();
  render();

  if ('serviceWorker' in navigator) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let swReloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || swReloading) return;
      swReloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => reg.update()).catch(() => {});
  }
  if (!hasValidConfig(state.config)) openSettingsModal(appCtx);
  else refreshFromServer(true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
