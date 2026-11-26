import {
  STORAGE_CONFIG,
  STORAGE_CACHE,
  STORAGE_QUEUE,
  STORAGE_PREFS,
  loadJson,
  saveJson,
  safeApiUrl,
  getOffsetDateStr,
  reconcileClientDoneStatus,
  playFeedbackSound
} from './utils.js';
import {
  apiListTasks,
  hasValidConfig,
  loadPendingQueue,
  savePendingQueue,
  setLastServerSnapshot,
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

const $ = (id) => document.getElementById(id);

const state = {
  config: loadJson(STORAGE_CONFIG, { url: '', pin: '' }),
  prefs: loadJson(STORAGE_PREFS, { soundEnabled: true }),
  tasks: [],
  pendingQueue: loadPendingQueue(),
  lastSyncAt: null,
  isInitialLoading: false,
  activeSphere: 'Усі',
  activeStatus: 'В роботі',
  quickFilter: 'all', // 'all' | 'today' | 'overdue'
  searchQuery: '',
  editingRow: null,
  deleteConfirmTimer: null,
  logoutConfirmTimer: null,
  inFlightCount: 0
};

let tempRowSeq = -1;
let draggedRow = null;
const pendingDeleteTimers = new Map();

function saveCache() {
  saveJson(STORAGE_CACHE, { tasks: state.tasks, lastSyncAt: state.lastSyncAt });
}

const syncCallbacks = {
  onSyncIndicator: setSyncIndicator,
  onToast: (msg, kind) => showToast(msg, kind),
  onQueueChange: () => updatePendingBadge(state.pendingQueue.length),
  onOfflineQueued: () => {
    setSyncIndicator('error', `Офлайн: у черзі ${state.pendingQueue.length}`);
    showToast('Збережено в офлайн-чергу. Синхронізується при появі мережі.');
  },
  onTasksUpdated: () => {
    saveCache();
    renderAll(state);
    updateLastSyncText(state.lastSyncAt);
  }
};

function ensureConfigured() {
  if (hasValidConfig(state.config)) return true;
  populateSettingsModal();
  openModal('settingsModal');
  showToast('Спочатку підключіть таблицю у налаштуваннях', 'error');
  return false;
}

async function refreshFromServer(silent = false) {
  if (!hasValidConfig(state.config)) {
    populateSettingsModal();
    openModal('settingsModal');
    return false;
  }
  if (!navigator.onLine) {
    setSyncIndicator('error', 'Офлайн: показано збережений кеш');
    if (!silent) showToast('Офлайн: показано кешовані задачі', 'error');
    return false;
  }

  if (state.pendingQueue.length > 0) {
    await flushQueue(state, syncCallbacks);
  }

  setSyncIndicator('syncing', 'Оновлення даних...');
  try {
    const fresh = await apiListTasks(state.config);
    state.isInitialLoading = false;
    if (state.inFlightCount === 0 && state.pendingQueue.length === 0) {
      state.tasks = fresh;
      state.lastSyncAt = Date.now();
      saveCache();
      renderAll(state);
    }
    setSyncIndicator('ok', 'Синхронізовано');
    updateLastSyncText(state.lastSyncAt);
    if (!silent) showToast('Список задач оновлено', 'success');
    return true;
  } catch (err) {
    state.isInitialLoading = false;
    renderAll(state);
    setSyncIndicator('error', err.message || 'Помилка з’єднання');
    showToast(err.message || 'Не вдалося завантажити задачі', 'error');
    return false;
  }
}

/* ======================== Операції над задачами ======================== */

const findTaskByRow = (row) => state.tasks.find((t) => t.row === Number(row));

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
  saveCache();
  renderAll(state);
  playFeedbackSound(next.done ? 'done' : 'undo', state.prefs.soundEnabled);

  enqueueOfflineOrSend(state, {
    action: 'update',
    targetRow: row,
    expectedTask,
    fields: { done: next.done }
  }, syncCallbacks);

  if (next.done) {
    showToast(`Виконано: ${expectedTask}`, 'success', {
      label: 'Скасувати',
      onClick: () => {
        const cur = findTaskByRow(row) || state.tasks.find((t) => t.task === expectedTask);
        if (!cur) return;
        cur.done = prevDone;
        cur.status = prevStatus;
        saveCache();
        renderAll(state);
        playFeedbackSound('undo', state.prefs.soundEnabled);
        enqueueOfflineOrSend(state, {
          action: 'update',
          targetRow: cur.row,
          expectedTask: cur.task,
          fields: { done: prevDone, status: prevStatus }
        }, syncCallbacks);
      }
    });
  }
}

