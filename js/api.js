import { STORAGE_QUEUE, loadJson, saveJson, safeApiUrl } from './utils.js';

let mutationChain = Promise.resolve();
let lastServerSnapshot = null;
let lastJournalSnapshot = null;
let lastArchivedSnapshot = null;

export function setLastServerSnapshot(tasks) {
  lastServerSnapshot = Array.isArray(tasks) ? tasks : null;
}

export function loadPendingQueue() {
  const list = loadJson(STORAGE_QUEUE, []);
  return Array.isArray(list) ? list : [];
}

export function savePendingQueue(queue) {
  saveJson(STORAGE_QUEUE, queue);
}

export function hasValidConfig(config) {
  return Boolean(safeApiUrl(config && config.url) && String((config && config.pin) || '').trim());
}

export function resolveRowNumber(targetRow, expectedTask, serverTasks) {
  if (!Array.isArray(serverTasks)) return targetRow;
  const exact = serverTasks.find((t) => t.row === targetRow && t.task === expectedTask);
  if (exact) return exact.row;
  const byName = serverTasks.find((t) => t.task === expectedTask);
  return byName ? byName.row : targetRow;
}

export async function apiPost(config, payload) {
  const endpoint = safeApiUrl(config && config.url);
  if (!endpoint) throw new Error('Вкажіть коректний URL Google Apps Script (script.google.com)');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, pin: config.pin }),
    redirect: 'follow',
    cache: 'no-store'
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.ok) {
    const msg = data && data.error === 'Unauthorized'
      ? 'Невірний PIN-код'
      : (data && data.error) || 'Не вдалося виконати запит';
    const err = new Error(msg);
    if (data && Array.isArray(data.tasks)) err.serverTasks = data.tasks;
    err.isServerError = true;
    throw err;
  }
  return data;
}

export async function apiListTasks(config) {
  const data = await apiPost(config, { action: 'list' });
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const archived = Array.isArray(data.archived) ? data.archived : [];
  lastServerSnapshot = tasks;
  return {
    tasks,
    archived,
    sheetUrl: data.sheetUrl || '',
    hasGeminiKey: Boolean(data.hasGeminiKey),
    telegram: data.telegram || null,
    journal: data.journal || null
  };
}

function buildItemPayload(item) {
  if (
    item.action === 'create' ||
    item.action === 'archiveDone' ||
    item.action === 'saveJournalDay' ||
    item.action === 'saveJournalMeta' ||
    (item.action === 'syncCalendar' && item.targetRow == null)
  ) {
    return { action: item.action, ...item.fields };
  }
  return {
    action: item.action,
    row: resolveRowNumber(item.targetRow, item.expectedTask, lastServerSnapshot),
    expectedTask: item.expectedTask,
    ...item.fields
  };
}

export function enqueueOfflineOrSend(state, item, callbacks) {
  const queueItem = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    action: item.action,
    targetRow: item.targetRow ?? null,
    expectedTask: item.expectedTask ?? '',
    fields: item.fields || {},
    successText: item.successText || ''
  };

  // Дедуплікація черги для частих автозбережень щоденника
  const startIdx = state.inFlightCount > 0 ? 1 : 0;
  let merged = false;
  if (queueItem.action === 'saveJournalDay' || queueItem.action === 'saveJournalMeta') {
    for (let i = startIdx; i < state.pendingQueue.length; i++) {
      const existing = state.pendingQueue[i];
      if (existing.action !== queueItem.action) continue;
      if (queueItem.action === 'saveJournalMeta' || existing.fields?.date === queueItem.fields?.date) {
        existing.fields = queueItem.fields;
        existing.successText = queueItem.successText;
        merged = true;
        break;
      }
    }
  }
  if (!merged) state.pendingQueue.push(queueItem);

  savePendingQueue(state.pendingQueue);
  callbacks.onQueueChange();

  if (!navigator.onLine) {
    state.queueBlocked = true;
    callbacks.onQueueChange();
    callbacks.onOfflineQueued();
    return Promise.resolve(false);
  }

  return flushQueue(state, callbacks);
}

