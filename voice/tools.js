














import { FLOW } from './flow.js';

export const MAX_TOOL_CALLS = 4;

export const TOOL_VERBS = Object.freeze({ map_create: 'map.create', map_update: 'map.update', map_remove: 'map.remove', undo: 'undo', switch_phase: 'phase.set',
  end_session: 'session.end', sound_steer: 'sound.steer', show_image: 'image.show' });


export const STEER_ANCHORS = Object.freeze(['chamber', 'temple', 'spiritual', 'emotional', 'astral', 'kinetic', 'club', 'acid', 'trance']);




const SAFE = { cutoff: [40, 12000], detune: [0, 60], shimmer: [0, 0.4], pan: [-1, 1], swell: [0, 1], reverbWet: [0, 1], octave: [0, 0.6],
  trip: [0, 1], feedback: [0, 0.85], field: [-1, 1], resonance: [0.1, 20], wah: [80, 8000], wahDepth: [0, 18], floor: [0, 0.5],
  vibrato: [0, 60], tremolo: [0, 1], modRate: [0.1, 12], beat: [0, 1] };
export const STATIC_REGISTRY = Object.freeze({
  targets: Object.fromEntries(Object.entries(SAFE).map(([id, safe]) => [id, { id, safe }])),
  sources: [
    ...['A', 'B'].flatMap((g) => ['x', 'height', 'spread', 'openness', 'depth', 'cx', 'cy'].map((k) => `${g}.${k}`)),
    ...['x', 'rise', 'lean', 'sway', 'headTilt', 'headTurn', 'nod', 'shrug', 'depth', 'armsUp', 'reach', 'here', 'energy', 'groove'].map((k) => `body.${k}`),
    ...['jawOpen', 'smile', 'squint', 'blink', 'browUp', 'pucker', 'cheekPuff', 'lookX', 'lookY'].map((k) => `face.${k}`),
  ],
  curves: ['lin', 'exp', 'log', 's', 'pow', 'invert', 'deadzone'],
  phases: ['orientation', 'enactment', 'integration'], 
  anchors: STEER_ANCHORS,
});

const ID_RE = /^[A-Za-z0-9_.\-]{1,40}$/;
const NUM_FIELDS = { glide: [0, 30], rest: [-20000, 20000], hold: [0, 30], cooldown: [0, 60], fadeIn: [0, 30], fadeOut: [0, 30], weight: [0, 1] };
const CREATE_KEYS = new Set(['id', 'kind', 'src', 'target', 'range', 'curve', 'mag', 'label', ...Object.keys(NUM_FIELDS)]);
const CURVE_KEYS = new Set(['name', 'k', 'p', 'invert', 'deadzone']);

const bad = (why) => ({ ok: false, why });
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function checkSrc(src, reg) {
  const known = new Set(reg.sources);
  if (typeof src === 'string') return known.has(src) ? null : `unknown source '${String(src).slice(0, 40)}'`;
  if (!Array.isArray(src) || src.length < 1 || src.length > 4) return 'src must be a source id or a blend of 1..4 terms';
  for (const t of src) {
    if (!t || typeof t !== 'object') return 'blend term must be {s, w}';
    for (const k of Object.keys(t)) if (!['s', 'w', 'mag', 'inv'].includes(k)) return `unknown blend key '${k.slice(0, 20)}'`;
    if (!known.has(t.s)) return `unknown source '${String(t.s).slice(0, 40)}'`;
    if (!fin(t.w) || t.w < 0 || t.w > 1) return 'blend weight must be 0..1';
  }
  return null;
}
function checkCurve(c, reg) {
  if (c == null) return null;
  if (typeof c === 'string') return reg.curves.includes(c) ? null : `unknown curve '${c.slice(0, 20)}'`;
  if (typeof c !== 'object' || Array.isArray(c)) return 'curve must be a name or a spec object';
  for (const k of Object.keys(c)) if (!CURVE_KEYS.has(k)) return `unknown curve key '${k.slice(0, 20)}'`;
  if (!reg.curves.includes(c.name)) return `unknown curve '${String(c.name).slice(0, 20)}'`;
  for (const k of ['k', 'p']) if (c[k] != null && (!fin(c[k]) || Math.abs(c[k]) > 100)) return `curve.${k} out of bounds`;
  return null;
}
function checkFields(a, reg, { partial }) {
  for (const k of Object.keys(a)) if (!CREATE_KEYS.has(k)) return `unknown field '${k.slice(0, 20)}'`;
  if (!partial || a.kind != null) if (!['static', 'binding'].includes(a.kind)) return "kind must be 'static' or 'binding'";
  if (!partial || a.src != null) { const e = checkSrc(a.src, reg); if (e) return e; }
  let tgt = null;
  const tid = a.kind === 'static' ? (a.target ?? a.id) : a.target; 
  if (!partial || tid != null) { tgt = reg.targets[tid]; if (!tgt) return `unknown target '${String(tid).slice(0, 40)}'`; }
  if (!partial || a.range != null) {
    if (!Array.isArray(a.range) || a.range.length !== 2 || !a.range.every(fin)) return 'range must be [n, n]';
    const safe = (tgt || { safe: [-20000, 20000] }).safe;
    if (a.range.some((v) => v < safe[0] || v > safe[1])) return `range outside safe [${safe}]`;
  }
  const ce = checkCurve(a.curve, reg); if (ce) return ce;
  if (a.mag != null && typeof a.mag !== 'boolean') return 'mag must be boolean';
  if (a.label != null && (typeof a.label !== 'string' || a.label.length > 40)) return 'label must be a string <= 40';
  for (const [k, [lo, hi]] of Object.entries(NUM_FIELDS)) if (a[k] != null && (!fin(a[k]) || a[k] < lo || a[k] > hi)) return `${k} must be ${lo}..${hi}`;
  return null;
}


