




export const SCALES = {
  major:            [0, 2, 4, 5, 7, 9, 11],
  minor:            [0, 2, 3, 5, 7, 8, 10],
  aeolian:          [0, 2, 3, 5, 7, 8, 10],
  dorian:           [0, 2, 3, 5, 7, 9, 10],
  phrygian:         [0, 1, 3, 5, 7, 8, 10],
  lydian:           [0, 2, 4, 6, 7, 9, 11],
  mixolydian:       [0, 2, 4, 5, 7, 9, 10],
  locrian:          [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor:    [0, 2, 3, 5, 7, 8, 11],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  pentatonicMinor:  [0, 3, 5, 7, 10],
  pentatonicMajor:  [0, 2, 4, 7, 9],
  blues:            [0, 3, 5, 6, 7, 10],
  wholeTone:        [0, 2, 4, 6, 8, 10],
  hirajoshi:        [0, 2, 3, 7, 8],
};


export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function weightedPick(items, weights, rng) {
  let total = 0; for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return items[0];
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) { r -= Math.max(0, weights[i]); if (r < 0) return items[i]; }
  return items[items.length - 1];
}

const mod12 = (n) => ((n % 12) + 12) % 12;
export const scaleOf = (name) => SCALES[name] ?? SCALES.minor;

export function pitchClasses(tonic, scale, extra = []) {
  const s = Array.isArray(scale) ? scale : scaleOf(scale);
  return [...new Set([...s, ...extra].map((d) => mod12(tonic + d)))].sort((a, b) => a - b);
}
export const inKey = (midi, tonic, scale, extra) => pitchClasses(tonic, scale, extra).includes(mod12(Math.round(midi)));


export function quantize(midi, tonic, scale, extra) {
  const pcs = pitchClasses(tonic, scale, extra), m = Math.round(midi);
  for (let d = 0; d <= 6; d++) {
    if (pcs.includes(mod12(m - d))) return m - d;
    if (pcs.includes(mod12(m + d))) return m + d;
  }
  return m;
}

export function degreeToMidi(tonic, scale, degree) {
  const s = Array.isArray(scale) ? scale : scaleOf(scale), n = s.length;
  const oct = Math.floor(degree / n), i = degree - oct * n;
  return tonic + 12 * oct + s[i];
}

export function midiToDegree(midi, tonic, scale) {
  const s = Array.isArray(scale) ? scale : scaleOf(scale), q = quantize(midi, tonic, s);
  const rel = q - tonic, oct = Math.floor(rel / 12), pc = rel - 12 * oct;
  return oct * s.length + Math.max(0, s.indexOf(pc));
}

export function fold(m, lo, hi) { while (m < lo) m += 12; while (m > hi) m -= 12; return m; }


export const FN = { T: 0, PD: 1, D: 2 };


export const reachCeiling = (reach) => (reach < 0.25 ? 0 : reach < 0.6 ? 1 : 2);




export class HarmonyEngine {
  constructor(stations, { tonic = 45, weights = null, seed = 7 } = {}) {
    if (!stations?.some((s) => s.fn === 0)) throw new Error('HarmonyEngine: needs at least one tonic station');
    this.stations = stations; this.tonic = tonic; this.weights = weights; this.rng = makeRng(seed);
    this.cursor = [0, 0, 0]; this.index = 0; this.changes = 0; this.cadences = 0;
  }
  get station() { return this.stations[this.index]; }
  #ofFn(fn) { return this.stations.map((s, i) => [s, i]).filter(([s]) => s.fn === fn); }
  