function quickChangeStatus(row, newStatus) {
  if (!ensureConfigured()) return;
  const target = findTaskByRow(row);
  if (!target || target.status === newStatus) return;

  const expectedTask = target.task;
  const next = reconcileClientDoneStatus(target.done, newStatus, target.done, target.status, 'status');
  target.done = next.done;
  target.status = next.status;
  saveCache();
  renderAll(state);
  if (next.done) playFeedbackSound('done', state.prefs.soundEnabled);

  enqueueOfflineOrSend(state, {
    action: 'update',
    targetRow: row,
    expectedTask,
    fields: { status: next.status }
  }, syncCallbacks);
}

function syncCardToCalendar(row) {
  if (!ensureConfigured()) return;
  const target = findTaskByRow(row);
  if (!target || target.inCalendar) return;
  if (!target.deadline) {
    openTaskModal(target, true);
    return showToast('Вкажіть дедлайн, щоб додати задачу в Календар', 'error');
  }

  target.inCalendar = true;
  saveCache();
  renderAll(state);
  playFeedbackSound('create', state.prefs.soundEnabled);

  enqueueOfflineOrSend(state, {
    action: 'syncCalendar',
    targetRow: row,
    expectedTask: target.task,
    fields: {},
    successText: 'Подію створено в Google Календарі'
  }, syncCallbacks);
}

/* ======================== Модальні вікна та форми ======================== */

function resetDeleteConfirm() {
  if (state.deleteConfirmTimer) clearTimeout(state.deleteConfirmTimer);
  state.deleteConfirmTimer = null;
  const delBtn = $('btnDeleteTask');
  if (delBtn) {
    delBtn.classList.remove('is-confirming');
    delBtn.textContent = 'Видалити';
  }
}

function resetLogoutConfirm() {
  if (state.logoutConfirmTimer) clearTimeout(state.logoutConfirmTimer);
  state.logoutConfirmTimer = null;
  const btn = $('btnLogoutDevice');
  if (btn) {
    btn.classList.remove('is-confirming');
    btn.textContent = 'Вийти і очистити пристрій';
  }
}

function openTaskModal(task = null, focusDeadline = false) {
  const isEdit = Boolean(task);
  state.editingRow = isEdit ? task.row : null;
  resetDeleteConfirm();

  $('taskModalTitle').textContent = isEdit ? 'Редагувати задачу' : 'Нова задача';
  $('fieldRow').value = isEdit ? String(task.row) : '';
  $('fieldTask').value = isEdit ? task.task : '';
  $('fieldSphere').value = isEdit ? (task.sphere || 'Життя') : (state.activeSphere !== 'Усі' ? state.activeSphere : 'Життя');
  $('fieldStatus').value = isEdit ? (task.status || 'В роботі') : (state.activeStatus === 'Готово' ? 'В роботі' : state.activeStatus);
  $('fieldPriority').value = isEdit ? (task.priority || 'Середній') : 'Середній';
  $('fieldDeadline').value = isEdit ? (task.deadline || '') : '';
  $('fieldTime').value = isEdit ? (task.time || '') : '';
  $('fieldNotes').value = isEdit ? (task.notes || '') : '';
  $('fieldDone').checked = isEdit ? Boolean(task.done) : false;
  $('doneToggleWrap').hidden = !isEdit;

  const calCheck = $('fieldAddToCalendar');
  calCheck.checked = isEdit ? Boolean(task.inCalendar) : false;
  calCheck.disabled = isEdit ? Boolean(task.inCalendar) : false;
  $('calendarToggleText').textContent = isEdit
    ? (task.inCalendar ? 'Вже в Календарі' : 'Додати в Календар')
    : 'Одразу в Календар';
  $('btnDeleteTask').hidden = !isEdit;

  openModal('taskModal');
  setTimeout(() => $(focusDeadline ? 'fieldDeadline' : 'fieldTask').focus(), 40);
}

