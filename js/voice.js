import { STATUS_COLUMNS, SPHERES, PRIORITIES, escapeHtml, getTodayLocal } from './utils.js';
import { serializeTaskMeta, extractTags } from './notes-meta.js';
import { apiPost, enqueueOfflineOrSend } from './api.js';
import { audioFx } from './fx.js';
import { openModal, closeModal, showToast } from './ui.js';
import { openSettingsModal } from './modals.js';

const $ = (id) => document.getElementById(id);
const MAX_RECORD_MS = 60000;
const MAX_AUDIO_BYTES = 4.2 * 1024 * 1024;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

const voice = {
  ctx: null,
  mode: 'idle',
  recorder: null,
  stream: null,
  chunks: [],
  activeMime: '',
  startedAt: 0,
  timerId: null,
  canceled: false,
  transcript: '',
  drafts: []
};

function setVoiceView(nextMode, titleText) {
  voice.mode = nextMode;
  $('voiceModalTitle').textContent = titleText;
  $('voiceRecView').hidden = nextMode !== 'recording';
  $('voiceBusyView').hidden = nextMode !== 'processing';
  $('voiceReviewView').hidden = nextMode !== 'review';
  $('voiceErrorView').hidden = nextMode !== 'error';
}

function stopMediaTracks() {
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
  const el = $('voiceTimer');
  if (el) el.textContent = `${mm}:${ss}`;
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
  setVoiceView('error', 'Голосовий запис');
  $('voiceErrorText').textContent = msg;
  $('btnVoiceOpenSettings').hidden = !showSettingsBtn;
  openModal('voiceModal');
}

