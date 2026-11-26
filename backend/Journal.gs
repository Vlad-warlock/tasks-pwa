/**
 * @OnlyCurrentDoc
 * Модуль щоденного журналу «Щоденник» для Google Apps Script (Tasks PWA v4).
 * Чистий людиночитабельний аркуш (рядки 2+, без JSON і тех. рядків); конфіг у Script Properties.
 */

const JOURNAL_SHEET_NAME = 'Щоденник';
const JOURNAL_CONFIG_KEY = '__CONFIG__';
const PROP_JOURNAL_HABITS = 'JOURNAL_HABITS';
const PROP_JOURNAL_MONTH_FOCUS = 'JOURNAL_MONTH_FOCUS';
const JOURNAL_HEADERS = ['Дата', 'Оцінка', 'Фокус дня', 'Звички', 'Що вдалося', 'Що заважало', 'Фокус місяця'];
const JOURNAL_COL_WIDTHS = [110, 75, 220, 240, 260, 260, 220];

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

function formatJournalSheet_(sheet) {
  sheet.getRange(1, 1, 1, 7).setValues([JOURNAL_HEADERS]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 7)
    .setFontWeight('bold')
    .setBackground('#1f2937')
    .setFontColor('#edf2f7')
    .setVerticalAlignment('middle');
  sheet.getRange(1, 1, 1, 2).setHorizontalAlignment('center');
  for (let i = 0; i < JOURNAL_COL_WIDTHS.length; i++) {
    sheet.setColumnWidth(i + 1, JOURNAL_COL_WIDTHS[i]);
  }
}

function getOrCreateJournalSheet_(ss) {
  const doc = ss || SpreadsheetApp.getActiveSpreadsheet();
  let sheet = doc.getSheetByName(JOURNAL_SHEET_NAME);
  if (!sheet) {
    sheet = doc.insertSheet(JOURNAL_SHEET_NAME);
    formatJournalSheet_(sheet);
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

function readLegacyConfigFromSheet_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return null;
  const lastRow = sheet.getLastRow();
  const rows = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() !== JOURNAL_CONFIG_KEY) continue;
    let habits = null;
    let monthFocus = null;
    try { if (rows[i][3]) habits = sanitizeHabitsList_(JSON.parse(String(rows[i][3]))); } catch (_) {}
    try { if (rows[i][6]) monthFocus = sanitizeMonthFocusMap_(JSON.parse(String(rows[i][6]))); } catch (_) {}
    return { row: i + 2, habits: habits, monthFocus: monthFocus };
  }
  return null;
}

function loadJournalMeta_(sheetOpt) {
  const props = PropertiesService.getScriptProperties();
  const rawHabits = props.getProperty(PROP_JOURNAL_HABITS);
  const rawFocus = props.getProperty(PROP_JOURNAL_MONTH_FOCUS);
  let habits = null;
  let monthFocus = null;
  try { if (rawHabits) habits = sanitizeHabitsList_(JSON.parse(rawHabits)); } catch (_) {}
  try { if (rawFocus) monthFocus = sanitizeMonthFocusMap_(JSON.parse(rawFocus)); } catch (_) {}

  if ((!habits || !monthFocus) && sheetOpt) {
    const legacy = readLegacyConfigFromSheet_(sheetOpt);
    if (legacy) {
      if (!habits && legacy.habits) habits = legacy.habits;
      if (!monthFocus && legacy.monthFocus) monthFocus = legacy.monthFocus;
    }
  }
  return {
    habits: habits || cloneDefaultHabits_(),
    monthFocus: monthFocus || {}
  };
}

function saveJournalMetaProps_(habits, monthFocus) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_JOURNAL_HABITS, JSON.stringify(habits));
  props.setProperty(PROP_JOURNAL_MONTH_FOCUS, JSON.stringify(monthFocus));
}

function habitTokensToIds_(cellText, habits) {
  if (!cellText) return [];
  const byId = {};
  const byName = {};
  for (let i = 0; i < habits.length; i++) {
    byId[habits[i].id.toLowerCase()] = habits[i].id;
    byName[habits[i].name.toLowerCase()] = habits[i].id;
  }
  const parts = String(cellText).split(',');
  const out = [];
  const seen = {};
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].trim();
    if (!token) continue;
    const low = token.toLowerCase();
    const id = byName[low] || byId[low] || '';
    if (id && !seen[id]) {
      seen[id] = true;
      out.push(id);
    }
  }
  return out;
}

function habitIdsToNamesCsv_(ids, habits) {
  const nameById = {};
  for (let i = 0; i < habits.length; i++) nameById[habits[i].id] = habits[i].name;
  const names = [];
  const seen = {};
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i] || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
    if (!id || seen[id]) continue;
    seen[id] = true;
    names.push(nameById[id] || id);
  }
  return names.join(', ');
}