function handleTaskFormSubmit(e) {
  e.preventDefault();
  if (!ensureConfigured()) return;

  const taskTitle = $('fieldTask').value.trim();
  if (!taskTitle) {
    $('fieldTask').focus();
    return showToast('Введіть назву задачі', 'error');
  }

  const sphere = $('fieldSphere').value;
  const rawStatus = $('fieldStatus').value;
  const priority = $('fieldPriority').value;
  const deadline = $('fieldDeadline').value.trim();
  const time = $('fieldTime').value.trim();
  const notes = $('fieldNotes').value.trim();
  const doneChecked = $('fieldDone').checked;
  const wantCalendar = !$('fieldAddToCalendar').disabled && $('fieldAddToCalendar').checked;

  if (wantCalendar && !deadline) {
    $('fieldDeadline').focus();
    return showToast('Вкажіть дедлайн, щоб додати подію в Календар', 'error');
  }

  if (state.editingRow === null) {
    const synced = reconcileClientDoneStatus(false, rawStatus, false, 'В роботі', 'status');
    state.tasks.push({
      row: tempRowSeq--,
      done: synced.done,
      sphere,
      task: taskTitle,
      status: synced.status,
      priority,
      deadline,
      time,
      notes,
      inCalendar: wantCalendar
    });
    if (state.activeStatus !== synced.status && window.innerWidth < 960) state.activeStatus = synced.status;
    saveCache();
    renderAll(state);
    closeModal('taskModal', resetDeleteConfirm);
    playFeedbackSound('create', state.prefs.soundEnabled);

    enqueueOfflineOrSend(state, {
      action: 'create',
      fields: { sphere, task: taskTitle, status: synced.status, priority, deadline, time, notes, addToCalendar: wantCalendar },
      successText: 'Задачу створено'
    }, syncCallbacks);
    return;
  }

  const existing = findTaskByRow(state.editingRow);
  if (!existing) return closeModal('taskModal', resetDeleteConfirm);

  const expectedTask = existing.task;
  const row = existing.row;
  const synced = reconcileClientDoneStatus(doneChecked, rawStatus, existing.done, existing.status, 'both');
  Object.assign(existing, {
    done: synced.done,
    sphere,
    task: taskTitle,
    status: synced.status,
    priority,
    deadline,
    time,
    notes,
    inCalendar: existing.inCalendar || wantCalendar
  });
  saveCache();
  renderAll(state);
  closeModal('taskModal', resetDeleteConfirm);
  playFeedbackSound('create', state.prefs.soundEnabled);

  enqueueOfflineOrSend(state, {
    action: 'update',
    targetRow: row,
    expectedTask,
    fields: { done: synced.done, sphere, task: taskTitle, status: synced.status, priority, deadline, time, notes, addToCalendar: wantCalendar },
    successText: 'Зміни збережено'
  }, syncCallbacks);
}

function handleDeleteClick() {
  if (state.editingRow === null) return;
  const delBtn = $('btnDeleteTask');
  if (!delBtn.classList.contains('is-confirming')) {
    delBtn.classList.add('is-confirming');
    delBtn.textContent = 'Точно видалити?';
    state.deleteConfirmTimer = setTimeout(resetDeleteConfirm, 3200);
    return;
  }

  const target = findTaskByRow(state.editingRow);
  if (!target) return closeModal('taskModal', resetDeleteConfirm);

  const removedCopy = structuredClone(target);
  const deleteKey = `${removedCopy.row}_${Date.now()}`;
  state.tasks = state.tasks.filter((t) => t.row !== removedCopy.row);
  saveCache();
  renderAll(state);
  closeModal('taskModal', resetDeleteConfirm);
  playFeedbackSound('undo', state.prefs.soundEnabled);

  const timerId = setTimeout(() => {
    pendingDeleteTimers.delete(deleteKey);
    enqueueOfflineOrSend(state, {
      action: 'delete',
      targetRow: removedCopy.row,
      expectedTask: removedCopy.task,
      fields: {},
      successText: 'Задачу видалено'
    }, syncCallbacks);
  }, 4000);
  pendingDeleteTimers.set(deleteKey, timerId);

  showToast(`Видалено: ${removedCopy.task}`, '', {
    label: 'Скасувати',
    onClick: () => {
      const pending = pendingDeleteTimers.get(deleteKey);
      if (pending) {
        clearTimeout(pending);
        pendingDeleteTimers.delete(deleteKey);
        state.tasks.push(removedCopy);
        saveCache();
        renderAll(state);
        playFeedbackSound('create', state.prefs.soundEnabled);
        showToast('Видалення скасовано', 'success');
      }
    }
  });
}

function populateSettingsModal() {
  $('fieldApiUrl').value = state.config.url || '';
  $('fieldPin').value = state.config.pin || '';
  $('fieldSoundEnabled').checked = Boolean(state.prefs.soundEnabled);
  resetLogoutConfirm();
  updateLastSyncText(state.lastSyncAt);
}

