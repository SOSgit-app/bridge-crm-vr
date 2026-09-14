/**
 * Procedural bridge audio. No asset downloads; everything is synthesised so
 * the build stays fully offline and tiny. All cues are short and localised.
 */
class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._alarm = null;
    this.enabled = true;
  }

  _ensure() {
    if (this.ctx) return true;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  unlock() {
    if (this._ensure() && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _tone({ freq = 440, type = 'square', dur = 0.06, gain = 0.4, slide = 0, attack = 0.002 }) {
    if (!this.enabled || !this._ensure()) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  click() {
    this._tone({ freq: 1800, type: 'square', dur: 0.03, gain: 0.25 });
  }
  tick() {
    this._tone({ freq: 900, type: 'triangle', dur: 0.02, gain: 0.15 });
  }
  confirm() {
    this._tone({ freq: 660, type: 'sine', dur: 0.12, gain: 0.35 });
    setTimeout(() => this._tone({ freq: 990, type: 'sine', dur: 0.18, gain: 0.35 }), 90);
  }
  error() {
    this._tone({ freq: 220, type: 'sawtooth', dur: 0.25, gain: 0.3, slide: -80 });
  }
  engage() {
    [440, 550, 660, 880].forEach((f, i) => setTimeout(() => this._tone({ freq: f, type: 'sine', dur: 0.25, gain: 0.35 }), i * 110));
  }
  inject() {
    this._tone({ freq: 520, type: 'square', dur: 0.09, gain: 0.3 });
    setTimeout(() => this._tone({ freq: 520, type: 'square', dur: 0.09, gain: 0.3 }), 140);
  }
  impact() {
    this._tone({ freq: 90, type: 'sawtooth', dur: 0.5, gain: 0.5, slide: -60 });
  }
  launch() {
    this._tone({ freq: 160, type: 'sawtooth', dur: 0.9, gain: 0.45, slide: 600 });
  }

  alarm(on) {
    if (!this.enabled || !this._ensure()) return;
    if (on && !this._alarm) {
      const osc = this.ctx.createOscillator();
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      const g = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 480;
      lfo.frequency.value = 2.2;
      lfoGain.gain.value = 140;
      lfo.connect(lfoGain).connect(osc.frequency);
      g.gain.value = 0.12;
      osc.connect(g).connect(this.master);
      osc.start();
      lfo.start();
      this._alarm = { osc, lfo, g };
    } else if (!on && this._alarm) {
      const { osc, lfo, g } = this._alarm;
      g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.2);
      setTimeout(() => {
        osc.stop();
        lfo.stop();
      }, 250);
      this._alarm = null;
    }
  }
}

export const sfx = new Sfx();
