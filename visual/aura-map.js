




























import { DJ } from '../mappings.js';

export const MIN_GLIDE = 0.25;   
export const BREATH_HZ = 0.09;   
export const PULSE_HZ = 1.2;     
export const MAX_EMITTERS = 8;   
export const MAX_RIPPLES = 2;
export const RIPPLE = { life: 1.8, refractory: 1.2, peak: 0.22, reach: 0.34, minRegard: 0.35, sightAt: 0.5, sightGap: 4 };
export const REST = { x: 0.5, y: 0.52 };          
export const STILL_BELOW = DJ?.stillBelow ?? 0.12; 
export const REDUCED = { motion: 0.35, breath: 0.5, tau: 0.6 };


export const LIMITS = {
  gain: [0.12, 1], warmth: [0, 1], tau: [0.25, 1.8], zoom: [0, 0.32], swirl: [-1.2, 1.2], swirlR: [0.12, 0.6],
  driftX: [-0.05, 0.05], driftY: [-0.05, 0.05], warp: [0, 1], pulseAmp: [0, 0.06],
  ax: [0, 1], ay: [0, 1], hx: [0, 1], hy: [0, 1], haloR: [0.06, 0.45],
  wake: [0, 1], regard: [0, 1], stir: [0, 1],
};


export const OUT_GLIDE = {
  gain: [0.5, 1.0], warmth: [0.8], tau: [0.8], zoom: [0.6, 1.0], swirl: [0.9], swirlR: [0.8], driftX: [1.0], driftY: [1.0],
  warp: [0.8], pulseAmp: [0.8, 1.6], ax: [0.5], ay: [0.5], hx: [0.35], hy: [0.35], haloR: [0.8],
};
export const ANCHOR_HOME = 3.0;

export const IN_GLIDE = {
  wake: [4, 8], regard: [1.5, 2.5], stir: [0.8, 2.5],
  smile: [0.6, 1.2], jaw: [0.3, 0.7], brow: [0.6, 1.2], squint: [0.8, 1.2], lookX: [0.8], lookY: [0.8],
  energy: [0.5, 1.5], groove: [1.0, 2.0], swellN: [0.6, 1.4], cutN: [1.2], pan: [1.5], beat: [0.8, 1.6], still: [5, 1.2],
  lean: [0.8], twist: [0.8], here: [0.6, 2.0],
};

export const PALETTE = [[0.34, 0.36, 0.95], [0.86, 0.42, 0.74], [1.0, 0.64, 0.32]];


export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (fin(v) ? v : d);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;


export function glide(cur, target, dt, tau) {
  const k = 1 - Math.exp(-dt / Math.max(MIN_GLIDE, tau));
  return cur + (target - cur) * k;
}
const pick = (spec, up) => Math.max(MIN_GLIDE, (up ? spec[0] : spec[1] ?? spec[0]));



export function feedbackCoeffs(tau, dt) {
  const d = Math.exp(-Math.max(0, dt) / Math.max(MIN_GLIDE, tau));
  return { decay: d, feed: 1 - d };
}

export function palette(w) {
  const x = clamp01(w) * (PALETTE.length - 1), i = Math.min(PALETTE.length - 2, Math.floor(x)), t = x - i;
  return PALETTE[i].map((c, k) => lerp(c, PALETTE[i + 1][k], t));
}
const toWhite = (c, t) => c.map((v) => lerp(v, 1, t));



export function coverUV(cx, cy, view = {}) {
  const cw = num(view.cw, 16) || 16, ch = num(view.ch, 9) || 9, vw = num(view.vw, 640) || 640, vh = num(view.vh, 480) || 480;
  const s = Math.max(cw / vw, ch / vh), w = vw * s, h = vh * s, ox = (cw - w) / 2, oy = (ch - h) / 2;
  return [clamp01((ox + cx * w) / cw), clamp01((oy + cy * h) / ch)];
}




