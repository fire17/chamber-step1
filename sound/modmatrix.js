










import { clamp01, readSource } from '../mappings.js';
import { makeRng } from './theory.js';

export const VECTOR_AXES = ['arousal', 'valence', 'tension', 'space', 'groove', 'grain'];

export const SYNC = { '1/16': 0.25, '1/8': 0.5, '1/4': 1, '1/2': 2, '1bar': 4, '2bar': 8, '4bar': 16 };
export const LFO_SHAPES = ['sine', 'tri', 'saw', 'ramp', 'square', 'sh', 'smoothRandom'];
export const ENV_MODES = ['ad', 'adsr', 'ar'];
export const LOGIC_OPS = ['max', 'min', 'mul', 'avg', 'crossfade'];
export const PATCH_CURVES = ['lin', 'exp', 'log', 's', 'inv', 'mag'];
export const DEST_CURVES = ['lin', 'exp'];
export const FEATURE_GROUPS = ['body', 'A', 'B', 'face'];
export const MS_KEYS = ['density', 'brightness', 'commit'];
export const CLOCK_KEYS = ['beat', 'bar'];

const TAU = Math.PI * 2;
const frac = (x) => x - Math.floor(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clampTo = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

const smooth = (y, x, dt, tau) => (tau > 0 ? y + (x - y) * (1 - Math.exp(-dt / tau)) : x);
const clone = (x) => (x == null || typeof x !== 'object' ? x : JSON.parse(JSON.stringify(x)));


function mix32(x) {
  x >>>= 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export function keyHash(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export const hashUnit = (key, n) => mix32(key ^ mix32((n | 0) ^ 0x5bd1e995)) / 4294967296;



export function patchCurve(curve, v) {
  if (curve == null || curve === 'lin') return v;
  const u = clamp01(v);
  if (typeof curve === 'number') return Math.pow(u, curve);
  switch (curve) {
    case 'exp': return (Math.pow(2, 4 * u) - 1) / 15;
    case 'log': return Math.log2(1 + 15 * u) / 4;
    case 's': return u * u * (3 - 2 * u);
    case 'inv': return 1 - u;
    case 'mag': return clamp01(Math.abs(u - 0.5) * 2);
    default: return v;
  }
}

export function mapDest(d, norm) {
  const [lo, hi] = d.range ?? [0, 1];
  if (d.curve === 'exp') return lo * Math.pow(hi / lo, norm);
  return lo + (hi - lo) * norm;
}


export function lfoShape(shape, cycles, key = 0) {
  const p = frac(cycles);
  switch (shape) {
    case 'sine': return 0.5 + 0.5 * Math.sin(TAU * p);
    case 'tri': return 1 - Math.abs(2 * p - 1);
    case 'saw': return 1 - p;
    case 'ramp': return p;
    case 'square': return p < 0.5 ? 1 : 0;
    case 'sh': return hashUnit(key, Math.floor(cycles));
    case 'smoothRandom': {
      const c = Math.floor(cycles), a = hashUnit(key, c), b = hashUnit(key, c + 1), w = (1 - Math.cos(Math.PI * p)) / 2;
      return a + (b - a) * w;
    }
    default: return 0;
  }
}




export const MS_WEIGHTS = {
  density: { energy: 0.5, groove: 0.3, reach: 0.2 },
  brightness: { lift: 0.35, openness: 0.2, eyes: 0.2, smile: 0.25 },
  commit: { groove: 0.5, symmetry: 0.2, motion: 0.3 },
};
export const MS_REST = { density: 0.15, brightness: 0.4, commit: 0.2 };
function weighted(terms, weights) {
  let s = 0, w = 0;
  for (const k in weights) { const v = terms[k]; if (v != null) { s += weights[k] * v; w += weights[k]; } }
  return w > 0 ? s / w : null;
}
const meanPresent = (...xs) => { const p = xs.filter((x) => x != null); return p.length ? p.reduce((a, b) => a + b, 0) / p.length : null; };

export function musicalState(inputs, stillness = null) {
  const r = (s) => featureRead(inputs, s);
  const lean = r('body.lean'), squint = r('face.squint');
  return {
    density: weighted({ energy: r('body.energy'), groove: r('body.groove'), reach: r('body.reach') }, MS_WEIGHTS.density),
    brightness: weighted({ lift: meanPresent(r('body.armsUp'), r('A.height')), openness: r('A.openness'),
      eyes: squint == null ? null : 1 - squint, smile: r('face.smile') }, MS_WEIGHTS.brightness),
    commit: weighted({ groove: r('body.groove'), symmetry: lean == null ? null : 1 - Math.abs(lean - 0.5) * 2,
      motion: stillness == null ? null : 1 - stillness }, MS_WEIGHTS.commit),
  };
}
function featureRead(inputs, src) {
  const g = inputs?.[src.slice(0, src.indexOf('.'))];
  if (!g || !g.present || !g.f) return null;
  const v = readSource(inputs, src);
  return isNum(v) ? v : null;
}



class Module {
  static type = '';
  static schema = {};
  static required = [];
  static stateKeys = [];
  constructor(spec = {}, key = 0) {
    this.id = spec.id;
    this.key = key;
    const S = this.constructor.schema;
    for (const k in S) this[k] = spec[k] !== undefined ? clone(spec[k]) : clone(S[k][0]);
    this.init();
  }
  init() {}
  
  sources() { const S = this.constructor.schema; return Object.keys(S).filter((k) => S[k][1] === 'src' && this[k] != null).map((k) => this[k]); }
  toJSON() {
    const S = this.constructor.schema, o = { id: this.id, type: this.constructor.type };
    for (const k in S) if (JSON.stringify(this[k]) !== JSON.stringify(S[k][0])) o[k] = clone(this[k]);
    return o;
  }
  getState() { const o = {}; for (const k of this.constructor.stateKeys) o[k] = clone(this[k]); return o; }
  setState(s) { for (const k of this.constructor.stateKeys) if (s && k in s) this[k] = clone(s[k]); }
}

const beatsHz = (bpm, sync) => (bpm ?? 120) / 60 / SYNC[sync];

function gateEdge(on, v, threshold, hysteresis) {
  if (v == null) return on ? { on: false, rise: false, fall: true } : { on: false, rise: false, fall: false };
  if (!on && v >= threshold + hysteresis / 2) return { on: true, rise: true, fall: false };
  if (on && v <= threshold - hysteresis / 2) return { on: false, rise: false, fall: true };
  return { on, rise: false, fall: false };
}

export class Lfo extends Module {
  static type = 'lfo';
  static schema = { shape: ['sine', LFO_SHAPES], rate: [1, 'num'], sync: [null, [null, ...Object.keys(SYNC)]], phase: [0, 'num'],
    bipolar: [false, 'bool'], rateSrc: [null, 'src'], rateDepth: [1, 'num'] };
  static stateKeys = ['cycles'];
  init() { this.cycles = this.phase; }
  
  hz(ctx) {
    let r = this.sync ? beatsHz(ctx?.clock?.bpm, this.sync) : this.rate;
    if (this.rateSrc) { const v = ctx.read(this.rateSrc); if (v != null) r *= Math.pow(2, this.rateDepth * (clampTo(v, 0, 1) * 2 - 1)); }
    return r;
  }
  step(dt, ctx) {
    this.cycles += this.hz(ctx) * dt;
    const u = lfoShape(this.shape, this.cycles, this.key);
    return this.bipolar ? u * 2 - 1 : u;
  }
}

export class Env extends Module {
  static type = 'env';
  static schema = { mode: ['adsr', ENV_MODES], gate: [null, 'src'], threshold: [0.5, 'num'], hysteresis: [0.1, 'num'],
    attack: [0.01, 'num'], decay: [0.25, 'num'], sustain: [0.6, 'num'], release: [0.4, 'num'], retrigger: [true, 'bool'] };
  static required = ['gate'];
  static stateKeys = ['level', 'stage', 'on'];
  init() { this.level = 0; this.stage = 'idle'; this.on = false; }
  step(dt, ctx) {
    const e = gateEdge(this.on, ctx.read(this.gate), this.threshold, this.hysteresis);
    this.on = e.on;
    if (e.rise && (this.retrigger || this.stage === 'idle')) this.stage = 'attack'; 
    if (e.fall && this.mode !== 'ad' && this.stage !== 'idle') this.stage = 'release';
    const sus = this.mode === 'ar' ? 1 : clamp01(this.sustain);
    switch (this.stage) {
      case 'attack':
        this.level = this.attack > 0 ? this.level + dt / this.attack : 1;
        if (this.level >= 1) { this.level = 1; this.stage = this.mode === 'ar' ? 'sustain' : 'decay'; }
        break;
      case 'decay': {
        const floor = this.mode === 'ad' ? 0 : sus;
        this.level = this.decay > 0 ? this.level - dt / this.decay : floor;
        if (this.level <= floor) { this.level = floor; this.stage = this.mode === 'ad' ? 'idle' : 'sustain'; }
        break;
      }
      case 'sustain': this.level = sus; break;
      case 'release':
        this.level = this.release > 0 ? this.level - dt / this.release : 0;
        if (this.level <= 0) { this.level = 0; this.stage = 'idle'; }
        break;
      default: this.level = 0;
    }
    return this.level;
  }
}

export class SampleHold extends Module {
  static type = 'sh';
  static schema = { src: [null, 'src'], rate: [1, 'num'], sync: [null, [null, ...Object.keys(SYNC)]], trig: [null, 'src'],
    threshold: [0.5, 'num'], hysteresis: [0.1, 'num'], glide: [0, 'num'] };
  static required = ['src'];
  static stateKeys = ['acc', 'held', 'out', 'on', 'primed', 'ticks'];
  init() { this.acc = 0; this.held = null; this.out = null; this.on = false; this.primed = false; this.ticks = 0; }
  step(dt, ctx) {
    let tick = false;
    if (this.trig) {
      const e = gateEdge(this.on, ctx.read(this.trig), this.threshold, this.hysteresis);
      this.on = e.on; tick = e.rise;
    } else {
      this.acc += (this.sync ? beatsHz(ctx?.clock?.bpm, this.sync) : this.rate) * dt;
      if (this.acc >= 1) { this.acc -= Math.floor(this.acc); tick = true; }
    }
    if (!this.primed) { this.primed = true; tick = true; }
    if (tick) { const v = ctx.read(this.src); if (v != null) { this.held = v; this.ticks++; } }
    if (this.held == null) return null;
    this.out = this.out == null ? this.held : smooth(this.out, this.held, dt, this.glide);
    return this.out;
  }
}

export class Slew extends Module {
  static type = 'slew';
  static schema = { src: [null, 'src'], rise: [0.1, 'num'], fall: [0.5, 'num'] };
  static required = ['src'];
  static stateKeys = ['y'];
  init() { this.y = null; }
  
  step(dt, ctx) {
    const x = ctx.read(this.src);
    if (x == null) return this.y;
    this.y = this.y == null ? x : smooth(this.y, x, dt, x > this.y ? this.rise : this.fall);
    return this.y;
  }
}

export class ClockDiv extends Module {
  static type = 'clockDiv';
  static schema = { div: [1, 'num'], mult: [1, 'num'], swing: [0, 'num'], width: [0.5, 'num'] };
  static stateKeys = ['prev', 'pulses', 'trig'];
  init() { this.prev = null; this.pulses = 0; this.trig = 0; }
  
  tickAt(k) { return k + ((k & 1) ? clampTo(this.swing, 0, 0.9) * 0.5 : 0); }
  step(dt, ctx) {
    const s = (ctx?.clock?.beat ?? 0) * Math.max(1e-6, this.mult) / Math.max(1e-6, this.div);
    const prev = this.prev == null ? s - 1e-9 : this.prev;
    let n = 0;
    if (s > prev) for (let k = Math.floor(prev) - 1; k <= Math.floor(s) + 1; k++) { const t = this.tickAt(k); if (t > prev && t <= s) n++; }
    this.prev = s; this.pulses += n; this.trig = n > 0 ? 1 : 0;
    let k0 = Math.floor(s); if (this.tickAt(k0) > s) k0--;
    return s - this.tickAt(k0) < clampTo(this.width, 0, 1) ? 1 : 0;
  }
}

export class Atv extends Module {
  static type = 'atv';
  static schema = { src: [null, 'src'], scale: [1, 'num'], offset: [0, 'num'] };
  static required = ['src'];
  step(dt, ctx) { const v = ctx.read(this.src); return v == null ? null : this.offset + clampTo(this.scale, -1, 1) * v; }
}

export class Drift extends Module {
  static type = 'drift';
  static schema = { depth: [0.1, 'num'], center: [0.5, 'num'], rates: [null, 'nums'], shRate: [0.11, 'num'], bipolar: [false, 'bool'] };
  static stateKeys = ['t'];
  init() {
    this.t = 0;
    const rng = makeRng(this.key || 1);
    
    this.hz = (this.rates ?? [0.061, 0.097, 0.143]).slice(0, 3).map((r) => r * (0.9 + 0.2 * rng()));
    this.ph = this.hz.map(() => rng());
  }
  
  valueAt(t) {
    let s = 0;
    for (let i = 0; i < this.hz.length; i++) s += Math.sin(TAU * (this.hz[i] * t + this.ph[i]));
    s /= Math.max(1, this.hz.length);
    const x = t * clampTo(this.shRate, 0.05, 0.2), c = Math.floor(x), w = (1 - Math.cos(Math.PI * frac(x))) / 2;
    const a = hashUnit(this.key, c), b = hashUnit(this.key, c + 1), h = (a + (b - a) * w) * 2 - 1;
    const dev = 0.6 * s + 0.4 * h;
    return this.bipolar ? this.depth * dev : clamp01(this.center + this.depth * dev);
  }
  step(dt) { this.t += dt; return this.valueAt(this.t); }
}

export class Follow extends Module {
  static type = 'follow';
  static schema = { src: [null, 'src'], window: [5, 'num'], minSpan: [0.08, 'num'], buckets: [10, 'num'] };
  static required = ['src'];
  static stateKeys = ['ring', 'bt', 'lo', 'hi'];
  init() { this.ring = []; this.bt = 0; this.lo = 0; this.hi = 1; }
  
  
  step(dt, ctx) {
    const v = ctx.read(this.src);
    if (v == null) return null;
    const n = Math.max(2, Math.round(this.buckets));
    if (!this.ring.length) this.ring.push([v, v]);
    const cur = this.ring[this.ring.length - 1];
    cur[0] = Math.min(cur[0], v); cur[1] = Math.max(cur[1], v);
    this.bt += dt;
    if (this.bt >= this.window / n) { this.bt = 0; this.ring.push([v, v]); if (this.ring.length > n) this.ring.shift(); }
    let wlo = Infinity, whi = -Infinity;
    for (const [a, b] of this.ring) { if (a < wlo) wlo = a; if (b > whi) whi = b; }
    if (whi - wlo >= this.minSpan) {
      this.lo = wlo < this.lo ? wlo : smooth(this.lo, wlo, dt, this.window * 0.3);
      this.hi = whi > this.hi ? whi : smooth(this.hi, whi, dt, this.window * 0.3);
    } else {
      this.lo = smooth(this.lo, 0, dt, this.window);
      this.hi = smooth(this.hi, 1, dt, this.window);
    }
    this.lo = Math.min(this.lo, v); this.hi = Math.max(this.hi, v);
    return clamp01((v - this.lo) / Math.max(1e-6, this.hi - this.lo));
  }
}

export class Logic extends Module {
  static type = 'logic';
  static schema = { op: ['max', LOGIC_OPS], a: [null, 'src'], b: [null, 'src'], mix: [0.5, 'num'], mixSrc: [null, 'src'] };
  static required = ['a', 'b'];
  
  step(dt, ctx) {
    const a = ctx.read(this.a), b = ctx.read(this.b);
    if (a == null && b == null) return null;
    if (a == null) return b;
    if (b == null) return a;
    switch (this.op) {
      case 'max': return Math.max(a, b);
      case 'min': return Math.min(a, b);
      case 'mul': return a * b;
      case 'avg': return (a + b) / 2;
      case 'crossfade': { const m = clamp01((this.mixSrc ? ctx.read(this.mixSrc) : null) ?? this.mix); return a * (1 - m) + b * m; }
      default: return null;
    }
  }
}

export class Quant extends Module {
  static type = 'quant';
  static schema = { src: [null, 'src'], steps: [4, 'num'] };
  static required = ['src'];
  step(dt, ctx) {
    const v = ctx.read(this.src);
    if (v == null) return null;
    const n = Math.max(2, Math.round(this.steps));
    return Math.round(clamp01(v) * (n - 1)) / (n - 1);
  }
}

export const MODULE_TYPES = { lfo: Lfo, env: Env, sh: SampleHold, slew: Slew, clockDiv: ClockDiv, atv: Atv, drift: Drift, follow: Follow, logic: Logic, quant: Quant };


const lin = (base, lo = 0, hi = 1) => ({ base, range: [lo, hi], curve: 'lin' });
const exp = (base, lo, hi) => ({ base, range: [lo, hi], curve: 'exp' });
export const DEST_VOCAB = {
  ...Object.fromEntries(VECTOR_AXES.map((a) => ['v.' + a, lin(0.5)])),
  'lead.cutoff': exp(0.45, 90, 9000), 'lead.reso': exp(0.2, 0.7, 16), 'lead.env': lin(0.4), 'lead.gate': lin(0.5, 0.05, 1), 'lead.level': lin(0.6),
  'bass.level': lin(0.6), 'bass.cutoff': exp(0.4, 60, 3500),
  'arp.level': lin(0.4), 'arp.density': lin(0.4),
  'pad.level': lin(0.55), 'pad.cutoff': exp(0.5, 200, 8000), 'pad.width': lin(0.5),
  'drums.density': lin(0.3), 'drums.level': lin(0.6),
  'fx.space': lin(0.4), 'fx.echo': lin(0.25), 'fx.drive': lin(0.1), 'master.tilt': lin(0.5, -6, 6),
  tension: lin(0.3), 'harmony.reach': lin(0.3), 'harmony.speed': lin(0.4),
};


const ID_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
const LAYER_RE = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/;

export function isSource(src, modIds = new Set()) {
  if (typeof src !== 'string' || !src) return false;
  if (src === 'stillness') return true;
  const dot = src.indexOf('.');
  if (dot < 0) return false;
  const fam = src.slice(0, dot), key = src.slice(dot + 1);
  if (FEATURE_GROUPS.includes(fam)) return ID_RE.test(key);
  if (fam === 'ms') return MS_KEYS.includes(key);
  if (fam === 'clock') return CLOCK_KEYS.includes(key);
  if (fam === 'const') return /^-?\d+(\.\d+)?$/.test(key);
  if (fam === 'v') return VECTOR_AXES.includes(key);
  if (fam === 'mod') { const [id, sub, extra] = key.split('.'); return extra == null && modIds.has(id) && (sub == null || sub === 'trig'); }
  return false;
}

function checkDest(name, d, errors) {
  if (!d || typeof d !== 'object') { errors.push(`dest ${name}: not an object`); return; }
  if (!isNum(d.base) || d.base < 0 || d.base > 1) errors.push(`dest ${name}: base must be 0..1`);
  if (!Array.isArray(d.range) || d.range.length !== 2 || !d.range.every(isNum)) errors.push(`dest ${name}: range must be [lo, hi]`);
  if (d.curve != null && !DEST_CURVES.includes(d.curve)) errors.push(`dest ${name}: unknown curve ${d.curve}`);
  if (d.curve === 'exp' && Array.isArray(d.range) && !(d.range[0] > 0 && d.range[1] > 0)) errors.push(`dest ${name}: exp needs lo, hi > 0`);
}
function checkModule(m, modIds, errors, takenIds) {
  const where = `module ${m?.id ?? '?'}`;
  if (!m || typeof m !== 'object') { errors.push('module: not an object'); return; }
  const C = MODULE_TYPES[m.type];
  if (!C) { errors.push(`${where}: unknown type ${m.type}`); return; }
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) errors.push(`${where}: id must be camelCase letters/digits`);
  if (takenIds?.has(m.id)) errors.push(`${where}: id already exists`);
  for (const k of Object.keys(m)) {
    if (k === 'id' || k === 'type') continue;
    const s = C.schema[k];
    if (!s) { errors.push(`${where}: unknown param ${k}`); continue; }
    const v = m[k], kind = s[1];
    if (Array.isArray(kind)) { if (!kind.includes(v)) errors.push(`${where}: ${k} must be one of ${kind.filter((x) => x != null).join('|')}`); }
    else if (kind === 'num') { if (!isNum(v)) errors.push(`${where}: ${k} must be a finite number`); }
    else if (kind === 'bool') { if (typeof v !== 'boolean') errors.push(`${where}: ${k} must be boolean`); }
    else if (kind === 'nums') { if (v != null && !(Array.isArray(v) && v.length >= 1 && v.every((x) => isNum(x) && x > 0))) errors.push(`${where}: ${k} must be positive numbers`); }
    else if (kind === 'src') { if (v != null && !isSource(v, modIds)) errors.push(`${where}: unknown source ${v}`); }
  }
  for (const r of C.required) if (m[r] == null) errors.push(`${where}: ${r} is required`);
}
function checkPatch(p, modIds, dests, errors) {
  const where = `patch ${p?.id ?? `${p?.src} -> ${p?.dst}`}`;
  if (!p || typeof p !== 'object') { errors.push('patch: not an object'); return; }
  if (!isSource(p.src, modIds)) errors.push(`${where}: unknown source ${p.src}`);
  if (!(p.dst in dests)) errors.push(`${where}: unknown dest ${p.dst}`);
  if (p.id != null && (typeof p.id !== 'string' || !ID_RE.test(p.id))) errors.push(`${where}: id must be camelCase letters/digits`);
  if (p.amount != null && (!isNum(p.amount) || p.amount < -1 || p.amount > 1)) errors.push(`${where}: amount must be -1..1`);
  if (p.offset != null && !isNum(p.offset)) errors.push(`${where}: offset must be a number`);
  for (const k of ['slew', 'restGlide']) if (p[k] != null && (!isNum(p[k]) || p[k] < 0)) errors.push(`${where}: ${k} must be >= 0`);
  if (p.curve != null && !PATCH_CURVES.includes(p.curve) && !(isNum(p.curve) && p.curve > 0)) errors.push(`${where}: unknown curve ${p.curve}`);
  if (p.enabled != null && typeof p.enabled !== 'boolean') errors.push(`${where}: enabled must be boolean`);
  if (p.layer != null && (typeof p.layer !== 'string' || !LAYER_RE.test(p.layer))) errors.push(`${where}: bad layer id`);
  const known = new Set(['id', 'src', 'dst', 'amount', 'curve', 'offset', 'slew', 'restGlide', 'enabled', 'layer']);
  for (const k of Object.keys(p)) if (!known.has(k)) errors.push(`${where}: unknown field ${k}`);
}




export function validate(spec, { modIds = new Set(), dests = DEST_VOCAB, existing = null } = {}) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec: not an object'] };
  if (spec.modules || spec.patches || spec.dests) {
    const table = spec.dests ?? dests;
    if (spec.dests) for (const k in spec.dests) checkDest(k, spec.dests[k], errors);
    const mods = spec.modules ?? [];
    const ids = new Set([...modIds, ...mods.map((m) => m?.id)]);
    const seen = new Set();
    for (const m of mods) { checkModule(m, ids, errors, seen); if (m?.id) seen.add(m.id); }
    const pids = new Set();
    for (const p of spec.patches ?? []) { checkPatch(p, ids, table, errors); if (p?.id != null) { if (pids.has(p.id)) errors.push(`patch ${p.id}: duplicate id`); pids.add(p.id); } }
  } else if (spec.type != null) checkModule(spec, new Set([...modIds, spec.id]), errors, existing);
  else if (spec.src != null || spec.dst != null) checkPatch(spec, modIds, dests, errors);
  else errors.push('spec: expected {modules, patches, dests}, a module {id, type} or a patch {src, dst}');
  return { ok: errors.length === 0, errors };
}


const PATCH_DEFAULTS = { amount: 1, curve: 'lin', offset: 0, slew: 0.08, restGlide: 0.9, enabled: true, layer: 'base' };
const STILL_TAU = 1.2;   
const MS_TAU = 0.25;     
const MS_REST_TAU = 0.9; 

export class ModMatrix {
  constructor({ modules = [], patches = [], dests = DEST_VOCAB, seed = 1, layers = {}, layerGlide = 0.6, nextPatch = 1 } = {}) {
    this.seed = seed >>> 0;
    this.layerGlide = layerGlide;
    this.dests = clone(dests);
    this.mods = new Map();
    this.patches = new Map();
    this.layers = {};
    for (const [k, w] of Object.entries(layers)) this.layers[k] = { target: clamp01(w), w: clamp01(w) };
    this.nextPatch = nextPatch;
    this.resetState();
    const r = validate({ modules, patches, dests });
    if (!r.ok) throw new Error('ModMatrix: ' + r.errors.join('; '));
    for (const m of modules) this.#makeModule(m);
    for (const p of patches) this.patch(p);
  }
  resetState() {
    this.beat = 0; this.bar = 0; this.time = 0;
    this.still = 1; this.stillPresent = false;
    this.ms = { ...MS_REST };
    this.vecOut = {}; this.vecIn = null;
    this.out = {};
    this.inputs = {};
  }
  #makeModule(spec) {
    const C = MODULE_TYPES[spec.type];
    const m = new C(spec, keyHash(`${this.seed}:${spec.id}`));
    this.mods.set(spec.id, m);
    return m;
  }
  get modIds() { return new Set(this.mods.keys()); }

  
  validate(spec) {
    if (spec && (spec.modules || spec.patches || spec.dests)) return validate(spec, { modIds: this.modIds, dests: this.dests });
    return validate(spec, { modIds: this.modIds, dests: this.dests, existing: this.modIds });
  }
  addModule(spec) {
    const r = this.validate(spec);
    if (!r.ok) throw new Error('addModule: ' + r.errors.join('; '));
    this.#makeModule(spec);
    return spec.id;
  }
  
  removeModule(id) { const had = this.mods.delete(id); delete this.out[id]; delete this.out[id + '.trig']; return had; }
  patch(spec) {
    const r = validate(spec, { modIds: this.modIds, dests: this.dests });
    if (!r.ok) throw new Error('patch: ' + r.errors.join('; '));
    let id = spec.id;
    if (id == null) { do id = 'p' + this.nextPatch++; while (this.patches.has(id)); }
    else if (this.patches.has(id) && !this.patches.get(id).removing) throw new Error(`patch: id ${id} exists`);
    const p = { id, src: spec.src, dst: spec.dst };
    for (const k in PATCH_DEFAULTS) p[k] = spec[k] ?? PATCH_DEFAULTS[k];
    p.c = 0; p.removing = false;
    if (!(p.layer in this.layers)) this.layers[p.layer] = { target: 1, w: 1 };
    this.patches.set(id, p);
    return id;
  }
  
  unpatch(id, { now = false } = {}) {
    const p = this.patches.get(id);
    if (!p) return false;
    if (now) this.patches.delete(id); else p.removing = true;
    return true;
  }
  setAmount(id, a) { const p = this.patches.get(id); if (!p || !isNum(a)) return false; p.amount = clampTo(a, -1, 1); return true; }
  setEnabled(id, on) { const p = this.patches.get(id); if (!p) return false; p.enabled = !!on; return true; }
  setBase(dst, base) { if (!this.dests[dst] || !isNum(base)) return false; this.dests[dst].base = clamp01(base); return true; }
  
  setLayerWeight(layerId, w) {
    if (typeof layerId !== 'string' || !LAYER_RE.test(layerId) || !isNum(w)) return false;
    const L = this.layers[layerId] ?? (this.layers[layerId] = { target: 0, w: 0 });
    L.target = clamp01(w);
    return true;
  }
  layerWeight(layerId) { return this.layers[layerId]?.w ?? 0; }
  
  addLayer(layerId, list, w = 0) {
    const r = validate({ patches: list.map((p) => ({ ...p, layer: layerId })) }, { modIds: this.modIds, dests: this.dests });
    if (!r.ok) throw new Error('addLayer: ' + r.errors.join('; '));
    if (!(layerId in this.layers)) this.layers[layerId] = { target: clamp01(w), w: clamp01(w) };
    return list.map((p) => this.patch({ ...p, layer: layerId }));
  }
  
  setAnchorWeights(weights) { for (const [k, w] of Object.entries(weights)) this.setLayerWeight('anchor.' + k, w); }

  
  #read(src, mods) {
    if (src === 'stillness') return this.stillPresent ? this.still : null;
    const dot = src.indexOf('.'), fam = src.slice(0, dot), key = src.slice(dot + 1);
    switch (fam) {
      case 'body': case 'A': case 'B': case 'face': return featureRead(this.inputs, src);
      case 'ms': return this.ms[key] ?? null;
      case 'clock': return key === 'beat' ? frac(this.beat) : key === 'bar' ? frac(this.bar) : null;
      case 'const': return Number(key);
      case 'v': return this.vecOut[key] ?? this.vecIn?.[key] ?? null;
      case 'mod': { const v = mods[key]; return v == null ? null : v; }
      default: return null;
    }
  }
  
  read(src) { return isSource(src, this.modIds) ? this.#read(src, this.out) : null; }

  
  
  
  step(dt, inputs = {}, clock = {}, vector = null) {
    dt = isNum(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.inputs = inputs ?? {};
    this.vecIn = vector;
    const bpm = isNum(clock?.bpm) ? clock.bpm : 120;
    this.beat = isNum(clock?.beat) ? clock.beat : this.beat + dt * bpm / 60;
    this.bar = isNum(clock?.bar) ? clock.bar : this.beat / 4;
    this.time = isNum(clock?.time) ? clock.time : this.time + dt;
    const clk = { bpm, beat: this.beat, bar: this.bar, time: this.time };

    
    const energy = featureRead(this.inputs, 'body.energy');
    this.stillPresent = energy != null;
    if (energy != null) this.still = smooth(this.still, 1 - clamp01(energy), dt, STILL_TAU);
    const raw = musicalState(this.inputs, this.stillPresent ? this.still : null);
    for (const k of MS_KEYS) this.ms[k] = smooth(this.ms[k], raw[k] ?? MS_REST[k], dt, raw[k] == null ? MS_REST_TAU : MS_TAU);

    
    const prev = this.out, next = {};
    const ctx = { dt, clock: clk, read: (s) => this.#read(s, prev) };
    for (const [id, m] of this.mods) {
      const v = m.step(dt, ctx);
      next[id] = isNum(v) ? v : null;
      if (m instanceof ClockDiv) next[id + '.trig'] = m.trig;
    }
    this.out = next;

    for (const k in this.layers) { const L = this.layers[k]; L.w = smooth(L.w, L.target, dt, this.layerGlide); }

    
    const sums = {};
    for (const [id, p] of this.patches) {
      const v = this.#read(p.src, next);
      const live = v != null && p.enabled && !p.removing;
      const target = live ? (this.layers[p.layer]?.w ?? 0) * p.amount * (patchCurve(p.curve, v) + p.offset) : 0;
      p.c = smooth(p.c, target, dt, live ? p.slew : p.restGlide);
      if (p.removing && Math.abs(p.c) < 1e-5) { this.patches.delete(id); continue; }
      sums[p.dst] = (sums[p.dst] ?? 0) + p.c;
    }

    
    const res = {};
    for (const [dst, d] of Object.entries(this.dests)) {
      const axis = dst.startsWith('v.') ? dst.slice(2) : null;
      const base = axis && isNum(vector?.[axis]) ? vector[axis] : d.base;
      const norm = clamp01(base + (sums[dst] ?? 0));
      res[dst] = { norm, value: mapDest(d, norm) };
      if (axis) this.vecOut[axis] = norm;
    }
    return res;
  }

  
  toJSON({ withState = false } = {}) {
    const j = {
      version: 1, seed: this.seed, layerGlide: this.layerGlide, nextPatch: this.nextPatch,
      dests: clone(this.dests),
      modules: [...this.mods.values()].map((m) => m.toJSON()),
      patches: [...this.patches.values()].filter((p) => !p.removing).map((p) => {
        const o = { id: p.id, src: p.src, dst: p.dst };
        for (const k in PATCH_DEFAULTS) if (p[k] !== PATCH_DEFAULTS[k]) o[k] = p[k];
        return o;
      }),
      layers: Object.fromEntries(Object.entries(this.layers).map(([k, L]) => [k, L.target])),
    };
    if (withState) {
      j.state = {
        beat: this.beat, bar: this.bar, time: this.time, still: this.still, stillPresent: this.stillPresent,
        ms: { ...this.ms }, vecOut: { ...this.vecOut }, out: { ...this.out },
        modules: Object.fromEntries([...this.mods].map(([id, m]) => [id, m.getState()])),
        patches: Object.fromEntries([...this.patches].map(([id, p]) => [id, { c: p.c, removing: p.removing }])),
        layers: Object.fromEntries(Object.entries(this.layers).map(([k, L]) => [k, L.w])),
        removing: [...this.patches.values()].filter((p) => p.removing).map((p) => {
          const o = { id: p.id, src: p.src, dst: p.dst }; for (const k in PATCH_DEFAULTS) o[k] = p[k]; return o;
        }),
      };
    }
    return j;
  }
  static fromJSON(json) {
    const j = typeof json === 'string' ? JSON.parse(json) : json;
    const m = new ModMatrix(j);
    const s = j.state;
    if (s) {
      Object.assign(m, { beat: s.beat, bar: s.bar, time: s.time, still: s.still, stillPresent: s.stillPresent });
      m.ms = { ...s.ms }; m.vecOut = { ...s.vecOut }; m.out = { ...s.out };
      for (const r of s.removing ?? []) { const id = m.patch(r); m.patches.get(id).removing = true; }
      for (const [id, st] of Object.entries(s.modules ?? {})) m.mods.get(id)?.setState(st);
      for (const [id, st] of Object.entries(s.patches ?? {})) { const p = m.patches.get(id); if (p) { p.c = st.c; p.removing = st.removing; } }
      for (const [k, w] of Object.entries(s.layers ?? {})) if (m.layers[k]) m.layers[k].w = w;
    }
    return m;
  }

  
  describe() {
    const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
    const lines = [];
    for (const m of this.mods.values()) {
      const { id, type, ...rest } = m.toJSON();
      lines.push(`mod ${id} ${type} ${Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')}`.trimEnd());
    }
    for (const p of this.patches.values()) {
      const w = this.layers[p.layer]?.target ?? 0;
      const bits = [`${p.id} [${p.layer} w${w.toFixed(2)}] ${p.src} -> ${p.dst} x${f(p.amount)}`];
      if (p.offset) bits.push(`off${f(p.offset)}`);
      if (p.curve !== 'lin') bits.push(`curve=${p.curve}`);
      if (!p.enabled) bits.push('(off)');
      if (p.removing) bits.push('(fading out)');
      lines.push(bits.join(' '));
    }
    return lines.join('\n');
  }
  
  catalog() {
    return {
      moduleTypes: Object.fromEntries(Object.entries(MODULE_TYPES).map(([t, C]) => [t, Object.fromEntries(Object.entries(C.schema).map(([k, [d, kind]]) => [k, { default: d, kind }]))])),
      sources: ['body.*', 'A.*', 'B.*', 'face.*', ...MS_KEYS.map((k) => 'ms.' + k), 'stillness', ...CLOCK_KEYS.map((k) => 'clock.' + k),
        'const.<number>', ...VECTOR_AXES.map((a) => 'v.' + a), ...[...this.mods.keys()].map((id) => 'mod.' + id)],
      dests: Object.keys(this.dests),
      curves: PATCH_CURVES,
    };
  }
}


const cap = (s) => s[0].toUpperCase() + s.slice(1);
export const DEFAULT_MODULES = [
  ...VECTOR_AXES.map((a) => ({ id: 'drift' + cap(a), type: 'drift', depth: 1, bipolar: true })),
  { id: 'breath', type: 'lfo', shape: 'sine', rate: 0.07 },
  { id: 'pulse', type: 'lfo', shape: 'tri', sync: '1bar' },
  { id: 'lift', type: 'slew', src: 'body.energy', rise: 0.3, fall: 2.5 },
  { id: 'reachSpan', type: 'follow', src: 'body.reach' },
];

export const DEFAULT_PATCHES = [
  { src: 'body.energy', dst: 'v.arousal', amount: 0.35, offset: -0.3 },
  { src: 'body.groove', dst: 'v.groove', amount: 0.35, offset: -0.3 },
  { src: 'stillness', dst: 'v.space', amount: 0.3, offset: -0.5 },
  { src: 'A.openness', dst: 'v.valence', amount: 0.15, offset: -0.5 },
  { src: 'face.smile', dst: 'v.valence', amount: 0.2, offset: -0.3 },
  { src: 'A.height', dst: 'v.grain', amount: 0.2, offset: -0.5 },
  { src: 'body.armsUp', dst: 'v.grain', amount: 0.2, offset: -0.3 },
  { src: 'body.reach', dst: 'v.tension', amount: 0.2, offset: -0.4 },
  { src: 'body.headTilt', dst: 'v.tension', amount: 0.15, curve: 'mag', offset: -0.2 },
  ...VECTOR_AXES.map((a) => ({ src: 'mod.drift' + cap(a), dst: 'v.' + a, amount: 0.04 })),
];

export const ANCHOR_PATCHES = {
  acid: [
    { src: 'A.height', dst: 'lead.cutoff', amount: 0.55, curve: 's', offset: -0.35 },
    { src: 'A.spread', dst: 'lead.reso', amount: 0.35, offset: -0.3 },
    { src: 'body.energy', dst: 'drums.density', amount: 0.35, offset: -0.25 },
    { src: 'body.lean', dst: 'fx.echo', amount: 0.3, curve: 'mag', offset: -0.2 },
    { src: 'mod.pulse', dst: 'lead.env', amount: 0.15, offset: -0.5 },
  ],
  club: [
    { src: 'body.groove', dst: 'bass.level', amount: 0.3, offset: -0.3 },
    { src: 'body.groove', dst: 'drums.density', amount: 0.4, offset: -0.3 },
    { src: 'body.armsUp', dst: 'pad.level', amount: 0.35, offset: -0.2 },
    { src: 'body.nod', dst: 'fx.echo', amount: 0.2, curve: 'mag', offset: -0.2 },
    { src: 'mod.pulse', dst: 'pad.cutoff', amount: 0.12, offset: -0.5 },
  ],
  astral: [
    { src: 'stillness', dst: 'fx.space', amount: 0.4, offset: -0.3 },
    { src: 'body.energy', dst: 'arp.density', amount: 0.4, offset: -0.2 },
    { src: 'mod.breath', dst: 'pad.width', amount: 0.2, offset: -0.5 },
    { src: 'A.height', dst: 'arp.level', amount: 0.2, offset: -0.4 },
  ],
  temple: [
    { src: 'stillness', dst: 'pad.level', amount: 0.35, offset: -0.3 },
    { src: 'mod.breath', dst: 'pad.cutoff', amount: 0.15, offset: -0.5 },
    { src: 'face.jawOpen', dst: 'harmony.reach', amount: 0.2, offset: -0.2 },
    { src: 'body.energy', dst: 'fx.space', amount: -0.2, offset: -0.2 },
  ],
  kinetic: [
    { src: 'body.energy', dst: 'drums.density', amount: 0.55, offset: -0.3 },
    { src: 'mod.lift', dst: 'drums.level', amount: 0.3, offset: -0.3 },
    { src: 'body.rise', dst: 'fx.drive', amount: 0.25, offset: -0.5 },
    { src: 'mod.reachSpan', dst: 'arp.density', amount: 0.3, offset: -0.5 },
  ],
  trance: [
    { src: 'body.armsUp', dst: 'lead.cutoff', amount: 0.45, offset: -0.3 },
    { src: 'body.reach', dst: 'tension', amount: 0.35, offset: -0.3 },
    { src: 'mod.pulse', dst: 'pad.cutoff', amount: 0.2, offset: -0.5 },
    { src: 'body.groove', dst: 'arp.density', amount: 0.3, offset: -0.3 },
  ],
  emotional: [
    { src: 'face.smile', dst: 'harmony.reach', amount: 0.35, offset: -0.2 },
    { src: 'A.openness', dst: 'harmony.reach', amount: 0.25, offset: -0.4 },
    { src: 'stillness', dst: 'harmony.speed', amount: -0.25, offset: -0.3 },
    { src: 'face.browUp', dst: 'pad.level', amount: 0.15, offset: -0.2 },
  ],
  spiritual: [
    { src: 'stillness', dst: 'fx.space', amount: 0.35, offset: -0.3 },
    { src: 'mod.breath', dst: 'pad.level', amount: 0.2, offset: -0.5 },
    { src: 'face.browUp', dst: 'harmony.reach', amount: 0.2, offset: -0.2 },
    { src: 'body.energy', dst: 'harmony.speed', amount: -0.2, offset: -0.3 },
    { src: 'body.headTilt', dst: 'pad.width', amount: 0.2, curve: 'mag', offset: -0.2 },
  ],
};
export const ANCHORS = Object.keys(ANCHOR_PATCHES);


export function createMatrix({ seed = 1, anchors = {}, dests = DEST_VOCAB } = {}) {
  const m = new ModMatrix({ seed, dests, modules: DEFAULT_MODULES });
  m.addLayer('body', DEFAULT_PATCHES, 1);
  for (const name of ANCHORS) m.addLayer('anchor.' + name, ANCHOR_PATCHES[name], 0);
  for (const name of ANCHORS) if (name in anchors) { const L = m.layers['anchor.' + name]; L.target = L.w = clamp01(anchors[name]); }
  return m;
}
