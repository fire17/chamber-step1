
















export const PHASE_AROUSAL = Object.freeze({ orientation: 0.3, enactment: 0.75, integration: 0.15 });
export const PEAK_DB = -16; 

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const dbToGain = (d) => Math.pow(10, d / 20);


export function swellPlan(from, to, { arousal = PHASE_AROUSAL } = {}) {
  if (!to || !from || from === to || arousal[to] == null || arousal[from] == null) return null; 
  const d = arousal[to] - arousal[from];
  const m = clamp(Math.abs(d), 0.2, 1); 
  return d >= 0
    ? { dir: 'lift', seconds: 3 + 3 * m, f0: 250, f1: 2500 + 4500 * m, q: 2.5, peakDb: PEAK_DB + 6 * m, tail: 0.3, send: 0.5 }
    : { dir: 'settle', seconds: 4 + 4 * m, f0: 3500, f1: 180, q: 1.6, peakDb: PEAK_DB + 6 + 4 * m, tail: 1.5, send: 0.85 };
}


export function quantiseArrival(now, seconds, { nextBar = null, barDur = null } = {}) {
  if (nextBar == null || !barDur) return now + seconds;
  let t = nextBar; while (t < now + seconds - 1e-9) t += barDur;
  return t;
}


function noiseBuffer(ctx, seconds = 2, seed = 0x5a17) {
  const n = Math.round(ctx.sampleRate * seconds), b = ctx.createBuffer(1, n, ctx.sampleRate), x = b.getChannelData(0);
  let s = seed; for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; x[i] = (s >>> 0) / 2147483648 - 1; }
  return b;
}

export class Swell {
  constructor(ctx, { dry, send }) { this.ctx = ctx; this.dry = dry; this.send = send; this.noise = null; this.live = null; this.count = 0; this.last = null; }
  
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
    const f = band.frequency, g = out.gain, peak = dbToGain(plan.peakDb), floor = peak * 1e-3; 
    f.setValueAtTime(plan.f0, start); f.exponentialRampToValueAtTime(plan.f1, arrival);
    if (plan.dir === 'lift') { 
      g.setValueAtTime(floor, start); g.exponentialRampToValueAtTime(peak, arrival); g.setTargetAtTime(0, arrival, plan.tail);
    } else { 
      const top = start + dur / 3;
      g.setValueAtTime(floor, start); g.exponentialRampToValueAtTime(peak, top); g.exponentialRampToValueAtTime(peak * 0.03, arrival); g.setTargetAtTime(0, arrival, plan.tail);
    }
    src.start(start); src.stop(arrival + 8 * plan.tail);
    this.live = { src, out }; this.count++;
    return (this.last = { dir: plan.dir, start: +start.toFixed(3), arrival: +arrival.toFixed(3), seconds: +dur.toFixed(3) });
  }
}
