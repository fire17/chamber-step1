











export const FACE = {
  jawOpenRaw:   [0.03, 0.55],  
  smileRaw:     [0.05, 0.70],  
  squintRaw:    [0.15, 0.70],  
  blinkRaw:     [0.20, 0.70],  
  browUpRaw:    [0.05, 0.60],  
  puckerRaw:    [0.05, 0.70],  
  cheekPuffRaw: [0.02, 0.50],  
  gazeXRaw: 0.55,              
  gazeYRaw: 0.45,              
  
  
  
  gazeSign: 1,
  smooth: 0.5,                 
  smoothFast: { blink: 0.85 }, 
  blinkOn: 0.6, blinkOff: 0.3, 
};

export const FACE_KEYS = ['jawOpen', 'smile', 'squint', 'blink', 'browUp', 'pucker', 'cheekPuff', 'gazeX', 'gazeY', 'lookX', 'lookY'];

export const FACE_NEUTRAL = Object.freeze({ jawOpen: 0, smile: 0, squint: 0, blink: 0, browUp: 0, pucker: 0, cheekPuff: 0, gazeX: 0, gazeY: 0, lookX: 0.5, lookY: 0.5 });

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp11 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const norm = (v, [lo, hi]) => clamp01((v - lo) / (hi - lo));
const mean = (...xs) => xs.reduce((s, x) => s + x, 0) / xs.length;


export function blendshapeMap(input) {
  if (input == null) return null;
  let cats = input;
  if (!Array.isArray(input) && Array.isArray(input.faceBlendshapes)) {
    const first = input.faceBlendshapes[0];
    if (!first) return null;
    cats = first.categories ?? first;
  }
  if (Array.isArray(cats) && cats.length && Array.isArray(cats[0]?.categories)) cats = cats[0].categories; 
  if (Array.isArray(cats)) {
    if (!cats.length) return null;
    const m = {};
    for (const c of cats) if (c && c.categoryName) m[c.categoryName] = fin(c.score);
    return m;
  }
  if (typeof cats === 'object') return cats;
  return null;
}


export function faceFeatures(input, cfg = FACE) {
  const b = blendshapeMap(input);
  if (!b) return null;
  const g = (k) => clamp01(fin(b[k]));
  
  const towardLeft = mean(g('eyeLookOutLeft'), g('eyeLookInRight'));
  const towardRight = mean(g('eyeLookInLeft'), g('eyeLookOutRight'));
  const up = mean(g('eyeLookUpLeft'), g('eyeLookUpRight'));
  const down = mean(g('eyeLookDownLeft'), g('eyeLookDownRight'));
  const gazeX = clamp11((cfg.gazeSign * (towardRight - towardLeft)) / cfg.gazeXRaw);
  const gazeY = clamp11((up - down) / cfg.gazeYRaw);
  return {
    jawOpen: norm(g('jawOpen'), cfg.jawOpenRaw),
    smile: norm(mean(g('mouthSmileLeft'), g('mouthSmileRight')), cfg.smileRaw),
    squint: norm(mean(g('eyeSquintLeft'), g('eyeSquintRight')), cfg.squintRaw),
    blink: norm(mean(g('eyeBlinkLeft'), g('eyeBlinkRight')), cfg.blinkRaw),
    browUp: norm(mean(g('browInnerUp'), mean(g('browOuterUpLeft'), g('browOuterUpRight'))), cfg.browUpRaw),
    pucker: norm(g('mouthPucker'), cfg.puckerRaw),
    cheekPuff: norm(g('cheekPuff'), cfg.cheekPuffRaw),
    gazeX, gazeY,
    lookX: clamp01(0.5 + 0.5 * gazeX), lookY: clamp01(0.5 + 0.5 * gazeY),
  };
}


export function smoothFace(prev, next, k = FACE.smooth, fast = FACE.smoothFast) {
  if (!next) return null;
  if (!prev) return { ...next };
  const out = { ...next };
  for (const key of FACE_KEYS) {
    if (prev[key] == null || next[key] == null) continue;
    const kk = fast?.[key] ?? k;
    out[key] = prev[key] + (next[key] - prev[key]) * kk;
  }
  return out;
}




export class FaceTracker {
  constructor(cfg = FACE) { this.cfg = cfg; this.reset(); }
  reset() { this.f = null; this.blinkHeld = false; this.blinks = 0; }
  update(result) {
    const raw = faceFeatures(result, this.cfg);
    if (!raw) { this.f = null; this.blinkHeld = false; return { present: false, f: null, blinkOnset: false }; }
    this.f = smoothFace(this.f, raw, this.cfg.smooth, this.cfg.smoothFast);
    let blinkOnset = false;
    if (!this.blinkHeld && this.f.blink >= this.cfg.blinkOn) { this.blinkHeld = true; blinkOnset = true; this.blinks++; }
    else if (this.blinkHeld && this.f.blink <= this.cfg.blinkOff) this.blinkHeld = false;
    return { present: true, f: this.f, blinkOnset };
  }
}




export function synthBlendshapes({ jawOpen = 0, smile = 0, squint = 0, blink = 0, browUp = 0, pucker = 0, cheekPuff = 0, gazeX = 0, gazeY = 0 } = {}, cfg = FACE) {
  const un = (v, [lo, hi]) => lo + clamp01(v) * (hi - lo);
  const gx = (clamp11(gazeX) * cfg.gazeXRaw) / cfg.gazeSign, gy = clamp11(gazeY) * cfg.gazeYRaw;
  const s = {
    jawOpen: un(jawOpen, cfg.jawOpenRaw),
    mouthSmileLeft: un(smile, cfg.smileRaw), mouthSmileRight: un(smile, cfg.smileRaw),
    eyeSquintLeft: un(squint, cfg.squintRaw), eyeSquintRight: un(squint, cfg.squintRaw),
    eyeBlinkLeft: un(blink, cfg.blinkRaw), eyeBlinkRight: un(blink, cfg.blinkRaw),
    browInnerUp: un(browUp, cfg.browUpRaw), browOuterUpLeft: un(browUp, cfg.browUpRaw), browOuterUpRight: un(browUp, cfg.browUpRaw),
    mouthPucker: un(pucker, cfg.puckerRaw), cheekPuff: un(cheekPuff, cfg.cheekPuffRaw),
    
    eyeLookInLeft: Math.max(0, gx), eyeLookOutRight: Math.max(0, gx),
    eyeLookOutLeft: Math.max(0, -gx), eyeLookInRight: Math.max(0, -gx),
    eyeLookUpLeft: Math.max(0, gy), eyeLookUpRight: Math.max(0, gy),
    eyeLookDownLeft: Math.max(0, -gy), eyeLookDownRight: Math.max(0, -gy),
  };
  const categories = [{ index: 0, score: 0, categoryName: '_neutral' }, ...Object.entries(s).map(([categoryName, score], i) => ({ index: i + 1, score, categoryName, displayName: '' }))];
  return { faceLandmarks: [[]], faceBlendshapes: [{ categories, headIndex: -1, headName: '' }] };
}
