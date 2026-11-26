export const STORAGE_CONFIG = 'tasks_pwa_config_v1';
export const STORAGE_CACHE = 'tasks_pwa_cache_v1';
export const STORAGE_QUEUE = 'tasks_pwa_queue_v1';
export const STORAGE_PREFS = 'tasks_pwa_prefs_v1';
export const STORAGE_JOURNAL = 'tasks_pwa_journal_v1';

// Класичний порядок воронки Trello зліва направо (як у вкладці «Канбан і Дашборд»)
export const STATUS_COLUMNS = ['Беклог', 'Цей тиждень', 'В роботі', 'Готово'];
export const SPHERES = ['Усі', 'Крипта', 'Навчання', 'Життя'];
export const PRIORITIES = ['Усі', 'Високий', 'Середній', 'Низький'];
export const PRIORITY_WEIGHT = { 'Високий': 1, 'Середній': 2, 'Низький': 3 };
export const MONTHS_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
export const MONTHS_FULL = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
  } catch (_) {}
  return '';
}

export function safeSheetUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' && parsed.hostname === 'docs.google.com') return parsed.href;
  } catch (_) {}
  return '';
}

export function safeApiUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const isGoogleScript = parsed.protocol === 'https:' &&
      (parsed.hostname === 'script.google.com' || parsed.hostname === 'script.googleusercontent.com');
    const isLocalDev = (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (isGoogleScript || isLocalDev) return parsed.href;
  } catch (_) {}
  return '';
}

export function renderRichText(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const tokenRe = /(https?:\/\/[^\s<>"']+)|(#[a-zA-Zа-яА-ЯіїєґІЇЄҐ0-9_-]{1,28})/g;
  let out = '';
  let lastIndex = 0;
  let match;

  while ((match = tokenRe.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(lastIndex, match.index));
    if (match[1]) {
      let candidate = match[1];
      let trailing = '';
      while (/[.,);!?]+$/.test(candidate)) {
        trailing = candidate.slice(-1) + trailing;
        candidate = candidate.slice(0, -1);
      }
      const cleanHref = safeUrl(candidate);
      if (cleanHref) {
        const shortLabel = candidate.replace(/^https?:\/\//, '');
        const display = shortLabel.length > 34 ? shortLabel.slice(0, 32) + '…' : shortLabel;
        out += `<a class="note-link" href="${escapeHtml(cleanHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(display)}</a>`;
      } else {
        out += escapeHtml(candidate);
      }
      out += escapeHtml(trailing);
    } else if (match[2]) {
      const tag = match[2];
      out += `<button type="button" class="tag-inline" data-action="tag-click" data-tag="${escapeHtml(tag)}" title="Клік — фільтр за тегом">${escapeHtml(tag)}</button>`;
    }
    lastIndex = tokenRe.lastIndex;
  }
  out += escapeHtml(raw.slice(lastIndex));
  return out;
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    return true;
  } catch (_) {
    return false;
  }
}

export function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

export function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}

export function getTodayLocal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    ts: now.getTime()
  };
}

export function getOffsetDateStr(daysOffset = 0) {
  const dt = new Date();
  dt.setDate(dt.getDate() + daysOffset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function shiftDateStr(ymd, deltaDays = 0) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return getOffsetDateStr(deltaDays);
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  dt.setDate(dt.getDate() + deltaDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function isTaskOverdue(task, nowInfo) {
  if (task.done || !task.deadline) return false;
  if (task.deadline < nowInfo.date) return true;
  return task.deadline === nowInfo.date && Boolean(task.time) && task.time < nowInfo.time;
}

export function getDeadlineInfo(task, nowInfo) {
  if (!task.deadline) return { label: '', countdown: '', overdue: false, urgent: false, isToday: false };
  const p = task.deadline.split('-').map(Number);
  let dayPart = task.deadline;
  if (task.deadline === nowInfo.date) {
    dayPart = 'Сьогодні';
  } else if (p.length === 3 && !p.some(Number.isNaN)) {
    dayPart = task.deadline === getOffsetDateStr(1) ? 'Завтра' : `${p[2]} ${MONTHS_SHORT[p[1] - 1] || ''}`;
  }
  const baseLabel = task.time ? `${dayPart}, ${task.time}` : dayPart;
  if (task.done) return { label: baseLabel, countdown: '', overdue: false, urgent: false, isToday: false };

  const overdue = isTaskOverdue(task, nowInfo);
  if (overdue) return { label: baseLabel, countdown: 'прострочено', overdue: true, urgent: false, isToday: false };

  let targetTs = null;
  if (p.length === 3 && !p.some(Number.isNaN)) {
    const tp = task.time ? task.time.split(':').map(Number) : [23, 59];
    targetTs = new Date(p[0], p[1] - 1, p[2], tp[0] ?? 23, tp[1] ?? 59, 0, 0).getTime();
  }
  if (!targetTs) return { label: baseLabel, countdown: '', overdue: false, urgent: false, isToday: task.deadline === nowInfo.date };

  const hrsLeft = (targetTs - nowInfo.ts) / 3600000;
  const urgent = hrsLeft > 0 && hrsLeft <= 24;
  const countdown = hrsLeft <= 24
    ? `${Math.max(1, Math.ceil(hrsLeft))}г`
    : `${Math.ceil(hrsLeft / 24)}д`;

  return { label: baseLabel, countdown, overdue: false, urgent, isToday: task.deadline === nowInfo.date };
}

export function reconcileClientDoneStatus(done, status, prevDone, prevStatus, changedField) {
  if (changedField === 'done') {
    return done
      ? { done: true, status: 'Готово' }
      : { done: false, status: prevStatus === 'Готово' ? 'В роботі' : prevStatus };
  }
  if (changedField === 'status') {
    return status === 'Готово' ? { done: true, status: 'Готово' } : { done: false, status };
  }
  return (done || status === 'Готово') ? { done: true, status: 'Готово' } : { done: false, status };
}

export function sortColumnTasks(tasks, status, isPinnedFn) {
  const copy = tasks.slice();
  if (status === 'Готово') return copy.sort((a, b) => b.row - a.row);
  return copy.sort((a, b) => {
    const aPin = Boolean(isPinnedFn && isPinnedFn(a));
    const bPin = Boolean(isPinnedFn && isPinnedFn(b));
    if (aPin !== bPin) return aPin ? -1 : 1;

    const aHas = Boolean(a.deadline);
    const bHas = Boolean(b.deadline);
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