async function handleSettingsSubmit(e) {
  e.preventDefault();
  const cleanUrl = safeApiUrl($('fieldApiUrl').value);
  const pin = $('fieldPin').value.trim();
  if (!cleanUrl) {
    $('fieldApiUrl').focus();
    return showToast('Вкажіть URL Google Apps Script (https://script.google.com/...)', 'error');
  }
  if (!pin) {
    $('fieldPin').focus();
    return showToast('Введіть секретний PIN', 'error');
  }

  state.config = { url: cleanUrl, pin };
  saveJson(STORAGE_CONFIG, state.config);

  const btn = $('btnSaveSettings');
  btn.disabled = true;
  btn.textContent = 'Перевірка...';
  const ok = await refreshFromServer(true);
  btn.disabled = false;
  btn.textContent = 'Зберегти і підключити';
  if (ok) {
    closeModal('settingsModal', resetLogoutConfirm);
    showToast('Таблицю підключено', 'success');
  }
}

function handleBulkCalendarSync() {
  if (!ensureConfigured()) return;
  const pendingCount = state.tasks.filter((t) => !t.done && !t.inCalendar && t.deadline).length;
  if (pendingCount === 0) return showToast('Немає активних задач із дедлайном без Календаря');

  state.tasks.forEach((t) => {
    if (!t.done && !t.inCalendar && t.deadline) t.inCalendar = true;
  });
  saveCache();
  renderAll(state);
  closeModal('settingsModal', resetLogoutConfirm);

  enqueueOfflineOrSend(state, {
    action: 'syncCalendar',
    targetRow: null,
    fields: {},
    successText: `Додано подій у Календар: ${pendingCount}`
  }, syncCallbacks);
}

function handleLogoutDevice() {
  const btn = $('btnLogoutDevice');
  if (!btn.classList.contains('is-confirming')) {
    btn.classList.add('is-confirming');
    btn.textContent = 'Підтвердити очищення?';
    state.logoutConfirmTimer = setTimeout(resetLogoutConfirm, 3200);
    return;
  }

  localStorage.removeItem(STORAGE_CONFIG);
  localStorage.removeItem(STORAGE_CACHE);
  localStorage.removeItem(STORAGE_QUEUE);
  state.config = { url: '', pin: '' };
  state.tasks = [];
  state.pendingQueue = [];
  state.lastSyncAt = null;
  setLastServerSnapshot(null);
  savePendingQueue([]);
  renderAll(state);
  populateSettingsModal();
  setSyncIndicator('', 'Не підключено');
  showToast('Дані та PIN видалено з цього пристрою', 'success');
}

/* ======================== Події, DnD та хоткеї ======================== */

