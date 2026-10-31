// What keeps it alive: the binding table (armed / retired through the conductor's verbs), and the slow chord
// progression the body bends. Pure (no DOM, no audio): driven by dt + energy, node-testable.
// All rules are DATA in mappings.js (POOL, PROGRESSION, VOICINGS).
import { POOL, PROGRESSION, VOICINGS, ENERGY, mapRange, readBlend } from './mappings.js';

// The binding table. Every binding in the POOL is idle | armed | cooling. WHO arms or retires it is never
// decided here: only the conductor's verbs call arm / retire (proposed by a policy: the DJ, a cue, a console
// edit, later the mind). This class keeps state, fades, and layers live bindings over the static targets.
// A binding is a continuous function (src -> mapRange -> target), never a branch.
export class Bindings {
  constructor(defs = POOL) { this.defs = defs.map((d) => ({ ...d })); this.reset(); }
  reset() {
    this.s = Object.fromEntries(this.defs.map((d) => [d.id, { phase: 'idle', w: 0, armedFor: 0, coolFor: 0, arms: 0, by: null, obs: null, why: null, claim: null }]));
    this.events = [];
  }
  def(id) { return this.defs.find((d) => d.id === id); }
  // Low-level re-wiring primitives. The bus verbs are map.create / map.update / map.remove (layer.js validates
  // against the registry, records undo, traces); binding.add / rebind / remove are aliases of those. Add a new binding, rebind an existing one's src / target / range /
  // curve / mag / timings, or remove one. Only while it is not armed (retire first, or force). targets = the
  // allowed target names (MAPPINGS keys) so nothing can wire to a param that does not exist.
  add(def, { targets } = {}) {
    if (!def?.id || this.def(def.id)) return { ok: false, why: def?.id ? `binding '${def.id}' exists` : 'no id' };
    if (targets && !targets.includes(def.target)) return { ok: false, why: `no target '${def.target}'` };
    if (!def.src || !Array.isArray(def.range)) return { ok: false, why: 'needs src and range' };
    const d = { hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: def.id, ...def };
    this.defs.push(d);
    this.s[d.id] = { phase: 'idle', w: 0, armedFor: 0, coolFor: 0, arms: 0, by: null, obs: null, why: null, claim: null };
    return { ok: true };
  }
  rebind(id, patch = {}, { targets, force = false, by = 'dev', now = 0, why = '' } = {}) {
    const d = this.def(id); if (!d) return { ok: false, why: `no binding '${id}'` };
    if (patch.target != null && targets && !targets.includes(patch.target)) return { ok: false, why: `no target '${patch.target}'` };
    if (this.s[id].phase === 'armed') { if (!force) return { ok: false, why: 'armed (retire first or force)' }; this.retire(id, { by, why: `rebind ${why}`, now }); }
    const keys = ['src', 'mag', 'target', 'range', 'curve', 'hold', 'cooldown', 'fadeIn', 'fadeOut', 'label'];
    for (const k of keys) if (k in patch) d[k] = patch[k];
    this.events.push({ t: now, id, ev: 'rebind', by, why, patch: Object.fromEntries(keys.filter((k) => k in patch).map((k) => [k, patch[k]])) });
    return { ok: true };
  }
  remove(id, { by = 'dev', now = 0, why = '' } = {}) {
    const i = this.defs.findIndex((d) => d.id === id); if (i < 0) return { ok: false, why: `no binding '${id}'` };
    if (this.s[id].phase !== 'idle' && this.s[id].w > 0) return { ok: false, why: `still ${this.s[id].phase}` };
    this.defs.splice(i, 1); delete this.s[id];
    this.events.push({ t: now, id, ev: 'remove', by, why });
    return { ok: true };
  }
  armed() { return this.defs.filter((d) => this.s[d.id].phase === 'armed'); }
  // the armed binding that owns a target (one per target)
  owner(target) { return this.defs.find((d) => d.target === target && this.s[d.id].phase === 'armed') || null; }
  // arm: by = 'dj' | 'cue' | 'dev' | ...; obs = the body-story observation id it rests on (or null);
  // claim = the claim id a probe will check on it; force = skip the cooldown. Returns false (+ .why) if refused.
  arm(id, { by = 'dj', obs = null, why = '', now = 0, force = false, claim = null } = {}) {
    const d = this.def(id), s = this.s[id];
    if (!d) return false;
    if (s.phase === 'armed') return false;
    if (s.phase === 'cooling' && !force) return false;
    const o = this.owner(d.target);
    if (o && o.id !== id) { if (!force) return false; this.retire(o.id, { by, why: `target taken by ${id}`, now }); }
    Object.assign(s, { phase: 'armed', armedFor: 0, by, obs, why, claim }); s.arms++;
    this.events.push({ t: now, id, ev: 'arm', by, obs, why });
    return true;
  }
  retire(id, { by = 'dj', why = '', now = 0 } = {}) {
    const s = this.s[id];
    if (!s || s.phase !== 'armed') return false;
    Object.assign(s, { phase: 'cooling', coolFor: 0, by, why });
    this.events.push({ t: now, id, ev: 'retire', by, why });
    return true;
  }
  update(dt) {
    for (const d of this.defs.slice()) {
      const s = this.s[d.id];
      if (s.phase === 'armed') { s.armedFor += dt; s.w = Math.min(1, s.w + dt / d.fadeIn); }
      else if (s.phase === 'cooling') {
        s.coolFor += dt; s.w = Math.max(0, s.w - dt / d.fadeOut);
        if (s.coolFor >= d.cooldown && s.w === 0) s.phase = 'idle';
      }
      // map.remove of a live binding: it retired (fade out) first; it leaves the table once silent
      if (d.removing && s.phase !== 'armed' && s.w === 0) { this.defs.splice(this.defs.indexOf(d), 1); delete this.s[d.id]; this.events.push({ t: d.removing.t, id: d.id, ev: 'removed', by: d.removing.by, why: 'faded out' }); }
    }
    if (this.events.length > 60) this.events.splice(0, this.events.length - 60);
  }
  // Cross-fade each live binding's value over the static target it takes over.
  apply(targets, inputs) {
    for (const d of this.defs) {
      const w = d.weight == null ? this.s[d.id].w : this.s[d.id].w * d.weight; // live `weight` (map.update) scales the fade
      if (w <= 0) continue;
      const v = readBlend(inputs, d.src, d.mag);
      if (v == null) continue; // source absent: the static mapping keeps the param
      targets[d.target] = targets[d.target] * (1 - w) + mapRange(d, v) * w;
    }
    return targets;
  }
  snapshot() { return JSON.parse(JSON.stringify(this.s)); }
}

