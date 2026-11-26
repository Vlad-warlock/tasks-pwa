/**
 * @OnlyCurrentDoc
 * Бекенд Google Apps Script для трекера задач (PWA) — v3 PRO.
 * Аркуші: «Задачі» (робочі задачі A–I), «Канбан і Дашборд» (аналітика в таблиці), «Архів» (автостворюваний).
 * Безпека: POST-only, Script Properties PIN, CacheService rate-limit, захист формул, LockService.
 */

const SHEET_NAME = 'Задачі';
const ARCHIVE_SHEET_NAME = 'Архів';
const FALLBACK_SECRET_PIN = '1234';
const PROP_PIN_KEY = 'SECRET_PIN';
const RATE_LIMIT_KEY = 'AUTH_FAIL_COUNT';
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SEC = 300;
const MIN_TEMPLATE_ROWS = 101; // Зберігаємо діапазон $C$2:$C$100 для формул «Канбан і Дашборд»

const VALID_SPHERES = ['Крипта', 'Навчання', 'Життя'];
const VALID_STATUSES = ['Sort', 'Short', 'Mid', 'Long', 'Фокус', 'Готово'];
const VALID_PRIORITIES = ['Високий', 'Середній', 'Низький'];
const LEGACY_STATUS_MAP = {
  'Беклог': 'Sort',
  'Цей тиждень': 'Mid',
  'В роботі': 'Фокус'
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Календар задач')
    .addItem('Синхронізувати активні задачі з Календарем', 'syncPendingTasksFromSheet')
    .addItem('Архівувати виконані задачі', 'archiveDoneFromSheet')
    .addSeparator()
    .addItem('Встановити / змінити секретний PIN', 'promptSetSecretPin')
    .addItem('Встановити Gemini API ключ (голос)', 'promptSetGeminiKey')
    .addItem('Скинути блокування невдалих входів', 'resetRateLimitFromSheet')
    .addToUi();
}

function promptSetSecretPin() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Секретний PIN / пароль',
    'Введіть новий пароль для PWA (рекомендовано 12–24 символи). Він збережеться у Script Properties:',
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
  ui.alert('Секретний PIN збережено у Script Properties.');
}

function resetRateLimitFromSheet() {
  CacheService.getScriptCache().remove(RATE_LIMIT_KEY);
  SpreadsheetApp.getUi().alert('Лічильник невдалих спроб входу скинуто.');
}

function syncPendingTasksFromSheet() {
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return ui.alert('Таблиця зайнята іншим запитом.');
  try {
    const res = syncAllPendingToCalendar_(getTasksSheet_());
    ui.alert('Синхронізовано подій у Календар: ' + res.synced);
  } catch (err) {
    ui.alert('Помилка: ' + (err && err.message ? err.message : String(err)));
  } finally {
    lock.releaseLock();
  }
}

