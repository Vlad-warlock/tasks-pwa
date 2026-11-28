import { getTodayLocal } from './utils.js';
import { apiPost } from './api.js';
import { audioFx } from './fx.js';
import { openModal, closeModal, showToast } from './ui.js';
import { openSettingsModal } from './modals.js';
import { buildAiContextPayload, renderAiActionCards, applyAiActions } from './ai-actions.js';
import { BOT_STAGE_HTML, setBotMood, pokeBot, startVoiceVisualizer, stopVoiceVisualizer } from './voice-bot.js';

const $ = (id) => document.getElementById(id);
const MAX_RECORD_MS = 60000;
const MAX_AUDIO_BYTES = 4.2 * 1024 * 1024;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

const voice = {
  ctx: null,
  mode: 'idle',
  minimized: false,
  recorder: null,
  stream: null,
  chunks: [],
  activeMime: '',
  startedAt: 0,
  timerId: null,
  canceled: false,
  transcript: '',
  reply: '',
  actions: []
};

function syncMiniControls() {
  const isRec = voice.mode === 'recording';
  const isBusy = voice.mode === 'processing';
  const recEl = $('voiceMiniRec');
  const micBtn = $('btnVoiceMiniMic');
  const busyEl = $('voiceMiniBusy');
  if (recEl) recEl.hidden = !isRec;
  if (micBtn) micBtn.hidden = isRec || isBusy;
  if (busyEl) busyEl.hidden = !isBusy;
}

function setVoiceMinimized(next) {
  voice.minimized = Boolean(next);
  $('voiceModal')?.classList.toggle('is-minimized', voice.minimized);
  const btn = $('btnToggleVoiceMin');
  if (btn) {
    btn.title = voice.minimized ? 'Розгорнути ШІ-асистента' : 'Згорнути, щоб бачити дошку';
    btn.setAttribute('aria-label', voice.minimized ? 'Розгорнути' : 'Згорнути');
  }
  const path = $('voiceMinIconPath');
  if (path) path.setAttribute('d', voice.minimized ? 'M5 12.5l5-5 5 5' : 'M4.5 11.5h11');
  syncMiniControls();
}

function setVoiceView(nextMode, titleText, botLine = '') {
  voice.mode = nextMode;
  $('voiceModalTitle').textContent = titleText;
  const composeView = $('voiceComposeView');
  if (composeView) composeView.hidden = nextMode !== 'compose';
  $('voiceRecView').hidden = nextMode !== 'recording';
  $('voiceBusyView').hidden = nextMode !== 'processing';
  $('voiceReviewView').hidden = nextMode !== 'review';
  $('voiceErrorView').hidden = nextMode !== 'error';
  $('voiceBotMount')?.classList.toggle('is-compact', nextMode === 'review');
  setBotMood(nextMode, botLine);
  if (nextMode === 'review' || nextMode === 'error') setVoiceMinimized(false);
  else syncMiniControls();
}

function stopMediaTracks() {
  stopVoiceVisualizer();
  if (voice.timerId) { clearInterval(voice.timerId); voice.timerId = null; }
  if (voice.stream) {
    voice.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    voice.stream = null;
  }
}

function updateTimerDisplay() {
  const sec = Math.max(0, Math.floor((Date.now() - voice.startedAt) / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  const timeStr = `${mm}:${ss}`;
  const el = $('voiceTimer');
  if (el) el.textContent = timeStr;
  const miniEl = $('voiceMiniTimer');
  if (miniEl) miniEl.textContent = timeStr;
  if (Date.now() - voice.startedAt >= MAX_RECORD_MS && voice.mode === 'recording') {
    stopRecording();
  }
}

function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(new Error('Не вдалося прочитати аудіофайл'));
    reader.readAsDataURL(blob);
  });
}

function showVoiceError(msg, showSettingsBtn = false) {
  setVoiceView('error', 'ШІ-асистент');
  $('voiceErrorText').textContent = msg;
  $('btnVoiceOpenSettings').hidden = !showSettingsBtn;
  openModal('voiceModal');
}

function renderActionPreview() {
  const trEl = $('voiceTranscript');
  if (trEl) {
    trEl.hidden = !voice.transcript;
    trEl.textContent = voice.transcript ? `«${voice.transcript}»` : '';
  }

  const listEl = $('voiceDraftList');
  if (listEl) listEl.innerHTML = renderAiActionCards(voice.actions, voice.ctx.state);

  const saveBtn = $('btnVoiceSave');
  if (saveBtn) {
    saveBtn.hidden = voice.actions.length === 0;
    saveBtn.textContent = voice.actions.length > 1 ? `Застосувати (${voice.actions.length})` : 'Застосувати';
  }
}

