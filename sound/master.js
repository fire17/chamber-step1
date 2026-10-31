// Output stage + space (pure Web Audio, no assets), from first principles:
//  - HPF 25 Hz: below the lowest musical fundamental we use (D1 ~37 Hz / 2); removes DC and subsonic energy.
//  - low shelf +2 dB @ 100 Hz: small speakers and laptops roll off here (equal-loudness contours, ISO 226).
//  - mud dip -2 dB @ 250 Hz: dense pads pile up energy in the low-mids, where masking is worst.
//  - presence shelf +2 dB @ 8 kHz: restores air lost to the pad's low-pass and reverb damping.
//  - soft saturation: odd+even harmonics raise perceived loudness without peak growth.
//  - glue compressor: slow attack (30 ms) lets transients through, 2:1 is transparent bus compression.
//  - limiter and ceiling at -1 dBFS: the usual true-peak headroom for codecs and inter-sample overs (EBU R128).
export const MASTER_DEFAULT = {
  hpf: 25, lowShelf: [100, 2], mudCut: [250, -2, 0.8], air: [8000, 2], drive: 1.1, tilt: 0,
  comp: { threshold: -16, ratio: 2, attack: 0.03, release: 0.3, knee: 6 },
  ceiling: Math.pow(10, -1 / 20), gain: 0.9,
};

export function tapeCurve(drive, n = 2048, ceiling = 1) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // asymmetric soft knee: a touch of even harmonics like tape, unity peak
    const y = Math.tanh(drive * (x + 0.04 * x * x)) / Math.tanh(drive * 1.04);
    c[i] = Math.max(-ceiling, Math.min(ceiling, y * ceiling));
  }
  return c;
}

export class MasterStage {
  constructor(ctx, spec = {}) {
    const s = { ...MASTER_DEFAULT, ...spec, comp: { ...MASTER_DEFAULT.comp, ...(spec.comp || {}) } };
    this.ctx = ctx; this.spec = s;
    const bq = (type, f, g = 0, q = 0.707) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = g; b.Q.value = q; return b; };
    this.input = ctx.createGain();
    this.hp = bq('highpass', s.hpf);
    this.low = bq('lowshelf', s.lowShelf[0], s.lowShelf[1]);
    this.mud = bq('peaking', s.mudCut[0], s.mudCut[1], s.mudCut[2]);
    this.airF = bq('highshelf', s.air[0], s.air[1]);
    this.tiltF = bq('highshelf', 1200, s.tilt);         // macro: master.tilt (dark <-> bright)
    this.tape = ctx.createWaveShaper(); this.tape.curve = tapeCurve(s.drive); this.tape.oversample = '2x';
    this.comp = ctx.createDynamicsCompressor();
    for (const k of ['threshold', 'ratio', 'attack', 'release', 'knee']) this.comp[k].value = s.comp[k];
    this.limit = ctx.createDynamicsCompressor();
    this.limit.threshold.value = -3; this.limit.ratio.value = 20; this.limit.attack.value = 0.001; this.limit.release.value = 0.1; this.limit.knee.value = 0;
    this.clip = ctx.createWaveShaper(); this.clip.curve = tapeCurve(1.0, 2048, s.ceiling); // ceiling: never above -1 dBFS
    this.output = ctx.createGain(); this.output.gain.value = s.gain;
    const chain = [this.input, this.hp, this.low, this.mud, this.airF, this.tiltF, this.tape, this.comp, this.limit, this.output, this.clip];
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    this.out = this.clip;
  }
  setTilt(db, tc = 0.2) { this.tiltF.gain.setTargetAtTime(db, this.ctx.currentTime, tc); }
  connect(dest) { this.out.connect(dest); return dest; }
  disconnect() { this.out.disconnect(); }
}

// Generated impulse response from data: { sec, decay, tone (0 dark..1 bright), pre (s), width }.
// Deterministic (xorshift), stereo-decorrelated. The space axis crossfades exactly TWO fixed IRs, so the
// reverb never swaps. intimate: a small room (RT60 ~0.6 s, early energy within 5 ms, near-mono).
// vast: a large stone nave (RT60 ~5 s, ~40 ms pre-delay = the first-reflection gap of a wide space, fully
// decorrelated). Highs decay faster than lows in real rooms (air absorption), so the tail darkens.
export const SPACES = {
  intimate: { sec: 0.8, decay: 4.0, tone: 0.6, pre: 0.003, width: 0.6 },
  vast:     { sec: 5.5, decay: 2.0, tone: 0.4, pre: 0.04, width: 1 },
};
export function makeIR(ctx, spec) {
  const s = typeof spec === 'string' ? SPACES[spec] : spec;
  const rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * s.sec)), buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch); let lp = 0, seed = ch ? 0x51ed270b : 0x6c8e9cf5;
    const pre = Math.floor(rate * (s.pre + (ch ? 0.004 * s.width : 0)));
    for (let i = 0; i < len; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const n = ((seed >>> 0) / 4294967296) * 2 - 1, t = i / len;
      const k = (1 - s.tone) * 0.4 + 0.55 * t;         // the tail darkens
      lp += (n - lp) * (1 - Math.min(0.97, k));
      d[i] = i < pre ? 0 : lp * Math.pow(1 - t, s.decay);
    }
  }
  return buf;
}