function archiveDoneFromSheet() {
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return ui.alert('Таблиця зайнята іншим запитом.');
  try {
    const count = archiveCompletedTasks_(getTasksSheet_());
    ui.alert('Перенесено виконаних задач в аркуш «Архів»: ' + count);
  } catch (err) {
    ui.alert('Помилка архівації: ' + (err && err.message ? err.message : String(err)));
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return jsonResponse_({ ok: false, error: 'Використовуйте POST-запит для доступу до API' });
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}');
  } catch (_) {
    return jsonResponse_({ ok: false, error: 'Некоректний формат JSON у тілі запиту' });
  }

  const auth = checkAuthorization_(payload && payload.pin);
  if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });

  const action = String(payload.action || 'list').trim();

  if (action === 'list') {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = getTasksSheet_(ss);
      return jsonResponse_({
        ok: true,
        sheetUrl: ss.getUrl(),
        hasGeminiKey: hasGeminiKey_(),
        tasks: readTasks_(sheet),
        archived: readArchivedSummary_(ss),
        journal: readJournalPayload_(ss)
      });
    } catch (err) {
      return jsonResponse_({ ok: false, error: err && err.message ? err.message : 'Помилка читання таблиці' });
    }
  }

  if (action === 'voiceParse') {
    try {
      const voiceRes = handleVoiceParse_(payload);
      return jsonResponse_({ ok: true, transcript: voiceRes.transcript, tasks: voiceRes.tasks });
    } catch (err) {
      return jsonResponse_({ ok: false, error: err && err.message ? err.message : 'Помилка розпізнавання голосу' });
    }
  }

  if (action === 'setGeminiKey') {
    try {
      const keyRes = handleSetGeminiKey_(payload);
      return jsonResponse_({ ok: true, hasGeminiKey: keyRes.hasGeminiKey });
    } catch (err) {
      return jsonResponse_({ ok: false, error: err && err.message ? err.message : 'Не вдалося зберегти ключ' });
    }
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (_) {
    return jsonResponse_({ ok: false, error: 'Сервер зайнятий, спробуйте ще раз' });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = getTasksSheet_(ss);
    const sheetUrl = ss.getUrl();

    if (action === 'create') {
      const row = handleCreate_(sheet, payload);
      return jsonResponse_({ ok: true, row: row, sheetUrl: sheetUrl, tasks: readTasks_(sheet) });
    }

    if (action === 'update') {
      const mismatch = verifyExpectedTask_(sheet, payload.row, payload.expectedTask);
      if (mismatch) return jsonResponse_({ ok: false, error: mismatch, tasks: readTasks_(sheet) });
      const updRes = handleUpdate_(sheet, payload);
      return jsonResponse_({ ok: true, spawnedDate: updRes.spawnedDate || '', sheetUrl: sheetUrl, tasks: readTasks_(sheet) });
    }

    if (action === 'delete') {
      const mismatch = verifyExpectedTask_(sheet, payload.row, payload.expectedTask);
      if (mismatch) return jsonResponse_({ ok: false, error: mismatch, tasks: readTasks_(sheet) });
      deleteTaskRowSafe_(sheet, validateRowIndex_(sheet, payload.row));
      return jsonResponse_({ ok: true, sheetUrl: sheetUrl, tasks: readTasks_(sheet) });
    }

    if (action === 'archiveDone') {
      const archived = archiveCompletedTasks_(sheet);
      return jsonResponse_({ ok: true, archived: archived, archivedTasks: readArchivedSummary_(ss), sheetUrl: sheetUrl, tasks: readTasks_(sheet) });
    }

    if (action === 'syncCalendar') {
      const hasRow = payload.row !== undefined && payload.row !== null && payload.row !== '';
      if (hasRow) {
        const mismatch = verifyExpectedTask_(sheet, payload.row, payload.expectedTask);
        if (mismatch) return jsonResponse_({ ok: false, error: mismatch, tasks: readTasks_(sheet) });
        const synced = syncSingleRowToCalendar_(sheet, Number(payload.row));
        return jsonResponse_({ ok: true, synced: synced, sheetUrl: sheetUrl, tasks: readTasks_(sheet) });
      }
      const batch = syncAllPendingToCalendar_(sheet);
      return jsonResponse_({ ok: true, synced: batch.synced, sheetUrl: sheetUrl, tasks: readTasks_(sheet) });
    }

    if (action === 'saveJournalDay') {
      const journal = handleSaveJournalDay_(ss, payload);
      return jsonResponse_({ ok: true, sheetUrl: sheetUrl, journal: journal });
    }

    if (action === 'saveJournalMeta') {
      const journal = handleSaveJournalMeta_(ss, payload);
      return jsonResponse_({ ok: true, sheetUrl: sheetUrl, journal: journal });
    }

    return jsonResponse_({ ok: false, error: 'Невідома дія: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err && err.message ? err.message : 'Помилка обробки запиту' });
  } finally {
    lock.releaseLock();
  }
}

/* ======================== Обробники операцій ======================== */

function findFirstEmptyRow_(sheet) {
  const maxR = sheet.getLastRow();
  if (maxR < 2) return 2;
  const colC = sheet.getRange(2, 3, maxR - 1, 1).getValues();
  const colH = sheet.getRange(2, 8, maxR - 1, 1).getValues();
  for (let i = 0; i < colC.length; i++) {
    if (!String(colC[i][0] || '').trim() && !String(colH[i][0] || '').trim()) {
      return i + 2;
    }
  }
  return maxR + 1;
}

function ensureStatusValidation_(sheet, rowOpt) {
  const checkRow = Math.max(2, Number(rowOpt) || 2);
  const dv = sheet.getRange(checkRow, 4).getDataValidation();
  if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    const allowed = (dv.getCriteriaValues()[0] || []).map(String);
    const same = allowed.length === VALID_STATUSES.length && VALID_STATUSES.every(function(s, i) { return allowed[i] === s; });
    if (same) return;
  }

  const maxRows = Math.max(sheet.getMaxRows(), MIN_TEMPLATE_ROWS);
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const rangeD = sheet.getRange(2, 4, lastRow - 1, 1);
    const vals = rangeD.getValues();
    let changed = false;
    for (let i = 0; i < vals.length; i++) {
      const raw = String(vals[i][0] || '').trim();
      if (LEGACY_STATUS_MAP[raw]) {
        vals[i][0] = LEGACY_STATUS_MAP[raw];
        changed = true;
      }
    }
    if (changed) {
      rangeD.clearDataValidations();
      rangeD.setValues(vals);
    }
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(VALID_STATUSES, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 4, maxRows - 1, 1).setDataValidation(rule);
}

function writeTaskRow_(sheet, row, data) {
  ensureStatusValidation_(sheet, row);
  const dateCellVal = toSheetDateOrEmpty_(data.deadline);
  sheet.getRange(row, 6).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(row, 7).setNumberFormat('@');
  sheet.getRange(row, 1, 1, 9).setValues([[
    data.done,
    data.sphere,
    sanitizeSheetCell_(data.task),
    data.status,
    data.priority,
    dateCellVal,
    data.time,
    sanitizeSheetCell_(data.notes),
    data.inCalendar
  ]]);
  sheet.getRange(row, 1).insertCheckboxes();
  sheet.getRange(row, 9).insertCheckboxes();
}

function handleCreate_(sheet, payload) {
  const rawTitle = String(payload.task || '').trim();
  if (!rawTitle) throw new Error('Назва задачі не може бути порожньою');

  const sphere = sanitizeEnum_(payload.sphere, VALID_SPHERES, 'Життя');
  const priority = sanitizeEnum_(payload.priority, VALID_PRIORITIES, 'Середній');
  const rawStatus = normalizeStatus_(payload.status, 'Sort');
  const synced = reconcileDoneStatus_(
    Boolean(payload.done), rawStatus, false, 'Sort',
    payload.done !== undefined, payload.status !== undefined
  );

  const deadline = normalizeDateInput_(payload.deadline);
  const time = normalizeTimeInput_(payload.time);
  const rawNotes = String(payload.notes || '').trim();
  const wantCalendar = Boolean(payload.addToCalendar);

  if (wantCalendar && !deadline) throw new Error('Вкажіть дедлайн, щоб додати задачу в Календар');

  let inCalendar = Boolean(payload.inCalendar);
  if (wantCalendar) {
    createCalendarEvent_({ sphere: sphere, task: rawTitle, priority: priority, deadline: deadline, time: time, notes: rawNotes });
    inCalendar = true;
  }

  const targetRow = findFirstEmptyRow_(sheet);
  writeTaskRow_(sheet, targetRow, {
    done: synced.done, sphere: sphere, task: rawTitle, status: synced.status,
    priority: priority, deadline: deadline, time: time, notes: rawNotes, inCalendar: inCalendar
  });
  return targetRow;
}

function handleUpdate_(sheet, payload) {
  const row = validateRowIndex_(sheet, payload.row);
  const tz = Session.getScriptTimeZone();
  const cur = sheet.getRange(row, 1, 1, 9).getValues()[0];

  const prevDone = toBool_(cur[0]);
  const prevSphere = String(cur[1] || '').trim() || 'Життя';
  const prevTask = String(cur[2] || '').trim();
  const prevStatus = normalizeStatus_(cur[3], 'Sort');
  const prevPriority = String(cur[4] || '').trim() || 'Середній';
  const prevDeadline = formatDateValue_(cur[5], tz);
  const prevTime = formatTimeValue_(cur[6], tz);
  const prevNotes = String(cur[7] || '');
  const prevInCalendar = toBool_(cur[8]);

  const hasDone = payload.done !== undefined;
  const hasStatus = payload.status !== undefined;
  const synced = reconcileDoneStatus_(
    hasDone ? Boolean(payload.done) : prevDone,
    hasStatus ? normalizeStatus_(payload.status, prevStatus) : prevStatus,
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
    createCalendarEvent_({ sphere: nextSphere, task: nextTask, priority: nextPriority, deadline: nextDeadline, time: nextTime, notes: nextNotes });
    nextInCalendar = true;
  }

  writeTaskRow_(sheet, row, {
    done: synced.done, sphere: nextSphere, task: nextTask, status: synced.status,
    priority: nextPriority, deadline: nextDeadline, time: nextTime, notes: nextNotes, inCalendar: nextInCalendar
  });

  // Автогенерація наступного повторення при переході в «Готово»
  let spawnedDate = '';
  if (!prevDone && synced.done) {
    const nextDate = computeNextRepeatDate_(nextNotes, nextDeadline, tz);
    if (nextDate) {
      const resetNotes = nextNotes.replace(/^(\s*-\s*)\[[xX]\]/gm, '$1[ ]');
      const newRow = findFirstEmptyRow_(sheet);
      writeTaskRow_(sheet, newRow, {
        done: false, sphere: nextSphere, task: nextTask, status: 'Short',
        priority: nextPriority, deadline: nextDate, time: nextTime, notes: resetNotes, inCalendar: false
      });
      spawnedDate = nextDate;
    }
  }
  return { spawnedDate: spawnedDate };
}

function deleteTaskRowSafe_(sheet, row) {
  sheet.deleteRow(row);
  ensureTemplateRows_(sheet);
}

function ensureTemplateRows_(sheet) {
  const maxRows = sheet.getMaxRows();
  if (maxRows < MIN_TEMPLATE_ROWS) {
    const addCount = MIN_TEMPLATE_ROWS - maxRows;
    sheet.insertRowsAfter(maxRows, addCount);
    const startNew = maxRows + 1;
    sheet.getRange(startNew, 1, addCount, 1).insertCheckboxes();
    sheet.getRange(startNew, 9, addCount, 1).insertCheckboxes();
  }
  ensureStatusValidation_(sheet, 2);
}

function archiveCompletedTasks_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const ss = sheet.getParent();
  let arch = ss.getSheetByName(ARCHIVE_SHEET_NAME);
  if (!arch) {
    arch = ss.insertSheet(ARCHIVE_SHEET_NAME);
    arch.getRange(1, 1, 1, 8).setValues([[
      'Архівовано', 'Сфера', 'Задача', 'Пріоритет', 'Дедлайн', 'Час', 'Нотатки', 'В Календарі'
    ]]);
    arch.setFrozenRows(1);
  }

  const tz = Session.getScriptTimeZone();
  const nowStamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
  const rows = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const toArchive = [];
  const rowIndicesDesc = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const title = String(r[2] || '').trim();
    const isDone = toBool_(r[0]) || String(r[3] || '').trim() === 'Готово';
    if (title && isDone) {
      toArchive.push([
        nowStamp,
        String(r[1] || '').trim() || 'Життя',
        sanitizeSheetCell_(title),
        String(r[4] || '').trim() || 'Середній',
        formatDateValue_(r[5], tz),
        formatTimeValue_(r[6], tz),
        sanitizeSheetCell_(String(r[7] || '')),
        toBool_(r[8])
      ]);
      rowIndicesDesc.push(i + 2);
    }
  }

  if (!toArchive.length) return 0;
  const archStart = Math.max(arch.getLastRow() + 1, 2);
  arch.getRange(archStart, 1, toArchive.length, 8).setValues(toArchive);

  for (let j = rowIndicesDesc.length - 1; j >= 0; j--) {
    sheet.deleteRow(rowIndicesDesc[j]);
  }
  ensureTemplateRows_(sheet);
  return toArchive.length;
}

