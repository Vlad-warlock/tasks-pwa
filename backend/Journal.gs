/**
 * @OnlyCurrentDoc
 * Модуль щоденного журналу «Щоденник» для Google Apps Script (Tasks PWA v4).
 * Працює в спільному просторі імен із Code.gs та не зачіпає аркуші «Задачі» й «Канбан і Дашборд».
 */

const JOURNAL_SHEET_NAME = 'Щоденник';
const JOURNAL_CONFIG_KEY = '__CONFIG__';
const DEFAULT_JOURNAL_HABITS = [
  { id: 'h1', name: 'Крипта-аналіз', active: true },
  { id: 'h2', name: 'Навчання', active: true },
  { id: 'h3', name: 'Спорт', active: true },
  { id: 'h4', name: 'Вода/Сон', active: true },
  { id: 'h5', name: 'Без думскролу', active: true }
];

function cloneDefaultHabits_() {
  return DEFAULT_JOURNAL_HABITS.map(function(h) {
    return { id: h.id, name: h.name, active: h.active };
  });
}

function getOrCreateJournalSheet_(ss) {
  const doc = ss || SpreadsheetApp.getActiveSpreadsheet();
  let sheet = doc.getSheetByName(JOURNAL_SHEET_NAME);
  if (!sheet) {
    sheet = doc.insertSheet(JOURNAL_SHEET_NAME);
    sheet.getRange(1, 1, 1, 7).setValues([[
      'Дата', 'Оцінка', 'Фокус дня', 'Звички', 'Що вдалося', 'Що заважало', 'Мета'
    ]]);
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1).setNumberFormat('@');
    sheet.getRange(2, 1, 1, 7).setValues([[
      JOURNAL_CONFIG_KEY, '', '', JSON.stringify(cloneDefaultHabits_()), '', '', '{}'
    ]]);
  }
  return sheet;
}

function sanitizeHabitsList_(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return cloneDefaultHabits_();
  const seen = {};
  const list = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || ('h' + (i + 1))).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    const name = String(item.name || '').trim().slice(0, 60);
    if (!id || !name || seen[id]) continue;
    seen[id] = true;
    list.push({ id: id, name: name, active: item.active !== false });
  }
  return list.length ? list : cloneDefaultHabits_();
}

function sanitizeMonthFocusMap_(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i++) {
    const k = String(keys[i] || '').trim();
    if (!/^\d{4}-\d{2}$/.test(k)) continue;
    const val = String(raw[k] || '').trim().slice(0, 300);
    if (val) out[k] = val;
  }
  return out;
}

function findJournalConfigRow_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < colA.length; i++) {
    if (String(colA[i][0] || '').trim() === JOURNAL_CONFIG_KEY) return i + 2;
  }
  return -1;
}

function readJournalPayload_(ss) {
  const doc = ss || SpreadsheetApp.getActiveSpreadsheet();
  const sheet = doc.getSheetByName(JOURNAL_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    return { habits: cloneDefaultHabits_(), monthFocus: {}, entries: {} };
  }

  const tz = Session.getScriptTimeZone();
  const lastRow = sheet.getLastRow();
  const rows = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  let habits = cloneDefaultHabits_();
  let monthFocus = {};
  const entries = {};

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const key = String(r[0] || '').trim();
    if (key === JOURNAL_CONFIG_KEY) {
      try {
        if (r[3]) habits = sanitizeHabitsList_(JSON.parse(String(r[3])));
      } catch (_) {}
      try {
        if (r[6]) monthFocus = sanitizeMonthFocusMap_(JSON.parse(String(r[6])));
      } catch (_) {}
      continue;
    }

    const dateStr = formatDateValue_(r[0], tz);
    if (!dateStr) continue;
    const numRating = Number(r[1]);
    const rating = (r[1] !== '' && Number.isFinite(numRating) && numRating >= 1 && numRating <= 10)
      ? Math.round(numRating)
      : null;

    const doneRaw = String(r[3] || '');
    const doneHabits = doneRaw
      ? doneRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean)
      : [];

    entries[dateStr] = {
      date: dateStr,
      rating: rating,
      focus: String(r[2] || ''),
      doneHabits: doneHabits,
      wins: String(r[4] || ''),
      blockers: String(r[5] || '')
    };
  }

  return { habits: habits, monthFocus: monthFocus, entries: entries };
}

function handleSaveJournalDay_(ss, payload) {
  const dateStr = normalizeDateInput_(payload && payload.date);
  if (!dateStr) throw new Error('Некоректна дата для щоденника');

  const sheet = getOrCreateJournalSheet_(ss);
  const tz = Session.getScriptTimeZone();
  const rawRating = payload.rating;
  const numRating = Number(rawRating);
  const ratingVal = (rawRating !== '' && rawRating !== null && rawRating !== undefined && Number.isFinite(numRating) && numRating >= 1 && numRating <= 10)
    ? Math.round(numRating)
    : '';

  const focusVal = sanitizeSheetCell_(String(payload.focus || '').trim().slice(0, 300));
  const winsVal = sanitizeSheetCell_(String(payload.wins || '').trim().slice(0, 1500));
  const blockersVal = sanitizeSheetCell_(String(payload.blockers || '').trim().slice(0, 1500));

  const doneArr = Array.isArray(payload.doneHabits) ? payload.doneHabits : [];
  const cleanDone = [];
  const seenDone = {};
  for (let i = 0; i < doneArr.length; i++) {
    const id = String(doneArr[i] || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
    if (id && !seenDone[id]) {
      seenDone[id] = true;
      cleanDone.push(id);
    }
  }
  const habitsCell = sanitizeSheetCell_(cleanDone.join(', '));

  const lastRow = sheet.getLastRow();
  let targetRow = -1;
  if (lastRow >= 2) {
    const colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < colA.length; i++) {
      if (String(colA[i][0] || '').trim() === JOURNAL_CONFIG_KEY) continue;
      if (formatDateValue_(colA[i][0], tz) === dateStr) {
        targetRow = i + 2;
        break;
      }
    }
  }
  if (targetRow === -1) targetRow = Math.max(lastRow + 1, 3);

  sheet.getRange(targetRow, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(targetRow, 4).setNumberFormat('@');
  sheet.getRange(targetRow, 1, 1, 6).setValues([[
    toSheetDateOrEmpty_(dateStr),
    ratingVal,
    focusVal,
    habitsCell,
    winsVal,
    blockersVal
  ]]);

  return readJournalPayload_(ss);
}

function handleSaveJournalMeta_(ss, payload) {
  const sheet = getOrCreateJournalSheet_(ss);
  const current = readJournalPayload_(ss);
  const nextHabits = payload && payload.habits !== undefined
    ? sanitizeHabitsList_(payload.habits)
    : current.habits;
  const nextMonthFocus = payload && payload.monthFocus !== undefined
    ? sanitizeMonthFocusMap_(payload.monthFocus)
    : current.monthFocus;

  let cfgRow = findJournalConfigRow_(sheet);
  if (cfgRow === -1) cfgRow = Math.max(sheet.getLastRow() + 1, 2);

  sheet.getRange(cfgRow, 1).setNumberFormat('@');
  sheet.getRange(cfgRow, 1, 1, 7).setValues([[
    JOURNAL_CONFIG_KEY,
    '',
    '',
    JSON.stringify(nextHabits),
    '',
    '',
    JSON.stringify(nextMonthFocus)
  ]]);

  return readJournalPayload_(ss);
}