  next(reach = 1) {
    const ceil = reachCeiling(reach), cur = this.station;
    if (cur.fn === 0 && ceil === 0 && !this.weights) return null; 
    let idx;
    if (this.weights) {
      const row = this.weights[cur.name] ?? {};
      const cands = this.stations.map((s, i) => [s, i]).filter(([s, i]) => s.fn <= ceil && i !== this.index && (row[s.name] ?? 0) > 0);
      if (!cands.length) {
        if (cur.fn === 0) return null;
        idx = this.#ofFn(0)[0][1];
      } else idx = weightedPick(cands.map((c) => c[1]), cands.map(([s]) => row[s.name]), this.rng);
    } else {
      let fn = (cur.fn + 1) % 3;
      if (fn > ceil || !this.#ofFn(fn).length) fn = 0;
      const pool = this.#ofFn(fn);
      idx = pool[this.cursor[fn] % pool.length][1]; this.cursor[fn]++;
      if (idx === this.index && pool.length === 1 && fn === 0 && cur.fn === 0) return null;
    }
    this.index = idx; this.changes++;
    const cadence = this.station.fn === 0; if (cadence) this.cadences++;
    return { station: this.station, cadence };
  }
  
  rootMidi(st = this.station) { return this.tonic + st.deg; }
  pcs(st = this.station) { return [0, ...st.tones].map((t) => mod12(this.tonic + st.deg + t)); }
}





const MULTIPLES = [1 / 2, 1, 3 / 2, 2];
const STRAIGHT = [0, 1, 0, 0], VARIED = [0.25, 0.3, 0.2, 0.25];
export class ChangeClock {
  constructor({ slow = 16, fast = 2, hold = 0.5, seed = 11 } = {}) {
    this.slow = slow; this.fast = fast; this.hold = hold; this.rng = makeRng(seed);
    this.armed = 0; this.ratio = 1; this.fires = 0;
  }
  
  mean(speed) { const s = Math.min(1, Math.max(0, speed)); return this.slow * Math.pow(this.fast / this.slow, s); }
  
  deadline(speed, grid = 0) {
    const raw = this.armed + this.mean(speed) * this.ratio;
    return grid > 0 ? Math.ceil(raw / grid - 1e-9) * grid : raw;
  }
  
  tick(now, speed, spread = 0, grid = 0) {
    if (now < this.deadline(speed, grid)) return false;
    this.armed = now; this.fires++;
    if (this.rng() >= this.hold) {
      const sp = Math.min(1, Math.max(0, spread));
      this.ratio = weightedPick(MULTIPLES, STRAIGHT.map((t, i) => t + (VARIED[i] - t) * sp), this.rng);
    }
    return true;
  }
}


const permsCache = new Map();
function perms(n) {
  if (permsCache.has(n)) return permsCache.get(n);
  const out = [], rec = (pre, rest) => (rest.length ? rest.forEach((x, i) => rec([...pre, x], rest.filter((_, j) => j !== i))) : out.push(pre));
  rec([], [...Array(n).keys()]); permsCache.set(n, out); return out;
}

function candidates(pc, aim, lo, hi) {
  const out = [];
  for (let n = pc + 12 * Math.floor(lo / 12) - 12; n <= hi + 12; n += 12) if (n >= lo && n <= hi) out.push(n);
  if (!out.length) out.push(fold(pc, lo, hi));
  return out.sort((a, b) => Math.abs(a - aim) - Math.abs(b - aim)).slice(0, 2);
}



export function voiceLeadN(prev, pcs, { lo = 48, hi = 76, n = 4, anchor = (lo + hi) / 2 } = {}) {
  const want = [...Array(n)].map((_, i) => pcs[i % pcs.length]);
  const aim = prev && prev.length === n ? prev : [...Array(n)].map((_, i) => anchor - 7 + (14 * i) / Math.max(1, n - 1));
  let best = null, bestCost = Infinity;
  for (const p of perms(Math.min(n, 6))) {
    const cand = p.map((j, i) => candidates(mod12(want[j]), aim[i], lo, hi));
    const walk = (i, acc, cost) => {
      if (cost >= bestCost) return;
      if (i === cand.length) { const c = cost + (new Set(acc).size < acc.length ? 100 : 0); if (c < bestCost) { bestCost = c; best = acc.slice(); } return; }
      for (const m of cand[i]) { acc.push(m); walk(i + 1, acc, cost + Math.abs(m - aim[i])); acc.pop(); }
    };
    walk(0, [], 0);
  }
  return best.sort((a, b) => a - b);
}

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
