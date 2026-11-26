// Інтерактивний бот-компаньйон для голосового запису з живою візуалізацією гучності

const REC_GREETINGS = [
  'О, давай щось запишемо! Слухаю тебе',
  'На зв’язку! Диктуй — розкладу по поличках',
  'Готовий! Кажи, що додаємо на дошку'
];

const POKE_LINES = [
  'Хей! Мікрофон уже гріється, диктуй!',
  'Піп-біп! Накидай задач на день',
  'Я тут! Кажи справу — і полетіли'
];

let greetIdx = 0;
let pokeIdx = 0;
let pokeTimer = null;
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let rafId = 0;
let smoothLevel = 0;
const smoothBars = [0.35, 0.5, 0.65, 0.5, 0.35];

export const BOT_STAGE_HTML = `
  <div class="voice-bot-stage" id="voiceBotStage" data-mood="recording">
    <button type="button" class="voice-bot-btn" id="voiceBotBtn" aria-label="Натисни на бота">
      <span class="voice-bot-halo" aria-hidden="true"></span>
      <svg class="voice-bot-svg" viewBox="0 0 96 96" width="88" height="88" aria-hidden="true">
        <line x1="48" y1="20" x2="48" y2="10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
        <circle class="vb-antenna" cx="48" cy="8" r="4.5"/>
        <rect x="11" y="42" width="7" height="18" rx="3.5" fill="#253246" stroke="#384b68" stroke-width="1.5"/>
        <rect x="78" y="42" width="7" height="18" rx="3.5" fill="#253246" stroke="#384b68" stroke-width="1.5"/>
        <rect class="vb-shell" x="18" y="20" width="60" height="58" rx="16" fill="#161f2d" stroke="#384b68" stroke-width="2.2"/>
        <rect x="25" y="30" width="46" height="36" rx="10" fill="#0c1018" stroke="#253246" stroke-width="1.5"/>
        <rect class="vb-eye vb-eye-l" x="34" y="39" width="8" height="10" rx="4"/>
        <rect class="vb-eye vb-eye-r" x="54" y="39" width="8" height="10" rx="4"/>
        <g class="vb-mouth">
          <rect class="vb-bar vb-b1" x="33" y="55" width="4" height="6" rx="2"/>
          <rect class="vb-bar vb-b2" x="40" y="54" width="4" height="8" rx="2"/>
          <rect class="vb-bar vb-b3" x="47" y="53" width="4" height="10" rx="2"/>
          <rect class="vb-bar vb-b4" x="54" y="54" width="4" height="8" rx="2"/>
          <rect class="vb-bar vb-b5" x="61" y="55" width="4" height="6" rx="2"/>
        </g>
      </svg>
    </button>
    <div class="voice-bot-bubble" id="voiceBotBubble">О, давай щось запишемо!</div>
  </div>
`;

export function setBotMood(mood, customLine = '') {
  const stage = document.getElementById('voiceBotStage');
  const bubble = document.getElementById('voiceBotBubble');
  if (!stage || !bubble) return;

  stage.dataset.mood = mood || 'recording';
  if (customLine) {
    bubble.textContent = customLine;
    return;
  }

  if (mood === 'recording') {
    bubble.textContent = REC_GREETINGS[greetIdx++ % REC_GREETINGS.length];
  } else if (mood === 'processing') {
    bubble.textContent = 'Хм, розкладаю твої слова по колонках...';
  } else if (mood === 'review') {
    bubble.textContent = 'Зловив задачі! Перевір перед додаванням';
  } else if (mood === 'error') {
    bubble.textContent = 'Ой, щось пішло не так... Спробуємо ще?';
  }
}

export function pokeBot() {
  const stage = document.getElementById('voiceBotStage');
  const bubble = document.getElementById('voiceBotBubble');
  if (!stage) return;

  stage.classList.remove('is-poked');
  void stage.offsetWidth;
  stage.classList.add('is-poked');

  if (bubble && stage.dataset.mood === 'recording') {
    bubble.textContent = POKE_LINES[pokeIdx++ % POKE_LINES.length];
  }

  if (pokeTimer) clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => stage.classList.remove('is-poked'), 520);
}

function applyLevelVars(stage, vals) {
  stage.style.setProperty('--vb-lvl', vals.lvl.toFixed(3));
  stage.style.setProperty('--vb-b1', vals.b1.toFixed(2));
  stage.style.setProperty('--vb-b2', vals.b2.toFixed(2));
  stage.style.setProperty('--vb-b3', vals.b3.toFixed(2));
  stage.style.setProperty('--vb-b4', vals.b4.toFixed(2));
  stage.style.setProperty('--vb-b5', vals.b5.toFixed(2));
}

export function startVoiceVisualizer(stream) {
  stopVoiceVisualizer();
  const stage = document.getElementById('voiceBotStage');
  if (!stage || !stream) return;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  let bins = null;

  if (Ctx && typeof stream.getAudioTracks === 'function' && stream.getAudioTracks().length > 0) {
    try {
      audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      sourceNode = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.85;
      sourceNode.connect(analyser);
      bins = new Uint8Array(analyser.frequencyBinCount);
    } catch (_) {
      stopVoiceVisualizer();
    }
  }

  const loop = (ts) => {
    const curStage = document.getElementById('voiceBotStage');
    if (!curStage || curStage.dataset.mood !== 'recording') {
      rafId = 0;
      return;
    }

    let target = 0.12 + 0.05 * Math.sin(ts / 450);
    const wave = (phase) => 0.32 + 0.12 * Math.sin(ts / 340 + phase);
    const targets = [wave(0.0), wave(0.9), wave(1.8), wave(2.7), wave(3.6)];

    if (analyser && bins) {
      analyser.getByteFrequencyData(bins);
      let sum = 0;
      for (let i = 1; i < 16; i++) sum += bins[i] || 0;
      const avg = sum / (15 * 255);
      target = Math.min(1, Math.max(0.06, avg * 2.2));
      const idxMap = [2, 4, 6, 9, 12];
      for (let k = 0; k < 5; k++) {
        targets[k] = Math.max(targets[k], Math.min(1, (bins[idxMap[k]] || 0) / 155));
      }
    }

    smoothLevel += (target - smoothLevel) * 0.14;
    for (let k = 0; k < 5; k++) {
      smoothBars[k] += (targets[k] - smoothBars[k]) * 0.16;
    }

    applyLevelVars(curStage, {
      lvl: smoothLevel,
      b1: smoothBars[0],
      b2: smoothBars[1],
      b3: smoothBars[2],
      b4: smoothBars[3],
      b5: smoothBars[4]
    });

    rafId = requestAnimationFrame(loop);
  };

  rafId = requestAnimationFrame(loop);
}

export function stopVoiceVisualizer() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  smoothLevel = 0;
  try { sourceNode?.disconnect(); } catch (_) {}
  sourceNode = null;
  analyser = null;
  if (audioCtx) {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
  const stage = document.getElementById('voiceBotStage');
  if (stage) applyLevelVars(stage, { lvl: 0, b1: 0.4, b2: 0.55, b3: 0.7, b4: 0.55, b5: 0.4 });
}