async function sendAiCommand({ text = '', audioBase64 = '', mimeType = '' }) {
  const { state } = voice.ctx;
  setVoiceView('processing', 'Аналізую команду');
  try {
    const defStatus = state.activeStatus === 'Готово' ? 'Фокус' : state.activeStatus;
    const res = await apiPost(state.config, {
      action: 'aiCommand',
      text,
      audioBase64,
      mimeType,
      todayDate: getTodayLocal().date,
      defaultStatus: defStatus,
      context: buildAiContextPayload(state)
    });

    voice.transcript = String(res.transcript || '').trim();
    voice.reply = String(res.reply || '').trim();
    voice.actions = Array.isArray(res.actions) ? res.actions : [];

    const title = voice.actions.length ? `План змін (${voice.actions.length})` : 'Відповідь ШІ';
    const bubbleLine = voice.reply || (voice.actions.length ? 'План готовий! Перевір перед застосуванням' : 'Готово.');
    setVoiceView('review', title, bubbleLine);
    renderActionPreview();
    audioFx.playSuccess();
  } catch (err) {
    const msg = err?.message || 'Не вдалося обробити команду';
    showVoiceError(msg, msg.includes('Gemini API ключ'));
    audioFx.playAlert();
  }
}

async function processAudioBlob(blob, durationMs) {
  if (durationMs < 400 || !blob || blob.size === 0) {
    return showVoiceError('Запис занадто короткий. Натисніть «Говорити» і продиктуйте команду.');
  }
  if (blob.size > MAX_AUDIO_BYTES) {
    return showVoiceError('Запис завеликий. Спробуйте записати коротше (до 1 хвилини).');
  }
  const audioBase64 = await blobToBase64(blob);
  const mimeType = blob.type || voice.activeMime || 'audio/mp4';
  await sendAiCommand({ audioBase64, mimeType });
}

export function openAiAssistant() {
  const { state, ensureConfigured } = voice.ctx;
  if (!ensureConfigured()) return;

  if (!state.hasGeminiKey) {
    return showVoiceError('Додайте безкоштовний Gemini API ключ у Налаштуваннях, щоб користуватись ШІ-асистентом.', true);
  }

  const modal = $('voiceModal');
  if (modal && !modal.hidden && voice.minimized) {
    setVoiceMinimized(false);
    audioFx.playClick();
    if (voice.mode === 'compose' && window.innerWidth > 720) setTimeout(() => $('aiCommandInput')?.focus(), 60);
    return;
  }

  voice.transcript = '';
  voice.reply = '';
  voice.actions = [];
  const inp = $('aiCommandInput');
  if (inp) inp.value = '';

  setVoiceMinimized(false);
  setVoiceView('compose', 'ШІ-асистент');
  openModal('voiceModal');
  audioFx.playClick();
  if (window.innerWidth > 720) setTimeout(() => inp?.focus(), 60);
}

export async function startVoiceRecording() {
  const { state, ensureConfigured } = voice.ctx;
  if (!ensureConfigured()) return;

  if (!state.hasGeminiKey) {
    return showVoiceError('Додайте безкоштовний Gemini API ключ у Налаштуваннях, щоб розпізнавати голос.', true);
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return showVoiceError('Ваш браузер не підтримує запис аудіо з мікрофона.');
  }

  try {
    voice.canceled = false;
    voice.chunks = [];
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voice.activeMime = pickAudioMime();
    const opts = voice.activeMime ? { mimeType: voice.activeMime } : undefined;
    voice.recorder = opts ? new MediaRecorder(voice.stream, opts) : new MediaRecorder(voice.stream);
    voice.activeMime = voice.recorder.mimeType || voice.activeMime || 'audio/mp4';

    voice.recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) voice.chunks.push(e.data);
    });
    voice.recorder.addEventListener('stop', () => {
      const durationMs = Date.now() - voice.startedAt;
      const blob = new Blob(voice.chunks, { type: voice.activeMime || 'audio/mp4' });
      voice.recorder = null;
      voice.chunks = [];
      stopMediaTracks();
      if (!voice.canceled) processAudioBlob(blob, durationMs);
    });

    voice.startedAt = Date.now();
    $('voiceTimer').textContent = '00:00';
    if ($('voiceMiniTimer')) $('voiceMiniTimer').textContent = '00:00';
    setVoiceView('recording', 'Голосовий запис');
    openModal('voiceModal');
    voice.recorder.start();
    startVoiceVisualizer(voice.stream);
    voice.timerId = setInterval(updateTimerDisplay, 250);
    audioFx.playClick();
  } catch (err) {
    stopMediaTracks();
    const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
    showVoiceError(denied ? 'Доступ до мікрофона заборонено. Дозвольте мікрофон у налаштуваннях браузера.' : 'Не вдалося увімкнути мікрофон.');
  }
}

