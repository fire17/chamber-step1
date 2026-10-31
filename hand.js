


import { FEATURES, clamp01 } from './mappings.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const norm = (v, [lo, hi]) => clamp01((v - lo) / (hi - lo));

const normLog = (v, [lo, hi]) => clamp01(Math.log(Math.max(v, 1e-6) / lo) / Math.log(hi / lo));

export function featuresFromLandmarks(lm) {
  const wrist = lm[0], mid = lm[9];
  const palm = Math.max(1e-4, dist(wrist, mid));
  const tips = [8, 12, 16, 20];
  const reach = tips.reduce((s, i) => s + dist(lm[i], wrist), 0) / tips.length / palm;
  
  const ids = [0, 5, 9, 13, 17];
  const cx = ids.reduce((s, i) => s + lm[i].x, 0) / ids.length;
  const cy = ids.reduce((s, i) => s + lm[i].y, 0) / ids.length;
  
  
  
  
  
  
  const palmScale = Math.max(palm, dist(lm[5], lm[17]) / 0.8);
  return {
    x: clamp01((1 - cx - 0.1) / 0.8),        
    height: clamp01((0.92 - cy) / 0.8),      
    spread: norm(dist(lm[4], lm[8]) / palm, FEATURES.spreadRaw),
    openness: norm(reach, FEATURES.opennessRaw),
    depth: normLog(palmScale, FEATURES.handDepthRaw), 
    cx: 1 - cx, cy,                          
  };
}




export function synthLandmarks({ x = 0.5, y = 0.5, spread = 0.5, openness = 0.7, size = 0.12 }) {
  const camX = 1 - x; 
  const P = (dx, dy) => ({ x: camX + dx * size, y: y + dy * size, z: 0 });
  const lm = new Array(21);
  lm[0] = P(0, 0.62);                      
  const mcps = { 5: [-0.32, -0.32], 9: [-0.02, -0.38], 13: [0.24, -0.33], 17: [0.45, -0.22] };
  
  for (const [i, d] of Object.entries(mcps)) lm[i] = P(d[0], d[1]);
  const fingerLen = -0.3 + 1.9 * openness; 
  const chain = (base, dir, ids) => ids.forEach((id, k) => {
    const f = ((k + 1) / ids.length) * fingerLen;
    lm[id] = { x: lm[base].x + dir[0] * f * size, y: lm[base].y + dir[1] * f * size, z: 0 };
  });
  chain(5, [-0.15, -1], [6, 7, 8]);
  chain(9, [0, -1], [10, 11, 12]);
  chain(13, [0.12, -1], [14, 15, 16]);
  chain(17, [0.28, -0.95], [18, 19, 20]);
  
  const a = (-0.2 - 1.3 * spread) * Math.PI / 2; 
  const tl = 0.55 + 0.75 * spread;
  lm[1] = P(-0.25, 0.42);
  [2, 3, 4].forEach((id, k) => {
    const f = ((k + 1) / 3) * tl;
    lm[id] = { x: lm[1].x + Math.sin(a) * f * size, y: lm[1].y - Math.cos(a) * f * size * 0.4, z: 0 };
  });
  
  const s = spread;
  lm[4] = { x: lm[8].x * (1 - s) + lm[4].x * s, y: lm[8].y * (1 - s) + lm[4].y * s, z: 0 };
  return lm;
}


export function assignHands(featList, lastA) {
  if (featList.length === 0) return { A: null, B: null };
  if (featList.length === 1) return { A: featList[0], B: null };
  const [p, q] = featList;
  if (!lastA) return p.cx <= q.cx ? { A: p, B: q } : { A: q, B: p }; 
  const dp = Math.hypot(p.cx - lastA.cx, p.cy - lastA.cy);
  const dq = Math.hypot(q.cx - lastA.cx, q.cy - lastA.cy);
  return dp <= dq ? { A: p, B: q } : { A: q, B: p };
}


export function smoothFeatures(prev, next, k = 0.5) {
  if (!prev) return { ...next };
  const out = { ...next };
  for (const key of ['x', 'height', 'spread', 'openness', 'depth', 'cx', 'cy']) out[key] = prev[key] + (next[key] - prev[key]) * k;
  return out;
}
