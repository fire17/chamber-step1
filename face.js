// Face blendshapes -> face features. Pure functions, no DOM (node-testable), in the hand.js idiom.
// Input: one FaceLandmarker result with `outputFaceBlendshapes: true` (result.faceBlendshapes[0].categories, 52
// ARKit-style scores 0..1), or that categories array, or a plain { name: score } map.
// Output (all smoothed, all clamped):
//   jawOpen, smile, squint, blink, browUp, pucker, cheekPuff   0..1   (0 = neutral face)
//   gazeX, gazeY                                               -1..1  (signed; 0 = looking at the screen)
//   lookX, lookY                                               0..1   (the same gaze as bipolar sources, 0.5 = centre,
//                                                                      so mappings.js blends can read them like body.*)
// The raw blendshape scores are compressed and person-dependent (a resting face already shows some squint and
// blink), so each feature is normalised from a raw [lo, hi] window, like FEATURES in mappings.js. [guess] values,
// to be tuned on real faces. Kept HERE (not in mappings.js) for Phase 1 only; FACE_INTEGRATION.md proposes moving
// them next to FEATURES once the other lane's mappings.js edit has landed.
export const FACE = {
  jawOpenRaw:   [0.03, 0.55],  // jawOpen: lips together .. a sung "ah"
  smileRaw:     [0.05, 0.70],  // mean(mouthSmileLeft, mouthSmileRight)
  squintRaw:    [0.15, 0.70],  // mean(eyeSquintLeft, eyeSquintRight): a resting face already reads ~0.1-0.3
  blinkRaw:     [0.20, 0.70],  // mean(eyeBlinkLeft, eyeBlinkRight): open eyes ~0.05-0.2, closed ~0.6-0.9
  browUpRaw:    [0.05, 0.60],  // mean(browInnerUp, mean(browOuterUpLeft, browOuterUpRight))
  puckerRaw:    [0.05, 0.70],  // mouthPucker
  cheekPuffRaw: [0.02, 0.50],  // cheekPuff
  gazeXRaw: 0.55,              // |eyeLook right - left| (mean of both eyes) at which gazeX saturates
  gazeYRaw: 0.45,              // |eyeLook up - down| at which gazeY saturates
  // Which way is screen-right. MediaPipe names Left/Right per its own face convention; the player sees a MIRROR.
  // +1 assumes "...Left" = the subject's left eye, so looking toward the subject's left = screen-left = gazeX < 0.
  // NOT verified on a real face: one live look-left / look-right check fixes the sign (flip to -1 if inverted).
  gazeSign: 1,
  smooth: 0.5,                 // EMA k per update, like hand.js smoothFeatures
  smoothFast: { blink: 0.85 }, // a blink lasts ~100-150 ms: smoothing it like the rest would erase it
  blinkOn: 0.6, blinkOff: 0.3, // blink onset hysteresis (on the normalised blink) for the optional soft tick
};

export const FACE_KEYS = ['jawOpen', 'smile', 'squint', 'blink', 'browUp', 'pucker', 'cheekPuff', 'gazeX', 'gazeY', 'lookX', 'lookY'];
// The neutral face (also what an absent face resolves to when a caller wants values instead of null).
export const FACE_NEUTRAL = Object.freeze({ jawOpen: 0, smile: 0, squint: 0, blink: 0, browUp: 0, pucker: 0, cheekPuff: 0, gazeX: 0, gazeY: 0, lookX: 0.5, lookY: 0.5 });

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp11 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const norm = (v, [lo, hi]) => clamp01((v - lo) / (hi - lo));
const mean = (...xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// Any accepted input -> { name: score } (missing names read 0), or null when there is no face.
export function blendshapeMap(input) {
  if (input == null) return null;
  let cats = input;
  if (!Array.isArray(input) && Array.isArray(input.faceBlendshapes)) {
    const first = input.faceBlendshapes[0];
    if (!first) return null;
    cats = first.categories ?? first;
  }
  if (Array.isArray(cats) && cats.length && Array.isArray(cats[0]?.categories)) cats = cats[0].categories; // [Classifications]
  if (Array.isArray(cats)) {
    if (!cats.length) return null;
    const m = {};
    for (const c of cats) if (c && c.categoryName) m[c.categoryName] = fin(c.score);
    return m;
  }
  if (typeof cats === 'object') return cats;
  return null;
}

// The pure feature function: one frame's blendshapes -> features, or null when there is no face.
export function faceFeatures(input, cfg = FACE) {
  const b = blendshapeMap(input);
  if (!b) return null;
  const g = (k) => clamp01(fin(b[k]));
  // gaze, per eye in the subject's frame: looking toward the subject's LEFT = left eye OUT + right eye IN.
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

// Light EMA, same idiom as hand.js smoothFeatures; blink gets a faster constant. prev null = take next as-is.
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

// Per-face state: smoothing across frames + a blink onset edge (hysteresis) for an optional soft percussive tick.
// update(result) -> { present, f, blinkOnset }. A missing face resets the smoothing (re-acquired faces don't glide
// in from stale values); the caller holds presence (FACE_HOLD_MS in the proposal), as it does for hands.
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

// Build a FaceLandmarker-shaped result from player-facing params (0..1, gazeX/Y -1..1), the inverse of
// faceFeatures through the default windows: used by tests and by a future injectFace() debug hook so injected
// faces go through the SAME feature path as real ones (as synthLandmarks / synthPose do).
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
    // gaze toward screen-right (gx > 0): the "toward right" pair carries it, the other pair rests at 0
    eyeLookInLeft: Math.max(0, gx), eyeLookOutRight: Math.max(0, gx),
    eyeLookOutLeft: Math.max(0, -gx), eyeLookInRight: Math.max(0, -gx),
    eyeLookUpLeft: Math.max(0, gy), eyeLookUpRight: Math.max(0, gy),
    eyeLookDownLeft: Math.max(0, -gy), eyeLookDownRight: Math.max(0, -gy),
  };
  const categories = [{ index: 0, score: 0, categoryName: '_neutral' }, ...Object.entries(s).map(([categoryName, score], i) => ({ index: i + 1, score, categoryName, displayName: '' }))];
  return { faceLandmarks: [[]], faceBlendshapes: [{ categories, headIndex: -1, headName: '' }] };
}