export class Progression {
  constructor(def = PROGRESSION) { this.def = def; this.reset(); }
  reset() { this.index = 0; this.beat = 0; this.bar = 0; this.bars = 0; this.changes = 0; this.wasMoving = false; this.wasMovingPeak = false; this.peak = 0; }
  get chord() { return this.def.chords[this.index]; }
  get barSeconds() { return (60 / this.def.bpm) * this.def.beatsPerBar; }
  // returns true when the chord changed during this tick
  tick(dt, energy) {
    const d = this.def;
    let changed = false;
    this.beat += dt * (d.bpm / 60);
    this.peak = Math.max(this.peak, energy);
    const moving = energy >= ENERGY.moving;
    while (this.beat >= d.beatsPerBar) {
      this.beat -= d.beatsPerBar; this.bar++; this.bars++;
      // phrase end: movement that had built up (peak over the advance level) has settled
      const phraseEnd = d.phraseEnd && this.wasMovingPeak && !moving;
      if (this.bar >= d.maxBars || (this.bar >= d.minBars && (energy >= d.advanceEnergy || phraseEnd))) {
        this.index = (this.index + 1) % d.chords.length; this.bar = 0; this.changes++; changed = true;
        this.peak = 0; this.wasMovingPeak = false;
      }
    }
    if (moving && this.peak >= d.advanceEnergy) this.wasMovingPeak = true;
    this.wasMoving = moving;
    return changed;
  }
  snapshot() { return { index: this.index, chord: this.chord.name, bar: this.bar, beat: +this.beat.toFixed(2), bars: this.bars, changes: this.changes }; }
}

// Voice-lead the chord into the zone's voicing. Bass = the chord root nearest the old bass in [33,47].
// The zone names which chord tones the 4 upper voices use (and its register window around `center`);
// they are assigned to voices by trying every permutation and keeping the one with the least total
// movement (no unisons), so a chord change slides each voice the shortest way. With no previous notes
// the voices aim at an even spread around the zone's centre.
const PERMS = ((a) => { const out = []; const rec = (pre, rest) => rest.length ? rest.forEach((x, i) => rec([...pre, x], rest.filter((_, j) => j !== i))) : out.push(pre); rec([], a); return out; })([0, 1, 2, 3]);
export function voiceLead(prev, chord, zone) {
  const z = VOICINGS[zone] ?? VOICINGS[0];
  const lo = z.center - 8, hi = z.center + 9;
  const near = (pc, p, a, b) => {
    let best = null;
    for (let k = -1; k <= 10; k++) { const n = pc + 12 * k; if (n < a || n > b) continue; if (best == null || Math.abs(n - p) < Math.abs(best - p)) best = n; }
    return best;
  };
  const bass = near(chord.root % 12, prev?.[0] ?? chord.root, 33, 47);
  const aim = prev ? prev.slice(1) : [z.center - 6, z.center - 2, z.center + 2, z.center + 6];
  const pcs = z.tones.map((ti) => (chord.root + (ti === 0 ? 0 : chord.tones[ti - 1])) % 12);
  let best = null, bestCost = Infinity;
  for (const perm of PERMS) {
    const notes = perm.map((j, i) => near(pcs[j], aim[i], lo, hi));
    const cost = notes.reduce((c, n, i) => c + Math.abs(n - aim[i]), 0) + (new Set(notes).size < 4 ? 100 : 0);
    if (cost < bestCost) { bestCost = cost; best = notes; }
  }
  return [bass, ...best];
}
