// Pose landmarks -> body features + movement energy. Pure, node-testable.
// Step 1: lean, sway, headTilt. Step 2 adds x (where you stand), rise (standing tall / sinking), headTurn (yaw),
// nod (pitch), shrug (shoulders up), depth (closer / further), armsUp and reach (wrists; null when out of frame),
// so the head and torso carry the core controls (mappings.js blends), with the hands as a layer on top.
// MediaPipe pose landmarks are in CAMERA coords; the player sees a mirror, so x is flipped here.
// Works with the hips out of frame (a laptop webcam usually sees head + shoulders only).
import { FEATURES, ENERGY, clamp01 } from './mappings.js';

const NOSE = 0, EAR_L = 7, EAR_R = 8, SH_L = 11, SH_R = 12, EL_L = 13, EL_R = 14, WR_L = 15, WR_R = 16, HIP_L = 23, HIP_R = 24;
// interior angle at b (degrees) of a-b-c: 180 = straight arm
const angle = (a, b, c) => { const u = [a.x - b.x, a.y - b.y], v = [c.x - b.x, c.y - b.y]; const d = Math.hypot(...u) * Math.hypot(...v); return d < 1e-9 ? 180 : deg(Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / d)))); };
const vis = (p) => (p.visibility ?? 1);
const mir = (p) => ({ x: 1 - p.x, y: p.y });
const deg = (r) => (r * 180) / Math.PI;

// screen-ordered pair (left-on-screen first) and its roll in degrees (+ = right side lower)
function roll(a, b) {
  let p = mir(a), q = mir(b);
  if (p.x > q.x) [p, q] = [q, p];
  return deg(Math.atan2(q.y - p.y, q.x - p.x));
}

export function bodyVisible(lm) {
  return !!lm && lm.length >= 17 && vis(lm[SH_L]) > 0.5 && vis(lm[SH_R]) > 0.5;
}