export function registryFromDescribe(d) {
  if (!d || !Array.isArray(d.targets) || !Array.isArray(d.sources)) return STATIC_REGISTRY;
  return Object.freeze({
    targets: Object.fromEntries(d.targets.filter((t) => Array.isArray(t.safe)).map((t) => [t.id, { id: t.id, safe: [...t.safe] }])),
    sources: d.sources.filter((s) => s.bindable !== false && s.kind !== 'latent').map((s) => s.id),
    curves: Array.isArray(d.curves) ? d.curves.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean) : STATIC_REGISTRY.curves,
    phases: STATIC_REGISTRY.phases,
    anchors: STATIC_REGISTRY.anchors,
  });
}


let warnedLegacyTo = false;
export function validateToolCall(name, argsJson, registry = STATIC_REGISTRY) {
  if (!Object.prototype.hasOwnProperty.call(TOOL_VERBS, name)) return bad(`tool '${String(name).slice(0, 40)}' is not allowed`);
  let a;
  try { a = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : (argsJson ?? {}); } catch { return bad('arguments are not JSON'); }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return bad('arguments must be an object');
  if (JSON.stringify(a).length > 2000) return bad('arguments too large');
  const verb = TOOL_VERBS[name];
  if (name === 'switch_phase') {
    
    for (const k of Object.keys(a)) if (k !== 'phase' && k !== 'to' && k !== 'why') return bad(`unknown field '${k.slice(0, 20)}'`);
    if ('phase' in a && 'to' in a) return bad('give phase, not both phase and to');
    if ('to' in a && !warnedLegacyTo) { warnedLegacyTo = true; console.warn('switch_phase {to} is deprecated: use {phase, why}'); }
    const phase = 'phase' in a ? a.phase : a.to;
    if (!(registry.phases || []).includes(phase)) return bad(`unknown phase '${String(phase).slice(0, 40)}'`);
    if (typeof a.why !== 'string' || !a.why.trim() || a.why.length > 200) return bad('why must be a non-empty string <= 200');
    return { ok: true, verb, args: { name: phase, why: a.why } };
  }
  const why = (v, required) => (v == null && !required) || (typeof v === 'string' && v.trim() && v.length <= 200);
  const onlyKeys = (keys) => { for (const k of Object.keys(a)) if (!keys.includes(k)) return `unknown field '${k.slice(0, 20)}'`; return null; };
  if (name === 'end_session') {
    const e = onlyKeys(['why']); if (e) return bad(e);
    if (!why(a.why, true)) return bad('why must be a non-empty string <= 200');
    return { ok: true, verb, args: { why: a.why } };
  }
  if (name === 'sound_steer') {
    const e = onlyKeys(['steps', 'why']); if (e) return bad(e);
    const { maxSteps, seconds: [lo, hi] } = FLOW.steer, anchors = registry.anchors || STEER_ANCHORS;
    if (!Array.isArray(a.steps) || a.steps.length < 1 || a.steps.length > maxSteps) return bad(`steps must be 1..${maxSteps} anchors`);
    for (const st of a.steps) {
      if (!st || typeof st !== 'object' || Array.isArray(st)) return bad('a step must be {to, seconds}');
      for (const k of Object.keys(st)) if (k !== 'to' && k !== 'seconds') return bad(`unknown step key '${k.slice(0, 20)}'`);
      if (!anchors.includes(st.to)) return bad(`unknown anchor '${String(st.to).slice(0, 40)}'`);
      if (!fin(st.seconds) || st.seconds < lo || st.seconds > hi) return bad(`seconds must be ${lo}..${hi}`);
    }
    if (!why(a.why, false)) return bad('why must be a string <= 200');
    return { ok: true, verb, args: { steps: a.steps.map((st) => ({ to: st.to, seconds: st.seconds })), ...(a.why ? { why: a.why } : {}) } };
  }
  if (name === 'show_image') {
    const e = onlyKeys(['subject', 'why']); if (e) return bad(e);
    if (typeof a.subject !== 'string' || !a.subject.trim() || a.subject.length > 200) return bad('subject must be a non-empty string <= 200');
    if (!why(a.why, false)) return bad('why must be a string <= 200');
    return { ok: true, verb, args: { subject: a.subject, ...(a.why ? { why: a.why } : {}) } };
  }
  if (name === 'undo') {
    for (const k of Object.keys(a)) if (k !== 'n') return bad(`unknown field '${k.slice(0, 20)}'`);
    if (a.n != null && (!Number.isInteger(a.n) || a.n < 1 || a.n > 10)) return bad('n must be 1..10');
    return { ok: true, verb, args: { n: a.n ?? 1 } };
  }
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return bad('id must match [A-Za-z0-9_.-]{1,40}');
  if (name === 'map_remove') {
    for (const k of Object.keys(a)) if (k !== 'id') return bad(`unknown field '${k.slice(0, 20)}'`);
    return { ok: true, verb, args: { id: a.id } };
  }
  const e = checkFields(a, registry, { partial: name === 'map_update' });
  return e ? bad(e) : { ok: true, verb, args: a };
}



