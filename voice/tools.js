






















import { FLOW } from './flow.js';
import { vizDefs, validateViz, VIZ_VERBS } from './viz-tools.js';

export const MAX_TOOL_CALLS = 4;

export const TOOL_VERBS = Object.freeze({ map_create: 'map.create', map_update: 'map.update', map_remove: 'map.remove', undo: 'undo', switch_phase: 'phase.set',
  end_session: 'session.end', sound_steer: 'sound.steer', show_image: 'image.show',
  stay_quiet: 'floor.quiet', beat: 'beat.set', sound_moment: 'sound.moment', play: 'body.oneshot', voice_mode: 'voice.mode',
  when: 'when.arm', look: 'look.now', ...VIZ_VERBS });


export const SOUND_MOMENTS = Object.freeze(['swell', 'sweep']);
export const PLAY_SOUNDS = Object.freeze(['chime']);
export const VOICE_MODES = Object.freeze(['talk', 'sing']); 
export const NEVER_IN_THEN = Object.freeze(['switch_phase', 'end_session', 'when']); 
export const WHEN = Object.freeze({ ttl: [15, 120], ttlDefault: 90, maxThen: 4 });


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
  if (name === 'stay_quiet' || name === 'look') {
    const e = onlyKeys(['why']); if (e) return bad(e);
    if (!why(a.why, true)) return bad('why must be a non-empty string <= 200');
    return { ok: true, verb, args: { why: a.why } };
  }
  const opt = () => (a.why ? { why: a.why } : {});
  const oneOf = (field, list) => {
    const e = onlyKeys([field, 'why']); if (e) return bad(e);
    if (!list.includes(a[field])) return bad(`unknown ${field} '${String(a[field]).slice(0, 30)}'; one of ${list.join(', ')}`);
    if (!why(a.why, false)) return bad('why must be a string <= 200');
    return null;
  };
  if (name === 'beat') {
    const e = onlyKeys(['on', 'why']); if (e) return bad(e);
    if (typeof a.on !== 'boolean') return bad('on must be boolean');
    if (!why(a.why, false)) return bad('why must be a string <= 200');
    return { ok: true, verb, args: { on: a.on, ...opt() } };
  }
  if (name === 'sound_moment') { const e = oneOf('name', SOUND_MOMENTS); return e || { ok: true, verb, args: { name: a.name, ...opt() } }; }
  if (name === 'play') { const e = oneOf('sound', PLAY_SOUNDS); return e || { ok: true, verb, args: { sound: a.sound, ...opt() } }; }
  if (name === 'voice_mode') { const e = oneOf('mode', VOICE_MODES); return e || { ok: true, verb, args: { mode: a.mode, ...opt() } }; }
  if (name === 'when') {
    if ('cancel' in a) {
      const e = onlyKeys(['cancel', 'why']); if (e) return bad(e);
      if (a.cancel !== true) return bad('cancel must be true');
      return { ok: true, verb, args: { cancel: true } };
    }
    const e = onlyKeys(['if', 'then', 'ttl', 'why']); if (e) return bad(e);
    const conds = FLOW.events?.conditions || [];
    if (!conds.includes(a.if)) return bad(`unknown condition '${String(a.if).slice(0, 30)}'; one of ${conds.join(', ')}`);
    if (!Array.isArray(a.then) || a.then.length < 1 || a.then.length > WHEN.maxThen) return bad(`then needs 1-${WHEN.maxThen} tool calls`);
    const then = [];
    for (const c of a.then) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return bad('a then item must be {name, arguments}');
      for (const k of Object.keys(c)) if (k !== 'name' && k !== 'arguments') return bad(`unknown then key '${k.slice(0, 20)}'`);
      if (NEVER_IN_THEN.includes(c.name)) return bad(`refused: then holds ${String(c.name).slice(0, 30)}`);
      const v = validateToolCall(c.name, c.arguments ?? {}, registry);
      if (!v.ok) return bad(`then ${String(c.name).slice(0, 30)}: ${v.why}`);
      then.push({ name: c.name, arguments: typeof c.arguments === 'string' ? JSON.parse(c.arguments || '{}') : (c.arguments ?? {}) });
    }
    if (a.ttl != null && (!fin(a.ttl) || a.ttl < WHEN.ttl[0] || a.ttl > WHEN.ttl[1])) return bad(`ttl must be ${WHEN.ttl[0]}..${WHEN.ttl[1]} s`);
    if (!why(a.why, false)) return bad('why must be a string <= 200');
    return { ok: true, verb, args: { if: a.if, then, ttl: a.ttl ?? WHEN.ttlDefault } };
  }
  if (Object.hasOwn(VIZ_VERBS, name)) { const v = validateViz(name, a); return v.ok ? { ok: true, verb, args: v.args } : v; }
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
    ...newToolDefs(registry),
  ];
}


