


import { MAPPINGS } from './mappings.js';
import { FACE_KEYS } from './face.js';
import { CURVES, CURVE_MODIFIERS, curveError } from './curves.js';




const S = (id, o = {}) => ({ id, group: id.split('.')[0], range: [0, 1], polarity: 'uni', neutral: 0, rate: 15, kind: 'felt', bindable: true, nullable: false, label: id, ...o });
const bi = { polarity: 'bi', neutral: 0.5 };
const hand = (g, who) => [
  S(`${g}.x`, { label: `${who} across (0 left .. 1 right)` }),
  S(`${g}.height`, { label: `${who} height (0 low .. 1 high)` }),
  S(`${g}.spread`, { label: `${who} thumb-index spread (pinch 0 .. wide 1)` }),
  S(`${g}.openness`, { label: `${who} openness (fist 0 .. open 1)` }),
  S(`${g}.depth`, { label: `${who} closeness to the camera (far 0 .. close 1)` }),
  S(`${g}.cx`, { kind: 'latent', label: `${who} palm centre x (raw frame)` }),
  S(`${g}.cy`, { kind: 'latent', label: `${who} palm centre y (raw frame)` }),
];
const FACE_LABEL = { jawOpen: 'mouth open', smile: 'smile', squint: 'squint', blink: 'blink', browUp: 'brows up', pucker: 'pucker', cheekPuff: 'cheek puff', gazeX: 'gaze x (signed)', gazeY: 'gaze y (signed)', lookX: 'gaze across (0.5 centre)', lookY: 'gaze up/down (0.5 centre)' };
export const SOURCES = Object.freeze([
  ...hand('A', 'hand A'), ...hand('B', 'hand B'),
  S('body.x', { ...bi, label: 'where you stand across the room' }),
  S('body.rise', { ...bi, label: 'rising / sinking' }),
  S('body.lean', { ...bi, label: 'torso lean' }),
  S('body.sway', { ...bi, label: 'sway vs its slow average' }),
  S('body.headTilt', { ...bi, label: 'head tilt' }),
  S('body.headTurn', { ...bi, label: 'head turn' }),
  S('body.nod', { ...bi, label: 'nod (chin up / down)' }),
  S('body.shrug', { ...bi, label: 'shoulders up / down' }),
  S('body.depth', { ...bi, label: 'closer / further vs baseline' }),
  S('body.armsUp', { nullable: true, label: 'arms raised' }),
  S('body.reach', { nullable: true, label: 'arms open (wrist span)' }),
  S('body.hunch', { ...bi, label: 'hunch / open chest' }),
  S('body.twist', { ...bi, label: 'torso twist' }),
  S('body.elbowBend', { nullable: true, label: 'elbows bent' }),
  S('body.crouch', { nullable: true, label: 'crouch' }),
  S('body.cx', { kind: 'latent', label: 'shoulder centre x (raw frame)' }),
  S('body.cy', { kind: 'latent', label: 'shoulder centre y (raw frame)' }),
  S('body.shoulderW', { kind: 'latent', label: 'shoulder width (raw frame)' }),
  S('body.here', { rate: 30, kind: 'latent', label: 'someone is here (0 / 1)' }),
  S('body.energy', { rate: 30, kind: 'latent', label: 'movement energy' }),
  S('body.groove', { rate: 30, kind: 'latent', label: 'movement building (energy averaged)' }),
  ...FACE_KEYS.map((k) => S(`face.${k}`, { rate: 7.5, ...(k === 'lookX' || k === 'lookY' ? bi : {}),
    ...(k === 'gazeX' || k === 'gazeY' ? { range: [-1, 1], polarity: 'bi', neutral: 0, bindable: false, kind: 'default_only' } : {}), label: FACE_LABEL[k] || k })),
  S('face.blinkPulse', { rate: 7.5, kind: 'latent', label: 'blink onset pulse (0 / 1)' }),
].map(Object.freeze));
export const SOURCE = Object.freeze(Object.fromEntries(SOURCES.map((s) => [s.id, s])));




const SAFE = {
  cutoff: [40, 12000], detune: [0, 60], shimmer: [0, 0.4], pan: [-1, 1], swell: [0, 1], reverbWet: [0, 1], octave: [0, 0.6],
  trip: [0, 1], feedback: [0, 0.85], field: [-1, 1], resonance: [0.1, 20], wah: [80, 8000], wahDepth: [0, 18], floor: [0, 0.5],
  vibrato: [0, 60], tremolo: [0, 1], modRate: [0.1, 12], beat: [0, 1],
};
const APPLY = { tremolo: 'derived', floor: 'params+derived(sub)', reverbWet: 'macro', trip: 'macro', beat: 'always', voicing: 'zones', feedback: 'params(capped)' };
export const TARGETS = Object.freeze(Object.entries(MAPPINGS).map(([id, m]) => Object.freeze({
  id, unit: m.unit ?? '', range: m.range ? [...m.range] : null, safe: SAFE[id] ?? null, rest: m.rest, glide: m.glide ?? null, restGlide: m.restGlide ?? null,
  apply: APPLY[id] ?? 'params', label: m.label, ...(id === 'voicing' ? { zones: m.zones } : {}),
})));
export const TARGET = Object.freeze(Object.fromEntries(TARGETS.map((t) => [t.id, t])));

