



export const AXES = ['arousal', 'valence', 'tension', 'space', 'groove', 'grain'];


export const ANCHORS = {
  chamber:   [0.15, 0.25, 0.30, 0.60, 0.10, 0.30],
  temple:    [0.00, 0.45, 0.15, 0.80, 0.05, 0.20],
  spiritual: [0.00, 0.45, 0.15, 0.80, 0.05, 0.20],
  emotional: [0.15, 0.30, 0.55, 0.60, 0.20, 0.35],
  astral:    [0.30, 0.90, 0.45, 0.90, 0.30, 0.50],
  kinetic:   [0.55, 0.14, 0.40, 0.35, 0.90, 0.55],
  club:      [0.80, 0.40, 0.35, 0.30, 0.70, 0.60],
  acid:      [0.85, 0.12, 0.80, 0.15, 0.50, 0.90],
  trance:    [1.00, 0.10, 0.60, 0.65, 0.30, 0.75],
};


export const SLEW = { arousal: 8, valence: 20, tension: 6, space: 10, groove: 8, grain: 6 };
export const BODY_SLEW = 0.6, BODY_REST = 0.9, BODY_MAX = 0.25;


export const MODE_LADDER = ['phrygian', 'aeolian', 'dorian', 'mixolydian', 'major', 'lydian'];
export const TONIC = 38; 

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const bump = (x, c, w) => Math.exp(-((x - c) ** 2) / (2 * w * w));
export const vec = (o) => (Array.isArray(o) ? o.slice() : AXES.map((k) => o[k] ?? 0.5));
export const named = (v) => Object.fromEntries(AXES.map((k, i) => [k, v[i]]));
export const dist = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
export function nearestAnchor(v) {
  let best = null, d = Infinity;
  for (const [k, a] of Object.entries(ANCHORS)) { const e = dist(v, a); if (e < d) { d = e; best = k; } }
  return { name: best, d };
}


export const modeIndexRaw = (valence) => Math.min(MODE_LADDER.length - 1, Math.floor(clamp01(valence) * MODE_LADDER.length));
export function modeStep(current, valence, h = 0.04) {
  const n = MODE_LADDER.length, target = modeIndexRaw(valence);
  if (target === current) return current;
  
  const lo = current / n - h, hi = (current + 1) / n + h;
  if (valence > lo && valence < hi) return current;
  return current + Math.sign(target - current);
}

export const BEAT_ON = 0.42, BEAT_OFF = 0.30;
export const beatGate = (on, density) => (on ? density > BEAT_OFF : density > BEAT_ON);


export function paramsAt(v) {
  const [ar, va, te, sp, gr, gn] = v.map(clamp01);
  const density = clamp01(0.55 * ar + 0.45 * gr); 
  return {
    bpm: 60 + 80 * ar,
    density,
    arpRate: 1 + 3 * ar,                    
    gate: 0.95 - 0.6 * ar,
    kit: { punch: ar, decay: clamp01(1 - 0.6 * ar + 0.2 * sp), grit: gn, tone: 0.3 + 0.7 * gn },
    reach: clamp01(0.6 * te + 0.4 * ar),
    chordSpeed: clamp01(0.7 * ar + 0.3 * te),
    chordSpread: gr,
    extension: te,                          
    resolve: 1 - te,
    filterQ: 0.7 + 8 * te * te,
    reverbWet: 0.08 + 0.47 * sp,
    vastMix: sp,                            
    delaySend: 0.05 + 0.3 * sp * (1 - 0.5 * ar),
    width: 0.4 + 0.6 * sp,
    preDelay: 0.003 + 0.037 * sp,
    attack: 0.02 + 1.5 * sp * (1 - ar),
    release: 0.2 + 3.5 * sp,
    swing: 0.5 + 0.17 * gr,                 
    layBack: 0.012 * gr,                    
    jitter: 0.003 * gr,
    duck: ar * gr,
    cutoff: 300 * Math.pow(8000 / 300, gn),
    oscMorph: gn,                           
    drive: 1 + 2 * gn,
    fmIndex: 0.5 + 4 * gn,
    acidRes: te * gn,
    layers: {
      drone: 1 - smooth(0.2, 0.9, ar),
      pad: 0.6 + 0.4 * (1 - ar),
      bass: smooth(0.35, 0.7, ar),
      acid: smooth(0.25, 0.6, te * gn * ar * 2.2),
      bells: smooth(0.3, 0.8, sp * va * 1.3),
      chant: (1 - ar) * (1 - gn) * bump(sp, 0.8, 0.3),
      stabs: smooth(0.3, 0.7, gr * ar * 1.4),
      lead: smooth(0.45, 0.7, sp),
    },
    modeRaw: modeIndexRaw(va),
    beatOnHint: density > BEAT_ON,
  };
}


export class SpaceState {
  constructor(start = ANCHORS.chamber) {
    this.base = vec(start); this.target = vec(start); this.body = AXES.map(() => 0); this.bodyTarget = AXES.map(() => 0);
    this.phase = AXES.map(() => 0); this.t = 0; this.drift = 0.02; this.override = null;
  }
  
  steer(to, seconds = null) {
    this.target = vec(typeof to === 'string' ? ANCHORS[to] ?? (() => { throw new Error(`unknown anchor ${to}`); })() : to);
    this.override = seconds;
  }
  setPhaseBias(b) { this.phase = vec(b).map((x) => x - 0.5); } 
  setBody(offsets) { this.bodyTarget = offsets ? vec(offsets).map((x) => Math.max(-BODY_MAX, Math.min(BODY_MAX, x - 0.5))) : AXES.map(() => 0); }
  step(dt) {
    this.t += dt;
    AXES.forEach((k, i) => {
      const tc = this.override ?? SLEW[k];
      this.base[i] += (this.target[i] - this.base[i]) * (1 - Math.exp(-dt / tc));
      const btc = this.bodyTarget[i] === 0 ? BODY_REST : BODY_SLEW;
      this.body[i] += (this.bodyTarget[i] - this.body[i]) * (1 - Math.exp(-dt / btc));
    });
    return this.value();
  }
  
  driftAt(i) { const P = [23, 31, 41, 53, 71, 97]; return this.drift * (0.6 * Math.sin(2 * Math.PI * this.t / P[i] + i) + 0.4 * Math.sin(2 * Math.PI * this.t / P[(i + 3) % 6] + 2 * i)); }
  value() { return AXES.map((_, i) => clamp01(this.base[i] + this.phase[i] + this.body[i] + this.driftAt(i))); }
}
