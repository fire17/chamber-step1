// Duck under speech (PARITY-1031 #3). When the Director speaks, the room makes space for the voice and comes back
// when it stops. It sits after the compressor and before the master gain, so compressor make-up cannot undo it.
//
// Design (first principles):
//  - Speech intelligibility lives in roughly 1-4 kHz, where consonants and the 2nd/3rd formants are. So the duck is
//    spectral: a small broadband dip (the room stays felt) plus a deeper dip in the presence band (the voice gets
//    the band it needs). At 2 kHz: BROAD_DB + PRESENCE_DB = -10 dB; averaged over 1-4 kHz about -6 dB (a Q 0.7 band
//    is wide and gentle, so no notch is heard); below 500 Hz: -4 dB (the floor and drone stay felt).
//  - Attack is fast enough to clear the first syllable (a syllable is about 200 ms). The ~90% point is 2.3 tau, so
//    tau 40 ms is in place after about 90 ms. Release is slow, so the gaps between phrases do not pump: tau 0.35 s,
//    ~90% after about 0.8 s. A follower hold of 0.3 s bridges the pauses between words.
//  - Keys, in order of truth:
//      key(node)       a sidechain follower on the voice output itself: it hears what actually plays (preferred)
//      set(amount)     explicit level 0..1 (e.g. from a voice 'speaking' state event)
//      hold(seconds)   a timed duck (fallback from a finished-utterance event, sized by speechSeconds(text))
//    The effective amount is the max of all three.
//  - At rest it is bit-transparent: the main gain is exactly 1 and the parallel presence branch is mixed at exactly 0.
export const BROAD_DB = -4;
export const PRESENCE_DB = -6;
export const PRESENCE_HZ = 2000, PRESENCE_Q = 0.7; // about 1-4 kHz at -3 dB
export const ATTACK = 0.04, RELEASE = 0.35, HOLD = 0.3; // seconds (time constants; hold is wall time on the audio clock)
export const OPEN_DB = -42, CLOSE_DB = -50; // follower thresholds (dBFS RMS) with hysteresis; room tone sits far below
export const CHARS_PER_SECOND = 15; // conversational speech: ~165 words/min at ~5.5 characters per word

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const dbToGain = (d) => Math.pow(10, d / 20);

// a duration estimate for a finished line of speech (the fallback key only)
export function speechSeconds(text) { return clamp(String(text ?? '').length / CHARS_PER_SECOND, 0.8, 20); }

export class Duck {
  constructor(ctx) {
    this.ctx = ctx;
    // main path: one gain (exactly 1 at rest). Presence dip: a PARALLEL band-pass (0 dB peak) mixed back with gain -k,
    // so the sum is x - k*BP(x): (1-k) at the centre, untouched far from it. At rest k = 0, the parallel branch adds
    // exact zeros, and the output is bit-identical to the input.
    this.gain = ctx.createGain(); this.gain.gain.value = 1;
    this.band = ctx.createBiquadFilter(); this.band.type = 'bandpass'; this.band.frequency.value = PRESENCE_HZ; this.band.Q.value = PRESENCE_Q;
    this.cut = ctx.createGain(); this.cut.gain.value = 0;
    this.gain.connect(this.band); this.band.connect(this.cut);
    this.input = this.gain;
    this.manual = 0; this.until = 0; this.timed = 0; this.keyOpen = false; this.lastLoud = -1;
    this.analyser = null; this.buf = null; this.level = 0; this.used = false; this.keyDb = -Infinity;
  }
  connect(dest) { this.gain.connect(dest); this.cut.connect(dest); return dest; }
  // the amount this instant (0..1), from all three keys
  target(now = this.ctx.currentTime) { return Math.max(this.manual, this.keyOpen ? 1 : 0, now < this.until ? this.timed : 0); }
  #glide(now, force = false) {
    const a = this.target(now);
    if (a === this.level && !force) return;
    const tc = a >= this.level ? ATTACK : RELEASE;
    this.level = a; this.used = true;
    const g = this.gain.gain, p = this.cut.gain, k = (x) => -(1 - dbToGain(PRESENCE_DB * x)); // centre gain (1-k) = PRESENCE_DB
    g.cancelScheduledValues(now); g.setTargetAtTime(dbToGain(BROAD_DB * a), now, tc);
    p.cancelScheduledValues(now); p.setTargetAtTime(k(a), now, tc);
    // a timed hold releases itself on the audio clock, so it never sticks even if nobody calls tick()
    const after = Math.max(this.manual, this.keyOpen ? 1 : 0);
    if (now < this.until && after < a) { g.setTargetAtTime(dbToGain(BROAD_DB * after), this.until, RELEASE); p.setTargetAtTime(k(after), this.until, RELEASE); }
  }
  set(amount) { this.manual = clamp(+amount || 0, 0, 1); this.#glide(this.ctx.currentTime); }
  hold(seconds, amount = 1) {
    const now = this.ctx.currentTime;
    this.until = Math.max(this.until, now + clamp(+seconds || 0, 0, 60)); this.timed = Math.max(now < this.until ? this.timed : 0, clamp(+amount || 0, 0, 1));
    this.#glide(now, true); // re-schedule the self-release at the (possibly extended) end
  }
  // sidechain: an analyser tap on the voice output (not connected onward; it only listens). Returns a detach function.
  key(node) {
    this.unkey();
    const an = this.ctx.createAnalyser(); an.fftSize = 1024; node.connect(an);
    this.analyser = an; this.keyNode = node; this.buf = new Float32Array(an.fftSize);
    return () => this.unkey();
  }
  unkey() {
    if (this.analyser) { try { this.keyNode.disconnect(this.analyser); } catch {} }
    this.analyser = null; this.keyNode = null; this.keyOpen = false; this.#glide(this.ctx.currentTime);
  }
  // once per frame: follow the key and expire timed holds. Cheap no-op when nothing is active.
  tick(now = this.ctx.currentTime) {
    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.buf);
      let s = 0; for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
      const db = (this.keyDb = 10 * Math.log10(s / this.buf.length + 1e-24));
      if (db > (this.keyOpen ? CLOSE_DB : OPEN_DB)) { this.keyOpen = true; this.lastLoud = now; }
      else if (this.keyOpen && now - this.lastLoud > HOLD) this.keyOpen = false;
    }
    if (this.analyser || this.level !== 0 || this.until > 0) this.#glide(now);
  }
  snapshot() { return { level: this.level, keyed: !!this.analyser, keyOpen: this.keyOpen, keyDb: +this.keyDb.toFixed(1), gain: this.gain.gain.value, presenceDb: +(20 * Math.log10(1 + this.cut.gain.value)).toFixed(2) }; }
}