function computeNextRepeatDate_(notes, currentDeadline, tz) {
  const m = String(notes || '').match(/\[repeat:(daily|weekly|monthly|every_n)(?::([0-9,]+))?\]/);
  if (!m) return '';
  const type = m[1];
  const val = m[2] || '';

  const baseParts = (currentDeadline || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd')).split('-').map(Number);
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const todayParts = todayStr.split('-').map(Number);
  let base = new Date(baseParts[0], baseParts[1] - 1, baseParts[2], 12, 0, 0);
  const today = new Date(todayParts[0], todayParts[1] - 1, todayParts[2], 12, 0, 0);
  if (base < today) base = today;

  if (type === 'daily') {
    base.setDate(base.getDate() + 1);
  } else if (type === 'every_n') {
    base.setDate(base.getDate() + Math.max(1, Number(val) || 1));
  } else if (type === 'monthly') {
    const targetDay = Math.min(28, Math.max(1, Number(val) || base.getDate()));
    base.setMonth(base.getMonth() + 1, targetDay);
  } else if (type === 'weekly') {
    const days = val.split(',').map(Number).filter(function(n) { return n >= 1 && n <= 7; });
    if (!days.length) base.setDate(base.getDate() + 7);
    else {
      for (let step = 1; step <= 7; step++) {
        const cand = new Date(base.getTime());
        cand.setDate(cand.getDate() + step);
        const isoDay = cand.getDay() === 0 ? 7 : cand.getDay();
        if (days.indexOf(isoDay) !== -1) { base = cand; break; }
      }
    }
  }
  return Utilities.formatDate(base, tz, 'yyyy-MM-dd');
}

/* ======================== Читання та Календар ======================== */

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
    sphere: String(r[1] || '').trim(), task: taskTitle,
    priority: String(r[4] || '').trim() || 'Середній',
    deadline: deadline, time: formatTimeValue_(r[6], tz), notes: String(r[7] || '').trim()
  });
  sheet.getRange(row, 9).setValue(true).insertCheckboxes();
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
      sphere: String(r[1] || '').trim(), task: taskTitle,
      priority: String(r[4] || '').trim() || 'Середній',
      deadline: deadline, time: formatTimeValue_(r[6], tz), notes: String(r[7] || '').trim()
    });
    sheet.getRange(i + 2, 9).setValue(true).insertCheckboxes();
    syncedCount++;
  }
  return { synced: syncedCount };
}

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
    const rawStatus = normalizeStatus_(r[3], rawDone ? 'Готово' : 'Sort');
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