// ---- PeakGuard: the limiter that is wired into the Pad (PARITY-1031 #5) ----
// Why not a DynamicsCompressor as the limiter: measured in Chrome (offline, 24 kHz), the built-in compressor adds
// automatic make-up gain (+1.71 dB at threshold -3, +3.42 dB at -6) and a fixed look-ahead delay (145 samples =
// 6 ms). Both would move the default output even when nothing is near full scale. So the guard has two parts, each
// exactly transparent below its threshold:
//  1. a RIDER: a gain that only moves when the TRUE peak (4x interpolated, so inter-sample overs count; ITU-R BS.1770
//     style) of the pre-guard signal goes over RIDE_DB. Attack is quick, then it holds and releases slowly (no
//     pumping). It runs at frame rate on an analyser tap and schedules nothing while the signal is under threshold.
//  2. a CEILING: a soft clip that is the identity up to KNEE_DB and approaches CEILING_DB smoothly above it. It
//     catches whatever is faster than a frame (a transient the rider has not reached yet).
export const RIDE_DB = -3, KNEE_DB = -3, CEILING_DB = -1;
export const RIDE_ATTACK = 0.005, RIDE_HOLD = 0.25, RIDE_RELEASE = 0.6; // seconds
const dbg = (d) => Math.pow(10, d / 20);

// identity for |x| <= knee, then knee + (c - knee) * tanh((|x| - knee) / (c - knee)): continuous slope 1 at the knee,
// asymptote c. Inputs past +-1 read the end points (WaveShaper semantics), which are still under the ceiling.
export function ceilingCurve(n = 8193, knee = dbg(KNEE_DB), c = dbg(CEILING_DB)) {
  const out = new Float32Array(n), w = c - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    out[i] = a <= knee ? x : Math.sign(x) * (knee + w * Math.tanh((a - knee) / w));
  }
  return out;
}

// 4x true-peak estimate of a block: sample peak and three interpolated phases (Hann-windowed sinc, 16 taps)
const TAPS = 8, PHASES = [0.25, 0.5, 0.75].map((f) => {
  const h = []; for (let j = -TAPS + 1; j <= TAPS; j++) { const x = j - f, s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x); h.push(s * (0.5 + 0.5 * Math.cos(Math.PI * x / TAPS))); }
  return h;
});
export function truePeak(buf) {
  let m = 0; const n = buf.length;
  for (let i = 0; i < n; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
  for (let i = TAPS - 1; i < n - TAPS; i++) for (const h of PHASES) {
    let s = 0; for (let j = 0; j < h.length; j++) s += h[j] * buf[i - TAPS + 1 + j];
    const a = Math.abs(s); if (a > m) m = a;
  }
  return m;
}

export class PeakGuard {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain(); this.input.gain.value = 1;            // the rider
    this.tap = ctx.createAnalyser(); this.tap.fftSize = 2048;           // pre-guard detector (listens only)
    this.clip = ctx.createWaveShaper(); this.clip.curve = ceilingCurve(); this.clip.oversample = 'none';
    this.input.connect(this.clip);
    this.buf = null; this.level = 1; this.lastOver = -1; this.peak = 0; this.minLevel = 1;
    this.threshold = dbg(RIDE_DB);
  }
  // the detector must see the signal BEFORE the rider: call with the node that feeds this.input
  listen(node) { node.connect(this.tap); }
  connect(dest) { this.clip.connect(dest); return dest; }
  tick(now = this.ctx.currentTime) {
    if (!this.buf) this.buf = new Float32Array(this.tap.fftSize);
    this.tap.getFloatTimeDomainData(this.buf);
    const p = (this.peak = truePeak(this.buf)), want = p > this.threshold ? this.threshold / p : 1, g = this.input.gain;
    if (want < this.level - 1e-4) { // over: duck to exactly the needed gain, fast
      this.level = want; this.lastOver = now; this.minLevel = Math.min(this.minLevel, want);
      g.cancelScheduledValues(now); g.setTargetAtTime(want, now, RIDE_ATTACK);
    } else if (want < 1) this.lastOver = Math.max(this.lastOver, now);
    else if (this.level < 1 && now - this.lastOver > RIDE_HOLD) { // under again for the hold: let go, slowly
      this.level = 1; g.cancelScheduledValues(now); g.setTargetAtTime(1, now, RIDE_RELEASE);
    }
  }
  snapshot() { return { peakDb: +(20 * Math.log10(this.peak + 1e-12)).toFixed(2), riderDb: +(20 * Math.log10(this.level)).toFixed(2), minRiderDb: +(20 * Math.log10(this.minLevel)).toFixed(2) }; }
}
