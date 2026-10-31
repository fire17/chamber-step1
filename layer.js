// The MappingLayer (DYNAMIC_LAYER.md M4/M5): the LIVE mapping set, editable at runtime through ONE verb family:
//   map.create {id, kind:'static'|'binding', src, target?, range, curve?, ...}   map.update {id, ...patch}
//   map.remove {id}   undo {n=1}
// static  = an always-on mapping, one per target (id === its target name; a removed one rests the target).
// binding = a POOL-style binding the conductor arms / retires (cross-fades over the static), many per target.
// Preset `default` = deep copies of MAPPINGS (statics) + POOL (bindings), so the default sound is identical
// (verify/golden). Every edit is validated against the SOURCE / TARGET registries (registry.js) and refused with
// a clean `why`, never a throw. Pure: no DOM, no audio.
import { MAPPINGS, POOL, computeTargets, srcNames } from './mappings.js';
import { mapError, MAP_FIELDS, TARGET, describeRegistry } from './registry.js';

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
export const UNDO_RING = 100;
export const AGENT_MAP_CAP = 4; // map.* verbs per conductor turn for agents (by other than dev / cue)
export const TRUSTED = ['dev', 'cue', 'boot', 'undo'];
const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
export const PRESET_HASH = 'fnv1a:' + fnv(JSON.stringify({ MAPPINGS, POOL }));

export class MappingLayer {
  // bindings: the life.js Bindings the conductor arms / retires (its defs ARE the live binding set)
  constructor({ bindings, statics = MAPPINGS } = {}) {
    this.B = bindings; this.defaults = statics;
    this.statics = clone(statics);
    this.undoStack = []; this.edits = 0;
  }
  reset() { this.statics = clone(this.defaults); this.undoStack = []; } // bindings: Bindings.reset() is the caller's
  // the frame: static mappings + live bindings over them (the same float ops as computeTargets + Bindings.apply)
  compute(inputs, zone) { const r = computeTargets(inputs, zone, this.statics); this.B.apply(r.targets, inputs); return r; }
  kindOf(id) { return this.statics[id] ? 'static' : this.B.def(id) ? 'binding' : null; }

  // ---------------- the verbs (conductor.js registers them; `ctx` = { by, now, agent }) ----------------
  create(args = {}, ctx = {}) {
    const { kind = 'binding', why, at, ...def } = args;
    if (kind === 'static') { if (def.id == null && def.target) def.id = def.target; if (def.target != null && def.target !== def.id) return no(`a static mapping's id is its target ('${def.target}')`); delete def.target; }
    if (ctx.undoing && kind === 'binding' && this.B.def(def.id)?.removing) { delete this.B.def(def.id).removing; return { ok: true, id: def.id, kind, state: 'removal cancelled' }; }
    if (def.id != null && this.kindOf(def.id)) return no(`'${def.id}' exists (map.update it, or map.remove first)`);
    if (kind !== 'static' && kind !== 'binding') return no("kind must be 'static' or 'binding'");
    const bad = Object.keys(def).find((k) => k !== 'id' && !MAP_FIELDS[kind].includes(k));
    if (bad) return no(`unknown field '${bad}' for a ${kind} mapping (allowed: ${MAP_FIELDS[kind]?.join(', ')})`);
    const full = kind === 'static'
      ? { ...def, ...(def.id === 'voicing' ? { zones: def.zones ?? MAPPINGS.voicing?.zones ?? 4, hysteresis: def.hysteresis ?? 0.05, rest: 'hold' } : { rest: def.rest ?? TARGET[def.id]?.rest }) }
      : { hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: def.id, ...def };
    if (kind === 'static' && full.label == null) full.label = TARGET[def.id]?.label;
    const e = mapError(full, kind, ctx); if (e) return no(e);
    Object.keys(full).forEach((k) => full[k] === undefined && delete full[k]);
    if (kind === 'static') { // keyed by target (no id field, as MAPPINGS), kept in registry order so a re-create restores exactly
      const { id, ...m } = full, next = {};
      for (const k of Object.keys(TARGET)) if (k === id) next[k] = m; else if (this.statics[k]) next[k] = this.statics[k];
      this.statics = next;
    }
    else { const r = this.B.add(full, { targets: Object.keys(TARGET).filter((t) => t !== 'voicing') }); if (!r.ok) return r; if (at != null) this.#moveTo(full.id, at); }
    this.#did('map.create', args, { verb: 'map.remove', args: { id: full.id } }, ctx);
    return { ok: true, id: full.id, kind };
  }
  update({ id, why, ...patch } = {}, ctx = {}) {
    const kind = this.kindOf(id); if (!kind) return no(`no mapping '${id}'`);
    const unset = patch.__unset || []; delete patch.__unset;
    const bad = Object.keys(patch).find((k) => !MAP_FIELDS[kind].includes(k));
    if (bad) return no(`unknown field '${bad}' for a ${kind} mapping (allowed: ${MAP_FIELDS[kind].join(', ')})`);
    if (!Object.keys(patch).length && !unset.length) return no('empty patch');
    const cur = kind === 'static' ? this.statics[id] : this.B.def(id);
    if (cur.removing) return no(`'${id}' is being removed`);
    const next = { ...cur, ...(kind === 'static' ? { id } : {}), ...clone(patch) }; for (const k of unset) delete next[k];
    const e = mapError(next, kind, ctx); if (e) return no(e);
    if (kind === 'binding' && 'target' in patch && patch.target !== cur.target && this.B.s[id].phase === 'armed') {
      const o = this.B.owner(patch.target); if (o && o.id !== id) return no(`target ${patch.target} is owned by ${o.id} (armed)`);
    }
    const keys = [...Object.keys(patch), ...unset];
    const prev = {}, prevUnset = [];
    for (const k of keys) { if (k in cur) prev[k] = clone(cur[k]); else prevUnset.push(k); }
    for (const k of Object.keys(patch)) cur[k] = clone(patch[k]); // in place: an armed binding keeps its fade `w` (no zipper)
    for (const k of unset) delete cur[k];
    if (kind === 'binding') this.B.events.push({ t: ctx.now ?? 0, id, ev: 'update', by: ctx.by, why, patch: clone(patch) });
    this.#did('map.update', { id, ...patch, ...(unset.length ? { __unset: unset } : {}) }, { verb: 'map.update', args: { id, ...prev, ...(prevUnset.length ? { __unset: prevUnset } : {}) } }, ctx);
    return { ok: true, id, kind, changed: keys };
  }
  remove({ id, why } = {}, ctx = {}) {
    const kind = this.kindOf(id); if (!kind) return no(`no mapping '${id}'`);
    if (kind === 'static') {
      const snap = clone(this.statics[id]); delete this.statics[id];
      this.#did('map.remove', { id }, { verb: 'map.create', args: { kind, id, ...snap } }, ctx);
      return { ok: true, id, kind, state: 'removed', rest: TARGET[id].rest };
    }
    const d = this.B.def(id), st = this.B.s[id];
    if (d.removing) return no(`'${id}' is already being removed`);
    const at = this.B.defs.indexOf(d), snap = clone(d);
    this.#did('map.remove', { id }, { verb: 'map.create', args: { kind, ...snap, at } }, ctx);
    if (st.phase === 'armed') this.B.retire(id, { by: ctx.by, why: `map.remove ${why || ''}`.trim(), now: ctx.now ?? 0 });
    if (st.w > 0) { d.removing = { by: ctx.by, t: ctx.now ?? 0 }; return { ok: true, id, kind, state: 'fading out (removed once silent)' }; }
    this.B.defs.splice(at, 1); delete this.B.s[id];
    this.B.events.push({ t: ctx.now ?? 0, id, ev: 'remove', by: ctx.by, why });
    return { ok: true, id, kind, state: 'removed' };
  }
  // undo: pops the inverse; the conductor runs it as a verb (so it is traced), with ctx.undoing set
  popUndo() { return this.undoStack.pop() || null; }
  #moveTo(id, at) { const i = this.B.defs.findIndex((d) => d.id === id); const [d] = this.B.defs.splice(i, 1); this.B.defs.splice(Math.min(at, this.B.defs.length), 0, d); }
  #did(verb, args, inverse, ctx) {
    this.edits++;
    if (ctx.undoing) return;
    this.undoStack.push({ verb, args: clone(args), inverse, by: ctx.by, t: ctx.now ?? 0 });
    if (this.undoStack.length > UNDO_RING) this.undoStack.splice(0, this.undoStack.length - UNDO_RING);
  }

