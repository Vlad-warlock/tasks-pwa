export const STORAGE_CONFIG = 'tasks_pwa_config_v1';
export const STORAGE_CACHE = 'tasks_pwa_cache_v1';
export const STORAGE_QUEUE = 'tasks_pwa_queue_v1';
export const STORAGE_PREFS = 'tasks_pwa_prefs_v1';

export const STATUS_COLUMNS = ['В роботі', 'Цей тиждень', 'Беклог', 'Готово'];
export const SPHERES = ['Усі', 'Крипта', 'Навчання', 'Життя'];
export const PRIORITY_WEIGHT = { 'Високий': 1, 'Середній': 2, 'Низький': 3 };
const MONTHS_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];

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

export function linkifyNotes(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const urlRe = /(https?:\/\/[^\s<>"']+)/g;
  let out = '';
  let lastIndex = 0;
  let match;

  while ((match = urlRe.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(lastIndex, match.index));
    let candidate = match[0];
    let trailing = '';
    while (/[.,);!?]+$/.test(candidate)) {
      trailing = candidate.slice(-1) + trailing;
      candidate = candidate.slice(0, -1);
    }
    const cleanHref = safeUrl(candidate);
    if (cleanHref) {
      const shortLabel = candidate.replace(/^https?:\/\//, '');
      const display = shortLabel.length > 36 ? shortLabel.slice(0, 34) + '…' : shortLabel;
      out += `<a class="note-link" href="${escapeHtml(cleanHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(display)}</a>`;
    } else {
      out += escapeHtml(candidate);
    }
    out += escapeHtml(trailing);
    lastIndex = urlRe.lastIndex;
  }

  out += escapeHtml(raw.slice(lastIndex));
  return out;
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
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`
  };
}

export function getOffsetDateStr(daysOffset = 0) {
  const dt = new Date();
  dt.setDate(dt.getDate() + daysOffset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function isTaskOverdue(task, nowInfo) {
  if (task.done || !task.deadline) return false;
  if (task.deadline < nowInfo.date) return true;
  return task.deadline === nowInfo.date && Boolean(task.time) && task.time < nowInfo.time;
}

export function formatDeadlineLabel(deadline, time, todayDate) {
  if (!deadline) return '';
  let dayPart = deadline;
  if (deadline === todayDate) {
    dayPart = 'Сьогодні';
  } else {
    const p = deadline.split('-').map(Number);
    if (p.length === 3 && !p.some(Number.isNaN)) {
      dayPart = deadline === getOffsetDateStr(1) ? 'Завтра' : `${p[2]} ${MONTHS_SHORT[p[1] - 1] || ''}`;
    }
  }
  return time ? `${dayPart}, ${time}` : dayPart;
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

export function sortColumnTasks(tasks, status) {
  const copy = tasks.slice();
  if (status === 'Готово') return copy.sort((a, b) => b.row - a.row);
  return copy.sort((a, b) => {
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

/* ======================== Web Audio API тактильний звук ======================== */

let audioCtx = null;

export function playFeedbackSound(kind, enabled) {
  if (!enabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (kind === 'done') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(780, now + 0.09);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.15);
    } else if (kind === 'create') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(420, now);
      osc.frequency.exponentialRampToValueAtTime(560, now + 0.06);
      gain.gain.setValueAtTime(0.045, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.start(now);
      osc.stop(now + 0.1);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(340, now);
      osc.frequency.exponentialRampToValueAtTime(260, now + 0.07);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.start(now);
      osc.stop(now + 0.1);
    }
  } catch (_) {}
}
