(() => {
  'use strict';

  const STORAGE_CONFIG = 'tasks_pwa_config_v1';
  const STORAGE_CACHE = 'tasks_pwa_cache_v1';
  const STATUS_COLUMNS = ['В роботі', 'Цей тиждень', 'Беклог', 'Готово'];
  const SPHERES = ['Усі', 'Крипта', 'Навчання', 'Життя'];
  const PRIORITY_WEIGHT = { 'Високий': 1, 'Середній': 2, 'Низький': 3 };
  const MONTHS_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];

  const $ = (id) => document.getElementById(id);

  const state = {
    config: loadJson(STORAGE_CONFIG, { url: '', pin: '' }),
    tasks: [],
    lastSyncAt: null,
    activeSphere: 'Усі',
    activeStatus: 'В роботі',
    editingRow: null,
    deleteConfirmTimer: null,
    inFlightCount: 0
  };

  let mutationChain = Promise.resolve();
  let lastServerSnapshot = null;
  let tempRowSeq = -1;

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeUrl(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))) {
        return parsed.href;
      }
    } catch (_) {}
    return '';
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveCache() {
    try {
      localStorage.setItem(STORAGE_CACHE, JSON.stringify({ tasks: state.tasks, lastSyncAt: state.lastSyncAt }));
    } catch (_) {}
  }

  function getTodayLocal() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`
    };
  }

  function isTaskOverdue(task, nowInfo) {
    if (task.done || !task.deadline) return false;
    if (task.deadline < nowInfo.date) return true;
    return task.deadline === nowInfo.date && Boolean(task.time) && task.time < nowInfo.time;
  }

  function formatDeadlineLabel(deadline, time, todayDate) {
    if (!deadline) return '';
    let dayPart = deadline;
    if (deadline === todayDate) {
      dayPart = 'Сьогодні';
    } else {
      const p = deadline.split('-').map(Number);
      if (p.length === 3 && !p.some(Number.isNaN)) {
        const tom = new Date();
        tom.setDate(tom.getDate() + 1);
        const tomStr = `${tom.getFullYear()}-${String(tom.getMonth() + 1).padStart(2, '0')}-${String(tom.getDate()).padStart(2, '0')}`;
        dayPart = deadline === tomStr ? 'Завтра' : `${p[2]} ${MONTHS_SHORT[p[1] - 1] || ''}`;
      }
    }
    return time ? `${dayPart}, ${time}` : dayPart;
  }

  function reconcileClientDoneStatus(done, status, prevDone, prevStatus, changedField) {
    if (changedField === 'done') {
      return done ? { done: true, status: 'Готово' } : { done: false, status: prevStatus === 'Готово' ? 'В роботі' : prevStatus };
    }
    if (changedField === 'status') {
      return status === 'Готово' ? { done: true, status: 'Готово' } : { done: false, status };
    }
    return (done || status === 'Готово') ? { done: true, status: 'Готово' } : { done: false, status };
  }

  /* ======================== Мережа та черга запитів ======================== */

  function setSyncIndicator(mode, title) {
    const dot = $('syncDot');
    dot.className = 'sync-dot' + (mode ? ` is-${mode}` : '');
    if (title) dot.title = title;
    $('btnRefresh').classList.toggle('is-spinning', mode === 'syncing');
  }

  function updateLastSyncText() {
    if (!state.lastSyncAt) {
      $('lastSyncLabel').textContent = 'Не синхронізовано';
      return;
    }
    const dt = new Date(state.lastSyncAt);
    $('lastSyncLabel').textContent = `Оновлено о ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  }

  function hasValidConfig() {
    return Boolean(safeUrl(state.config.url) && String(state.config.pin || '').trim());
  }

  async function apiGetTasks() {
    const endpoint = safeUrl(state.config.url);
    if (!endpoint) throw new Error('Не вказано коректний Web App URL');
    const sep = endpoint.includes('?') ? '&' : '?';
    const res = await fetch(`${endpoint}${sep}pin=${encodeURIComponent(state.config.pin)}&_t=${Date.now()}`, {
      method: 'GET', redirect: 'follow', cache: 'no-store'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.ok) {
      throw new Error(data && data.error === 'Unauthorized' ? 'Невірний PIN-код' : (data && data.error) || 'Помилка відповіді сервера');
    }
    return Array.isArray(data.tasks) ? data.tasks : [];
  }

  async function apiPost(payload) {
    const endpoint = safeUrl(state.config.url);
    if (!endpoint) throw new Error('Не вказано коректний Web App URL');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, pin: state.config.pin }),
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.ok) {
      const err = new Error(data && data.error === 'Unauthorized' ? 'Невірний PIN-код' : (data && data.error) || 'Не вдалося зберегти зміни');
      if (data && Array.isArray(data.tasks)) err.serverTasks = data.tasks;
      throw err;
    }
    return data;
  }

  function enqueueMutation(payloadBuilder, snapshot, onSuccessToast) {
    if (!hasValidConfig()) {
      state.tasks = snapshot;
      renderAll();
      populateSettingsModal();
      openModal('settingsModal');
      showToast('Спочатку підключіть таблицю у налаштуваннях', 'error');
      return;
    }
    if (!navigator.onLine) {
      state.tasks = snapshot;
      renderAll();
      showToast('Немає інтернету. Зміни доступні після підключення.', 'error');
      return;
    }

    state.inFlightCount++;
    setSyncIndicator('syncing', 'Збереження у Google Таблицю...');

    mutationChain = mutationChain.catch(() => {}).then(async () => {
      try {
        const data = await apiPost(payloadBuilder(lastServerSnapshot));
        if (Array.isArray(data.tasks)) lastServerSnapshot = data.tasks;
        state.lastSyncAt = Date.now();
        if (state.inFlightCount === 1 && lastServerSnapshot) {
          state.tasks = lastServerSnapshot;
          saveCache();
          renderAll();
        }
        if (onSuccessToast) onSuccessToast(data);
        setSyncIndicator('ok', 'Синхронізовано');
        updateLastSyncText();
      } catch (err) {
        state.tasks = err.serverTasks || snapshot;
        saveCache();
        renderAll();
        setSyncIndicator('error', err.message || 'Помилка синхронізації');
        showToast(err.message || 'Помилка збереження. Стан відновлено.', 'error');
      } finally {
        state.inFlightCount = Math.max(0, state.inFlightCount - 1);
      }
    });
  }

  async function refreshFromServer(silent = false) {
    if (!hasValidConfig()) {
      populateSettingsModal();
      openModal('settingsModal');
      return false;
    }
    if (!navigator.onLine) {
      setSyncIndicator('error', 'Офлайн: показано збережений кеш');
      if (!silent) showToast('Офлайн: показано кешовані задачі', 'error');
      return false;
    }

    setSyncIndicator('syncing', 'Оновлення даних...');
    try {
      const fresh = await apiGetTasks();
      lastServerSnapshot = fresh;
      if (state.inFlightCount === 0) {
        state.tasks = fresh;
        state.lastSyncAt = Date.now();
        saveCache();
        renderAll();
      }
      setSyncIndicator('ok', 'Синхронізовано');
      updateLastSyncText();
      if (!silent) showToast('Список задач оновлено', 'success');
      return true;
    } catch (err) {
      setSyncIndicator('error', err.message || 'Помилка з’єднання');
      showToast(err.message || 'Не вдалося завантажити задачі', 'error');
      return false;
    }
  }

  /* ======================== Сортування та рендеринг ======================== */

  function sortColumnTasks(tasks, status) {
    const copy = tasks.slice();
    if (status === 'Готово') return copy.sort((a, b) => b.row - a.row);
    return copy.sort((a, b) => {
      const aHas = Boolean(a.deadline), bHas = Boolean(b.deadline);
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && bHas && a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
      if (aHas && bHas && (a.time || '') !== (b.time || '')) {
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time < b.time ? -1 : 1;
      }
      const pw = (PRIORITY_WEIGHT[a.priority] || 2) - (PRIORITY_WEIGHT[b.priority] || 2);
      return pw !== 0 ? pw : b.row - a.row;
    });
  }

  function renderAll() {
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
    $('statOverduePill').classList.toggle('has-overdue', overdueCount > 0);

    document.querySelectorAll('#statusTabs .status-tab').forEach((tab) => {
      const st = tab.dataset.status;
      tab.classList.toggle('is-active', st === state.activeStatus);
      const countEl = tab.querySelector('[data-status-count]');
      if (countEl) countEl.textContent = String(bySphere.filter((t) => t.status === st).length);
    });

    $('board').innerHTML = STATUS_COLUMNS.map((status) => {
      const colTasks = sortColumnTasks(bySphere.filter((t) => t.status === status), status);
      const cardsHtml = colTasks.length
        ? `<div class="task-list">${colTasks.map((t) => renderTaskCard(t, nowInfo)).join('')}</div>`
        : renderEmptyColumn(status);
      return `
        <section class="column${status === state.activeStatus ? ' is-active' : ''}" data-column="${escapeHtml(status)}">
          <div class="column-head">
            <h2 class="column-title">${escapeHtml(status)}</h2>
            <span class="tab-badge">${colTasks.length}</span>
          </div>
          ${cardsHtml}
        </section>`;
    }).join('');
  }

  function renderEmptyColumn(status) {
    if (!hasValidConfig()) {
      return `<div class="empty-state"><p>Таблицю ще не підключено.</p><button type="button" class="btn btn-secondary" data-action="open-settings">Відкрити налаштування</button></div>`;
    }
    const text = status === 'Готово' ? 'Виконаних задач у цій вибірці ще немає.' : `У колонці «${escapeHtml(status)}» зараз порожньо.`;
    return `<div class="empty-state"><p>${text}</p></div>`;
  }

  function renderTaskCard(task, nowInfo) {
    const overdue = isTaskOverdue(task, nowInfo);
    const isToday = !task.done && !overdue && task.deadline === nowInfo.date;
    const dlLabel = formatDeadlineLabel(task.deadline, task.time, nowInfo.date);
    const dlHtml = dlLabel
      ? `<span class="badge badge-deadline${overdue ? ' is-overdue' : isToday ? ' is-today' : ''}">${escapeHtml(dlLabel)}</span>`
      : '';
    const opts = STATUS_COLUMNS.map((st) => `<option value="${escapeHtml(st)}"${st === task.status ? ' selected' : ''}>${escapeHtml(st)}</option>`).join('');
    const calCtrl = task.inCalendar
      ? `<span class="cal-synced" title="Додано в Google Календар"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>Календар</span>`
      : `<button type="button" class="cal-btn" data-action="sync-cal" data-row="${task.row}" title="Додати в Google Календар">+ Календар</button>`;

    return `
      <article class="task-card${task.done ? ' is-done' : ''}" data-row="${task.row}" data-priority="${escapeHtml(task.priority)}">
        <button type="button" class="task-check" data-action="toggle-done" data-row="${task.row}" aria-label="Перемкнути виконання">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>
        </button>
        <div class="task-main">
          <div class="task-title-row"><h3 class="task-title">${escapeHtml(task.task)}</h3></div>
          ${task.notes ? `<p class="task-notes">${escapeHtml(task.notes)}</p>` : ''}
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

  /* ======================== Операції та форми ======================== */

  const findTaskByRow = (row) => state.tasks.find((t) => t.row === Number(row));

  function resolveRowNumber(targetRow, expectedTask, serverTasks) {
    if (!Array.isArray(serverTasks)) return targetRow;
    const exact = serverTasks.find((t) => t.row === targetRow && t.task === expectedTask);
    if (exact) return exact.row;
    const byName = serverTasks.find((t) => t.task === expectedTask);
    return byName ? byName.row : targetRow;
  }

  function toggleTaskDone(row) {
    const target = findTaskByRow(row);
    if (!target) return;
    if (target.row < 0) return showToast('Зачекайте завершення створення задачі', 'error');

    const snapshot = structuredClone(state.tasks);
    const expectedTask = target.task;
    const next = reconcileClientDoneStatus(!target.done, target.status, target.done, target.status, 'done');
    target.done = next.done;
    target.status = next.status;
    saveCache();
    renderAll();

    enqueueMutation((srv) => ({ action: 'update', row: resolveRowNumber(row, expectedTask, srv), expectedTask, done: next.done }), snapshot);
  }

  function quickChangeStatus(row, newStatus) {
    const target = findTaskByRow(row);
    if (!target || target.status === newStatus) return;
    if (target.row < 0) {
      renderAll();
      return showToast('Зачекайте завершення створення задачі', 'error');
    }

    const snapshot = structuredClone(state.tasks);
    const expectedTask = target.task;
    const next = reconcileClientDoneStatus(target.done, newStatus, target.done, target.status, 'status');
    target.done = next.done;
    target.status = next.status;
    saveCache();
    renderAll();

    enqueueMutation((srv) => ({ action: 'update', row: resolveRowNumber(row, expectedTask, srv), expectedTask, status: next.status }), snapshot);
  }

  function syncCardToCalendar(row) {
    const target = findTaskByRow(row);
    if (!target || target.inCalendar) return;
    if (target.row < 0) return showToast('Зачекайте завершення створення задачі', 'error');
    if (!target.deadline) {
      openTaskModal(target, true);
      return showToast('Вкажіть дедлайн, щоб додати задачу в Календар', 'error');
    }

    const snapshot = structuredClone(state.tasks);
    const expectedTask = target.task;
    target.inCalendar = true;
    saveCache();
    renderAll();

    enqueueMutation(
      (srv) => ({ action: 'syncCalendar', row: resolveRowNumber(row, expectedTask, srv), expectedTask }),
      snapshot,
      () => showToast('Подію створено в Google Календарі', 'success')
    );
  }

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) {
    $(id).hidden = true;
    resetDeleteConfirm();
  }

  function resetDeleteConfirm() {
    if (state.deleteConfirmTimer) clearTimeout(state.deleteConfirmTimer);
    state.deleteConfirmTimer = null;
    const delBtn = $('btnDeleteTask');
    delBtn.classList.remove('is-confirming');
    delBtn.textContent = 'Видалити';
  }

  function openTaskModal(task = null, focusDeadline = false) {
    if (task && task.row < 0) return showToast('Зачекайте завершення створення задачі', 'error');
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
    $('calendarToggleText').textContent = isEdit ? (task.inCalendar ? 'Вже в Календарі' : 'Додати в Календар') : 'Одразу в Календар';
    $('btnDeleteTask').hidden = !isEdit;

    openModal('taskModal');
    setTimeout(() => $(focusDeadline ? 'fieldDeadline' : 'fieldTask').focus(), 40);
  }

  function handleTaskFormSubmit(e) {
    e.preventDefault();
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

    const snapshot = structuredClone(state.tasks);

    if (state.editingRow === null) {
      const synced = reconcileClientDoneStatus(false, rawStatus, false, 'В роботі', 'status');
      state.tasks.push({
        row: tempRowSeq--, done: synced.done, sphere, task: taskTitle,
        status: synced.status, priority, deadline, time, notes, inCalendar: wantCalendar
      });
      if (state.activeStatus !== synced.status && window.innerWidth < 960) state.activeStatus = synced.status;
      saveCache();
      renderAll();
      closeModal('taskModal');

      enqueueMutation(
        () => ({ action: 'create', sphere, task: taskTitle, status: synced.status, priority, deadline, time, notes, addToCalendar: wantCalendar }),
        snapshot,
        () => showToast('Задачу створено', 'success')
      );
      return;
    }

    const existing = findTaskByRow(state.editingRow);
    if (!existing) return closeModal('taskModal');

    const expectedTask = existing.task;
    const row = existing.row;
    const synced = reconcileClientDoneStatus(doneChecked, rawStatus, existing.done, existing.status, 'both');
    Object.assign(existing, {
      done: synced.done, sphere, task: taskTitle, status: synced.status,
      priority, deadline, time, notes, inCalendar: existing.inCalendar || wantCalendar
    });
    saveCache();
    renderAll();
    closeModal('taskModal');

    enqueueMutation(
      (srv) => ({
        action: 'update', row: resolveRowNumber(row, expectedTask, srv), expectedTask,
        done: synced.done, sphere, task: taskTitle, status: synced.status, priority, deadline, time, notes, addToCalendar: wantCalendar
      }),
      snapshot,
      () => showToast('Зміни збережено', 'success')
    );
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
    if (!target) return closeModal('taskModal');

    const snapshot = structuredClone(state.tasks);
    const expectedTask = target.task, rowToDelete = target.row;
    state.tasks = state.tasks.filter((t) => t.row !== rowToDelete);
    saveCache();
    renderAll();
    closeModal('taskModal');

    enqueueMutation(
      (srv) => ({ action: 'delete', row: resolveRowNumber(rowToDelete, expectedTask, srv), expectedTask }),
      snapshot,
      () => showToast('Задачу видалено', 'success')
    );
  }

  function populateSettingsModal() {
    $('fieldApiUrl').value = state.config.url || '';
    $('fieldPin').value = state.config.pin || '';
    updateLastSyncText();
  }

  async function handleSettingsSubmit(e) {
    e.preventDefault();
    const cleanUrl = safeUrl($('fieldApiUrl').value);
    const pin = $('fieldPin').value.trim();
    if (!cleanUrl) { $('fieldApiUrl').focus(); return showToast('Введіть коректний https:// Web App URL', 'error'); }
    if (!pin) { $('fieldPin').focus(); return showToast('Введіть секретний PIN', 'error'); }

    state.config = { url: cleanUrl, pin };
    localStorage.setItem(STORAGE_CONFIG, JSON.stringify(state.config));

    const btn = $('btnSaveSettings');
    btn.disabled = true;
    btn.textContent = 'Перевірка...';
    const ok = await refreshFromServer(true);
    btn.disabled = false;
    btn.textContent = 'Зберегти і підключити';
    if (ok) {
      closeModal('settingsModal');
      showToast('Таблицю підключено', 'success');
    }
  }

  function handleBulkCalendarSync() {
    if (!hasValidConfig()) return showToast('Спочатку збережіть URL та PIN', 'error');
    const pendingCount = state.tasks.filter((t) => !t.done && !t.inCalendar && t.deadline).length;
    if (pendingCount === 0) return showToast('Немає активних задач із дедлайном без Календаря');

    const snapshot = structuredClone(state.tasks);
    state.tasks.forEach((t) => { if (!t.done && !t.inCalendar && t.deadline) t.inCalendar = true; });
    saveCache();
    renderAll();
    closeModal('settingsModal');

    enqueueMutation(
      () => ({ action: 'syncCalendar' }),
      snapshot,
      (res) => showToast(`Додано подій у Календар: ${res.synced ?? pendingCount}`, 'success')
    );
  }

  function showToast(message, kind = '') {
    const item = document.createElement('div');
    item.className = 'toast' + (kind ? ` is-${kind}` : '');
    item.textContent = message;
    $('toastStack').appendChild(item);
    setTimeout(() => item.remove(), 3200);
  }

  function bindEvents() {
    $('sphereBar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sphere]');
      if (btn) { state.activeSphere = btn.dataset.sphere; renderAll(); }
    });
    $('statusTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (btn) { state.activeStatus = btn.dataset.status; renderAll(); }
    });

    const board = $('board');
    board.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="open-settings"]')) { populateSettingsModal(); openModal('settingsModal'); return; }
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

    $('btnAdd').addEventListener('click', () => openTaskModal(null));
    $('btnRefresh').addEventListener('click', () => refreshFromServer(false));
    $('btnSettings').addEventListener('click', () => { populateSettingsModal(); openModal('settingsModal'); });
    $('fieldDone').addEventListener('change', (e) => {
      const st = $('fieldStatus');
      if (e.target.checked) st.value = 'Готово';
      else if (st.value === 'Готово') st.value = 'В роботі';
    });
    $('fieldStatus').addEventListener('change', (e) => { $('fieldDone').checked = e.target.value === 'Готово'; });
    $('taskForm').addEventListener('submit', handleTaskFormSubmit);
    $('btnDeleteTask').addEventListener('click', handleDeleteClick);
    $('settingsForm').addEventListener('submit', handleSettingsSubmit);
    $('btnSyncAllCalendar').addEventListener('click', handleBulkCalendarSync);

    $('btnTogglePin').addEventListener('click', (e) => {
      const input = $('fieldPin');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      e.currentTarget.textContent = show ? 'Сховати' : 'Показати';
    });

    document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
    document.querySelectorAll('.modal-backdrop').forEach((bd) => bd.addEventListener('click', (e) => { if (e.target === bd) closeModal(bd.id); }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal('taskModal'); closeModal('settingsModal'); } });
    window.addEventListener('online', () => refreshFromServer(true));
  }

  function init() {
    const cached = loadJson(STORAGE_CACHE, null);
    if (cached && Array.isArray(cached.tasks)) {
      state.tasks = cached.tasks;
      state.lastSyncAt = cached.lastSyncAt || null;
    }
    bindEvents();
    renderAll();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    if (!hasValidConfig()) { populateSettingsModal(); openModal('settingsModal'); }
    else refreshFromServer(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
