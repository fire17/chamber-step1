// Transition swells (PARITY-1031 #4, G21). When the phase changes, the room marks it with one gesture that ARRIVES
// on the new phase, instead of a silent cut-over.
//
// Design (first principles):
//  - A phase change is a change of energy. Its direction comes from the arousal each phase aims at (PHASE_AROUSAL):
//    going up (into enactment) is a LIFT, a filtered-noise riser whose band climbs and gets louder until the
//    arrival. Going down (into integration) is a SETTLE, a band that falls and fades into the reverb. Rising pitch
//    with rising level reads as approach and anticipation (looming: Neuhoff 1998); a falling, darkening band
//    reads as release.
//  - The size of the gesture follows |delta arousal|: a bigger change is longer and a little louder. It is all
//    continuous, with no per-phase special case.
//  - Arrival is quantised. When the generated beat is on, the arrival lands on a bar line (whole bars, the
//    musically quantised discrete change); otherwise on the plain seconds.
//  - Level: a gesture, not a takeover. The lift peaks about 10 dB under the pad (pad mean about -24 dBFS) and the
//    settle, which is mostly reverb, sits lower again. The level envelope is exponential (linear in dB), so the 3 s
//    short-term loudness moves smoothly (SOUND-ARCH §6).
//  - Nothing is created until the first swell, so the default pad is untouched.
export const PHASE_AROUSAL = Object.freeze({ orientation: 0.3, enactment: 0.75, integration: 0.15 });
export const PEAK_DB = -16; // dB gain after the band-pass (full-scale noise in; calibrated by render: sound/swell-render-proof.json)

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const dbToGain = (d) => Math.pow(10, d / 20);

// pure: the gesture for a phase change. from/to are phase names (or null). Returns null when there is nothing to mark.
export function swellPlan(from, to, { arousal = PHASE_AROUSAL } = {}) {
  if (!to || !from || from === to || arousal[to] == null || arousal[from] == null) return null; // the first phase is not a change
  const d = arousal[to] - arousal[from];
  const m = clamp(Math.abs(d), 0.2, 1); // even a small change gets a small gesture
  return d >= 0
    ? { dir: 'lift', seconds: 3 + 3 * m, f0: 250, f1: 2500 + 4500 * m, q: 2.5, peakDb: PEAK_DB + 6 * m, tail: 0.3, send: 0.5 }
    : { dir: 'settle', seconds: 4 + 4 * m, f0: 3500, f1: 180, q: 1.6, peakDb: PEAK_DB + 6 + 4 * m, tail: 1.5, send: 0.85 };
}

// whole bars that cover at least `seconds`, landing on a bar line after now (nextBar = the next downbeat)
export function quantiseArrival(now, seconds, { nextBar = null, barDur = null } = {}) {
  if (nextBar == null || !barDur) return now + seconds;
  let t = nextBar; while (t < now + seconds - 1e-9) t += barDur;
  return t;
}

// a deterministic noise loop (xorshift; no Math.random)
function noiseBuffer(ctx, seconds = 2, seed = 0x5a17) {
  const n = Math.round(ctx.sampleRate * seconds), b = ctx.createBuffer(1, n, ctx.sampleRate), x = b.getChannelData(0);
  let s = seed; for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; x[i] = (s >>> 0) / 2147483648 - 1; }
  return b;
}

export class Swell {
  constructor(ctx, { dry, send }) { this.ctx = ctx; this.dry = dry; this.send = send; this.noise = null; this.live = null; this.count = 0; this.last = null; }
  // play one gesture; returns { dir, start, arrival, seconds }
  play(plan, { at = null, quant = null } = {}) {
    if (!plan) return null;
    const ctx = this.ctx, now = ctx.currentTime;
    if (!this.noise) this.noise = noiseBuffer(ctx);
    if (this.live) { const g = this.live.out.gain; g.cancelScheduledValues(now); g.setTargetAtTime(0, now, 0.15); this.live.src.stop(now + 1); }
    const arrival = at ?? quantiseArrival(now, plan.seconds, quant || {}), start = now, dur = Math.max(0.5, arrival - start);
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = plan.q;
    const out = ctx.createGain(), toDry = ctx.createGain(), toSend = ctx.createGain();
    toDry.gain.value = 1 - plan.send; toSend.gain.value = plan.send;
    src.connect(band); band.connect(out); out.connect(toDry); out.connect(toSend); toDry.connect(this.dry); toSend.connect(this.send);
    const f = band.frequency, g = out.gain, peak = dbToGain(plan.peakDb), floor = peak * 1e-3; // -60 dB under the peak
    f.setValueAtTime(plan.f0, start); f.exponentialRampToValueAtTime(plan.f1, arrival);
    if (plan.dir === 'lift') { // rises all the way into the downbeat, then lets go quickly
      g.setValueAtTime(floor, start); g.exponentialRampToValueAtTime(peak, arrival); g.setTargetAtTime(0, arrival, plan.tail);
    } else { // swells in over the first third, then falls with the band into the reverb
      const top = start + dur / 3;
      g.setValueAtTime(floor, start); g.exponentialRampToValueAtTime(peak, top); g.exponentialRampToValueAtTime(peak * 0.03, arrival); g.setTargetAtTime(0, arrival, plan.tail);
    }
    src.start(start); src.stop(arrival + 8 * plan.tail);
    this.live = { src, out }; this.count++;
    return (this.last = { dir: plan.dir, start: +start.toFixed(3), arrival: +arrival.toFixed(3), seconds: +dur.toFixed(3) });
  }
}
