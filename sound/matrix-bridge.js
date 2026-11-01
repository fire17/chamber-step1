

























import { createMatrix, ANCHORS, mapDest, VECTOR_AXES, validate as validateSpec } from './modmatrix.js';
import { AXES, vec } from './space.js';
import { PROGRESSION, MAPPINGS } from '../mappings.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const RATE_MIN = 30, RATE_MAX = 60; 
export const MAX_LLM_PATCHES = 24; 
export const MAX_LLM_MODULES = 16; 
export const MAX_FAILS = 30; 
export const LLM_LAYER = 'llm';
const isLlmLayer = (l) => l === LLM_LAYER || (typeof l === 'string' && l.startsWith(LLM_LAYER + '.'));





export const DEST_MAP = Object.freeze({
  'pad.cutoff': { target: 'cutoff', op: 'ratio', clamp: [60, 16000] },
  tension: { target: 'resonance', op: 'oct', scale: 2, clamp: [0.3, 18] },
  'pad.width': { target: 'detune', op: 'add', scale: 40, clamp: [0, 60] },
  'pad.level': { target: 'swell', op: 'add', scale: 0.5, clamp: [MAPPINGS.swell.range[0], 0.95] }, 
  'fx.space': { target: 'reverbWet', op: 'add', scale: 0.6, clamp: [0, 0.9] },
  'fx.echo': { target: 'feedback', op: 'add', scale: 0.5, clamp: [0, 0.85] },
  'fx.drive': { target: 'trip', op: 'add', scale: 0.8, clamp: [0, 1] },
  'bass.level': { target: 'floor', op: 'add', scale: 0.3, clamp: [MAPPINGS.floor.range[0], 0.4] }, 
  'drums.density': { target: 'beat', op: 'add', scale: 1, clamp: [0, 1] }, 
  'master.tilt': { target: 'tint', op: 'add', scale: 2, clamp: [-1, 1], rest: 0 },
});







export const PATCH = {
  on: true,        
  layer: 'patch',  
  weight: 1,       
  depth: 1,        
  rate: 60,        
  fade: 0.4,       
                   
  cables: [
    { id: 'armsSpace', src: 'body.armsUp', dst: 'fx.space', amount: 0.3 },                  
    { id: 'reachWidth', src: 'body.reach', dst: 'pad.width', amount: 0.3 },                  
    { id: 'twistTension', src: 'body.twist', dst: 'tension', amount: 0.25, curve: 'mag' },  
    { id: 'grooveTilt', src: 'body.groove', dst: 'master.tilt', amount: 0.2 },               
  ],
};


const REST = Object.fromEntries(Object.values(DEST_MAP).filter((mp) => mp.rest != null).map((mp) => [mp.target, mp.rest]));
export function matrixTargets(targets, res, dests, depth = 1) {
  let out = null;
  for (const dst in DEST_MAP) {
    const r = res?.[dst], d = dests[dst];
    if (!r || !d) continue;
    const delta = (r.norm - d.base) * depth;
    if (!(Math.abs(delta) > 1e-9)) continue; 
    const mp = DEST_MAP[dst], cur = targets[mp.target] ?? mp.rest;
    if (!isNum(cur)) continue;
    let v;
    if (mp.op === 'ratio') { const b = mapDest(d, d.base), x = mapDest(d, d.base + delta); v = b ? cur * (x / b) : cur; }
    else if (mp.op === 'oct') v = cur * Math.pow(2, mp.scale * delta);
    else v = cur + mp.scale * delta;
    
    (out ??= { ...targets })[mp.target] = clamp(v, Math.min(mp.clamp[0], cur), Math.max(mp.clamp[1], cur));
  }
  return out ?? targets;
}

const WRAP = Symbol('matrixWrap');
const live = (fn) => { while (fn?.[WRAP]?.st.done) fn = fn[WRAP].orig; return fn; }; 

export const PATCH_KEYS = Object.freeze(['on', 'layer', 'weight', 'depth', 'rate', 'fade', 'cables']);

