import { shiftDateStr } from './utils.js';

export const DEFAULT_HABITS = [
  { id: 'h1', name: 'Крипта-аналіз', active: true },
  { id: 'h2', name: 'Навчання', active: true },
  { id: 'h3', name: 'Спорт', active: true },
  { id: 'h4', name: 'Вода/Сон', active: true },
  { id: 'h5', name: 'Без думскролу', active: true }
];

export function createDefaultJournal() {
  return {
    habits: DEFAULT_HABITS.map((h) => ({ ...h })),
    monthFocus: {},
    monthReview: {},
    entries: {}
  };
}

function normalizeMonthTextMap(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (/^\d{4}-\d{2}$/.test(k) && String(v || '').trim()) out[k] = String(v).trim();
    }
  }
  return out;
}

export function normalizeJournal(raw) {
  if (!raw || typeof raw !== 'object') return createDefaultJournal();
  const rawHabits = Array.isArray(raw.habits) && raw.habits.length ? raw.habits : DEFAULT_HABITS;
  const habits = [];
  const seen = new Set();
  for (const h of rawHabits) {
    if (!h || typeof h !== 'object') continue;
    const id = String(h.id || '').trim();
    const name = String(h.name || '').trim();
    if (id && name && !seen.has(id)) { seen.add(id); habits.push({ id, name, active: h.active !== false }); }
  }
  const monthFocus = normalizeMonthTextMap(raw.monthFocus);
  const monthReview = normalizeMonthTextMap(raw.monthReview);
  const entries = {};
  if (raw.entries && typeof raw.entries === 'object') {
    for (const [dateStr, val] of Object.entries(raw.entries)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !val || typeof val !== 'object') continue;
      const num = Number(val.rating);
      const rating = val.rating !== null && val.rating !== '' && Number.isFinite(num) && num >= 1 && num <= 10 ? Math.round(num) : null;
      const doneHabits = Array.isArray(val.doneHabits) ? [...new Set(val.doneHabits.map((x) => String(x || '').trim()).filter(Boolean))] : [];
      entries[dateStr] = { date: dateStr, rating, focus: String(val.focus || ''), doneHabits, wins: String(val.wins || ''), blockers: String(val.blockers || '') };
    }
  }
  return { habits: habits.length ? habits : createDefaultJournal().habits, monthFocus, monthReview, entries };
}

export function getOrCreateDayEntry(journal, dateStr) {
  if (!journal.entries[dateStr]) {
    journal.entries[dateStr] = { date: dateStr, rating: null, focus: '', doneHabits: [], wins: '', blockers: '' };
  }
  return journal.entries[dateStr];
}

export function toggleHabitForDate(journal, dateStr, habitId) {
  const entry = getOrCreateDayEntry(journal, dateStr);
  const idx = entry.doneHabits.indexOf(habitId);
  if (idx === -1) entry.doneHabits.push(habitId);
  else entry.doneHabits.splice(idx, 1);
  return entry;
}

export function updateDayEntryFields(journal, dateStr, patch) {
  const entry = getOrCreateDayEntry(journal, dateStr);
  if (patch.rating !== undefined) entry.rating = patch.rating;
  if (patch.focus !== undefined) entry.focus = String(patch.focus || '');
  if (patch.wins !== undefined) entry.wins = String(patch.wins || '');
  if (patch.blockers !== undefined) entry.blockers = String(patch.blockers || '');
  return entry;
}

export function updateMonthFocus(journal, ymKey, text) {
  const clean = String(text || '').trim();
  if (clean) journal.monthFocus[ymKey] = clean;
  else delete journal.monthFocus[ymKey];
}

export function updateMonthReview(journal, ymKey, text) {
  if (!journal.monthReview) journal.monthReview = {};
  const clean = String(text || '').trim();
  if (clean) journal.monthReview[ymKey] = clean;
  else delete journal.monthReview[ymKey];
}