function renderDrafts() {
  const trEl = $('voiceTranscript');
  if (trEl) {
    trEl.hidden = !voice.transcript;
    trEl.textContent = voice.transcript ? `«${voice.transcript}»` : '';
  }

  const activeStatuses = STATUS_COLUMNS.filter((s) => s !== 'Готово');
  const sphereList = SPHERES.filter((s) => s !== 'Усі');
  const prioList = PRIORITIES.filter((p) => p !== 'Усі');

  $('voiceDraftList').innerHTML = voice.drafts.map((d, idx) => {
    const sphereOpts = sphereList.map((s) => `<option value="${escapeHtml(s)}"${s === d.sphere ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
    const statusOpts = activeStatuses.map((s) => `<option value="${escapeHtml(s)}"${s === d.status ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
    const prioOpts = prioList.map((p) => `<option value="${escapeHtml(p)}"${p === d.priority ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('');
    const metaBadges = [
      d.deadline ? `<span class="badge badge-deadline">${escapeHtml(d.deadline)}${d.time ? `, ${escapeHtml(d.time)}` : ''}</span>` : '',
      d.checklist.length ? `<span class="badge">✓ ${d.checklist.length} крок.</span>` : ''
    ].filter(Boolean).join('');

    return `
      <div class="voice-draft-card" data-vd-idx="${idx}">
        <div class="vd-head">
          <input type="text" class="vd-title-input" data-vd-title="${idx}" value="${escapeHtml(d.task)}" aria-label="Назва задачі">
          <button type="button" class="cl-remove-btn" data-vd-del="${idx}" aria-label="Прибрати задачу">&times;</button>
        </div>
        <div class="vd-selects">
          <select data-vd-sphere="${idx}" aria-label="Сфера">${sphereOpts}</select>
          <select data-vd-status="${idx}" aria-label="Статус">${statusOpts}</select>
          <select data-vd-prio="${idx}" aria-label="Пріоритет">${prioOpts}</select>
        </div>
        ${metaBadges ? `<div class="vd-meta">${metaBadges}</div>` : ''}
        ${d.notes ? `<p class="vd-notes">${escapeHtml(d.notes)}</p>` : ''}
      </div>`;
  }).join('');

  $('btnVoiceSave').textContent = voice.drafts.length > 1 ? `Додати (${voice.drafts.length})` : 'Додати на дошку';
}

async function processAudioBlob(blob, durationMs) {
  if (durationMs < 400 || !blob || blob.size === 0) {
    return showVoiceError('Запис занадто короткий. Натисніть мікрофон і продиктуйте задачу.');
  }
  if (blob.size > MAX_AUDIO_BYTES) {
    return showVoiceError('Запис завеликий. Спробуйте записати коротше (до 1 хвилини).');
  }

  setVoiceView('processing', 'Обробка голосу');
  try {
    const audioBase64 = await blobToBase64(blob);
    const { state } = voice.ctx;
    const defStatus = state.activeStatus === 'Готово' ? 'Фокус' : state.activeStatus;
    const res = await apiPost(state.config, {
      action: 'voiceParse',
      audioBase64,
      mimeType: blob.type || voice.activeMime || 'audio/mp4',
      todayDate: getTodayLocal().date,
      defaultStatus: defStatus
    });

    voice.transcript = String(res.transcript || '').trim();
    voice.drafts = (Array.isArray(res.tasks) ? res.tasks : []).map((t) => ({
      task: String(t.task || '').trim(),
      sphere: t.sphere || 'Життя',
      status: t.status || defStatus,
      priority: t.priority || 'Середній',
      deadline: t.deadline || '',
      time: t.time || '',
      notes: String(t.notes || '').trim(),
      checklist: Array.isArray(t.checklist) ? t.checklist : []
    })).filter((d) => d.task);

    if (voice.drafts.length === 0) {
      const hint = voice.transcript ? `Розшифровка: «${voice.transcript}». ` : '';
      return showVoiceError(`${hint}Не вдалося виділити задачі. Спробуйте ще раз.`);
    }

    setVoiceView('review', `Знайдено задач: ${voice.drafts.length}`);
    renderDrafts();
    audioFx.playSuccess();
  } catch (err) {
    const msg = err?.message || 'Не вдалося розпізнати голос';
    const needKey = msg.includes('Gemini API ключ');
    showVoiceError(msg, needKey);
    audioFx.playAlert();
  }
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
    setVoiceView('recording', 'Голосовий запис');
    openModal('voiceModal');
    voice.recorder.start();
    voice.timerId = setInterval(updateTimerDisplay, 250);
    audioFx.playClick();
  } catch (err) {
    stopMediaTracks();
    const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
    showVoiceError(denied ? 'Доступ до мікрофона заборонено. Дозвольте мікрофон у налаштуваннях Safari/браузера.' : 'Не вдалося увімкнути мікрофон.');
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

export function closeVoiceModal() {
  voice.canceled = true;
  if (voice.recorder && voice.recorder.state !== 'inactive') {
    try { voice.recorder.stop(); } catch (_) {}
  }
  stopMediaTracks();
  voice.mode = 'idle';
  closeModal('voiceModal');
}

function saveVoiceDrafts() {
  const { state, saveCache, render, syncCallbacks, nextTempRow } = voice.ctx;
  const ready = voice.drafts.filter((d) => d.task.trim());
  if (!ready.length) return showToast('Залиште хоча б одну задачу з назвою', 'error');

  for (const d of ready) {
    const serializedNotes = serializeTaskMeta({
      cleanNotes: d.notes,
      checklist: d.checklist.map((text) => ({ done: false, text })),
      tags: extractTags(d.notes),
      pinned: false,
      repeat: { type: 'none', value: '' }
    });
    state.tasks.push({
      row: nextTempRow(),
      done: false,
      sphere: d.sphere,
      task: d.task.trim(),
      status: d.status,
      priority: d.priority,
      deadline: d.deadline,
      time: d.time,
      notes: serializedNotes,
      inCalendar: false
    });
    enqueueOfflineOrSend(state, {
      action: 'create',
      fields: {
        sphere: d.sphere,
        task: d.task.trim(),
        status: d.status,
        priority: d.priority,
        deadline: d.deadline,
        time: d.time,
        notes: serializedNotes,
        addToCalendar: false
      },
      successText: ready.length > 1 ? '' : 'Голосову задачу додано'
    }, syncCallbacks);
  }

  if (window.innerWidth < 960 && ready.length === 1) state.activeStatus = ready[0].status;
  saveCache();
  render();
  closeVoiceModal();
  audioFx.playSuccess();
  if (ready.length > 1) showToast(`Додано задач: ${ready.length}`, 'success');
}

export function initVoice(ctx) {
  voice.ctx = ctx;

  $('btnVoice')?.addEventListener('click', startVoiceRecording);
  $('btnVoiceStop')?.addEventListener('click', stopRecording);
  $('btnVoiceCancel')?.addEventListener('click', closeVoiceModal);
  $('btnCloseVoiceModal')?.addEventListener('click', closeVoiceModal);
  $('btnVoiceRetry')?.addEventListener('click', startVoiceRecording);
  $('btnVoiceRetryErr')?.addEventListener('click', startVoiceRecording);
  $('btnVoiceSave')?.addEventListener('click', saveVoiceDrafts);
  $('btnVoiceOpenSettings')?.addEventListener('click', () => {
    closeVoiceModal();
    openSettingsModal(ctx);
  });

  $('voiceModal')?.addEventListener('click', (e) => {
    if (e.target === $('voiceModal') && voice.mode !== 'processing') closeVoiceModal();
  });

  const list = $('voiceDraftList');
  list?.addEventListener('input', (e) => {
    const inp = e.target.closest('[data-vd-title]');
    if (inp && voice.drafts[Number(inp.dataset.vdTitle)]) {
      voice.drafts[Number(inp.dataset.vdTitle)].task = inp.value;
    }
  });
  list?.addEventListener('change', (e) => {
    const sel = e.target.closest('select');
    if (!sel) return;
    if (sel.dataset.vdSphere !== undefined) voice.drafts[Number(sel.dataset.vdSphere)].sphere = sel.value;
    else if (sel.dataset.vdStatus !== undefined) voice.drafts[Number(sel.dataset.vdStatus)].status = sel.value;
    else if (sel.dataset.vdPrio !== undefined) voice.drafts[Number(sel.dataset.vdPrio)].priority = sel.value;
  });
  list?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-vd-del]');
    if (!del) return;
    voice.drafts.splice(Number(del.dataset.vdDel), 1);
    audioFx.playClick();
    if (!voice.drafts.length) closeVoiceModal();
    else renderDrafts();
  });
}
