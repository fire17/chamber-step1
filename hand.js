// Landmarks -> features. Pure functions, no DOM (node-testable).
// MediaPipe landmarks are normalized to the CAMERA image; the player sees a mirror,
// so every x here is flipped (x = 1 - lm.x) and "left" means the player's screen-left.
import { FEATURES, clamp01 } from './mappings.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const norm = (v, [lo, hi]) => clamp01((v - lo) / (hi - lo));
// log-normalise: apparent size goes as 1 / distance, so equal hand travel toward the camera = equal steps
const normLog = (v, [lo, hi]) => clamp01(Math.log(Math.max(v, 1e-6) / lo) / Math.log(hi / lo));

export function featuresFromLandmarks(lm) {
  const wrist = lm[0], mid = lm[9];
  const palm = Math.max(1e-4, dist(wrist, mid));
  const tips = [8, 12, 16, 20];
  const reach = tips.reduce((s, i) => s + dist(lm[i], wrist), 0) / tips.length / palm;
  // hand centre: average of wrist and the four MCP knuckles (stable when fingers curl)
  const ids = [0, 5, 9, 13, 17];
  const cx = ids.reduce((s, i) => s + lm[i].x, 0) / ids.length;
  const cy = ids.reduce((s, i) => s + lm[i].y, 0) / ids.length;
  // depth: how close the hand is to the camera, from its apparent palm size. ROBUST size = the larger of two
  // roughly orthogonal rigid palm spans (wrist -> middle knuckle, and index -> pinky knuckle / 0.8, the knuckle
  // line being ~0.8 palm lengths), so turning the hand edge-on or pointing it at the camera foreshortens one
  // span but not the other; curling the fingers moves neither. Absolute (no slow baseline, unlike body.depth):
  // a hand HELD close keeps its modulation instead of drifting home in FEATURES.baselineSeconds, and there is no
  // per-hand state for an A/B swap to corrupt. Stateless = steadier here.
  const palmScale = Math.max(palm, dist(lm[5], lm[17]) / 0.8);
  return {
    x: clamp01((1 - cx - 0.1) / 0.8),        // mirrored; the outer 10% each side saturates
    height: clamp01((0.92 - cy) / 0.8),      // top of frame = 1
    spread: norm(dist(lm[4], lm[8]) / palm, FEATURES.spreadRaw),
    openness: norm(reach, FEATURES.opennessRaw),
    depth: normLog(palmScale, FEATURES.handDepthRaw), // far 0 .. close to the camera 1
    cx: 1 - cx, cy,                          // raw mirrored centre, for tracking
  };
}

// Build a plausible 21-point hand (camera coords) from player-facing params — used by the
// debug hook so injected hands go through the SAME feature path as real ones.
// x, y in 0..1 of the mirrored screen (y: 0 = top), spread/openness 0..1, size = palm length.
export function synthLandmarks({ x = 0.5, y = 0.5, spread = 0.5, openness = 0.7, size = 0.12 }) {
  const camX = 1 - x; // un-mirror
  const P = (dx, dy) => ({ x: camX + dx * size, y: y + dy * size, z: 0 });
  const lm = new Array(21);
  lm[0] = P(0, 0.62);                      // wrist, below centre
  const mcps = { 5: [-0.32, -0.32], 9: [-0.02, -0.38], 13: [0.24, -0.33], 17: [0.45, -0.22] };
  // centre of [0,5,9,13,17] should land at (camX, y): offsets average ~(0.07,-0.13); good enough
  for (const [i, d] of Object.entries(mcps)) lm[i] = P(d[0], d[1]);
  const fingerLen = -0.3 + 1.9 * openness; // tip offset from MCP in palm units (<0 = curled back toward the palm)
  const chain = (base, dir, ids) => ids.forEach((id, k) => {
    const f = ((k + 1) / ids.length) * fingerLen;
    lm[id] = { x: lm[base].x + dir[0] * f * size, y: lm[base].y + dir[1] * f * size, z: 0 };
  });
  chain(5, [-0.15, -1], [6, 7, 8]);
  chain(9, [0, -1], [10, 11, 12]);
  chain(13, [0.12, -1], [14, 15, 16]);
  chain(17, [0.28, -0.95], [18, 19, 20]);
  // thumb: swings away from the index tip as spread grows
  const a = (-0.2 - 1.3 * spread) * Math.PI / 2; // angle from straight up toward -x
  const tl = 0.55 + 0.75 * spread;
  lm[1] = P(-0.25, 0.42);
  [2, 3, 4].forEach((id, k) => {
    const f = ((k + 1) / 3) * tl;
    lm[id] = { x: lm[1].x + Math.sin(a) * f * size, y: lm[1].y - Math.cos(a) * f * size * 0.4, z: 0 };
  });
  // pinch: pull thumb tip onto index tip as spread -> 0
  const s = spread;
  lm[4] = { x: lm[8].x * (1 - s) + lm[4].x * s, y: lm[8].y * (1 - s) + lm[4].y * s, z: 0 };
  return lm;
}

// Keep hand A as A across frames: with two hands, A is the one nearest A's last centre.
export function assignHands(featList, lastA) {
  if (featList.length === 0) return { A: null, B: null };
  if (featList.length === 1) return { A: featList[0], B: null };
  const [p, q] = featList;
  if (!lastA) return p.cx <= q.cx ? { A: p, B: q } : { A: q, B: p }; // left hand = A at first sight
  const dp = Math.hypot(p.cx - lastA.cx, p.cy - lastA.cy);
  const dq = Math.hypot(q.cx - lastA.cx, q.cy - lastA.cy);
  return dp <= dq ? { A: p, B: q } : { A: q, B: p };
}

// Light EMA on features so zone edges don't chatter on landmark noise (glide does the rest).
export function smoothFeatures(prev, next, k = 0.5) {
  if (!prev) return { ...next };
  const out = { ...next };
  for (const key of ['x', 'height', 'spread', 'openness', 'depth', 'cx', 'cy']) out[key] = prev[key] + (next[key] - prev[key]) * k;
  return out;
}
