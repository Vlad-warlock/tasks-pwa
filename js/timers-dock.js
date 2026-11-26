// Док Фокус-таймерів (адаптовано з cex-copilot/core/timers-dock.js) + Picture-in-Picture на ПК
import { escapeHtml, loadJson, saveJson } from './utils.js';
import { audioFx } from './fx.js';

const TIMERS_KEY = 'tasks_pwa_timers_v1';
const PRESETS_MIN = [5, 15, 25, 45, 60];

let timers = [];
let dockOpen = false;
let pipWin = null;
let tickInterval = null;
let notifyFn = null;

function fmtMs(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function getRemMs(t, now = Date.now()) {
  return t.pausedRem !== null && t.pausedRem !== undefined
    ? t.pausedRem
    : Math.max(0, (t.endAt || 0) - now);
}

function persist() {
  saveJson(TIMERS_KEY, timers);
}

export function startFocusTimer(minutes, labelText = '') {
  const mins = Number(minutes);
  if (!mins || mins <= 0) return;
  const durationMs = Math.round(mins * 60 * 1000);
  timers.push({
    id: `tm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    label: String(labelText || '').trim() || 'Фокус-сесія',
    durationMs,
    endAt: Date.now() + durationMs,
    pausedRem: null,
    notified: false
  });
  persist();
  audioFx.playClick();
  dockOpen = true;
  renderDock();
  updateTopbarTimerBtn();
}

function updateTopbarTimerBtn() {
  const btn = document.getElementById('btnTimers');
  const lbl = document.getElementById('timersBtnLabel');
  if (!btn || !lbl) return;

  const now = Date.now();
  const running = timers.filter((t) => getRemMs(t, now) > 0 && t.pausedRem === null);
  const finished = timers.filter((t) => getRemMs(t, now) === 0);

  btn.classList.toggle('has-running', running.length > 0);
  btn.classList.toggle('has-done', finished.length > 0 && running.length === 0);

  if (running.length > 0) {
    const nearest = running.reduce((a, b) => (getRemMs(a, now) < getRemMs(b, now) ? a : b));
    lbl.textContent = fmtMs(getRemMs(nearest, now));
  } else if (finished.length > 0) {
    lbl.textContent = `Готово (${finished.length})`;
  } else {
    lbl.textContent = 'Таймер';
  }
}

function buildDockHtml(isPip = false) {
  const now = Date.now();
  const canPip = !isPip && 'documentPictureInPicture' in window;
  const rowsHtml = timers.length
    ? timers.map((t) => {
      const rem = getRemMs(t, now);
      const isDone = rem === 0;
      const isPaused = t.pausedRem !== null;
      const pct = t.durationMs > 0 ? Math.min(100, Math.round(((t.durationMs - rem) / t.durationMs) * 100)) : 100;
      return `
        <div class="tm-item${isDone ? ' is-done' : isPaused ? ' is-paused' : ''}">
          <div class="tm-item-row">
            <span class="tm-label">${escapeHtml(t.label)}</span>
            <div class="tm-controls">
              <strong class="tm-clock" data-tm-clock="${escapeHtml(t.id)}">${isDone ? 'Час вийшов' : fmtMs(rem)}</strong>
              ${!isDone ? `<button type="button" class="tm-mini-btn" data-tm-act="pause" data-id="${escapeHtml(t.id)}" title="${isPaused ? 'Продовжити' : 'Пауза'}">${isPaused ? '▶' : '⏸'}</button>` : ''}
              <button type="button" class="tm-mini-btn" data-tm-act="restart" data-id="${escapeHtml(t.id)}" title="Перезапустити">↻</button>
              <button type="button" class="tm-mini-btn" data-tm-act="del" data-id="${escapeHtml(t.id)}" title="Прибрати">&times;</button>
            </div>
          </div>
          <progress class="tm-progress" data-tm-prog="${escapeHtml(t.id)}" value="${pct}" max="100"></progress>
        </div>`;
    }).join('')
    : '<p class="tm-empty">Оберіть час нижче для старту фокус-сесії або перерви.</p>';

  return `
    <div class="tm-head">
      <strong class="tm-title">Фокус-таймери (${timers.length})</strong>
      <div class="tm-head-actions">
        ${canPip ? '<button type="button" class="tm-pip-btn" data-tm-act="pip" title="Винести поверх усіх вікон">⧉ Поверх вікон</button>' : ''}
        ${!isPip ? '<button type="button" class="tm-mini-btn" data-tm-act="close" title="Згорнути">&times;</button>' : ''}
      </div>
    </div>
    <div class="tm-input-row">
      <input type="text" id="tmLabelInput" class="tm-input" placeholder="Задача або #профіль (опційно)" autocomplete="off">
    </div>
    <div class="tm-presets">
      ${PRESETS_MIN.map((m) => `<button type="button" class="tm-preset-btn" data-tm-min="${m}">${m} хв</button>`).join('')}
    </div>
    <div class="tm-list">${rowsHtml}</div>`;
}

function bindDockContainer(root, isPip = false) {
  root.onclick = (e) => {
    const preset = e.target.closest('[data-tm-min]');
    if (preset) {
      const inp = root.querySelector('#tmLabelInput');
      const label = inp ? inp.value.trim() : '';
      if (inp) inp.value = '';
      startFocusTimer(Number(preset.dataset.tmMin), label);
      return;
    }
    const actBtn = e.target.closest('[data-tm-act]');
    if (!actBtn) return;
    const act = actBtn.dataset.tmAct;
    const id = actBtn.dataset.id;

    if (act === 'close') {
      dockOpen = false;
      renderDock();
      return;
    }
    if (act === 'pip' && !isPip) {
      openPipWindow();
      return;
    }

    const target = timers.find((x) => x.id === id);
    if (!target) return;

    if (act === 'pause') {
      if (target.pausedRem !== null) {
        target.endAt = Date.now() + target.pausedRem;
        target.pausedRem = null;
      } else {
        target.pausedRem = getRemMs(target);
      }
    } else if (act === 'restart') {
      target.endAt = Date.now() + target.durationMs;
      target.pausedRem = null;
      target.notified = false;
    } else if (act === 'del') {
      timers = timers.filter((x) => x.id !== id);
    }
    audioFx.playClick();
    persist();
    renderDock();
    updateTopbarTimerBtn();
  };
}

function renderDock() {
  const dock = document.getElementById('timersDock');
  if (dock) {
    dock.hidden = !dockOpen;
    if (dockOpen) {
      dock.innerHTML = buildDockHtml(false);
      bindDockContainer(dock, false);
    }
  }
  if (pipWin && !pipWin.closed) {
    const pipRoot = pipWin.document.getElementById('pipDockRoot');
    if (pipRoot) {
      pipRoot.innerHTML = buildDockHtml(true);
      bindDockContainer(pipRoot, true);
    }
  }
}

async function openPipWindow() {
  if (!('documentPictureInPicture' in window)) return;
  try {
    pipWin = await window.documentPictureInPicture.requestWindow({ width: 320, height: 290 });
    const link1 = pipWin.document.createElement('link');
    link1.rel = 'stylesheet';
    link1.href = new URL('./styles.css', window.location.href).href;
    const link2 = pipWin.document.createElement('link');
    link2.rel = 'stylesheet';
    link2.href = new URL('./board-views.css', window.location.href).href;
    pipWin.document.head.append(link1, link2);
    pipWin.document.body.innerHTML = '<div id="pipDockRoot" class="timers-dock is-pip"></div>';
    pipWin.addEventListener('pagehide', () => { pipWin = null; });
    dockOpen = false;
    renderDock();
  } catch (_) {}
}

function tick() {
  const now = Date.now();
  let stateChanged = false;

  for (const t of timers) {
    const rem = getRemMs(t, now);
    if (rem === 0 && !t.notified) {
      t.notified = true;
      stateChanged = true;
      audioFx.playTimerDone();
      if (notifyFn) notifyFn(`Таймер завершено: ${t.label}`, 'success');
    }
    const pct = t.durationMs > 0 ? Math.min(100, Math.round(((t.durationMs - rem) / t.durationMs) * 100)) : 100;
    for (const doc of [document, pipWin && !pipWin.closed ? pipWin.document : null]) {
      if (!doc) continue;
      const clk = doc.querySelector(`[data-tm-clock="${t.id}"]`);
      if (clk) clk.textContent = rem === 0 ? 'Час вийшов' : fmtMs(rem);
      const prg = doc.querySelector(`[data-tm-prog="${t.id}"]`);
      if (prg) prg.value = pct;
    }
  }

  if (stateChanged) {
    persist();
    renderDock();
  }
  updateTopbarTimerBtn();
}

export function initTimersDock({ onNotify }) {
  notifyFn = onNotify;
  const saved = loadJson(TIMERS_KEY, []);
  timers = Array.isArray(saved) ? saved : [];

  document.getElementById('btnTimers')?.addEventListener('click', (e) => {
    e.stopPropagation();
    dockOpen = !dockOpen;
    audioFx.playClick();
    renderDock();
  });

  document.addEventListener('click', (e) => {
    if (!dockOpen) return;
    const dock = document.getElementById('timersDock');
    const btn = document.getElementById('btnTimers');
    if (dock && !dock.contains(e.target) && btn && !btn.contains(e.target)) {
      dockOpen = false;
      dock.hidden = true;
    }
  });

  updateTopbarTimerBtn();
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(tick, 1000);
}
