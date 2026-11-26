/**
 * @OnlyCurrentDoc
 * Бекенд Google Apps Script для менеджера задач (PWA) — v2.
 * Аркуш: «Задачі» (1-й рядок — заголовки, дані з 2-го рядка, стовпці A–I).
 * Безпека: POST-only (без PIN у URL), Script Properties, rate-limit у CacheService,
 * захист від формул у Sheets, LockService.
 */

const SHEET_NAME = 'Задачі';
const FALLBACK_SECRET_PIN = '1234'; // Використовується лише якщо PIN ще не задано в Script Properties
const PROP_PIN_KEY = 'SECRET_PIN';
const RATE_LIMIT_KEY = 'AUTH_FAIL_COUNT';
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SEC = 300; // 5 хвилин

const VALID_SPHERES = ['Крипта', 'Навчання', 'Життя'];
const VALID_STATUSES = ['Беклог', 'Цей тиждень', 'В роботі', 'Готово'];
const VALID_PRIORITIES = ['Високий', 'Середній', 'Низький'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Календар задач')
    .addItem('Синхронізувати активні задачі з Календарем', 'syncPendingTasksFromSheet')
    .addSeparator()
    .addItem('Встановити / змінити секретний PIN', 'promptSetSecretPin')
    .addItem('Скинути блокування невдалих входів', 'resetRateLimitFromSheet')
    .addToUi();
}

