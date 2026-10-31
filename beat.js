// The beat layer: synthesized drums on the audio clock at the progression's tempo (a 100 ms look-ahead
// scheduler; no samples, nothing fetched). There is NO level classifier: the beat is a binding TARGET
// (`beat`, density 0..1) like any other. The pool's groove->beat binding drives it from body.groove, so it
// arms when movement builds (the conductor's DJ arms it on the 'movement building' observation) and follows
// the groove continuously. Every voice fades in over its own density window (BEAT.voices[v] = [from, to],
// a smoothstep), so a little groove is a soft kick and a lot is a full kit. Pure math is exported for tests.
import { BEAT, PROGRESSION } from './mappings.js';

export const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// density -> per-voice gain (0..1). Pure.
export const voiceGains = (density, voices = BEAT.voices) => Object.fromEntries(Object.entries(voices).map(([k, [a, b]]) => [k, smoothstep(a, b, density)]));

// One bar of 16ths per voice: per-step velocity (0 = rest). A fixed groove; density decides how much of it sounds.
const PAT = {
  kick:  [1, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0],
  ghost: [0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.6, 0, 0, 0, 0, 0.4],  // extra soft kicks: the groove thickens
  shake: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
  hat:   [0.6, 0, 0.9, 0.4, 0.6, 0, 0.9, 0.4, 0.6, 0, 0.9, 0.4, 0.6, 0, 0.9, 0.5],
  clap:  [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
};

export class BeatSynth {
  constructor(ctx, out, send) {
    this.ctx = ctx; this.density = 0; this.step = 0; this.next = null; this.hits = 0;
    this.bus = ctx.createGain(); this.bus.gain.value = BEAT.gain;
    this.bus.connect(out);
    const s = ctx.createGain(); s.gain.value = 0.18; this.bus.connect(s); s.connect(send); // a little room on the drums
    // one second of deterministic white noise, shared by shaker / hat / clap
    const n = ctx.sampleRate, b = ctx.createBuffer(1, n, n), d = b.getChannelData(0);
    let seed = 0x1234567; for (let i = 0; i < n; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; d[i] = ((seed >>> 0) / 4294967296) * 2 - 1; }
    this.noise = b;
  }
  setDensity(d) {
    this.density = Math.max(0, Math.min(1, d || 0));
    if (this.density > 0.01 && this.next == null) { this.next = this.ctx.currentTime + 0.05; this.step = 0; }
  }
  // call every frame: schedules any steps inside the look-ahead window
  pump() {
    if (this.next == null) return;
    const ctx = this.ctx, sixteenth = 60 / PROGRESSION.bpm / 4;
    if (this.next < ctx.currentTime - 0.2) this.next = ctx.currentTime + 0.02; // resumed after a pause: re-sync
    while (this.next < ctx.currentTime + 0.1) {
      if (this.density <= 0.01) { this.next = null; return; } // no groove: stop scheduling (the grid restarts on arm)
      const i = this.step % 16, swing = i % 2 ? sixteenth * 0.12 : 0, g = voiceGains(this.density);
      for (const k of Object.keys(PAT)) { const v = PAT[k][i] * g[k]; if (v > 0.02) this[k](this.next + swing, v); }
      this.next += sixteenth; this.step++;
    }
  }
  #env(t, peak, dur, node) { const g = this.ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0008, t + dur); node.connect(g); g.connect(this.bus); return g; }
  #noise(t, dur) { const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.start(t, Math.random() * 0.5, dur + 0.05); return s; }
  kick(t, v) {
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    this.#env(t, 0.9 * v, 0.42, o); o.start(t); o.stop(t + 0.5); this.hits++;
  }
  ghost(t, v) { this.kick(t, 0.55 * v); }
  shake(t, v) { const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 5200; f.Q.value = 1.2; this.#noise(t, 0.09).connect(f); this.#env(t, 0.16 * v, 0.09, f); this.hits++; }
  hat(t, v) { const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7800; this.#noise(t, 0.05).connect(f); this.#env(t, 0.2 * v, 0.05, f); this.hits++; }
  clap(t, v) {
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 0.9;
    for (const dt of [0, 0.011, 0.023]) this.#noise(t + dt, 0.14).connect(f);
    this.#env(t, 0.32 * v, 0.18, f); this.hits++;
  }
}