export const PATCH_RANGES = Object.freeze({ weight: [0, 1], depth: [0, 1], rate: [RATE_MIN, RATE_MAX], fade: [0, Infinity] }); 

export function checkPatchTable(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { errors: [`patch table: not an object (${t === null ? 'null' : Array.isArray(t) ? 'array' : typeof t})`], clamped: {} };
  const errors = [], clamped = {};
  for (const k of Object.keys(t)) if (!PATCH_KEYS.includes(k)) errors.push(`patch table: unknown key ${k} (one of ${PATCH_KEYS.join(', ')})`);
  if (!Object.prototype.hasOwnProperty.call(t, 'cables')) errors.push('patch table: cables is missing (an empty list [] is the way to say "no cables")');
  else if (!Array.isArray(t.cables)) errors.push(`patch table: cables must be an array (got ${t.cables === null ? 'null' : typeof t.cables})`);
  if ('on' in t && typeof t.on !== 'boolean') errors.push(`patch table: on must be true or false (got ${JSON.stringify(t.on) ?? typeof t.on})`);
  for (const [k, [lo, hi]] of Object.entries(PATCH_RANGES)) {
    if (!(k in t)) continue;
    if (!isNum(t[k])) { errors.push(`patch table: ${k} must be a finite number (got ${String(t[k])})`); continue; }
    if (t[k] < lo || t[k] > hi) clamped[k] = [t[k], clamp(t[k], lo, hi)];
  }
  return { errors, clamped };
}

export class MatrixBridge {
  constructor({ bus = null, pad = null, seed = 1, rate = 60, enabled = false, steer = false, depth = 1, inputs = null, clock = null, vector = null } = {}) {
    this.m = createMatrix({ seed });
    this.bus = bus;
    this.getPad = typeof pad === 'function' ? pad : () => pad;
    this.getInputs = inputs ?? (() => bus?.state?.sense?.inputs ?? {});
    this.getClock = clock; 
    this.getVector = vector; 
    this.rate = clamp(isNum(rate) ? rate : 60, RATE_MIN, RATE_MAX);
    this.steer = !!steer; this.depth = clamp(isNum(depth) ? depth : 1, 0, 1);
    this.enabled = false; this.acc = 0; this.steps = 0; this.res = null;
    this.fails = 0; this.errors = 0; this.lastError = null; this.failed = false;
    this.wrapped = null; 
    this.drvWrap = null; 
    this.introduced = new Set(); 
    this.llmMods = new Set(); 
    this.forced = !!enabled; 
    this.patchLayer = null; this.patchIds = []; 
    this.ownLayers = new Set(); 
    this.killing = false; 
    this.off = bus ? bus.on('frame', (ev) => this.frame(ev?.dt)) : null;
    if (enabled) this.enable();
  }
  
  
  