function promptSetSecretPin() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Секретний PIN / пароль',
    'Введіть новий пароль для PWA (рекомендовано 12–24 символи). Він збережеться у Script Properties і не пропаде при оновленні коду:',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const nextPin = String(res.getResponseText() || '').trim();
  if (nextPin.length < 4) {
    ui.alert('Пароль має містити щонайменше 4 символи.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty(PROP_PIN_KEY, nextPin);
  CacheService.getScriptCache().remove(RATE_LIMIT_KEY);
  ui.alert('Секретний PIN збережено у Script Properties. Тепер використовуйте його в PWA.');
}

function resetRateLimitFromSheet() {
  CacheService.getScriptCache().remove(RATE_LIMIT_KEY);
  SpreadsheetApp.getUi().alert('Лічильник невдалих спроб входу скинуто.');
}

function syncPendingTasksFromSheet() {
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    ui.alert('Таблиця зараз зайнята іншим запитом. Спробуйте за кілька секунд.');
    return;
  }
  try {
    const res = syncAllPendingToCalendar_(getTasksSheet_());
    ui.alert('Синхронізацію завершено. Додано подій у Календар: ' + res.synced);
  } catch (err) {
    ui.alert('Помилка синхронізації: ' + (err && err.message ? err.message : String(err)));
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  // Навмисно не приймаємо PIN у URL, щоб він не потрапляв в історію браузера та логи
  return jsonResponse_({ ok: false, error: 'Використовуйте POST-запит для доступу до API' });
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}');
  } catch (parseErr) {
    return jsonResponse_({ ok: false, error: 'Некоректний формат JSON у тілі запиту' });
  }

  const auth = checkAuthorization_(payload && payload.pin);
  if (!auth.ok) {
    return jsonResponse_({ ok: false, error: auth.error });
  }

  const action = String(payload.action || 'list').trim();

  if (action === 'list') {
    try {
      return jsonResponse_({ ok: true, tasks: readTasks_(getTasksSheet_()) });
    } catch (err) {
      return jsonResponse_({ ok: false, error: err && err.message ? err.message : 'Помилка читання таблиці' });
    }
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    return jsonResponse_({ ok: false, error: 'Сервер зайнятий, спробуйте ще раз' });
  }

  try {
    const sheet = getTasksSheet_();

    if (action === 'create') {
      const row = handleCreate_(sheet, payload);
      return jsonResponse_({ ok: true, row: row, tasks: readTasks_(sheet) });
    }

    if (action === 'update' || action === 'delete') {
      const mismatch = verifyExpectedTask_(sheet, payload.row, payload.expectedTask);
      if (mismatch) return jsonResponse_({ ok: false, error: mismatch, tasks: readTasks_(sheet) });
      if (action === 'update') handleUpdate_(sheet, payload);
      else sheet.deleteRow(validateRowIndex_(sheet, payload.row));
      return jsonResponse_({ ok: true, tasks: readTasks_(sheet) });
    }

    if (action === 'syncCalendar') {
      const hasRow = payload.row !== undefined && payload.row !== null && payload.row !== '';
      if (hasRow) {
        const mismatch = verifyExpectedTask_(sheet, payload.row, payload.expectedTask);
        if (mismatch) return jsonResponse_({ ok: false, error: mismatch, tasks: readTasks_(sheet) });
        const synced = syncSingleRowToCalendar_(sheet, Number(payload.row));
        return jsonResponse_({ ok: true, synced: synced, tasks: readTasks_(sheet) });
      }
      const batch = syncAllPendingToCalendar_(sheet);
      return jsonResponse_({ ok: true, synced: batch.synced, tasks: readTasks_(sheet) });
    }

    return jsonResponse_({ ok: false, error: 'Невідома дія: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err && err.message ? err.message : 'Помилка обробки запиту' });
  } finally {
    lock.releaseLock();
  }
}

/* ======================== Обробники операцій ======================== */

function handleCreate_(sheet, payload) {
  const rawTitle = String(payload.task || '').trim();
  if (!rawTitle) throw new Error('Назва задачі не може бути порожньою');

  const sphere = sanitizeEnum_(payload.sphere, VALID_SPHERES, 'Життя');
  const priority = sanitizeEnum_(payload.priority, VALID_PRIORITIES, 'Середній');
  const rawStatus = sanitizeEnum_(payload.status, VALID_STATUSES, 'В роботі');
  const synced = reconcileDoneStatus_(
    Boolean(payload.done), rawStatus, false, 'В роботі',
    payload.done !== undefined, payload.status !== undefined
  );

  const deadline = normalizeDateInput_(payload.deadline);
  const time = normalizeTimeInput_(payload.time);
  const rawNotes = String(payload.notes || '').trim();
  const wantCalendar = Boolean(payload.addToCalendar);

  if (wantCalendar && !deadline) {
    throw new Error('Вкажіть дедлайн, щоб додати задачу в Календар');
  }

  let inCalendar = Boolean(payload.inCalendar);
  if (wantCalendar) {
    createCalendarEvent_({ sphere: sphere, task: rawTitle, priority: priority, deadline: deadline, time: time, notes: rawNotes });
    inCalendar = true;
  }

  const nextRow = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(nextRow, 6, 1, 2).setNumberFormat('@');
  sheet.getRange(nextRow, 1, 1, 9).setValues([[
    synced.done,
    sphere,
    sanitizeSheetCell_(rawTitle),
    synced.status,
    priority,
    deadline,
    time,
    sanitizeSheetCell_(rawNotes),
    inCalendar
  ]]);
  sheet.getRange(nextRow, 1).insertCheckboxes();
  sheet.getRange(nextRow, 9).insertCheckboxes();
  return nextRow;
}

function handleUpdate_(sheet, payload) {
  const row = validateRowIndex_(sheet, payload.row);
  const tz = Session.getScriptTimeZone();
  const range = sheet.getRange(row, 1, 1, 9);
  const cur = range.getValues()[0];

  const prevDone = toBool_(cur[0]);
  const prevSphere = String(cur[1] || '').trim() || 'Життя';
  const prevTask = String(cur[2] || '').trim();
  const prevStatus = String(cur[3] || '').trim() || 'Беклог';
  const prevPriority = String(cur[4] || '').trim() || 'Середній';
  const prevDeadline = formatDateValue_(cur[5], tz);
  const prevTime = formatTimeValue_(cur[6], tz);
  const prevNotes = String(cur[7] || '');
  const prevInCalendar = toBool_(cur[8]);

  const hasDone = payload.done !== undefined;
  const hasStatus = payload.status !== undefined;
  const synced = reconcileDoneStatus_(
    hasDone ? Boolean(payload.done) : prevDone,
    hasStatus ? sanitizeEnum_(payload.status, VALID_STATUSES, prevStatus) : prevStatus,
    prevDone, prevStatus, hasDone, hasStatus
  );

  const nextTask = payload.task !== undefined ? String(payload.task || '').trim() : prevTask;
  if (!nextTask) throw new Error('Назва задачі не може бути порожньою');

  const nextSphere = payload.sphere !== undefined ? sanitizeEnum_(payload.sphere, VALID_SPHERES, prevSphere) : prevSphere;
  const nextPriority = payload.priority !== undefined ? sanitizeEnum_(payload.priority, VALID_PRIORITIES, prevPriority) : prevPriority;
  const nextDeadline = payload.deadline !== undefined ? normalizeDateInput_(payload.deadline) : prevDeadline;
  const nextTime = payload.time !== undefined ? normalizeTimeInput_(payload.time) : prevTime;
  const nextNotes = payload.notes !== undefined ? String(payload.notes || '').trim() : prevNotes;
  let nextInCalendar = payload.inCalendar !== undefined ? Boolean(payload.inCalendar) : prevInCalendar;

  if (payload.addToCalendar === true && !nextInCalendar) {
    if (!nextDeadline) throw new Error('Вкажіть дедлайн, щоб додати задачу в Календар');
    createCalendarEvent_({
      sphere: nextSphere, task: nextTask, priority: nextPriority,
      deadline: nextDeadline, time: nextTime, notes: nextNotes
    });
    nextInCalendar = true;
  }

  sheet.getRange(row, 6, 1, 2).setNumberFormat('@');
  range.setValues([[
    synced.done,
    nextSphere,
    sanitizeSheetCell_(nextTask),
    synced.status,
    nextPriority,
    nextDeadline,
    nextTime,
    sanitizeSheetCell_(nextNotes),
    nextInCalendar
  ]]);
}

function syncSingleRowToCalendar_(sheet, rowInput) {
  const row = validateRowIndex_(sheet, rowInput);
  const tz = Session.getScriptTimeZone();
  const r = sheet.getRange(row, 1, 1, 9).getValues()[0];
  const taskTitle = String(r[2] || '').trim();
  const deadline = formatDateValue_(r[5], tz);

  if (!taskTitle) throw new Error('Рядок не містить назви задачі');
  if (!deadline) throw new Error('Вкажіть дедлайн перед відправкою в Календар');
  if (toBool_(r[8])) return 0;

  createCalendarEvent_({
    sphere: String(r[1] || '').trim(),
    task: taskTitle,
    priority: String(r[4] || '').trim() || 'Середній',
    deadline: deadline,
    time: formatTimeValue_(r[6], tz),
    notes: String(r[7] || '').trim()
  });

  const calCell = sheet.getRange(row, 9);
  calCell.setValue(true);
  calCell.insertCheckboxes();
  return 1;
}

function syncAllPendingToCalendar_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { synced: 0 };

  const tz = Session.getScriptTimeZone();
  const rows = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  let syncedCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const done = toBool_(r[0]) || String(r[3] || '').trim() === 'Готово';
    const taskTitle = String(r[2] || '').trim();
    const deadline = formatDateValue_(r[5], tz);
    if (done || toBool_(r[8]) || !taskTitle || !deadline) continue;

    createCalendarEvent_({
      sphere: String(r[1] || '').trim(),
      task: taskTitle,
      priority: String(r[4] || '').trim() || 'Середній',
      deadline: deadline,
      time: formatTimeValue_(r[6], tz),
      notes: String(r[7] || '').trim()
    });

    const calCell = sheet.getRange(i + 2, 9);
    calCell.setValue(true);
    calCell.insertCheckboxes();
    syncedCount++;
  }
  return { synced: syncedCount };
}

