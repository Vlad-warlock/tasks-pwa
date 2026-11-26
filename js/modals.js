import {
  STORAGE_CONFIG,
  STORAGE_CACHE,
  STORAGE_QUEUE,
  STORAGE_PREFS,
  escapeHtml,
  saveJson,
  safeApiUrl,
  safeSheetUrl,
  getOffsetDateStr,
  normalizeStatus,
  reconcileClientDoneStatus
} from './utils.js';
import {
  WEEKDAYS,
  parseTaskMeta,
  serializeTaskMeta,
  extractTags
} from './notes-meta.js';
import { audioFx } from './fx.js';
import { startFocusTimer } from './timers-dock.js';
import {
  setLastServerSnapshot,
  savePendingQueue,
  enqueueOfflineOrSend
} from './api.js';
import {
  setSyncIndicator,
  updateLastSyncText,
  showToast,
  openModal,
  closeModal
} from './ui.js';

const $ = (id) => document.getElementById(id);

export function resetDeleteConfirm(state) {
  if (state.deleteConfirmTimer) clearTimeout(state.deleteConfirmTimer);
  state.deleteConfirmTimer = null;
  const delBtn = $('btnDeleteTask');
  if (delBtn) {
    delBtn.classList.remove('is-confirming');
    delBtn.textContent = 'Видалити';
  }
}

export function resetLogoutConfirm(state) {
  if (state.logoutConfirmTimer) clearTimeout(state.logoutConfirmTimer);
  state.logoutConfirmTimer = null;
  const btn = $('btnLogoutDevice');
  if (btn) {
    btn.classList.remove('is-confirming');
    btn.textContent = 'Вийти і очистити пристрій';
  }
}

function renderModalChecklist(state) {
  const wrap = $('checklistItems');
  if (!wrap) return;
  wrap.innerHTML = state.modalChecklist.map((item, idx) => `
    <div class="cl-edit-row">
      <input type="checkbox" data-cl-toggle="${idx}" ${item.done ? 'checked' : ''}>
      <span class="cl-edit-text${item.done ? ' is-done' : ''}">${escapeHtml(item.text)}</span>
      <button type="button" class="cl-remove-btn" data-cl-del="${idx}" aria-label="Видалити крок">&times;</button>
    </div>`).join('');
}

function syncRepeatModalFields() {
  const type = $('fieldRepeatType').value;
  $('repeatWeekdaysWrap').hidden = type !== 'weekly';
  $('repeatValWrap').hidden = !(type === 'monthly' || type === 'every_n');
  $('fieldRepeatValLabel').textContent = type === 'monthly' ? 'Число місяця' : 'Інтервал (днів)';
}

function syncModalPills() {
  const sp = $('fieldSphere')?.value;
  document.querySelectorAll('#spherePills [data-val]').forEach((b) => b.classList.toggle('is-active', b.dataset.val === sp));
  const pr = $('fieldPriority')?.value;
  document.querySelectorAll('#priorityPills [data-val]').forEach((b) => b.classList.toggle('is-active', b.dataset.val === pr));
}

function updateExtraSummaryBadge(state) {
  const badge = $('taskExtraBadge');
  if (!badge) return;
  const parts = [];
  if ($('fieldRepeatType')?.value !== 'none') parts.push('↻');
  const tagCount = ($('fieldTags')?.value.trim().split(/[\s,]+/).filter(Boolean) || []).length;
  if (tagCount > 0) parts.push(`${tagCount} тег.`);
  if (state.modalChecklist.length > 0) {
    const done = state.modalChecklist.filter((c) => c.done).length;
    parts.push(`✓ ${done}/${state.modalChecklist.length}`);
  }
  badge.textContent = parts.join(' · ');
}