export class BodyTracker {
  constructor() { this.reset(); }
  reset() { this.avgX = null; this.lastT = null; this.base = null; }
  // lm: 33 pose landmarks, t: seconds. Returns features (0..1, bipolar centred at 0.5).
  update(lm, t) {
    const sL = lm[SH_L], sR = lm[SH_R];
    const shoulderRoll = roll(sL, sR);
    const cx = 1 - (sL.x + sR.x) / 2, cy = (sL.y + sR.y) / 2;
    const dt = this.lastT == null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    if (this.avgX == null) this.avgX = cx;
    else this.avgX += (cx - this.avgX) * (1 - Math.exp(-dt / FEATURES.swayAvgSeconds));
    const earsOk = vis(lm[EAR_L]) > 0.4 && vis(lm[EAR_R]) > 0.4;
    const headRoll = earsOk ? roll(lm[EAR_L], lm[EAR_R]) - shoulderRoll : 0;
    const sw = Math.max(1e-3, Math.hypot(sL.x - sR.x, sL.y - sR.y));
    // head turn + nod: the nose relative to the ear axis (or the shoulder axis if the ears are lost), in axis widths
    let [p, q] = earsOk ? [mir(lm[EAR_L]), mir(lm[EAR_R])] : [mir(sL), mir(sR)];
    if (p.x > q.x) [p, q] = [q, p];
    const span = Math.max(1e-3, Math.hypot(q.x - p.x, q.y - p.y)), ux = (q.x - p.x) / span, uy = (q.y - p.y) / span;
    const n = mir(lm[NOSE]), nx = n.x - (p.x + q.x) / 2, ny = n.y - (p.y + q.y) / 2;
    const along = (nx * ux + ny * uy) / span, perp = (-nx * uy + ny * ux) / span;
    // head height above the shoulder line, in shoulder widths: shrinks on a shrug. The ear midpoint (not the
    // nose) so a nod doesn't read as a shrug; the nose only if the ears are lost.
    const headY = earsOk ? (p.y + q.y) / 2 : n.y;
    const neck = (cy - headY) / sw;
    // rise: the whole upper body up / down in the frame, read at the HEAD (ear midpoint) so a shrug (shoulders
    // only) or a nod (nose only) doesn't read as rising
    const ry = earsOk ? headY : cy;
    // slow baselines: nod / shrug / depth are measured against the person's own resting posture
    const kB = 1 - Math.exp(-dt / FEATURES.baselineSeconds);
    // extra dimensions (generic sources; null when the joints they need are not visible):
    // hunch: the nose forward of the shoulder plane (MediaPipe z, smaller = nearer the camera) vs its baseline
    const hz = (sL.z ?? 0) / 2 + (sR.z ?? 0) / 2 - (lm[NOSE].z ?? 0);
    // twist: torso yaw from the shoulders' depth difference, in shoulder widths (signed; 0.5 = square to camera)
    const tw = ((sR.z ?? 0) - (sL.z ?? 0)) / sw;
    // crouch: the hip line dropping below its baseline, in shoulder widths (hips must be in frame)
    const hipsOk = lm.length > HIP_R && vis(lm[HIP_L]) > 0.5 && vis(lm[HIP_R]) > 0.5;
    const hy = hipsOk ? (lm[HIP_L].y + lm[HIP_R].y) / 2 : null;
    if (!this.base) this.base = { perp, neck, sw, ry, hz, hy };
    else for (const [k, v] of [['perp', perp], ['neck', neck], ['sw', sw], ['ry', ry], ['hz', hz], ['hy', hy]]) {
      if (v == null) continue;
      this.base[k] = this.base[k] == null ? v : this.base[k] + (v - this.base[k]) * kB;
    }
    // elbowBend: the mean bend of the visible arms (0 = straight, 1 = fully folded); null if no arm is visible
    const arms = [[SH_L, EL_L, WR_L], [SH_R, EL_R, WR_R]].filter((ix) => ix.every((i) => vis(lm[i]) > 0.5));
    const bend = arms.length ? arms.reduce((s, [a, b, c]) => s + (180 - angle(lm[a], lm[b], lm[c])), 0) / arms.length : null;
    const wristsOk = vis(lm[WR_L]) > 0.5 && vis(lm[WR_R]) > 0.5;
    const anyWrist = [WR_L, WR_R].filter((i) => vis(lm[i]) > 0.5);
    const up = anyWrist.length ? Math.max(...anyWrist.map((i) => (cy - lm[i].y) / sw)) : null;
    const reach = wristsOk ? Math.hypot(lm[WR_L].x - lm[WR_R].x, lm[WR_L].y - lm[WR_R].y) / sw : null;
    const norm = (v, [lo, hi]) => clamp01((v - lo) / (hi - lo));
    return {
      x: norm(cx, FEATURES.xRaw),
      rise: clamp01(0.5 + 0.5 * ((this.base.ry - ry) / FEATURES.riseRange)),
      lean: clamp01(0.5 + 0.5 * (shoulderRoll / FEATURES.leanDeg)),
      sway: clamp01(0.5 + 0.5 * ((cx - this.avgX) / FEATURES.swayRange)),
      headTilt: clamp01(0.5 + 0.5 * (headRoll / FEATURES.headTiltDeg)),
      headTurn: clamp01(0.5 + 0.5 * (along / FEATURES.turnRange)),
      nod: clamp01(0.5 + 0.5 * ((perp - this.base.perp) / FEATURES.nodRange)),
      shrug: clamp01(0.5 + 0.5 * ((this.base.neck - neck) / FEATURES.shrugRange)),
      depth: clamp01(0.5 + 0.5 * ((sw / this.base.sw - 1) / FEATURES.depthRange)),
      armsUp: up == null ? null : norm(up, FEATURES.armsUpRaw),
      reach: reach == null ? null : norm(reach, FEATURES.reachRaw),
      hunch: clamp01(0.5 + 0.5 * ((hz - this.base.hz) / FEATURES.hunchRange)),
      twist: clamp01(0.5 + 0.5 * (tw / FEATURES.twistRange)),
      elbowBend: bend == null ? null : norm(bend, FEATURES.elbowBendDeg),
      crouch: hy == null || this.base.hy == null ? null : clamp01(((hy - this.base.hy) / sw) / FEATURES.crouchRange),
      cx, cy, shoulderW: sw,
    };
  }
}

// Movement energy from point speeds, normalised by body scale; fast attack, slow release. (body.groove, the
// energy averaged over ENERGY.grooveSeconds, is integrated in app.js so it also follows injected energy.)
export class EnergyMeter {
  constructor() { this.reset(); }
  reset() { this.prev = {}; this.raw = 0; this.value = 0; this.lastT = null; }
  // channel: 'pose' | 'hands'; pts: [{x,y}] in frame units (same set each call), scale: body scale
  observe(channel, pts, scale, t) {
    const p = this.prev[channel];
    this.prev[channel] = { pts, t };
    if (!p || p.pts.length !== pts.length || t <= p.t) return;
    const dt = t - p.t;
    if (dt > 0.5) return; // a gap, not a movement
    let s = 0;
    for (let i = 0; i < pts.length; i++) s += Math.hypot(pts[i].x - p.pts[i].x, pts[i].y - p.pts[i].y);
    const speed = s / pts.length / Math.max(0.05, scale) / dt; // body-scales per second
    const w = ENERGY.weights?.[channel] ?? 1; // per-channel weight (data): hands count half, so they can't dominate
    this.raw = Math.max(this.raw * 0.5, clamp01((w * speed) / ENERGY.full)); // max-combine channels within a tick
  }
  // advance smoothing to time t; returns 0..1
  step(t) {
    const dt = this.lastT == null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const tc = this.raw > this.value ? ENERGY.attack : ENERGY.release;
    this.value += (this.raw - this.value) * (1 - Math.exp(-dt / tc));
    this.raw *= Math.exp(-dt / 0.15); // raw decays if no new observations arrive
    return this.value;
  }
}