for (const t of TARGETS) if (t.id !== 'voicing' && !t.safe) throw new Error(`registry: target '${t.id}' has no safe range`);


const TERM_KEYS = ['s', 'w', 'inv', 'mag', 'idle', 'opt', 'ctr'];
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
export function srcError(src, { agent = false, allowNull = false } = {}) {
  if (src == null) return allowNull ? null : 'needs a src';
  const chk = (id) => {
    if (typeof id !== 'string' || !SOURCE[id]) return `unknown source '${id}'`;
    if (agent && !SOURCE[id].bindable) return `source '${id}' is not bindable (use ${id.replace('gaze', 'look')})`;
    return null;
  };
  if (typeof src === 'string') return chk(src);
  if (!Array.isArray(src) || !src.length) return 'src must be a source id or a non-empty blend [{s, w}, ...]';
  for (const t of src) {
    if (!t || typeof t !== 'object') return 'a blend term must be {s, w, ...}';
    const bad = Object.keys(t).find((k) => !TERM_KEYS.includes(k)); if (bad) return `unknown blend term field '${bad}'`;
    const e = chk(t.s); if (e) return e;
    if (!finite(t.w) || t.w < 0) return `term ${t.s}: w must be a finite number >= 0`;
    if (t.idle != null && !finite(t.idle)) return `term ${t.s}: idle must be finite`;
  }
  if (!src.some((t) => t.w > 0)) return 'a blend needs at least one term with w > 0';
  return null;
}
export const MAP_FIELDS = {
  static: ['src', 'mag', 'range', 'curve', 'rest', 'glide', 'restGlide', 'weight', 'label', 'unit', 'hysteresis', 'zones'],
  binding: ['src', 'mag', 'target', 'range', 'curve', 'weight', 'hold', 'cooldown', 'fadeIn', 'fadeOut', 'label'],
};

export function mapError(def, kind, { agent = false } = {}) {
  if (kind !== 'static' && kind !== 'binding') return `kind must be 'static' or 'binding'`;
  if (!def || typeof def.id !== 'string' || !def.id) return 'needs an id';
  const tid = kind === 'static' ? def.id : def.target;
  const T = TARGET[tid];
  if (!T) return `unknown target '${tid}' (known: ${TARGETS.map((t) => t.id).join(', ')})`;
  if (tid === 'voicing') {
    if (kind === 'binding') return "voicing is not bindable (zones, static only)";
    return srcError(def.src, { agent, allowNull: true }) || (def.hysteresis != null && !(finite(def.hysteresis) && def.hysteresis >= 0) ? 'hysteresis must be >= 0' : null)
      || (def.zones != null && !(Number.isInteger(def.zones) && def.zones >= 1 && def.zones <= 8) ? 'zones must be an integer 1..8' : null);
  }
  const e = srcError(def.src, { agent, allowNull: kind === 'static' }); if (e) return e;
  const r = def.range;
  if (!Array.isArray(r) || r.length !== 2 || !finite(r[0]) || !finite(r[1])) return 'range must be [lo, hi], two finite numbers';
  const [a, b] = T.safe;
  if (Math.min(r[0], r[1]) < a - 1e-12 || Math.max(r[0], r[1]) > b + 1e-12) return `range [${r}] is outside ${tid}'s safe [${a}, ${b}]`;
  const ce = curveError(def.curve, r); if (ce) return ce;
  if (def.weight != null && !(finite(def.weight) && def.weight >= 0 && def.weight <= 1)) return 'weight must be in 0..1';
  for (const k of ['glide', 'restGlide', 'hold', 'cooldown']) if (def[k] != null && !(finite(def[k]) && def[k] >= 0)) return `${k} must be a finite number >= 0`;
  for (const k of ['fadeIn', 'fadeOut']) if (def[k] != null && !(finite(def[k]) && def[k] > 0)) return `${k} must be > 0`;
  if (kind === 'static' && !finite(def.rest)) return 'a static mapping needs a finite rest';
  if (kind === 'static' && (def.rest < a - 1e-12 || def.rest > b + 1e-12)) return `rest ${def.rest} is outside ${tid}'s safe [${a}, ${b}]`;
  return null;
}

export const describeRegistry = () => ({
  sources: SOURCES.map((s) => ({ ...s })),
  targets: TARGETS.map((t) => ({ ...t })),
  curves: [...CURVES, ...CURVE_MODIFIERS],
});