function newToolDefs(registry) {
  const why = { type: 'string', description: 'one short sentence: why now' };
  const named = new Set(Object.keys(TOOL_VERBS).filter((n) => !NEVER_IN_THEN.includes(n)));
  return [
    { type: 'function', name: 'stay_quiet', description: 'When the room nudges you and the moment wants stillness, hold back this once. The room keeps breathing; it does not reset the clock, so an act still comes soon.',
      parameters: { type: 'object', properties: { why }, required: ['why'] } },
    { type: 'function', name: 'beat', description: 'Let the beat come in (it then grows with their movement) or let it go.',
      parameters: { type: 'object', properties: { on: { type: 'boolean' }, why }, required: ['on'] } },
    { type: 'function', name: 'sound_moment', description: 'One sound gesture now: a swell (the whole sound lifts or settles) or a sweep (the filter opens and closes).',
      parameters: { type: 'object', properties: { name: { type: 'string', enum: [...SOUND_MOMENTS] }, why }, required: ['name'] } },
    { type: 'function', name: 'play', description: 'Play one short sound that answers something the person just did.',
      parameters: { type: 'object', properties: { sound: { type: 'string', enum: [...PLAY_SOUNDS] }, why }, required: ['sound'] } },
    { type: 'function', name: 'voice_mode', description: 'talk (the default) or sing: while they sing or chant, the room waits through longer pauses before it answers.',
      parameters: { type: 'object', properties: { mode: { type: 'string', enum: [...VOICE_MODES] }, why }, required: ['mode'] } },
    { type: 'function', name: 'when', description: 'Arm ONE reaction to the body: when the condition happens (within ttl seconds), run these tool calls. A new arm replaces the old one; {cancel:true} disarms. Never phase or ending tools.',
      parameters: { type: 'object', properties: {
        if: { type: 'string', enum: [...(FLOW.events?.conditions || [])] },
        then: { type: 'array', minItems: 1, maxItems: WHEN.maxThen, items: { type: 'object', properties: { name: { type: 'string', enum: [...named] }, arguments: { type: 'object' } }, required: ['name', 'arguments'] } },
        ttl: { type: 'number', minimum: WHEN.ttl[0], maximum: WHEN.ttl[1], description: `seconds, default ${WHEN.ttlDefault}` },
        cancel: { type: 'boolean', description: 'true: disarm (give nothing else)' }, why } } },
    { type: 'function', name: 'look', description: 'Take one look at the person now (one camera frame). Your reaction follows when it arrives.',
      parameters: { type: 'object', properties: { why }, required: ['why'] } },
    ...vizDefs(registry),
  ];
}


















const FAMILY = { map_create: 'sound', map_update: 'sound', map_remove: 'sound', undo: 'sound', sound_steer: 'sound', beat: 'sound', sound_moment: 'sound',
  play: 'sound', viz_switch: 'viz', viz_param: 'viz', viz_preset: 'viz', show_image: 'viz' };
export const BEAT_BINDING = 'groove→beat'; 

export function ackState(name, args = {}, { nextActDue = null, tag = '' } = {}) {
  if (name === 'switch_phase') return `phase change to ${args.name} queued`;
  if (name === 'end_session') return 'closing: one goodbye, then the call ends';
  if (name === 'stay_quiet') return Number.isFinite(nextActDue) ? `quiet held; next act due by t+${Math.max(0, Math.round(nextActDue))}` : 'quiet held; the room keeps breathing';
  if (name === 'look') return 'look requested; the receipt says what came of it'; 
  return `queued${tag ? ` (${tag})` : ''}; the receipt says what happened`;
}