export function openSettingsModal(ctx) {
  const { state } = ctx;
  $('fieldApiUrl').value = state.config.url || '';
  $('fieldPin').value = state.config.pin || '';
  $('fieldSheetUrl').value = state.config.sheetUrl || '';
  $('fieldSoundEnabled').checked = Boolean(state.prefs.soundEnabled);
  resetLogoutConfirm(state);
  updateLastSyncText(state.lastSyncAt);
  openModal('settingsModal');
}

export function openTaskModal(ctx, task = null, opts = {}) {
  const { state } = ctx;
  const isEdit = Boolean(task);
  state.editingRow = isEdit ? task.row : null;
  resetDeleteConfirm(state);

  const meta = isEdit
    ? parseTaskMeta(task.notes)
    : { cleanNotes: '', checklist: [], tags: state.activeTag ? [state.activeTag] : [], pinned: false, repeat: { type: 'none', value: '' } };

  state.modalChecklist = meta.checklist.map((c) => ({ ...c }));
  renderModalChecklist(state);
  $('fieldNewCheck').value = '';

  $('taskModalTitle').textContent = isEdit ? 'Редагувати задачу' : 'Нова задача';
  $('fieldRow').value = isEdit ? String(task.row) : '';
  $('fieldTask').value = isEdit ? task.task : '';
  $('fieldSphere').value = isEdit ? (task.sphere || 'Життя') : (state.activeSphere !== 'Усі' ? state.activeSphere : 'Життя');
  $('fieldStatus').value = isEdit ? normalizeStatus(task.status, 'Фокус') : (opts.defaultStatus || (state.activeStatus === 'Готово' ? 'Фокус' : state.activeStatus));
  $('fieldPriority').value = isEdit ? (task.priority || 'Середній') : (state.activePriority !== 'Усі' ? state.activePriority : 'Середній');
  $('fieldDeadline').value = isEdit ? (task.deadline || '') : (opts.defaultDate || '');
  $('fieldTime').value = isEdit ? (task.time || '') : '';
  $('fieldTags').value = meta.tags.join(' ');
  $('fieldNotes').value = meta.cleanNotes;
  $('fieldPinned').checked = Boolean(meta.pinned);
  $('fieldDone').checked = isEdit ? Boolean(task.done) : false;
  $('doneToggleWrap').hidden = !isEdit;

  $('fieldRepeatType').value = meta.repeat.type || 'none';
  $('fieldRepeatVal').value = meta.repeat.type === 'weekly' ? '' : (meta.repeat.value || '1');
  const selDays = meta.repeat.type === 'weekly' ? String(meta.repeat.value || '').split(',') : [];
  document.querySelectorAll('#repeatWeekdaysWrap input[type="checkbox"]').forEach((cb) => {
    cb.checked = selDays.includes(cb.value);
  });
  syncRepeatModalFields();

  const calCheck = $('fieldAddToCalendar');
  calCheck.checked = isEdit ? Boolean(task.inCalendar) : false;
  calCheck.disabled = isEdit ? Boolean(task.inCalendar) : false;
  $('calendarToggleText').textContent = isEdit ? (task.inCalendar ? 'Вже в Календарі' : 'Додати в Календар') : 'Одразу в Календар';
  $('btnDeleteTask').hidden = !isEdit;
  $('btnStartTaskTimer').hidden = !isEdit;

  syncModalPills();
  const extraDetails = $('taskExtraDetails');
  if (extraDetails) {
    const hasExtras = meta.repeat.type !== 'none' || meta.tags.length > 0 || state.modalChecklist.length > 0;
    extraDetails.open = window.innerWidth > 720 || (isEdit && hasExtras);
  }
  updateExtraSummaryBadge(state);

  openModal('taskModal');
  if (window.innerWidth > 720 || !isEdit || opts.focusDeadline) {
    setTimeout(() => $(opts.focusDeadline ? 'fieldDeadline' : 'fieldTask').focus(), 40);
  }
}