  // ---------------- reads ----------------
  list() {
    const st = Object.entries(this.statics).map(([id, m]) => ({ id, kind: 'static', target: id, src: clone(m.src), mag: m.mag, range: m.range && [...m.range], curve: clone(m.curve), weight: m.weight ?? 1, rest: m.rest, label: m.label }));
    const bd = this.B.defs.map((d) => ({ id: d.id, kind: 'binding', target: d.target, src: clone(d.src), mag: d.mag, range: [...d.range], curve: clone(d.curve), weight: d.weight ?? 1, label: d.label, state: this.B.s[d.id]?.phase, w: this.B.s[d.id]?.w, ...(d.removing ? { removing: true } : {}) }));
    return [...st, ...bd];
  }
  snapshot() { return Object.freeze({ statics: deepFreeze(clone(this.statics)), bindings: deepFreeze(clone(this.B.defs)) }); }
  describe() {
    const reg = describeRegistry();
    return {
      schema: 'chamber.mapping/1', ...reg, combine: ['xfade'],
      verbs: {
        'map.create': { args: { id: 'string', kind: "'static'|'binding'", src: 'sourceId|blend[{s,w,inv?,mag?,idle?,opt?,ctr?}]', target: 'targetId (binding)', range: '[n,n] inside target.safe', curve: 'curveSpec?', weight: '0..1?', mag: 'bool?', glide: 's?', rest: 'n? (static)', hold: 's?', cooldown: 's?', fadeIn: 's?', fadeOut: 's?', label: 'string?' } },
        'map.update': { args: { id: 'string', '...patch': 'any create field except id/kind' } },
        'map.remove': { args: { id: 'string' } },
        undo: { args: { n: 'int>=1 (default 1)' } },
        'binding.arm': { args: { id: 'string', force: 'bool?' } }, 'binding.retire': { args: { id: 'string' } }, 'binding.disarm': { alias: 'binding.retire' },
      },
      mappings: Object.entries(this.statics).map(([id, m]) => ({ id, kind: 'static', target: id, src: clone(m.src), range: m.range, curve: m.curve ?? 'lin', weight: m.weight ?? 1, rest: m.rest })),
      bindings: this.B.defs.map((d) => ({ id: d.id, kind: 'binding', target: d.target, src: clone(d.src), range: d.range, curve: d.curve ?? 'lin', weight: d.weight ?? 1, state: this.B.s[d.id]?.phase, w: +(this.B.s[d.id]?.w ?? 0).toFixed(3) })),
      caps: { agentVerbsPerTurn: AGENT_MAP_CAP, undoRing: UNDO_RING },
      preset: { name: 'default', hash: PRESET_HASH, edited: this.edits > 0 },
    };
  }
  sources(id) { const m = this.statics[id] || this.B.def(id); return m ? srcNames(m.src) : []; }
}
const no = (why) => ({ ok: false, why });
function deepFreeze(o) { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; }