function rewriteSheetReadableRows_(sheet, parseHabits, targetHabits, monthFocus) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const tz = Session.getScriptTimeZone();
  const rows = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (let i = 0; i < rows.length; i++) {
    const dateStr = formatDateValue_(rows[i][0], tz);
    if (!dateStr) continue;
    const ids = habitTokensToIds_(rows[i][3], parseHabits);
    const nextCsv = sanitizeSheetCell_(habitIdsToNamesCsv_(ids, targetHabits));
    const nextMonth = sanitizeSheetCell_(monthFocus[dateStr.slice(0, 7)] || '');
    if (String(rows[i][3] || '') !== nextCsv) {
      sheet.getRange(i + 2, 4).setNumberFormat('@').setValue(nextCsv);
    }
    if (String(rows[i][6] || '') !== nextMonth) {
      sheet.getRange(i + 2, 7).setValue(nextMonth);
    }
  }
}

function migrateLegacyJournalIfNeeded_(sheet) {
  const legacy = readLegacyConfigFromSheet_(sheet);
  if (!legacy) return;
  const meta = loadJournalMeta_(sheet);
  saveJournalMetaProps_(meta.habits, meta.monthFocus);
  sheet.deleteRow(legacy.row);
  formatJournalSheet_(sheet);
  rewriteSheetReadableRows_(sheet, meta.habits, meta.habits, meta.monthFocus);
}

function readJournalPayload_(ss) {
  const doc = ss || SpreadsheetApp.getActiveSpreadsheet();
  const sheet = doc.getSheetByName(JOURNAL_SHEET_NAME);
  const meta = loadJournalMeta_(sheet);
  if (!sheet || sheet.getLastRow() < 2) {
    return { habits: meta.habits, monthFocus: meta.monthFocus, entries: {} };
  }

  const tz = Session.getScriptTimeZone();
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  const entries = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0] || '').trim() === JOURNAL_CONFIG_KEY) continue;
    const dateStr = formatDateValue_(r[0], tz);
    if (!dateStr) continue;
    const numRating = Number(r[1]);
    const rating = (r[1] !== '' && Number.isFinite(numRating) && numRating >= 1 && numRating <= 10)
      ? Math.round(numRating)
      : null;

    entries[dateStr] = {
      date: dateStr,
      rating: rating,
      focus: String(r[2] || ''),
      doneHabits: habitTokensToIds_(r[3], meta.habits),
      wins: String(r[4] || ''),
      blockers: String(r[5] || '')
    };
  }
  return { habits: meta.habits, monthFocus: meta.monthFocus, entries: entries };
}

function handleSaveJournalDay_(ss, payload) {
  const dateStr = normalizeDateInput_(payload && payload.date);
  if (!dateStr) throw new Error('Некоректна дата для щоденника');

  const sheet = getOrCreateJournalSheet_(ss);
  migrateLegacyJournalIfNeeded_(sheet);
  const meta = loadJournalMeta_(sheet);
  const tz = Session.getScriptTimeZone();

  const rawRating = payload.rating;
  const numRating = Number(rawRating);
  const ratingVal = (rawRating !== '' && rawRating !== null && rawRating !== undefined && Number.isFinite(numRating) && numRating >= 1 && numRating <= 10)
    ? Math.round(numRating)
    : '';

  const doneArr = Array.isArray(payload.doneHabits) ? payload.doneHabits : [];
  const habitsCell = sanitizeSheetCell_(habitIdsToNamesCsv_(doneArr, meta.habits));
  const monthFocusVal = sanitizeSheetCell_(meta.monthFocus[dateStr.slice(0, 7)] || '');

  const lastRow = sheet.getLastRow();
  let targetRow = -1;
  if (lastRow >= 2) {
    const colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < colA.length; i++) {
      if (formatDateValue_(colA[i][0], tz) === dateStr) { targetRow = i + 2; break; }
    }
  }
  if (targetRow === -1) targetRow = Math.max(lastRow + 1, 2);

  sheet.getRange(targetRow, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(targetRow, 4).setNumberFormat('@');
  sheet.getRange(targetRow, 1, 1, 7).setValues([[
    toSheetDateOrEmpty_(dateStr),
    ratingVal,
    sanitizeSheetCell_(String(payload.focus || '').trim().slice(0, 300)),
    habitsCell,
    sanitizeSheetCell_(String(payload.wins || '').trim().slice(0, 1500)),
    sanitizeSheetCell_(String(payload.blockers || '').trim().slice(0, 1500)),
    monthFocusVal
  ]]);
  sheet.getRange(targetRow, 1, 1, 2).setHorizontalAlignment('center').setVerticalAlignment('top');
  sheet.getRange(targetRow, 3, 1, 5).setWrap(true).setVerticalAlignment('top');

  return readJournalPayload_(ss);
}

function handleSaveJournalMeta_(ss, payload) {
  const sheet = getOrCreateJournalSheet_(ss);
  migrateLegacyJournalIfNeeded_(sheet);
  const prevMeta = loadJournalMeta_(sheet);
  const nextHabits = payload && payload.habits !== undefined
    ? sanitizeHabitsList_(payload.habits)
    : prevMeta.habits;
  const nextMonthFocus = payload && payload.monthFocus !== undefined
    ? sanitizeMonthFocusMap_(payload.monthFocus)
    : prevMeta.monthFocus;

  saveJournalMetaProps_(nextHabits, nextMonthFocus);
  rewriteSheetReadableRows_(sheet, prevMeta.habits, nextHabits, nextMonthFocus);
  return readJournalPayload_(ss);
}