export function initModals(ctx) {
  const { state, saveCache, render, ensureConfigured, refreshFromServer, syncCallbacks, nextTempRow, pendingDeleteTimers } = ctx;
  const findByRow = (r) => state.tasks.find((t) => t.row === Number(r));

  $('repeatWeekdaysWrap').innerHTML = WEEKDAYS.map(
    (w, idx) => `<label class="wd-chip"><input type="checkbox" value="${idx + 1}"><span>${w}</span></label>`
  ).join('');

  $('quickDates').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick-date]');
    if (!btn) return;
    const mode = btn.dataset.quickDate;
    $('fieldDeadline').value = mode === 'clear' ? '' : getOffsetDateStr(Number(mode));
    if (mode === 'clear') $('fieldTime').value = '';
  });

  const addModalCheck = () => {
    const txt = $('fieldNewCheck').value.trim();
    if (!txt) return;
    state.modalChecklist.push({ done: false, text: txt });
    $('fieldNewCheck').value = '';
    renderModalChecklist(state);
    updateExtraSummaryBadge(state);
    $('fieldNewCheck').focus();
  };
  $('btnAddCheckItem').addEventListener('click', addModalCheck);
  $('fieldNewCheck').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addModalCheck(); } });
  $('checklistItems').addEventListener('click', (e) => {
    const del = e.target.closest('[data-cl-del]');
    if (del) { state.modalChecklist.splice(Number(del.dataset.clDel), 1); renderModalChecklist(state); updateExtraSummaryBadge(state); }
  });
  $('checklistItems').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-cl-toggle]');
    if (cb && state.modalChecklist[Number(cb.dataset.clToggle)]) {
      state.modalChecklist[Number(cb.dataset.clToggle)].done = cb.checked;
      renderModalChecklist(state);
      updateExtraSummaryBadge(state);
    }
  });

  $('spherePills')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-val]');
    if (!btn) return;
    $('fieldSphere').value = btn.dataset.val;
    audioFx.playClick();
    syncModalPills();
  });
  $('priorityPills')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-val]');
    if (!btn) return;
    $('fieldPriority').value = btn.dataset.val;
    audioFx.playClick();
    syncModalPills();
  });
  $('fieldSphere').addEventListener('change', syncModalPills);
  $('fieldPriority').addEventListener('change', syncModalPills);
  $('fieldTags').addEventListener('input', () => updateExtraSummaryBadge(state));
  $('fieldRepeatType').addEventListener('change', () => { syncRepeatModalFields(); updateExtraSummaryBadge(state); });
  $('btnStartTaskTimer').addEventListener('click', () => {
    const title = $('fieldTask').value.trim() || 'Задача';
    closeModal('taskModal', () => resetDeleteConfirm(state));
    startFocusTimer(25, title);
    showToast(`Запущено 25 хв фокус-таймер: ${title}`, 'success');
  });

  $('fieldDone').addEventListener('change', (e) => {
    const st = $('fieldStatus');
    if (e.target.checked) st.value = 'Готово';
    else if (st.value === 'Готово') st.value = 'Фокус';
  });
  $('fieldStatus').addEventListener('change', (e) => { $('fieldDone').checked = e.target.value === 'Готово'; });
  $('fieldSoundEnabled').addEventListener('change', (e) => {
    state.prefs.soundEnabled = e.target.checked;
    audioFx.setEnabled(e.target.checked);
    saveJson(STORAGE_PREFS, state.prefs);
    if (e.target.checked) audioFx.playClick();
  });

  $('taskForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!ensureConfigured()) return;

    const pendingCheck = $('fieldNewCheck').value.trim();
    if (pendingCheck) {
      state.modalChecklist.push({ done: false, text: pendingCheck });
      $('fieldNewCheck').value = '';
    }

    const taskTitle = $('fieldTask').value.trim();
    if (!taskTitle) { $('fieldTask').focus(); return showToast('Введіть назву задачі', 'error'); }

    const repeatType = $('fieldRepeatType').value;
    let repeatValue = '';
    if (repeatType === 'weekly') {
      repeatValue = [...document.querySelectorAll('#repeatWeekdaysWrap input:checked')].map((c) => c.value).join(',');
      if (!repeatValue) return showToast('Оберіть хоча б один день тижня', 'error');
    } else if (repeatType === 'monthly' || repeatType === 'every_n') {
      repeatValue = String(Math.max(1, Number($('fieldRepeatVal').value) || 1));
    }

    const rawTags = $('fieldTags').value.trim();
    const parsedTags = rawTags ? rawTags.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`)) : [];
    const allTags = [...new Set([...parsedTags, ...extractTags($('fieldNotes').value)])];

    const sphere = $('fieldSphere').value;
    const rawStatus = $('fieldStatus').value;
    const priority = $('fieldPriority').value;
    let deadline = $('fieldDeadline').value.trim();
    if (repeatType !== 'none' && !deadline) deadline = getOffsetDateStr(0);
    const time = $('fieldTime').value.trim();
    const doneChecked = $('fieldDone').checked;
    const wantCalendar = !$('fieldAddToCalendar').disabled && $('fieldAddToCalendar').checked;

    if (wantCalendar && !deadline) { $('fieldDeadline').focus(); return showToast('Вкажіть дедлайн для Календаря', 'error'); }

    const serializedNotes = serializeTaskMeta({
      cleanNotes: $('fieldNotes').value.trim(),
      checklist: state.modalChecklist,
      tags: allTags,
      pinned: $('fieldPinned').checked,
      repeat: { type: repeatType, value: repeatValue }
    });

    if (state.editingRow === null) {
      const synced = reconcileClientDoneStatus(false, rawStatus, false, 'Фокус', 'status');
      state.tasks.push({
        row: nextTempRow(), done: synced.done, sphere, task: taskTitle,
        status: synced.status, priority, deadline, time, notes: serializedNotes, inCalendar: wantCalendar
      });
      if (state.activeStatus !== synced.status && window.innerWidth < 960) state.activeStatus = synced.status;
      saveCache(); render(); closeModal('taskModal', () => resetDeleteConfirm(state)); audioFx.playSuccess();
      enqueueOfflineOrSend(state, {
        action: 'create',
        fields: { sphere, task: taskTitle, status: synced.status, priority, deadline, time, notes: serializedNotes, addToCalendar: wantCalendar },
        successText: 'Задачу створено'
      }, syncCallbacks);
      return;
    }

    const existing = findByRow(state.editingRow);
    if (!existing) return closeModal('taskModal', () => resetDeleteConfirm(state));
    const expectedTask = existing.task;
    const row = existing.row;
    const synced = reconcileClientDoneStatus(doneChecked, rawStatus, existing.done, existing.status, 'both');
    Object.assign(existing, {
      done: synced.done, sphere, task: taskTitle, status: synced.status,
      priority, deadline, time, notes: serializedNotes, inCalendar: existing.inCalendar || wantCalendar
    });
    saveCache(); render(); closeModal('taskModal', () => resetDeleteConfirm(state)); audioFx.playSuccess();
    enqueueOfflineOrSend(state, {
      action: 'update', targetRow: row, expectedTask,
      fields: { done: synced.done, sphere, task: taskTitle, status: synced.status, priority, deadline, time, notes: serializedNotes, addToCalendar: wantCalendar },
      successText: 'Зміни збережено'
    }, syncCallbacks);
  });

  $('btnDeleteTask').addEventListener('click', () => {
    if (state.editingRow === null) return;
    const delBtn = $('btnDeleteTask');
    if (!delBtn.classList.contains('is-confirming')) {
      delBtn.classList.add('is-confirming');
      delBtn.textContent = 'Точно видалити?';
      state.deleteConfirmTimer = setTimeout(() => resetDeleteConfirm(state), 3200);
      return;
    }
    const target = findByRow(state.editingRow);
    if (!target) return closeModal('taskModal', () => resetDeleteConfirm(state));

    const removedCopy = structuredClone(target);
    const deleteKey = `${removedCopy.row}_${Date.now()}`;
    state.tasks = state.tasks.filter((t) => t.row !== removedCopy.row);
    saveCache(); render(); closeModal('taskModal', () => resetDeleteConfirm(state)); audioFx.playAlert();

    const timerId = setTimeout(() => {
      pendingDeleteTimers.delete(deleteKey);
      enqueueOfflineOrSend(state, {
        action: 'delete', targetRow: removedCopy.row, expectedTask: removedCopy.task, fields: {}, successText: 'Задачу видалено'
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
          saveCache(); render(); audioFx.playClick();
          showToast('Видалення скасовано', 'success');
        }
      }
    });
  });

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cleanUrl = safeApiUrl($('fieldApiUrl').value);
    const pin = $('fieldPin').value.trim();
    const manualSheet = safeSheetUrl($('fieldSheetUrl').value);
    if (!cleanUrl) { $('fieldApiUrl').focus(); return showToast('Вкажіть URL Google Apps Script (script.google.com)', 'error'); }
    if (!pin) { $('fieldPin').focus(); return showToast('Введіть секретний PIN', 'error'); }

    state.config = { url: cleanUrl, pin, sheetUrl: manualSheet || state.config.sheetUrl || '' };
    saveJson(STORAGE_CONFIG, state.config);

    const btn = $('btnSaveSettings');
    btn.disabled = true; btn.textContent = 'Перевірка...';
    const ok = await refreshFromServer(true);
    btn.disabled = false; btn.textContent = 'Зберегти і підключити';
    if (ok) {
      render(); closeModal('settingsModal', () => resetLogoutConfirm(state));
      audioFx.playSuccess(); showToast('Таблицю підключено', 'success');
    }
  });

  $('btnSyncAllCalendar').addEventListener('click', () => {
    if (!ensureConfigured()) return;
    const pendingCount = state.tasks.filter((t) => !t.done && !t.inCalendar && t.deadline).length;
    if (!pendingCount) return showToast('Немає активних задач із дедлайном без Календаря');
    state.tasks.forEach((t) => { if (!t.done && !t.inCalendar && t.deadline) t.inCalendar = true; });
    saveCache(); render(); closeModal('settingsModal', () => resetLogoutConfirm(state));
    enqueueOfflineOrSend(state, { action: 'syncCalendar', targetRow: null, fields: {}, successText: `Додано подій у Календар: ${pendingCount}` }, syncCallbacks);
  });

  $('btnLogoutDevice').addEventListener('click', () => {
    const btn = $('btnLogoutDevice');
    if (!btn.classList.contains('is-confirming')) {
      btn.classList.add('is-confirming');
      btn.textContent = 'Підтвердити очищення?';
      state.logoutConfirmTimer = setTimeout(() => resetLogoutConfirm(state), 3200);
      return;
    }
    localStorage.removeItem(STORAGE_CONFIG);
    localStorage.removeItem(STORAGE_CACHE);
    localStorage.removeItem(STORAGE_QUEUE);
    state.config = { url: '', pin: '', sheetUrl: '' };
    state.tasks = []; state.pendingQueue = []; state.lastSyncAt = null;
    setLastServerSnapshot(null); savePendingQueue([]); render();
    openSettingsModal(ctx);
    setSyncIndicator('', 'Не підключено');
    showToast('Дані та PIN видалено з цього пристрою', 'success');
  });

  $('btnTogglePin').addEventListener('click', (e) => {
    const input = $('fieldPin');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Сховати' : 'Показати';
  });

  document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(btn.dataset.close, () => resetDeleteConfirm(state))));
  document.querySelectorAll('.modal-backdrop').forEach((bd) => bd.addEventListener('click', (e) => { if (e.target === bd) closeModal(bd.id, () => resetDeleteConfirm(state)); }));
}
