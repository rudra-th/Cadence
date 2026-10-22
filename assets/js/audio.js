/**
 * Cadence — sound engine
 *
 * Every cue is synthesised with the Web Audio API, so the app ships with zero
 * audio assets and keeps working fully offline. Six themes change the timbre
 * (not the notes) so the character of the app is consistent.
 */

const NOTES = {
  start:   [659.25, 880.00],
  pause:   [880.00, 659.25],
  reset:   [329.63],
  complete:[523.25, 659.25, 783.99, 1046.50],
  tick:    [1600],
  click:   [2200],
};

const TIMING = {
  start:   { gap: 0.10, dur: 0.26, peak: 0.32 },
  pause:   { gap: 0.10, dur: 0.26, peak: 0.26 },
  reset:   { gap: 0.00, dur: 0.20, peak: 0.22 },
  complete:{ gap: 0.13, dur: 1.30, peak: 0.40 },
  tick:    { gap: 0.00, dur: 0.045, peak: 0.16 },
  click:   { gap: 0.00, dur: 0.028, peak: 0.12 },
};

export const SOUND_THEMES = [
  { id: 'digital',  label: 'Digital' },
  { id: 'bell',     label: 'Bell' },
  { id: 'chime',    label: 'Chime' },
  { id: 'minimal',  label: 'Minimal' },
  { id: 'marimba',  label: 'Marimba' },
  { id: 'pad',      label: 'Soft Pad' },
];

export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.reverb = null;
    this.reverbSend = null;
    this.volume = 0.6;
    this.theme = 'bell';
    this.enabled = true;
    this._unlocked = false;
  }

  /* ── lifecycle ─────────────────────────────────────────── */

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC({ latencyHint: 'interactive' }); }
      catch { return null; }

      this.master = this.ctx.createGain();
      this.master.gain.value = this._gain();
      this.master.connect(this.ctx.destination);

      // Small algorithmic reverb (generated impulse response)
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = this._impulse(1.7, 2.8);
      this.reverbGain = this.ctx.createGain();
      this.reverbGain.gain.value = 0.5;
      this.reverb.connect(this.reverbGain).connect(this.master);

      this.reverbSend = this.ctx.createGain();
      this.reverbSend.gain.value = 1;
      this.reverbSend.connect(this.reverb);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  unlock() {
    if (this._unlocked) return;
    this._unlocked = true;
    this.ensure();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  _gain() {
    return Math.pow(Math.max(0, Math.min(1, this.volume)), 1.7);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master && this.ctx) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(this._gain(), now, 0.02);
    }
  }

  setTheme(t) { this.theme = t; }
  setEnabled(on) { this.enabled = on; }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /* ── playback ──────────────────────────────────────────── */

  play(name) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;

    const freqs = NOTES[name];
    const cfg = TIMING[name];
    if (!freqs || !cfg) return;

    const t0 = ctx.currentTime + 0.02;
    const useReverb = this.theme === 'chime' || this.theme === 'bell' || this.theme === 'pad';

    freqs.forEach((f, i) => {
      const when = t0 + i * cfg.gap;
      const peak = cfg.peak * (i === 0 ? 1 : 0.78);
      this._voice(ctx, f, when, cfg.dur, peak, useReverb);
    });
  }

  _voice(ctx, freq, when, dur, peak, useReverb) {
    const theme = this.theme;

    const env = ctx.createGain();
    env.connect(this.master);
    if (useReverb && this.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = theme === 'pad' ? 0.5 : 0.28;
      env.connect(send).connect(this.reverbSend);
    }

    const stop = when + dur + 0.12;

    const adsr = (attack, hold, release) => {
      env.gain.setValueAtTime(0.0001, when);
      env.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
      env.gain.setValueAtTime(Math.max(peak, 0.0002), when + attack + hold);
      env.gain.exponentialRampToValueAtTime(0.0001, when + attack + hold + release);
    };

    switch (theme) {
      case 'digital': {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, when);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.985, when + dur);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(4600, when);
        lp.frequency.exponentialRampToValueAtTime(1200, when + dur);
        lp.Q.value = 4;
        osc.connect(lp).connect(env);
        adsr(0.003, dur * 0.12, dur * 0.85);
        osc.start(when); osc.stop(stop);
        break;
      }

      case 'bell': {
        const car = ctx.createOscillator();
        car.type = 'sine';
        car.frequency.value = freq;
        const mod = ctx.createOscillator();
        mod.type = 'sine';
        mod.frequency.value = freq * 3.18;
        const modGain = ctx.createGain();
        modGain.gain.setValueAtTime(freq * 4.6, when);
        modGain.gain.exponentialRampToValueAtTime(freq * 0.05, when + dur * 0.55);
        mod.connect(modGain).connect(car.frequency);
        car.connect(env);
        adsr(0.004, 0.02, dur);
        car.start(when); car.stop(stop);
        mod.start(when); mod.stop(stop);
        break;
      }

      case 'chime': {
        const a = ctx.createOscillator();
        a.type = 'triangle'; a.frequency.value = freq;
        const b = ctx.createOscillator();
        b.type = 'sine'; b.frequency.value = freq * 2; b.detune.value = 4;
        const bg = ctx.createGain(); bg.gain.value = 0.22;
        a.connect(env); b.connect(bg).connect(env);
        adsr(0.012, dur * 0.15, dur * 0.85);
        a.start(when); a.stop(stop);
        b.start(when); b.stop(stop);
        break;
      }

      case 'minimal': {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(env);
        adsr(0.006, 0.01, dur * 0.9);
        osc.start(when); osc.stop(stop);
        break;
      }

      case 'marimba': {
        const a = ctx.createOscillator();
        a.type = 'sine'; a.frequency.value = freq;
        const b = ctx.createOscillator();
        b.type = 'sine'; b.frequency.value = freq * 4;
        const bg = ctx.createGain(); bg.gain.value = 0.22;
        a.connect(env); b.connect(bg).connect(env);
        adsr(0.002, 0.01, dur * 0.9);
        a.start(when); a.stop(stop);
        b.start(when); b.stop(stop);
        break;
      }

      case 'pad':
      default: {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq * 0.5, when);
        osc.frequency.exponentialRampToValueAtTime(freq, when + dur * 0.5);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(500, when);
        lp.frequency.exponentialRampToValueAtTime(2200, when + dur * 0.45);
        lp.frequency.exponentialRampToValueAtTime(600, when + dur);
        lp.Q.value = 2.4;
        osc.connect(lp).connect(env);
        adsr(0.07, dur * 0.2, dur * 0.7);
        osc.start(when); osc.stop(stop);
        break;
      }
    }
  }
}

export const sound = new SoundEngine();