export function toolDefs(registry = STATIC_REGISTRY) {
  const targets = Object.keys(registry.targets), sources = registry.sources, curves = registry.curves;
  const fields = {
    id: { type: 'string', description: 'mapping id, [A-Za-z0-9_.-]{1,40}' },
    kind: { type: 'string', enum: ['static', 'binding'] },
    src: { description: 'a source id, or a blend [{s, w}]', anyOf: [{ type: 'string', enum: sources }, { type: 'array', maxItems: 4, items: { type: 'object', properties: { s: { type: 'string', enum: sources }, w: { type: 'number' } }, required: ['s', 'w'] } }] },
    target: { type: 'string', enum: targets },
    range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    curve: { type: 'string', enum: curves },
    label: { type: 'string' },
  };
  return [
    { type: 'function', name: 'map_create', description: 'Create a mapping from a body/hand/face source to a sound target.', parameters: { type: 'object', properties: fields, required: ['id', 'kind', 'src', 'target', 'range'] } },
    { type: 'function', name: 'map_update', description: 'Change fields of an existing mapping.', parameters: { type: 'object', properties: fields, required: ['id'] } },
    { type: 'function', name: 'map_remove', description: 'Remove a mapping by id.', parameters: { type: 'object', properties: { id: fields.id }, required: ['id'] } },
    { type: 'function', name: 'undo', description: 'Undo the last n mapping changes.', parameters: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 10 } } } },
    { type: 'function', name: 'switch_phase', description: 'Move the session to another phase when you judge the current one used up (e.g. orientation complete because the person has let go). Your judgement, never a timer or a count.',
      parameters: { type: 'object', properties: { phase: { type: 'string', enum: registry.phases || [] }, why: { type: 'string', minLength: 1, description: 'one short sentence: what you perceived that ends this phase' } }, required: ['phase', 'why'] } },
    { type: 'function', name: 'end_session', description: 'End the session when you judge the person is done (they say goodbye, or it has settled and they are ready to leave). The room then makes one short closing act and lets them go. Your judgement, never a timer.',
      parameters: { type: 'object', properties: { why: { type: 'string', description: 'one short sentence: what you perceived that ends the session' } }, required: ['why'] } },
    { type: 'function', name: 'sound_steer', description: 'Move the whole sound world along a short arc of named anchors, each reached over its own seconds. A new steer cancels the running arc.',
      parameters: { type: 'object', properties: { steps: { type: 'array', minItems: 1, maxItems: FLOW.steer.maxSteps, items: { type: 'object', properties: { to: { type: 'string', enum: [...(registry.anchors || STEER_ANCHORS)] }, seconds: { type: 'number', minimum: FLOW.steer.seconds[0], maximum: FLOW.steer.seconds[1] } }, required: ['to', 'seconds'] } }, why: { type: 'string' } }, required: ['steps'] } },
    { type: 'function', name: 'show_image', description: 'Show the person one image or symbol (an archetype, a scene, an abstract form), named in a few words.',
      parameters: { type: 'object', properties: { subject: { type: 'string', description: 'what to show, in a few words' }, why: { type: 'string' } }, required: ['subject'] } },
  ];
}