export function addCustomHabit(journal, name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return null;
  const id = `h_${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
  const item = { id, name: clean, active: true };
  journal.habits.push(item);
  return item;
}

export function renameCustomHabit(journal, id, name) {
  const clean = String(name || '').trim().slice(0, 60);
  const h = journal.habits.find((x) => x.id === id);
  if (!h || !clean || h.name === clean) return false;
  h.name = clean;
  return true;
}

export function toggleHabitActive(journal, id) {
  const h = journal.habits.find((x) => x.id === id);
  if (!h) return false;
  const activeCount = journal.habits.filter((x) => x.active !== false).length;
  if (h.active !== false && activeCount <= 1) return false;
  h.active = h.active === false;
  return true;
}

export function computeHabitStreak(entries, habitId, todayStr) {
  const hasDone = (d) => Boolean(entries[d] && Array.isArray(entries[d].doneHabits) && entries[d].doneHabits.includes(habitId));
  let cursor = todayStr;
  if (!hasDone(cursor)) {
    const yesterday = shiftDateStr(todayStr, -1);
    if (!hasDone(yesterday)) return 0;
    cursor = yesterday;
  }
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    if (!hasDone(cursor)) break;
    streak++;
    cursor = shiftDateStr(cursor, -1);
  }
  return streak;
}

export function computeBestHabitStreak(journal) {
  const datesByHabit = new Map();
  for (const [d, entry] of Object.entries(journal.entries || {})) {
    if (!entry || !Array.isArray(entry.doneHabits)) continue;
    for (const hid of entry.doneHabits) {
      if (!datesByHabit.has(hid)) datesByHabit.set(hid, []);
      datesByHabit.get(hid).push(d);
    }
  }
  let best = 0;
  for (const dates of datesByHabit.values()) {
    dates.sort();
    let run = 0;
    let prev = '';
    for (const d of dates) {
      if (d === prev) continue;
      run = prev && shiftDateStr(prev, 1) === d ? run + 1 : 1;
      if (run > best) best = run;
      prev = d;
    }
  }
  return best;
}

export function computeJournalStats(journal, todayStr, rangeMode = '14') {
  const activeHabits = journal.habits.filter((h) => h.active !== false);
  const activeIds = new Set(activeHabits.map((h) => h.id));
  const mode = String(rangeMode || '14');
  let dates = [];

  if (mode === 'month') {
    const dayNum = Number(todayStr.slice(8, 10)) || 1;
    const prefix = todayStr.slice(0, 8);
    for (let d = 1; d <= dayNum; d++) dates.push(`${prefix}${String(d).padStart(2, '0')}`);
  } else if (mode === 'year') {
    const yearPrefix = todayStr.slice(0, 4);
    const yearDates = Object.keys(journal.entries || {}).filter((d) => d.startsWith(yearPrefix) && d <= todayStr).sort();
    const startDate = yearDates[0] || `${yearPrefix}-01-01`;
    let cur = startDate;
    for (let guard = 0; guard < 366 && cur <= todayStr; guard++) {
      dates.push(cur);
      cur = shiftDateStr(cur, 1);
    }
  } else {
    const rangeDays = mode === '30' ? 30 : 14;
    for (let i = rangeDays - 1; i >= 0; i--) dates.push(shiftDateStr(todayStr, -i));
  }

  const points = [];
  let ratingSum = 0;
  let ratedCount = 0;
  let habitDoneTotal = 0;
  let habitLoggedDays = 0;

  for (const d of dates) {
    const entry = journal.entries[d];
    const parts = d.split('-');
    const label = `${parts[2]}.${parts[1]}`;
    const rating = entry && entry.rating ? entry.rating : null;
    if (rating !== null) {
      ratingSum += rating;
      ratedCount++;
    }
    if (entry && (entry.doneHabits.length > 0 || rating !== null || entry.focus)) {
      habitLoggedDays++;
      for (const hid of entry.doneHabits) {
        if (activeIds.has(hid)) habitDoneTotal++;
      }
    }
    points.push({ date: d, label, rating });
  }

  const avgRating = ratedCount > 0 ? (ratingSum / ratedCount).toFixed(1) : null;
  const habitDenom = habitLoggedDays * activeHabits.length;
  const habitPct = habitDenom > 0 ? Math.min(100, Math.round((habitDoneTotal / habitDenom) * 100)) : 0;

  return { avgRating, ratedCount, habitPct, habitLoggedDays, points };
}