function readArchivedSummary_(ss) {
  const doc = ss || SpreadsheetApp.getActiveSpreadsheet();
  const arch = doc.getSheetByName(ARCHIVE_SHEET_NAME);
  if (!arch || arch.getLastRow() < 2) return [];
  const tz = Session.getScriptTimeZone();
  const rows = arch.getRange(2, 1, arch.getLastRow() - 1, 7).getValues();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const title = String(r[2] || '').trim();
    if (!title) continue;
    out.push({
      archivedDate: formatDateValue_(r[0], tz),
      sphere: String(r[1] || '').trim() || 'Життя',
      task: title,
      deadline: formatDateValue_(r[4], tz),
      notes: String(r[6] || '')
    });
  }
  return out;
}

function createCalendarEvent_(item) {
  const parts = item.deadline.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) throw new Error('Некоректна дата: ' + item.deadline);
  const title = item.sphere ? '[' + item.sphere + '] ' + item.task : item.task;
  const cleanNotes = String(item.notes || '').replace(/\[(pin|repeat:[^\]]+)\]/g, '').trim();
  const desc = [item.priority ? 'Пріоритет: ' + item.priority : '', cleanNotes].filter(Boolean).join('\n\n');
  const cal = CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error('Не вдалося отримати основний Google Календар');

  let event;
  if (item.time) {
    const tp = item.time.split(':').map(Number);
    const start = new Date(parts[0], parts[1] - 1, parts[2], tp[0] || 0, tp[1] || 0, 0, 0);
    event = cal.createEvent(title, start, new Date(start.getTime() + 30 * 60 * 1000), { description: desc });
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
  if (failCount >= RATE_LIMIT_MAX) return { ok: false, error: 'Забагато невдалих спроб входу. Зачекайте 5 хвилин.' };
  const expected = getConfiguredPin_();
  const actual = String(pin || '');
  let diff = (!expected || actual.length !== expected.length) ? 1 : 0;
  if (diff === 0) {
    for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) {
    cache.put(RATE_LIMIT_KEY, String(failCount + 1), RATE_LIMIT_WINDOW_SEC);
    return { ok: false, error: 'Unauthorized' };
  }
  if (failCount > 0) cache.remove(RATE_LIMIT_KEY);
  return { ok: true };
}