/* ======================== Читання та Календар ======================== */

function readTasks_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const tz = Session.getScriptTimeZone();
  const rows = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const tasks = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const taskTitle = String(r[2] || '').trim();
    if (!taskTitle && !String(r[7] || '').trim()) continue;

    const rawDone = toBool_(r[0]);
    const rawStatus = String(r[3] || '').trim() || (rawDone ? 'Готово' : 'Беклог');
    const done = rawDone || rawStatus === 'Готово';

    tasks.push({
      row: i + 2,
      done: done,
      sphere: String(r[1] || '').trim() || 'Життя',
      task: taskTitle,
      status: done ? 'Готово' : rawStatus,
      priority: String(r[4] || '').trim() || 'Середній',
      deadline: formatDateValue_(r[5], tz),
      time: formatTimeValue_(r[6], tz),
      notes: String(r[7] || ''),
      inCalendar: toBool_(r[8])
    });
  }
  return tasks;
}

function createCalendarEvent_(item) {
  const parts = item.deadline.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error('Некоректна дата дедлайну: ' + item.deadline);
  }
  const title = item.sphere ? '[' + item.sphere + '] ' + item.task : item.task;
  const desc = [item.priority ? 'Пріоритет: ' + item.priority : '', item.notes || ''].filter(Boolean).join('\n\n');
  const cal = CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error('Не вдалося отримати основний Google Календар');

  let event;
  if (item.time) {
    const tp = item.time.split(':').map(Number);
    const start = new Date(parts[0], parts[1] - 1, parts[2], tp[0] || 0, tp[1] || 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    event = cal.createEvent(title, start, end, { description: desc });
  } else {
    event = cal.createAllDayEvent(title, new Date(parts[0], parts[1] - 1, parts[2]), { description: desc });
  }
  event.removeAllReminders();
  event.addPopupReminder(15);
  return event.getId();
}