export function flushQueue(state, callbacks) {
  if (!hasValidConfig(state.config) || !navigator.onLine || state.pendingQueue.length === 0) {
    return Promise.resolve(false);
  }

  mutationChain = mutationChain.catch(() => {}).then(async () => {
    let syncedAny = false;
    let tasksChanged = false;
    while (state.pendingQueue.length > 0) {
      if (!navigator.onLine) {
        state.queueBlocked = true;
        callbacks.onQueueChange();
        callbacks.onSyncIndicator('error', `Офлайн: у черзі ${state.pendingQueue.length}`);
        break;
      }

      const current = state.pendingQueue[0];
      state.inFlightCount++;
      callbacks.onSyncIndicator('syncing', 'Синхронізація змін...');

      try {
        const data = await apiPost(state.config, buildItemPayload(current));
        state.queueBlocked = false;
        if (Array.isArray(data.tasks)) {
          lastServerSnapshot = data.tasks;
          tasksChanged = true;
        }
        if (Array.isArray(data.archivedTasks)) lastArchivedSnapshot = data.archivedTasks;
        if (data.journal) lastJournalSnapshot = data.journal;
        if (data.sheetUrl && callbacks.onSheetUrl) callbacks.onSheetUrl(data.sheetUrl);

        state.pendingQueue.shift();
        savePendingQueue(state.pendingQueue);
        state.lastSyncAt = Date.now();
        syncedAny = true;

        if (data.spawnedDate) {
          callbacks.onToast(`Створено наступне повторення на ${data.spawnedDate}`, 'success');
        } else if (current.action === 'archiveDone' && data.archived !== undefined) {
          callbacks.onToast(`Перенесено в аркуш «Архів»: ${data.archived}`, 'success');
        } else if (current.successText) {
          const msg = current.action === 'syncCalendar' && current.targetRow == null && data.synced !== undefined
            ? `Додано подій у Календар: ${data.synced}`
            : current.successText;
          callbacks.onToast(msg, 'success');
        }
        callbacks.onQueueChange();
      } catch (err) {
        if (!err.isServerError) {
          state.queueBlocked = true;
          callbacks.onQueueChange();
          callbacks.onSyncIndicator('error', `Немає зв’язку: у черзі ${state.pendingQueue.length}`);
          if (navigator.onLine) callbacks.onToast('Немає зв’язку з таблицею. Зміни в офлайн-черзі.', 'error');
          break;
        }
        state.pendingQueue.shift();
        savePendingQueue(state.pendingQueue);
        if (err.serverTasks) {
          lastServerSnapshot = err.serverTasks;
          state.tasks = err.serverTasks;
          callbacks.onTasksUpdated();
        }
        callbacks.onSyncIndicator('error', err.message || 'Помилка синхронізації');
        callbacks.onToast(err.message || 'Помилка синхронізації', 'error');
        callbacks.onQueueChange();
      } finally {
        state.inFlightCount = Math.max(0, state.inFlightCount - 1);
      }
    }

    if (state.pendingQueue.length === 0) {
      state.queueBlocked = false;
      callbacks.onQueueChange();
      if (tasksChanged && lastServerSnapshot) {
        state.tasks = lastServerSnapshot;
        callbacks.onTasksUpdated();
      }
      if (lastJournalSnapshot && callbacks.onJournalUpdated) {
        callbacks.onJournalUpdated(lastJournalSnapshot);
        lastJournalSnapshot = null;
      }
      if (lastArchivedSnapshot && callbacks.onArchivedUpdated) {
        callbacks.onArchivedUpdated(lastArchivedSnapshot);
        lastArchivedSnapshot = null;
      }
      callbacks.onSyncIndicator('ok', 'Синхронізовано');
    }
    return syncedAny;
  });

  return mutationChain;
}