function sanitizeSheetCell_(val) {
  const str = String(val || '');
  return str && /^[=+\-@\t\r]/.test(str) ? "'" + str : str;
}

function toSheetDateOrEmpty_(ymd) {
  if (!ymd) return '';
  const p = ymd.split('-').map(Number);
  return p.length === 3 && !p.some(isNaN) ? new Date(p[0], p[1] - 1, p[2], 12, 0, 0) : '';
}

function getTasksSheet_(ssOpt) {
  const ss = ssOpt || SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Скрипт не прив’язаний до Google Таблиці');
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Аркуш "' + SHEET_NAME + '" не знайдено');
  return sheet;
}

function validateRowIndex_(sheet, rowInput) {
  const row = Number(rowInput);
  if (!Number.isInteger(row) || row < 2 || row > sheet.getLastRow()) throw new Error('Рядок #' + rowInput + ' не існує');
  return row;
}

function verifyExpectedTask_(sheet, rowInput, expectedTask) {
  const row = Number(rowInput);
  if (!Number.isInteger(row) || row < 2 || row > sheet.getLastRow()) return 'Рядок у таблиці змінився. Список оновлено.';
  if (expectedTask !== undefined && expectedTask !== null && String(expectedTask).trim() !== '') {
    const actual = String(sheet.getRange(row, 3).getValue() || '').trim();
    if (actual !== String(expectedTask).trim()) return 'Порядок рядків у таблиці змінився. Список оновлено.';
  }
  return '';
}