function stopRecording() {
  if (voice.recorder && voice.recorder.state !== 'inactive') {
    audioFx.playClick();
    voice.recorder.stop();
  } else {
    stopMediaTracks();
  }
}

function cancelRecordingToCompose() {
  voice.canceled = true;
  if (voice.recorder && voice.recorder.state !== 'inactive') {
    try { voice.recorder.stop(); } catch (_) {}
  }
  stopMediaTracks();
  setVoiceView('compose', 'ШІ-асистент');
  audioFx.playClick();
}

export function closeVoiceModal() {
  voice.canceled = true;
  if (voice.recorder && voice.recorder.state !== 'inactive') {
    try { voice.recorder.stop(); } catch (_) {}
  }
  stopMediaTracks();
  voice.mode = 'idle';
  setVoiceMinimized(false);
  closeModal('voiceModal');
}

function submitTextCommand() {
  const inp = $('aiCommandInput');
  const text = String(inp?.value || '').trim();
  if (!text) {
    inp?.focus();
    return showToast('Введіть команду або натисніть «Говорити»', 'error');
  }
  audioFx.playClick();
  sendAiCommand({ text });
}

function confirmAndApplyActions() {
  if (!voice.actions.length) return closeVoiceModal();
  const res = applyAiActions(voice.actions, voice.ctx);
  closeVoiceModal();
  audioFx.playSuccess();
  if (res.appliedCount > 0) {
    showToast(`Застосовано змін: ${res.appliedCount}`, 'success');
  } else {
    showToast('Зміни не застосовано (ціль не знайдено)', 'error');
  }
}

export function initVoice(ctx) {
  voice.ctx = ctx;
  const mount = $('voiceBotMount');
  if (mount) {
    mount.innerHTML = BOT_STAGE_HTML;
    $('voiceBotBtn')?.addEventListener('click', () => {
      audioFx.playClick();
      pokeBot();
    });
  }

  $('btnVoice')?.addEventListener('click', openAiAssistant);
  $('btnAiSend')?.addEventListener('click', submitTextCommand);
  $('btnAiMic')?.addEventListener('click', startVoiceRecording);
  $('aiCommandInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitTextCommand();
    }
  });

  $('btnVoiceStop')?.addEventListener('click', stopRecording);
  $('btnVoiceMiniStop')?.addEventListener('click', stopRecording);
  $('btnVoiceMiniMic')?.addEventListener('click', startVoiceRecording);
  $('btnToggleVoiceMin')?.addEventListener('click', () => {
    audioFx.playClick();
    setVoiceMinimized(!voice.minimized);
  });
  $('btnVoiceCancel')?.addEventListener('click', cancelRecordingToCompose);
  $('btnCloseVoiceModal')?.addEventListener('click', closeVoiceModal);
  $('btnVoiceRetry')?.addEventListener('click', openAiAssistant);
  $('btnVoiceRetryErr')?.addEventListener('click', openAiAssistant);
  $('btnVoiceSave')?.addEventListener('click', confirmAndApplyActions);
  $('btnVoiceOpenSettings')?.addEventListener('click', () => {
    closeVoiceModal();
    openSettingsModal(ctx);
  });

  const list = $('voiceDraftList');
  list?.addEventListener('input', (e) => {
    const inp = e.target.closest('[data-vd-title]');
    if (inp && voice.actions[Number(inp.dataset.vdTitle)]) {
      voice.actions[Number(inp.dataset.vdTitle)].task = inp.value;
    }
  });
  list?.addEventListener('change', (e) => {
    const sel = e.target.closest('select');
    if (!sel) return;
    if (sel.dataset.vdSphere !== undefined) voice.actions[Number(sel.dataset.vdSphere)].sphere = sel.value;
    else if (sel.dataset.vdStatus !== undefined) voice.actions[Number(sel.dataset.vdStatus)].status = sel.value;
    else if (sel.dataset.vdPrio !== undefined) voice.actions[Number(sel.dataset.vdPrio)].priority = sel.value;
  });
  list?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-ai-del]');
    if (!del) return;
    voice.actions.splice(Number(del.dataset.aiDel), 1);
    audioFx.playClick();
    if (!voice.actions.length && !voice.reply) openAiAssistant();
    else renderActionPreview();
  });
}