export function readSnapshot(state) {
  const st = state && typeof state === 'object' ? state : {};
  const sense = st.sense && typeof st.sense === 'object' ? st.sense : {};
  const inp = sense.inputs && typeof sense.inputs === 'object' ? sense.inputs : {};
  const grp = (k) => { const g = inp[k]; return g && g.present && g.f && typeof g.f === 'object' ? g.f : null; };
  const bf = grp('body'), A = grp('A'), B = grp('B'), F = grp('face');
  const T = st.targets && typeof st.targets === 'object' ? st.targets : {};
  const pose = !!(bf && inp.body.pose !== false && fin(bf.cx) && fin(bf.cy));
  return {
    here: bf ? clamp01(num(bf.here, 1)) : 0,
    energy: clamp01(num(sense.energy, 0)),
    groove: clamp01(num(sense.groove, 0)),
    body: pose ? {
      cx: clamp01(bf.cx), cy: clamp01(bf.cy), sw: clamp(num(bf.shoulderW, 0.22), 0.02, 0.9),
      lean: clamp01(num(bf.lean, 0.5)), twist: clamp01(num(bf.twist, 0.5)),
    } : null,
    hands: [A, B].filter((h) => h && fin(h.cx) && fin(h.cy))
      .map((h) => ({ cx: clamp01(h.cx), cy: clamp01(h.cy), open: clamp01(num(h.openness, 0.5)), depth: clamp01(num(h.depth, 0.3)) })),
    face: F ? {
      smile: clamp01(num(F.smile, 0)), jaw: clamp01(num(F.jawOpen, 0)), brow: clamp01(num(F.browUp, 0)),
      squint: clamp01(num(F.squint, 0)), lookX: clamp01(num(F.lookX, 0.5)), lookY: clamp01(num(F.lookY, 0.5)),
    } : null,
    swell: clamp(num(T.swell, 0.16), 0, 1.5),
    cutoff: clamp(num(T.cutoff, 650), 20, 20000),
    pan: clamp(num(T.pan, 0), -1, 1),
    beat: clamp01(num(T.beat, 0)),
    speech: clamp01(num(st.speech?.level, 0)),
  };
}




const AMORPH = [ 
  [0.071, 0.053, 0.00, 0.31, -0.22], [0.047, 0.089, 0.47, 0.12, 0.18],
  [0.061, 0.037, 0.71, 0.63, 0.05], [0.083, 0.059, 0.23, 0.88, 0.30],
];

export class AuraModel {
  constructor() { this.reset(); }
  reset() {
    this.t = 0;
    this.clk = { breath: 0, pulse: 0, amorph: 0, flow: 0 };
    this.src = { wake: 0, regard: 0, stir: 0, smile: 0, jaw: 0, brow: 0, squint: 0, lookX: 0.5, lookY: 0.5, energy: 0, groove: 0,
      swellN: 0, cutN: 0.36, pan: 0, beat: 0, still: 1, lean: 0.5, twist: 0.5, here: 0 };
    this.out = null;          
    this.sayLeft = 0;         
    this.jawPrev = null; this.jawAct = 0;
    this.ripples = []; this.lastRipple = -1e9;
    this.glint = 0; this.glintAge = null; 
    this.faceGone = 1e9;      
    this.sightArmed = true;   
    this.lastHead = null;     
    this.sw = 0.22;           
  }

