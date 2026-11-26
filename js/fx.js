// Нативний звуковий рушій (Web Audio API) + тактильний 3D-відгук карток (адаптовано з cex-copilot)

class SoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this._lastClick = 0;
  }

  setEnabled(val) {
    this.enabled = Boolean(val);
  }

  _init() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) this.ctx = new Ctx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  playClick() {
    if (!this.enabled) return;
    const nowMs = performance.now();
    if (nowMs - this._lastClick < 90) return;
    this._lastClick = nowMs;

    this._init();
    if (!this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1050, t);
      osc.frequency.exponentialRampToValueAtTime(420, t + 0.03);
      gain.gain.setValueAtTime(0.055, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.04);
    } catch (_) {}
  }

  playSuccess() {
    if (!this.enabled) return;
    this._init();
    if (!this.ctx) return;
    try {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, idx) => {
        const start = this.ctx.currentTime + idx * 0.055;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.08, start + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(start);
        osc.stop(start + 0.3);
      });
    } catch (_) {}
  }

  playAlert() {
    if (!this.enabled) return;
    this._init();
    if (!this.ctx) return;
    try {
      [340, 260].forEach((freq, idx) => {
        const start = this.ctx.currentTime + idx * 0.09;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.07, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(start);
        osc.stop(start + 0.15);
      });
    } catch (_) {}
  }

  playTimerDone() {
    if (!this.enabled) return;
    this._init();
    if (!this.ctx) return;
    try {
      [880, 1174.66, 1318.51, 1760].forEach((freq, idx) => {
        const start = this.ctx.currentTime + idx * 0.08;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.09, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.36);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(start);
        osc.stop(start + 0.38);
      });
    } catch (_) {}
  }
}

export const audioFx = new SoundEngine();

export function initTactile3D(isEnabledFn) {
  let activeCard = null;

  const resetCard = (el) => {
    if (!el) return;
    el.classList.remove('tactile-active');
    el.style.removeProperty('--tilt-rx');
    el.style.removeProperty('--tilt-ry');
  };

  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !isEnabledFn()) {
      if (activeCard) { resetCard(activeCard); activeCard = null; }
      return;
    }
    const card = e.target.closest('.task-card, .dash-card');
    if (!card || card.classList.contains('is-dragging')) {
      if (activeCard) { resetCard(activeCard); activeCard = null; }
      return;
    }
    if (activeCard && activeCard !== card) resetCard(activeCard);
    activeCard = card;

    const r = card.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    const rx = ((0.5 - y) * 6).toFixed(2);
    const ry = ((x - 0.5) * 6).toFixed(2);

    card.classList.add('tactile-active');
    card.style.setProperty('--tilt-rx', `${rx}deg`);
    card.style.setProperty('--tilt-ry', `${ry}deg`);
    card.style.setProperty('--sheen-x', `${(x * 100).toFixed(1)}%`);
    card.style.setProperty('--sheen-y', `${(y * 100).toFixed(1)}%`);
  });

  document.addEventListener('pointerleave', () => {
    if (activeCard) { resetCard(activeCard); activeCard = null; }
  });
}