/* ======================== Безпека та допоміжні функції ======================== */

function getConfiguredPin_() {
  const propPin = PropertiesService.getScriptProperties().getProperty(PROP_PIN_KEY);
  return propPin && String(propPin).trim() ? String(propPin).trim() : String(FALLBACK_SECRET_PIN || '');
}

function checkAuthorization_(pin) {
  const cache = CacheService.getScriptCache();
  const failCount = Number(cache.get(RATE_LIMIT_KEY) || 0);
  if (failCount >= RATE_LIMIT_MAX) {
    return { ok: false, error: 'Забагато невдалих спроб входу. Зачекайте 5 хвилин.' };
  }

  const expected = getConfiguredPin_();
  const actual = String(pin || '');
  const match = constantTimeEquals_(actual, expected);

  if (!match) {
    cache.put(RATE_LIMIT_KEY, String(failCount + 1), RATE_LIMIT_WINDOW_SEC);
    return { ok: false, error: 'Unauthorized' };
  }
  if (failCount > 0) cache.remove(RATE_LIMIT_KEY);
  return { ok: true };
}

function constantTimeEquals_(a, b) {
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sanitizeSheetCell_(val) {
  const str = String(val || '');
  if (!str) return '';
  return /^[=+\-@\t\r]/.test(str) ? "'" + str : str;
}

function getTasksSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Скрипт не прив’язаний до Google Таблиці');
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Аркуш "' + SHEET_NAME + '" не знайдено');
  return sheet;
}

function validateRowIndex_(sheet, rowInput) {
  const row = Number(rowInput);
  if (!Number.isInteger(row) || row < 2 || row > sheet.getLastRow()) {
    throw new Error('Рядок #' + rowInput + ' не існує або вже видалений');
  }
  return row;
}

function verifyExpectedTask_(sheet, rowInput, expectedTask) {
  const row = Number(rowInput);
  if (!Number.isInteger(row) || row < 2 || row > sheet.getLastRow()) {
    return 'Рядок у таблиці змінився. Список задач оновлено.';
  }
  if (expectedTask !== undefined && expectedTask !== null && String(expectedTask).trim() !== '') {
    const actual = String(sheet.getRange(row, 3).getValue() || '').trim();
    if (actual !== String(expectedTask).trim()) {
      return 'Порядок рядків у таблиці змінився. Список задач оновлено.';
    }
  }
  return '';
}

function reconcileDoneStatus_(nextDone, nextStatus, prevDone, prevStatus, hasDone, hasStatus) {
  if (hasDone && !hasStatus) {
    return nextDone
      ? { done: true, status: 'Готово' }
      : { done: false, status: prevStatus === 'Готово' ? 'В роботі' : prevStatus };
  }
  if (hasStatus && !hasDone) {
    return nextStatus === 'Готово' ? { done: true, status: 'Готово' } : { done: false, status: nextStatus };
  }
  if (nextDone && !prevDone) return { done: true, status: 'Готово' };
  if (nextStatus === 'Готово' && prevStatus !== 'Готово') return { done: true, status: 'Готово' };
  if (!nextDone && prevDone && nextStatus === 'Готово') return { done: false, status: 'В роботі' };
  if (nextStatus !== 'Готово' && prevStatus === 'Готово') return { done: false, status: nextStatus };
  return (nextDone || nextStatus === 'Готово')
    ? { done: true, status: 'Готово' }
    : { done: false, status: nextStatus };
}

function formatDateValue_(val, tz) {
  if (!val) return '';
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
  }
  return normalizeDateInput_(val);
}

function formatTimeValue_(val, tz) {
  if (!val && val !== 0) return '';
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, tz, 'HH:mm');
  }
  return normalizeTimeInput_(val);
}

function normalizeDateInput_(raw) {
  const m = String(raw || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}

function normalizeTimeInput_(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const hh = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function sanitizeEnum_(val, allowed, fallback) {
  const clean = String(val || '').trim();
  return allowed.indexOf(clean) !== -1 ? clean : fallback;
}

function toBool_(val) {
  return val === true || String(val).toLowerCase() === 'true';
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