function reconcileDoneStatus_(nextDone, nextStatus, prevDone, prevStatus, hasDone, hasStatus) {
  if (hasDone && !hasStatus) return nextDone ? { done: true, status: 'Готово' } : { done: false, status: prevStatus === 'Готово' ? 'Фокус' : prevStatus };
  if (hasStatus && !hasDone) return nextStatus === 'Готово' ? { done: true, status: 'Готово' } : { done: false, status: nextStatus };
  if (nextDone && !prevDone) return { done: true, status: 'Готово' };
  if (nextStatus === 'Готово' && prevStatus !== 'Готово') return { done: true, status: 'Готово' };
  if (!nextDone && prevDone && nextStatus === 'Готово') return { done: false, status: 'Фокус' };
  if (nextStatus !== 'Готово' && prevStatus === 'Готово') return { done: false, status: nextStatus };
  return (nextDone || nextStatus === 'Готово') ? { done: true, status: 'Готово' } : { done: false, status: nextStatus };
}

function formatDateValue_(val, tz) {
  if (!val) return '';
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime())) return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
  return normalizeDateInput_(val);
}

function formatTimeValue_(val, tz) {
  if (!val && val !== 0) return '';
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime())) return Utilities.formatDate(val, tz, 'HH:mm');
  return normalizeTimeInput_(val);
}

function normalizeDateInput_(raw) {
  const m = String(raw || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}

function normalizeTimeInput_(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  return String(Math.min(23, Math.max(0, Number(m[1])))).padStart(2, '0') + ':' + String(Math.min(59, Math.max(0, Number(m[2])))).padStart(2, '0');
}

function normalizeStatus_(raw, fallback) {
  const clean = String(raw || '').trim();
  const mapped = LEGACY_STATUS_MAP[clean] || clean;
  return VALID_STATUSES.indexOf(mapped) !== -1 ? mapped : fallback;
}

function sanitizeEnum_(val, allowed, fallback) {
  const clean = String(val || '').trim();
  return allowed.indexOf(clean) !== -1 ? clean : fallback;
}

function toBool_(val) {
  return val === true || String(val).toLowerCase() === 'true';
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