export function createDispatcher(ctx = {}) {
  const c = { registry: STATIC_REGISTRY, phase: () => null, allowed: null, act: null, handlers: {}, lines: {}, receipt: () => {}, trace: () => {},
    landingS: FLOW.floor?.landingS, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h),
    schedule: (fn) => (typeof queueMicrotask === 'function' ? queueMicrotask(fn) : setTimeout(fn, 0)), ...ctx };
  const seen = new Set(), order = [];
  let gn = 0, wn = 0;
  const remember = (id) => { seen.add(id); order.push(id); if (order.length > 256) seen.delete(order.shift()); };
  const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
  const inPhase = (name, phase) => { const list = typeof c.allowed === 'function' ? safe(() => c.allowed(phase), null) : null; return !list || list.includes(name); };
  const lineFor = (name) => { const f = c.lines?.[FAMILY[name]]; return typeof f === 'function' ? safe(f, null) : null; };
  const recOut = (rec) => (rec?.ok
    ? { ok: true, state: rec.result?.state || null, ...(rec.result?.closing === true ? { closing: true } : {}) } 
    : { ok: false, why: String(rec?.result?.why || rec?.error || 'refused').slice(0, 200) });
  const errOut = (e) => ({ ok: false, why: String(e?.message || e).slice(0, 200) });
  function conductor(verb, args, why) { 
    if (typeof c.act !== 'function') return { ok: false, why: `no handler for '${verb}'` };
    const r = c.act(verb, args, why);
    return r && typeof r.then === 'function' ? r.then(recOut) : recOut(r); 
  }

  
  function route(v, call) {
    const h = c.handlers?.[v.verb];
    if (typeof h === 'function') return h(v.args, call);
    const why = v.args.why || `voice ${call.name}`;
    if (call.name === 'beat') return v.args.on ? conductor('binding.arm', { id: BEAT_BINDING, why }, why) : conductor('binding.retire', { id: BEAT_BINDING, why }, why);
    if (call.name === 'play') {
      const obs = typeof c.obs === 'function' ? safe(c.obs, null) : null;
      if (!obs) return { ok: false, why: 'nothing to answer: no body observation yet' };
      return conductor('body.oneshot', { what: v.args.sound, obs, why }, why);
    }
    return conductor(v.verb, v.args, v.args.why);
  }
  function finish(call, res) {
    const r = res && typeof res === 'object' ? res : { ok: res !== false };
    const ok = r.ok !== false, line = ok ? lineFor(call.name) : null;
    const state = ok ? String(line || r.state || 'done').slice(0, 300) : undefined;
    const closing = ok && r.closing === true ? { closing: true } : {}; 
    c.trace('tool.receipt', { callId: call.callId, name: call.name, ok, group: call.tag, ...closing });
    safe(() => c.receipt({ rid: call.rid, callId: call.callId, name: call.name, ok, ...(ok ? { state } : { why: String(r.why || 'refused').slice(0, 200) }), ...closing, group: call.tag }), null);
  }
  function work(call, v) {
    let res;
    try { res = route(v, call); } catch (e) { res = { ok: false, why: String(e?.message || e).slice(0, 200) }; }
    if (res && typeof res.then === 'function') res.then((r) => finish(call, r), (e) => finish(call, { ok: false, why: String(e?.message || e).slice(0, 200) }));
    else finish(call, res);
  }
  function release(held, landed) {
    for (const { call } of held) {
      if (!landed.ok) { finish(call, { ok: false, why: landed.timeout ? `held for the phase change, which did not answer within ${landed.timeout} s`
        : `held for the phase change, which was refused (${String(landed.why || 'refused').slice(0, 80)})` }); continue; }
      const v = validateToolCall(call.name, call.arguments, c.registry); 
      if (!v.ok) { finish(call, v); continue; }
      if (!inPhase(call.name, safe(c.phase, null))) { finish(call, { ok: false, why: `${call.name} is not offered in ${safe(c.phase, '?')}` }); continue; }
      work(call, v);
    }
  }
  
  
  function changePhase(call, v, held) {
    let p, settled = false, timer = null;
    const settle = (r) => {
      if (settled) { c.trace('tool.phaseLate', { callId: call.callId, to: v.args.name, ok: r?.ok !== false }); return; }
      settled = true; if (timer != null) safe(() => c.clearTimer(timer), null);
      const landed = r && typeof r === 'object' ? r : { ok: r !== false };
      finish(call, landed.ok !== false ? { ok: true, state: `phase ${v.args.name} landed` } : landed);
      release(held, { ok: landed.ok !== false, why: landed.why, timeout: landed.timeout });
    };
    try { p = typeof c.setPhase === 'function' ? c.setPhase(v.args.name, v.args.why) : conductor('phase.set', v.args, v.args.why); } catch (e) { p = errOut(e); }
    const s = Number(c.landingS);
    if (p && typeof p.then === 'function' && Number.isFinite(s) && s > 0) {
      timer = safe(() => c.setTimer(() => settle({ ok: false, timeout: s, why: `phase change to ${v.args.name}: no answer within ${s} s (it may still land; the next state says)` }), s * 1000), null);
    }
    Promise.resolve(p).then((r) => r, errOut).then(settle);
  }

  
  function dispatch(calls = [], { rid = null } = {}) {
    const fresh = [];
    for (const raw of Array.isArray(calls) ? calls : []) {
      const callId = String(raw?.call_id ?? raw?.callId ?? '').slice(0, 64);
      if (callId && seen.has(callId)) { c.trace('tool.dedupe', { callId }); continue; }
      if (callId) remember(callId);
      fresh.push({ callId, name: String(raw?.name ?? ''), arguments: raw?.arguments ?? '{}', rid });
    }
    if (!fresh.length) return [];
    const ranked = [...fresh.filter((x) => x.name === 'switch_phase'), ...fresh.filter((x) => x.name !== 'switch_phase')];
    const g = ++gn, run = ranked.slice(0, MAX_TOOL_CALLS), n = run.length, acks = [];
    for (const x of ranked.slice(MAX_TOOL_CALLS)) acks.push({ callId: x.callId, name: x.name, output: { ok: false, why: `cap: at most ${MAX_TOOL_CALLS} tool calls per response` } });
    const phaseNow = safe(c.phase, null), jobs = [], held = [];
    let arc = null; 
    run.forEach((call, i) => {
      call.tag = `g${g} ${i + 1}/${n}`;
      const v = validateToolCall(call.name, call.arguments, c.registry);
      if (!v.ok) { acks.push({ callId: call.callId, name: call.name, output: { ok: false, why: v.why } }); return; }
      
      if (arc && call.name === 'switch_phase') { acks.push({ callId: call.callId, name: call.name, output: { ok: false, why: `one phase change per response: already changing to ${arc.v.args.name}` } }); return; }
      if (arc) { held.push({ call, v }); acks.push({ callId: call.callId, name: call.name, output: { ok: true, id: call.callId, state: `held for the phase change; checked against the new phase (${call.tag})` } }); return; }
      if (!inPhase(call.name, phaseNow)) { acks.push({ callId: call.callId, name: call.name, output: { ok: false, why: `${call.name} is not offered in ${phaseNow}` } }); return; }
      
      if (call.name === 'look' && typeof c.presence === 'function' && !safe(c.presence, false)) { acks.push({ callId: call.callId, name: call.name, output: { ok: false, why: 'no one in view' } }); return; }
      if (call.name === 'switch_phase') arc = { call, v };
      const nextActDue = call.name === 'stay_quiet' && typeof c.nextActDue === 'function' ? safe(c.nextActDue, null) : null;
      acks.push({ callId: call.callId, name: call.name, output: { ok: true, id: call.callId, state: ackState(call.name, v.args, { nextActDue, tag: call.tag }) } });
      if (call !== arc?.call) jobs.push(() => work(call, v));
    });
    if (arc) jobs.unshift(() => changePhase(arc.call, arc.v, held));
    if (jobs.length) c.schedule(() => { for (const j of jobs) j(); }); 
    c.trace('tool.group', { g, rid, n, held: held.length });
    return acks;
  }
  
  
  function runThen(then = []) {
    const calls = (Array.isArray(then) ? then : []).filter((t) => !NEVER_IN_THEN.includes(t?.name)).slice(0, WHEN.maxThen)
      .map((t) => ({ call_id: `w${++wn}`, name: t.name, arguments: t.arguments ?? {} }));
    dispatch(calls, { rid: null });
    return calls.map((x) => ({ callId: x.call_id, name: x.name }));
  }
  return { dispatch, runThen, stats: () => ({ groups: gn, seen: seen.size }) };
}