  step(snap, dt, opts = {}) {
    dt = fin(dt) ? clamp(dt, 0, 0.1) : 0;
    const s = snap || readSnapshot(null);
    const view = opts.view || {};
    const reduced = !!opts.reduced, paused = !!opts.paused;
    const ev = opts.events || {};
    const motion = reduced ? REDUCED.motion : 1;
    this.t += dt;

    
    const S = this.src, g = (k, target) => { S[k] = glide(S[k], target, dt, pick(IN_GLIDE[k], target > S[k])); };
    const face = s.face;
    g('here', s.here);
    g('wake', s.here > 0 ? 1 : 0);
    g('regard', face ? 1 : 0);
    g('smile', face ? face.smile : 0); g('jaw', face ? face.jaw : 0); g('brow', face ? face.brow : 0);
    g('squint', face ? face.squint : 0); g('lookX', face ? face.lookX : 0.5); g('lookY', face ? face.lookY : 0.5);
    g('energy', paused ? 0 : s.energy); g('groove', paused ? 0 : s.groove);
    g('swellN', clamp01((s.swell - 0.16) / (0.85 - 0.16)));
    g('cutN', clamp01(Math.log(s.cutoff / 180) / Math.log(6500 / 180)));
    g('pan', s.pan); g('beat', paused ? 0 : s.beat);
    g('still', 1 - smoothstep(0.35 * STILL_BELOW, 1.35 * STILL_BELOW, paused ? 0 : s.energy));
    g('lean', s.body ? s.body.lean : 0.5); g('twist', s.body ? s.body.twist : 0.5);
    
    if (fin(ev.say) && ev.say > 0) this.sayLeft = Math.max(this.sayLeft, Math.min(8, ev.say));
    this.sayLeft = Math.max(0, this.sayLeft - dt);
    const jawNow = face ? face.jaw : 0;
    const jawRate = this.jawPrev == null || dt <= 0 ? 0 : Math.abs(jawNow - this.jawPrev) / dt;
    this.jawPrev = face ? jawNow : null;
    this.jawAct = glide(this.jawAct, clamp01(jawRate * 0.25), dt, 0.6);
    g('stir', Math.max(this.sayLeft > 0 ? 1 : 0, s.speech, this.jawAct));
    const W = S.wake, R = S.regard;

    
    const slow = paused ? 0.3 : 1;
    this.clk.breath += dt * BREATH_HZ * (reduced ? REDUCED.breath : 1);
    this.clk.pulse += dt * PULSE_HZ;
    this.clk.amorph += dt * (0.6 + 1.2 * S.stir) * motion * slow;
    this.clk.flow += dt * (0.4 + 1.2 * S.energy + 0.4 * S.stir) * motion * slow;
    const breath = Math.sin(TAU * this.clk.breath);

    
    let anchorT = null, headT = null;
    const vAsp = num(view.vw, 640) / num(view.vh, 480);
    if (s.body) {
      const b = s.body;
      this.sw = b.sw;
      anchorT = coverUV(b.cx, b.cy + 0.35 * b.sw * vAsp, view);
      headT = coverUV(b.cx, b.cy - 0.7 * b.sw * vAsp, view);
    } else if (s.hands.length) {
      const hx = s.hands.reduce((a, h) => a + h.cx, 0) / s.hands.length, hy = s.hands.reduce((a, h) => a + h.cy, 0) / s.hands.length;
      anchorT = coverUV(hx, hy, view);
    }
    const cw = num(view.cw, 16) || 16, ch = num(view.ch, 9) || 9, vw = num(view.vw, 640) || 640, vh = num(view.vh, 480) || 480;
    const scale = Math.max(cw / vw, ch / vh), minDim = Math.min(cw, ch);
    const swScreen = (this.sw * vw * scale) / minDim; 

    
    const tauBody = lerp(0.5, 1.6, S.groove) * (1 - 0.35 * S.squint * R);
    let tau = lerp(1.4, tauBody, W);
    if (reduced) tau *= REDUCED.tau;
    const leanB = (S.lean - 0.5) * 2, twistB = (S.twist - 0.5) * 2;
    const T = {
      gain: 0.3 + 0.55 * lerp(0.2, S.swellN, W) + 0.15 * S.smile * R + 0.1 * S.stir,
      warmth: 0.08 + 0.78 * S.cutN + 0.25 * S.smile * R,
      tau,
      zoom: (lerp(0.05, 0.03, W) + 0.14 * S.energy + 0.05 * S.swellN * W + 0.08 * S.jaw * R + 0.05 * S.brow * R + 0.05 * S.stir) * motion,
      swirl: (0.07 + 0.7 * leanB + 0.35 * twistB) * (0.6 + 0.8 * S.energy) * motion,
      swirlR: lerp(0.38, 0.14 + 0.55 * swScreen, W) + 0.08 * S.brow * R,
      driftX: (0.02 * S.pan + 0.035 * (S.lookX - 0.5) * 2 * R) * motion,
      driftY: (-0.03 * (S.lookY - 0.5) * 2 * R) * motion,
      warp: (0.25 + 0.35 * S.energy + 0.35 * (1 - W) + 0.3 * S.stir) * motion,
      pulseAmp: reduced ? 0 : 0.06 * S.beat,
      haloR: 0.9 * swScreen,
    };
    
    const home = W < 0.2;
    const aT = anchorT || (home ? [REST.x, REST.y] : this.out ? [this.out.ax, this.out.ay] : [REST.x, REST.y]);
    T.ax = aT[0]; T.ay = aT[1];
    if (headT) this.lastHead = headT;
    const hT = headT || this.lastHead || [aT[0], Math.max(0, aT[1] - 0.16)];
    T.hx = hT[0]; T.hy = hT[1];
    for (const k in T) T[k] = clamp(T[k], LIMITS[k][0], LIMITS[k][1]);

    
    if (!this.out) this.out = { ...T };
    const O = this.out;
    for (const k in T) {
      let tauK = pick(OUT_GLIDE[k], T[k] > O[k]);
      if ((k === 'ax' || k === 'ay') && !anchorT) tauK = ANCHOR_HOME;
      O[k] = clamp(glide(O[k], T[k], dt, tauK), LIMITS[k][0], LIMITS[k][1]);
    }

    
    
    this.faceGone = face ? 0 : this.faceGone + dt;
    if (this.faceGone >= RIPPLE.sightGap) this.sightArmed = true;
    const sight = face && this.sightArmed && R >= RIPPLE.sightAt;
    if (sight) this.sightArmed = false;
    if ((sight || (ev.blink && face && R >= RIPPLE.minRegard)) && this.t - this.lastRipple >= RIPPLE.refractory) {
      this.lastRipple = this.t;
      if (reduced) this.glintAge = 0;
      else if (this.ripples.length < MAX_RIPPLES) this.ripples.push({ x: O.hx, y: O.hy, age: 0 });
    }
    for (const r of this.ripples) r.age += dt;
    this.ripples = this.ripples.filter((r) => r.age < RIPPLE.life);
    if (this.glintAge != null) { this.glintAge += dt; if (this.glintAge >= RIPPLE.life) this.glintAge = null; }
    const env = (age) => Math.sin(Math.PI * clamp01(age / RIPPLE.life)) ** 2;
    this.glint = this.glintAge == null ? 0 : env(this.glintAge);
    const ripples = this.ripples.map((r) => ({
      x: r.x, y: r.y, radius: 0.03 + RIPPLE.reach * clamp01(r.age / RIPPLE.life) ** 0.6, i: RIPPLE.peak * R * env(r.age),
    }));

    
    const em = [];
    const base = palette(O.warmth);
    
    em.push({ x: O.ax, y: O.ay, r: O.haloR, i: 0.5 * W * S.here * (0.6 + 0.4 * S.swellN) * (1 + 0.12 * breath), col: base });
    
    em.push({ x: O.hx, y: O.hy, r: 0.05 + 0.05 * S.jaw + 0.02 * S.smile,
      i: R * (0.32 + 0.25 * S.smile + 0.15 * this.glint), col: toWhite(palette(O.warmth + 0.2), 0.35) });
    
    s.hands.slice(0, 2).forEach((h, k) => {
      const [x, y] = coverUV(h.cx, h.cy, view);
      em.push({ x, y, r: 0.035 + 0.05 * h.depth, i: 0.3 + 0.3 * h.open, col: palette(O.warmth + (k ? -0.3 : 0.15)) });
    });
    
    const cx = lerp(REST.x, O.ax, W), cy = lerp(REST.y, O.ay, W), orbit = lerp(0.2, 0.06, W) * (1 + 0.4 * S.stir);
    for (const [fx, fy, px, py, hue] of AMORPH) {
      if (em.length >= MAX_EMITTERS) break;
      const a = this.clk.amorph;
      em.push({ x: clamp01(cx + orbit * Math.sin(TAU * (fx * a + px))), y: clamp01(cy + 0.8 * orbit * Math.cos(TAU * (fy * a + py))),
        r: lerp(0.15, 0.07, W), i: (0.42 - 0.3 * W) * (1 + 0.6 * S.stir) * (1 + 0.08 * breath), col: palette(O.warmth + hue) });
    }
    for (const e of em) { e.i = clamp(e.i, 0, 1); e.r = clamp(e.r, 0.01, 0.5); }

    
    const breathDepth = (0.04 + 0.07 * S.still) * (reduced ? REDUCED.breath : 1);
    const pulse = O.pulseAmp * 0.5 * (1 - Math.cos(TAU * this.clk.pulse));
    const gainOut = clamp(O.gain * (1 + breathDepth * breath) * (1 + pulse), 0, 1.2);
    const luma = gainOut + ripples.reduce((a, r) => a + r.i * 0.5, 0);

    return {
      t: this.t,
      params: { ...O, gainOut, breath, pulse, flowT: this.clk.flow, wake: W, regard: R, stir: S.stir, still: S.still },
      emitters: em, ripples, luma,
    };
  }
}