function bindEvents() {
  $('sphereBar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sphere]');
    if (btn) { state.activeSphere = btn.dataset.sphere; renderAll(state); }
  });

  $('statusTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-status]');
    if (btn) { state.activeStatus = btn.dataset.status; renderAll(state); }
  });

  $('statActivePill').addEventListener('click', () => {
    state.quickFilter = 'all';
    renderAll(state);
  });
  $('statTodayPill').addEventListener('click', () => {
    state.quickFilter = state.quickFilter === 'today' ? 'all' : 'today';
    renderAll(state);
  });
  $('statOverduePill').addEventListener('click', () => {
    state.quickFilter = state.quickFilter === 'overdue' ? 'all' : 'overdue';
    renderAll(state);
  });

  $('fieldSearch').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    renderAll(state);
  });
  $('btnClearSearch').addEventListener('click', () => {
    $('fieldSearch').value = '';
    state.searchQuery = '';
    renderAll(state);
    $('fieldSearch').focus();
  });

  const board = $('board');
  board.addEventListener('click', (e) => {
    if (e.target.closest('.note-link')) return;
    if (e.target.closest('[data-action="open-settings"]')) { populateSettingsModal(); openModal('settingsModal'); return; }
    if (e.target.closest('[data-action="reset-filters"]')) {
      state.quickFilter = 'all';
      state.searchQuery = '';
      $('fieldSearch').value = '';
      renderAll(state);
      return;
    }
    const checkBtn = e.target.closest('[data-action="toggle-done"]');
    if (checkBtn) { e.stopPropagation(); toggleTaskDone(Number(checkBtn.dataset.row)); return; }
    const calBtn = e.target.closest('[data-action="sync-cal"]');
    if (calBtn) { e.stopPropagation(); syncCardToCalendar(Number(calBtn.dataset.row)); return; }
    if (e.target.closest('.status-quick')) { e.stopPropagation(); return; }
    const card = e.target.closest('.task-card');
    if (card) openTaskModal(findTaskByRow(Number(card.dataset.row)));
  });

  board.addEventListener('change', (e) => {
    const select = e.target.closest('[data-action="quick-status"]');
    if (select) { e.stopPropagation(); quickChangeStatus(Number(select.dataset.row), select.value); }
  });

  // Desktop Drag & Drop між колонками
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.task-card');
    if (!card) return;
    draggedRow = Number(card.dataset.row);
    card.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(draggedRow));
    }
  });
  board.addEventListener('dragend', (e) => {
    const card = e.target.closest('.task-card');
    if (card) card.classList.remove('is-dragging');
    draggedRow = null;
    board.querySelectorAll('.column.is-drop-target').forEach((c) => c.classList.remove('is-drop-target'));
  });
  board.addEventListener('dragover', (e) => {
    if (draggedRow === null) return;
    const col = e.target.closest('.column[data-drop-status]');
    if (!col) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    board.querySelectorAll('.column.is-drop-target').forEach((c) => {
      if (c !== col) c.classList.remove('is-drop-target');
    });
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

  // Швидкі кнопки дедлайну в модалці
  $('quickDates').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick-date]');
    if (!btn) return;
    const mode = btn.dataset.quickDate;
    $('fieldDeadline').value = mode === 'clear' ? '' : getOffsetDateStr(Number(mode));
    if (mode === 'clear') $('fieldTime').value = '';
  });

  $('btnAdd').addEventListener('click', () => openTaskModal(null));
  $('btnRefresh').addEventListener('click', () => refreshFromServer(false));
  $('btnSettings').addEventListener('click', () => { populateSettingsModal(); openModal('settingsModal'); });
  $('fieldDone').addEventListener('change', (e) => {
    const st = $('fieldStatus');
    if (e.target.checked) st.value = 'Готово';
    else if (st.value === 'Готово') st.value = 'В роботі';
  });
  $('fieldStatus').addEventListener('change', (e) => { $('fieldDone').checked = e.target.value === 'Готово'; });
  $('fieldSoundEnabled').addEventListener('change', (e) => {
    state.prefs.soundEnabled = e.target.checked;
    saveJson(STORAGE_PREFS, state.prefs);
    if (e.target.checked) playFeedbackSound('create', true);
  });

  $('taskForm').addEventListener('submit', handleTaskFormSubmit);
  $('btnDeleteTask').addEventListener('click', handleDeleteClick);
  $('settingsForm').addEventListener('submit', handleSettingsSubmit);
  $('btnSyncAllCalendar').addEventListener('click', handleBulkCalendarSync);
  $('btnLogoutDevice').addEventListener('click', handleLogoutDevice);

  $('btnTogglePin').addEventListener('click', (e) => {
    const input = $('fieldPin');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Сховати' : 'Показати';
  });

  document.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => closeModal(btn.dataset.close, resetDeleteConfirm))
  );
  document.querySelectorAll('.modal-backdrop').forEach((bd) =>
    bd.addEventListener('click', (e) => { if (e.target === bd) closeModal(bd.id, resetDeleteConfirm); })
  );

  // Хоткеї ПК: N (нова задача), / (пошук), R (оновити), Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('taskModal').hidden) { closeModal('taskModal', resetDeleteConfirm); return; }
      if (!$('settingsModal').hidden) { closeModal('settingsModal', resetLogoutConfirm); return; }
      if (state.searchQuery) {
        $('fieldSearch').value = '';
        state.searchQuery = '';
        renderAll(state);
      }
      return;
    }

    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!$('taskModal').hidden || !$('settingsModal').hidden) return;

    if (e.key === '/') {
      e.preventDefault();
      $('fieldSearch').focus();
    } else if (e.code === 'KeyN') {
      e.preventDefault();
      openTaskModal(null);
    } else if (e.code === 'KeyR') {
      e.preventDefault();
      refreshFromServer(false);
    }
  });

  window.addEventListener('online', () => {
    showToast('З’єднання відновлено', 'success');
    refreshFromServer(true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!hasValidConfig(state.config) || !navigator.onLine) return;
    const stale = !state.lastSyncAt || (Date.now() - state.lastSyncAt > 20000);
    if (stale || state.pendingQueue.length > 0) refreshFromServer(true);
  });
}

function init() {
  const cached = loadJson(STORAGE_CACHE, null);
  if (cached && Array.isArray(cached.tasks)) {
    state.tasks = cached.tasks;
    state.lastSyncAt = cached.lastSyncAt || null;
  }
  if (hasValidConfig(state.config) && state.tasks.length === 0) {
    state.isInitialLoading = true;
  }

  bindEvents();
  renderAll(state);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  if (!hasValidConfig(state.config)) {
    populateSettingsModal();
    openModal('settingsModal');
  } else {
    refreshFromServer(true);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