export function posePointsForEnergy(lm) {
  return [NOSE, SH_L, SH_R, EL_L, EL_R, WR_L, WR_R].map((i) => ({ x: lm[i].x, y: lm[i].y }));
}

// A plausible 33-point upper-body pose from player-facing params (for the debug hook / tests).
// x: shoulder-centre on the mirrored screen; y: shoulder line; lean/headTilt/turn/nod/shrug bipolar 0..1
// (0.5 = neutral); width = shoulder width (depth); armsUp / reach 0..1 move the wrists (omit = hands down).
export function synthPose({ x = 0.5, y = 0.62, lean = 0.5, headTilt = 0.5, width = 0.28, turn = 0.5, nod = 0.5, shrug = 0.5, armsUp, reach, hunch = 0.5, twist = 0.5, crouch = 0 }) {
  const a = (((lean - 0.5) * 2) * FEATURES.leanDeg * Math.PI) / 180;      // shoulder roll (screen)
  const h = a + (((headTilt - 0.5) * 2) * FEATURES.headTiltDeg * Math.PI) / 180;
  const cx = 1 - x; // to camera coords
  // P takes SCREEN offsets (sx right, sy down) and returns camera-coord landmarks (x un-mirrored).
  const P = (sx, sy) => ({ x: cx - sx, y: sy, z: 0, visibility: 0.99 });
  const rot = (dx, dy, ang) => [dx * Math.cos(ang) - dy * Math.sin(ang), dx * Math.sin(ang) + dy * Math.cos(ang)];
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: y + 0.4, z: 0, visibility: 0.2 }));
  const half = width / 2;
  const [rx, ry] = rot(half, 0, a);
  const sy = y - ((shrug - 0.5) * 2) * FEATURES.shrugRange * width; // a shrug lifts the shoulder line, not the head
  // which index sits screen-left doesn't matter: roll() orders the pair by screen x
  lm[SH_R] = P(-rx, sy - ry);
  lm[SH_L] = P(rx, sy + ry);
  const headC = rot(0, -width * 0.62, a);
  const hx = headC[0], hy = y + headC[1];
  const [ex, ey] = rot(width * 0.22, 0, h);
  lm[EAR_R] = P(hx - ex, hy - ey); lm[EAR_L] = P(hx + ex, hy + ey);
  // the nose: along the ear axis = turn, across it = nod (+ a resting offset below the ear line)
  const span = 2 * Math.hypot(ex, ey), u = [Math.cos(h), Math.sin(h)], v = [-Math.sin(h), Math.cos(h)];
  const along = ((turn - 0.5) * 2) * FEATURES.turnRange * span, perp = (0.12 + ((nod - 0.5) * 2) * FEATURES.nodRange) * span;
  lm[NOSE] = P(hx + along * u[0] + perp * v[0], hy + along * u[1] + perp * v[1]);
  lm[EL_R] = P(-rx - 0.03, sy - ry + width * 0.8); lm[EL_L] = P(rx + 0.03, sy + ry + width * 0.8);
  lm[WR_R] = P(-rx + 0.02, sy - ry + width * 1.4); lm[WR_L] = P(rx - 0.02, sy + ry + width * 1.4);
  if (armsUp != null || reach != null) {
    const upW = FEATURES.armsUpRaw[0] + clamp01(armsUp ?? 0) * (FEATURES.armsUpRaw[1] - FEATURES.armsUpRaw[0]);
    const spanW = FEATURES.reachRaw[0] + clamp01(reach ?? 0) * (FEATURES.reachRaw[1] - FEATURES.reachRaw[0]);
    lm[WR_R] = P(-spanW * width / 2, sy - upW * width); lm[WR_L] = P(spanW * width / 2, sy - upW * width);
    lm[EL_R] = P(-spanW * width / 3, sy - upW * width / 2); lm[EL_L] = P(spanW * width / 3, sy - upW * width / 2);
  }
  const hipY = y + width * 1.6 + clamp01(crouch) * FEATURES.crouchRange * width;
  lm[23] = P(-half * 0.7, hipY); lm[24] = P(half * 0.7, hipY);
  // depth cues for hunch / twist (MediaPipe z: smaller = nearer the camera)
  const tz = (twist - 0.5) * 2 * FEATURES.twistRange * width / 2;
  lm[SH_R].z = tz; lm[SH_L].z = -tz;
  lm[NOSE].z = -(hunch - 0.5) * 2 * FEATURES.hunchRange;
  for (const i of [NOSE, EAR_L, EAR_R, SH_L, SH_R, EL_L, EL_R, WR_L, WR_R]) lm[i].visibility = 0.99;
  return lm;
}