  setPatch(table = PATCH) {
    try { return this.#setPatch(table); } catch (e) { return { ok: false, errors: [`patch table: ${e?.message ?? e}`] }; }
  }
  #setPatch(table) {
    const chk = checkPatchTable(table); 
    if (chk.errors.length) return { ok: false, errors: chk.errors };
    const t = table, on = t.on !== false, cables = on ? t.cables : [];
    const layer = t.layer ?? PATCH.layer, errors = [];
    if (typeof layer !== 'string' || layer === 'body' || layer.startsWith('anchor.') || isLlmLayer(layer)) errors.push(`patch table: layer ${layer} is not the table's to use`);
    cables.forEach((c, i) => { if (!c || typeof c !== 'object' || !(c.dst in DEST_MAP)) errors.push(`cable ${c?.id ?? i}: dst ${c?.dst} is not heard by the Pad (one of ${Object.keys(DEST_MAP).join(', ')})`); });
    const rows = cables.map((c) => ({ ...c, layer })); 
    if (typeof layer === 'string' && !this.ownLayers.has(layer) && layer in this.m.layers) errors.push(`patch table: layer ${layer} already belongs to the matrix (pick a new name)`);
    
    for (const r of rows) { const e = r.id != null && this.m.patches.get(r.id); if (e && !this.ownLayers.has(e.layer)) errors.push(`cable ${r.id}: id exists (layer ${e.layer})`); }
    if (rows.length) errors.push(...validateSpec({ patches: rows }, { modIds: this.m.modIds, dests: this.m.dests }).errors);
    if (errors.length) return { ok: false, errors };
    const fade = isNum(t.fade) ? clamp(t.fade, ...PATCH_RANGES.fade) : PATCH.fade;
    
    
    const was = new Map();
    for (const [id, p] of this.m.patches) if (this.ownLayers.has(p.layer)) {
      was.set(id, p);
      if (!p.removing) { this.m.unpatch(id); if (!rows.length) p.restGlide = fade; }
    }
    for (const L of this.ownLayers) if (L !== layer) this.m.setLayerWeight(L, 0);
    for (const r of rows) { 
      const o = r.id != null && was.get(r.id);
      if (o && o.dst !== r.dst) { let k = 1; while (this.m.patches.has(`${o.id}Out${k}`)) k++; this.m.patches.delete(o.id); o.id = `${o.id}Out${k}`; this.m.patches.set(o.id, o); }
    }
    const w = isNum(t.weight) ? clamp(t.weight, 0, 1) : 1;
    this.ownLayers.add(layer);
    this.patchIds = rows.length ? this.m.addLayer(layer, rows, w) : [];
    for (const id of this.patchIds) { const o = was.get(id), p = this.m.patches.get(id); if (o && o !== p && o.dst === p.dst) p.c = o.c; }
    this.m.setLayerWeight(layer, rows.length ? w : 0);
    this.patchLayer = layer;
    if (isNum(t.depth)) this.depth = clamp(t.depth, 0, 1);
    if (isNum(t.rate)) this.rate = clamp(t.rate, RATE_MIN, RATE_MAX);
    if (rows.length) { this.killing = false; if (!this.enabled) this.enable(); }
    else if (!this.enabled || fade === 0) { this.#purgeOwn(); this.killing = false; if (!this.forced && this.enabled) this.disable(); }
    else if (!this.forced) this.killing = true; 
    return { ok: true, errors: [], on, layer, cables: this.patchIds.slice(), clamped: chk.clamped };
  }
  #hasOwn() { for (const p of this.m.patches.values()) if (this.ownLayers.has(p.layer)) return true; return false; }
  #purgeOwn() { for (const [id, p] of this.m.patches) if (this.ownLayers.has(p.layer) && p.removing) this.m.patches.delete(id); }
  stop() { this.dispose(); } 
  
  enable() { this.enabled = true; this.failed = false; this.fails = 0; this.#wrap(); return true; }
  disable() { this.enabled = false; this.killing = false; this.#unsteer(); this.#unwrap(); this.acc = 0; return false; }
  dispose() { this.disable(); this.off?.(); this.off = null; if (this.bus?.state?.matrix === this) delete this.bus.state.matrix; }
  toJSON() { return this.snapshot(); } 
  #wrap() {
    const pad = this.getPad();
    if (!pad || typeof pad.apply !== 'function') return;
    if (this.wrapped?.pad === pad) { 
      const f = this.wrapped.st.flush; if (f) for (const k in f) this.introduced.add(k);
      this.wrapped.st.flush = null; return;
    }
    this.#unwrap(true);
    
    
    let orig = live(pad.apply), pre = null;
    while (orig?.[WRAP] && orig[WRAP].pad === pad && orig[WRAP].st.flush && orig[WRAP] !== this.wrapped) {
      const o = orig[WRAP]; pre = { ...o.st.flush, ...pre }; o.st.flush = null; o.st.done = true; orig = live(o.orig);
    }
    const self = this, st = { flush: null, done: false, pre };
    const w = { pad, orig, st, fn: null };
    w.fn = function (targets, glides) {
      if (st.done) return orig.call(this, targets, glides);
      if (st.pre) { 
        const f = st.pre; st.pre = null;
        const out = self.enabled ? self.transform(targets) : targets, o2 = { ...out };
        for (const k in f) if (o2[k] == null) o2[k] = f[k];
        return orig.call(this, o2, glides);
      }
      if (st.flush) { 
        const f = st.flush; st.flush = null; targets = { ...targets };
        for (const k in f) if (targets[k] == null) targets[k] = f[k];
        self.#release(w);
        return orig.call(this, targets, glides);
      }
      return orig.call(this, self.enabled ? self.transform(targets) : targets, glides);
    };
    w.fn[WRAP] = w; pad.apply = w.fn; this.wrapped = w;
  }
  #unwrap(now = false) {
    const w = this.wrapped; if (!w) return;
    const flush = { ...w.st.pre }; w.st.pre = null; 
    for (const k of this.introduced) flush[k] = REST[k];
    this.introduced.clear();
    if (!now && Object.keys(flush).length) { w.st.flush = flush; return; }
    this.#release(w);
  }
  #release(w) {
    w.st.done = true;
    const cur = live(w.pad.apply);
    if (cur !== w.pad.apply || w.pad.apply === w.fn) { 
      const orig = live(w.orig);
      if (Object.prototype.hasOwnProperty.call(w.pad, 'apply') && orig === Object.getPrototypeOf(w.pad).apply) delete w.pad.apply; else w.pad.apply = orig;
    }
    if (this.wrapped === w) this.wrapped = null;
  }
  #steerOn(drv) {
    if (this.drvWrap?.drv === drv) return this.drvWrap;
    this.#unsteer();
    const orig = drv.setPhaseBias, self = this;
    const w = { drv, orig, fn: null, lean: AXES.map(() => 0), bias: Array.isArray(drv.directorBias) && drv.directorBias.length === AXES.length ? drv.directorBias.slice() : AXES.map(() => 0) };
    w.fn = function (b) { 
      w.bias = vec(b).map((x) => x - 0.5);
      return orig.call(this, w.bias.map((x, i) => 0.5 + x + (self.drvWrap === w ? w.lean[i] : 0)));
    };
    drv.setPhaseBias = w.fn; this.drvWrap = w;
    return w;
  }
  #unsteer() {
    const w = this.drvWrap; if (!w) return;
    this.drvWrap = null;
    if (w.drv.setPhaseBias === w.fn) { if (Object.prototype.hasOwnProperty.call(w.drv, 'setPhaseBias') && w.orig === Object.getPrototypeOf(w.drv).setPhaseBias) delete w.drv.setPhaseBias; else w.drv.setPhaseBias = w.orig; }
    w.orig.call(w.drv, w.bias.map((x) => 0.5 + x)); 
  }
  
  frame(dt) {
    if (!this.enabled) return null;
    if (!this.wrapped || this.wrapped.pad !== this.getPad()) this.#wrap(); 
    if (!isNum(dt) || dt <= 0) return null;
    this.acc += dt;
    if (this.acc < 0.9 / this.rate) return null; 
    const step = this.acc; this.acc = 0;
    try {
      const r = this.tick(step); this.fails = 0;
      if (this.killing && !this.#hasOwn()) { this.killing = false; if (!this.forced) this.disable(); } 
      return r;
    } catch (e) { this.#fail(e); return null; }
  }
  #fail(e) {
    this.errors++; this.fails++; this.lastError = String(e?.message ?? e);
    if (this.errors === 1) console.warn('[matrix]', e);
    if (this.fails >= MAX_FAILS) { this.failed = true; this.res = null; this.disable(); console.warn('[matrix] disabled after', this.fails, 'failing steps:', this.lastError); }
  }
  tick(dt) {
    const pad = this.getPad(), drv = pad?.spaceDriver;
    const clock = this.getClock?.() ?? { bpm: drv?.P?.bpm ?? PROGRESSION.bpm };
    this.res = this.m.step(dt, this.getInputs() ?? {}, clock, this.getVector?.() ?? null);
    this.steps++;
    
    if (this.steer && drv && typeof drv.setPhaseBias === 'function') {
      const vecIn = this.getVector?.() ?? null, w = this.#steerOn(drv);
      w.lean = VECTOR_AXES.map((a) => this.res['v.' + a].norm - (isNum(vecIn?.[a]) ? vecIn[a] : this.m.dests['v.' + a].base));
      w.orig.call(drv, w.bias.map((x, i) => 0.5 + x + w.lean[i]));
    }
    return this.res;
  }
  transform(targets) {
    if (!this.res || !targets) return targets;
    let out;
    try { out = matrixTargets(targets, this.res, this.m.dests, this.depth); } catch (e) { this.#fail(e); return targets; }
    for (const k of this.introduced) if (out[k] == null) { if (out === targets) out = { ...targets }; out[k] = REST[k]; this.introduced.delete(k); } 
    for (const k in REST) if (targets[k] == null && out[k] != null && out[k] !== REST[k]) this.introduced.add(k);
    return out;
  }
  
  
  setAnchorWeights(weights = {}) {
    const ok = {};
    for (const [k, w] of Object.entries(weights ?? {})) if (ANCHORS.includes(k) && isNum(w)) ok[k] = clamp(w, 0, 1);
    this.m.setAnchorWeights(ok);
    return Object.keys(ok);
  }
  anchorWeights() { return Object.fromEntries(ANCHORS.map((k) => [k, this.m.layerWeight('anchor.' + k)])); }
  
  
  
  
  
  propose(spec) {
    try { return this.#propose(spec); } catch (e) { return { ok: false, errors: [`spec: ${e?.message ?? e}`] }; }
  }
  #propose(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['spec: not an object'] };
    const s = (spec.type != null) ? { modules: [spec] } : (spec.src != null || spec.dst != null) ? { patches: [spec] } : spec;
    const known = new Set(['modules', 'patches', 'unpatch', 'removeModules', 'amounts', 'layer']);
    const errors = Object.keys(s).filter((k) => !known.has(k)).map((k) => `spec: unknown field ${k}`);
    for (const k of ['modules', 'patches', 'unpatch', 'removeModules']) if (s[k] != null && !Array.isArray(s[k])) errors.push(`spec: ${k} must be an array`);
    if (s.amounts != null && (typeof s.amounts !== 'object' || Array.isArray(s.amounts))) errors.push('spec: amounts must be an object');
    if (s.layer != null && (!isNum(s.layer) || s.layer < 0 || s.layer > 1)) errors.push('spec: layer weight must be 0..1');
    if (errors.length) return { ok: false, errors };
    const P = this.m.patches, mine = (id) => P.has(id) && isLlmLayer(P.get(id).layer);
    const modules = s.modules ?? [], unpatch = s.unpatch ?? [], removeMods = s.removeModules ?? [], amounts = s.amounts ?? {};
    
    const patches = (s.patches ?? []).map((p) => (p && typeof p === 'object' && p.layer == null ? { ...p, layer: LLM_LAYER } : p)); 
    patches.forEach((p, i) => { if (p && typeof p === 'object' && !isLlmLayer(p.layer)) errors.push(`patch ${p.id ?? i}: layer must be ${LLM_LAYER} or ${LLM_LAYER}.<name>`); });
    for (const id of unpatch) if (!P.has(id)) errors.push(`unpatch ${id}: unknown cable`); else if (!mine(id)) errors.push(`unpatch ${id}: may only remove conductor cables`);
    for (const [id, a] of Object.entries(amounts)) {
      if (!P.has(id) || P.get(id).removing) errors.push(`amount ${id}: unknown cable`);
      else if (!mine(id)) errors.push(`amount ${id}: not a conductor cable`);
      else if (!isNum(a) || a < -1 || a > 1) errors.push(`amount ${id}: must be -1..1`);
    }
    for (const id of removeMods) if (!this.llmMods.has(id)) errors.push(`removeModules ${id}: not a conductor module`);
    const ids = new Set([...this.m.modIds].filter((id) => !removeMods.includes(id)));
    modules.forEach((mod, i) => {
      if (!mod || typeof mod !== 'object' || mod.type == null || 'modules' in mod || 'patches' in mod || 'dests' in mod) { errors.push(`module ${mod?.id ?? i}: not a module {id, type}`); return; }
      const r = validateSpec(mod, { modIds: new Set([...ids, mod.id]), dests: this.m.dests, existing: ids });
      errors.push(...r.errors);
      if (r.ok) ids.add(mod.id);
    });
    
    for (const p of patches) if (p?.id != null && P.has(p.id)) errors.push(`patch ${p.id}: id exists${P.get(p.id).removing ? ' (fading out)' : ''}`);
    if (patches.length) errors.push(...validateSpec({ patches }, { modIds: ids, dests: this.m.dests }).errors);
    const held = [...P.values()].filter((p) => isLlmLayer(p.layer) && !p.removing && !unpatch.includes(p.id)).length;
    if (held + patches.length > MAX_LLM_PATCHES) errors.push(`spec: more than ${MAX_LLM_PATCHES} conductor cables`);
    const heldMods = [...this.llmMods].filter((id) => !removeMods.includes(id)).length;
    if (heldMods + modules.length > MAX_LLM_MODULES) errors.push(`spec: more than ${MAX_LLM_MODULES} conductor modules`);
    if (errors.length) return { ok: false, errors };
    
    const undo = [], pids = [];
    try {
      for (const id of unpatch) { const p = P.get(id), was = p.removing; this.m.unpatch(id); undo.push(() => { p.removing = was; }); }
      for (const id of removeMods) {
        const mod = this.m.mods.get(id); this.m.removeModule(id); this.llmMods.delete(id);
        undo.push(() => { if (mod) this.m.mods.set(id, mod); this.llmMods.add(id); });
      }
      for (const mod of modules) { this.m.addModule(mod); this.llmMods.add(mod.id); undo.push(() => { this.m.removeModule(mod.id); this.llmMods.delete(mod.id); }); }
      for (const p of patches) { const id = this.m.patch(p); pids.push(id); undo.push(() => P.delete(id)); }
      for (const [id, a] of Object.entries(amounts)) { const p = P.get(id), was = p.amount; this.m.setAmount(id, a); undo.push(() => { p.amount = was; }); }
      if (s.layer != null) { 
        const L = this.m.layers[LLM_LAYER], was = L?.target;
        this.m.setLayerWeight(LLM_LAYER, s.layer);
        undo.push(() => { if (L) L.target = was; else delete this.m.layers[LLM_LAYER]; });
      }
    } catch (e) {
      for (const u of undo.reverse()) u();
      return { ok: false, errors: [`spec: ${e?.message ?? e} (nothing changed)`] };
    }
    return { ok: true, errors: [], modules: modules.map((m) => m.id), patches: pids };
  }
  validate(spec) { return this.m.validate(spec); }
  describe() { return this.m.describe(); }
  catalog() { return { ...this.m.catalog(), anchors: ANCHORS.slice(), heard: Object.keys(DEST_MAP) }; }
  snapshot() {
    return { enabled: this.enabled, steps: this.steps, rate: this.rate, steer: this.steer, anchors: this.anchorWeights(), patch: { layer: this.patchLayer, cables: this.patchIds.length },
      errors: this.errors, failed: this.failed, lastError: this.lastError, conductor: { modules: this.llmMods.size, cables: [...this.m.patches.values()].filter((p) => isLlmLayer(p.layer) && !p.removing).length },
      heard: this.res ? Object.fromEntries(Object.keys(DEST_MAP).map((k) => [k, +this.res[k].norm.toFixed(3)])) : null };
  }
}



export function mountMatrixBridge(opts = {}) {
  const prev = opts.bus?.state?.matrix;
  if (prev instanceof MatrixBridge) prev.dispose();
  const b = new MatrixBridge(opts);
  if (opts.bus?.state) opts.bus.state.matrix = b;
  return b;
}


export function mountBodyPatch(opts = {}) {
  const { patch = PATCH, ...rest } = opts;
  const b = mountMatrixBridge(rest);
  const r = b.setPatch(patch);
  if (!r.ok) console.warn('[matrix] PATCH table refused (the plain sound plays):', r.errors.join('; '));
  else if (Object.keys(r.clamped).length) console.warn('[matrix] PATCH table values clamped:', JSON.stringify(r.clamped));
  return b;
}
