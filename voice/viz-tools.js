





















import { FLOW } from './flow.js';

export const VIZ_LAYERS = Object.freeze(['aura', 'dream']);
export const VIZ_KEYS = Object.freeze(['warmth', 'zoom', 'swirl', 'warp', 'pulse', 'halo', 'gain', 'trails']);
export const DREAM_KEYS = Object.freeze(['dream', 'departure']); 

export const BIAS_PARAM = Object.freeze({ warmth: 'warmth', zoom: 'zoom', swirl: 'swirl', warp: 'warp', pulse: 'pulseAmp', halo: 'haloR', gain: 'gain', trails: 'tau' });
const BIAS_CODE = Object.freeze({ warmth: 'w', zoom: 'z', swirl: 's', warp: 'r', pulse: 'p', halo: 'h', gain: 'g', trails: 't', dream: 'D', departure: 'd' });
export const VIZ_VERBS = Object.freeze({ viz_switch: 'viz.switch', viz_param: 'viz.param', viz_preset: 'viz.preset' });


export const TAIL_LIMITS = Object.freeze({ warmth: [0, 1], zoom: [0, 0.32], swirl: [-1.2, 1.2], haloR: [0.06, 0.45] });
export const MAX_LINE_WORDS = 30; 

const VIZ = () => FLOW.viz || {};
export const presetNames = () => Object.keys(VIZ().presets || {});
const bad = (why) => ({ ok: false, why });
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => (fin(v) ? Math.max(0, Math.min(1, v)) : 0);
const r2 = (v) => Math.round(v * 100) / 100;
const dec = (v) => { const s = (Math.round(clamp01(v) * 10) / 10).toFixed(1); return s === '1.0' ? '1' : s.replace(/^0/, ''); }; 
const cut = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, n);
const okWhy = (v) => v == null || (typeof v === 'string' && v.trim() && v.length <= 200);


export function vizDefs() {
  return [
    { type: 'function', name: 'viz_switch', description: 'Switch the renderer: aura (light that follows the body) or dream (generated imagery over it, only when mounted).',
      parameters: { type: 'object', properties: { name: { type: 'string', enum: [...VIZ_LAYERS] }, why: { type: 'string' } }, required: ['name'] } },
    { type: 'function', name: 'viz_param', description: 'Nudge one quality of the light, 0..1. It is a bias: the body still drives the image. Read the viz line for what is really on screen.',
      parameters: { type: 'object', properties: { key: { type: 'string', enum: [...VIZ_KEYS, ...DREAM_KEYS] }, value: { type: 'number', minimum: 0, maximum: 1 }, why: { type: 'string' } }, required: ['key', 'value'] } },
    { type: 'function', name: 'viz_preset', description: 'Set the whole look of the light at once from a named preset.',
      parameters: { type: 'object', properties: { name: { type: 'string', enum: presetNames() }, why: { type: 'string' } }, required: ['name'] } },
  ];
}


export function validateViz(name, a) {
  const only = (keys) => { for (const k of Object.keys(a)) if (!keys.includes(k)) return `unknown field '${k.slice(0, 20)}'`; return null; };
  const why = (e) => (e ? bad(e) : okWhy(a.why) ? null : bad('why must be a string <= 200'));
  const w = a.why ? { why: a.why } : {};
  if (name === 'viz_switch') {
    const e = why(only(['name', 'why'])); if (e) return e;
    if (!VIZ_LAYERS.includes(a.name)) return bad(`unknown layer '${cut(a.name, 30)}'; one of ${VIZ_LAYERS.join(', ')}`);
    return { ok: true, args: { name: a.name, ...w } };
  }
  if (name === 'viz_param') {
    const e = why(only(['key', 'value', 'why'])); if (e) return e;
    if (![...VIZ_KEYS, ...DREAM_KEYS].includes(a.key)) return bad(`unknown key '${cut(a.key, 30)}'; one of ${[...VIZ_KEYS, ...DREAM_KEYS].join(', ')}`);
    if (!fin(a.value) || a.value < 0 || a.value > 1) return bad('value must be 0..1');
    return { ok: true, args: { key: a.key, value: a.value, ...w } };
  }
  if (name === 'viz_preset') {
    const e = why(only(['name', 'why'])); if (e) return e;
    if (!presetNames().includes(a.name)) return bad(`unknown preset '${cut(a.name, 30)}'; one of ${presetNames().join(', ')}`);
    return { ok: true, args: { name: a.name, ...w } };
  }
  return bad(`'${cut(name, 40)}' is not a visual tool`);
}


export const createVizState = () => ({ layer: 'aura', preset: null, bias: {}, rendering: null, renderingWhy: null, prompt: null, requestedAt: null, submitSeq: -1, shown: null });


export function applyViz(viz, name, args, { dreamMounted = false } = {}) {
  const v = { ...createVizState(), ...(viz || {}) };
  if (name === 'viz_switch') {
    if (args.name === 'dream' && !dreamMounted) return bad('dream not mounted');
    return { ok: true, viz: { ...v, layer: args.name } };
  }
  if (name === 'viz_param') {
    if (DREAM_KEYS.includes(args.key) && !dreamMounted) return bad('dream not mounted');
    return { ok: true, viz: { ...v, bias: { ...v.bias, [args.key]: r2(clamp01(args.value)) } } };
  }
  if (name === 'viz_preset') {
    const p = (VIZ().presets || {})[args.name];
    if (!p) return bad(`unknown preset '${cut(args.name, 30)}'`);
    const bias = Object.fromEntries(Object.entries(p).filter(([k]) => dreamMounted || !DREAM_KEYS.includes(k)).map(([k, x]) => [k, r2(clamp01(x))]));
    return { ok: true, viz: { ...v, preset: args.name, bias } };
  }
  return bad(`'${cut(name, 40)}' is not a visual tool`);
}

export const requestImage = (viz, subject, { now = 0, seq = -1 } = {}) => ({ ...createVizState(), ...(viz || {}), prompt: cut(subject, 80), requestedAt: now, submitSeq: fin(seq) ? seq : -1 });
export function observeFrame(viz, frame) {
  if (!viz?.prompt || viz.prompt === viz.shown || !frame?.fresh || !fin(frame.seq) || frame.seq < 0 || frame.seq <= viz.submitSeq) return viz;
  return { ...viz, shown: viz.prompt };
}
export const showImageState = (subject, { mounted = false } = {}) => (mounted
  ? `requested '${cut(subject, 80)}': submitted to the generator; the viz line says when it shows`
  : `requested '${cut(subject, 80)}', NOT rendered: no image layer`);



export function relationClause({ g = 0, d = 0, here = false, prompt = null } = {}, bands = VIZ().relation || []) {
  const hit = bands.find(({ if: c = {} }) => (c.here == null || c.here === !!here) && (c.gLt == null || g < c.gLt) && (c.gGte == null || g >= c.gGte)
    && (c.dLt == null || d < c.dLt) && (c.dGte == null || d >= c.dGte));
  const says = hit?.says ?? '';
  return prompt ? says.replaceAll('<prompt>', cut(prompt, 40)) : says.replace(/<prompt>(-like)?\s*/g, '');
}

export function renderingOf(stats, viz) {
  if (!stats) return { yes: false, why: 'renderer not mounted' };
  if (stats.kind === 'none') return { yes: false, why: 'no canvas context' };
  if (viz?.rendering === false) return { yes: false, why: cut(viz.renderingWhy || 'renderer off', 40) };
  if (!(stats.frames > 0)) return { yes: false, why: 'no frame drawn yet' };
  return { yes: true, why: null };
}

const DRIVER_WORD = { lean: 'lean', twist: 'twist', energy: 'movement', groove: 'groove', stir: 'voice', still: 'breath', breath: 'breath', smile: 'smile', jaw: 'jaw', swellN: 'the swell', cutN: 'the filter', beat: 'the beat', pan: 'the pan' };
function follows(stats) {
  const p = stats?.params;
  if (Array.isArray(stats?.driving) && stats.driving.length) { 
    const names = stats.driving.slice(0, 2).map((n) => DRIVER_WORD[n] || cut(n, 16));
    return { where: 'follows your torso', by: `driven now by ${names.join(' and ')}` };
  }
  if (!p) return { where: 'follows nothing yet', by: '' };
  const by = []; 
  if (fin(p.stir) && p.stir > 0.35) by.push('voice');
  by.push(fin(p.still) && p.still > 0.6 ? 'breath' : 'movement');
  return { where: fin(p.wake) && p.wake > 0.2 ? 'follows your torso' : 'resting, nobody held', by: `driven now by ${by.join(' and ')}` };
}
function tail(stats) {
  const p = stats?.params; if (!p) return '';
  const n = (k, v) => { const [lo, hi] = TAIL_LIMITS[k]; return (v - lo) / (hi - lo); };
  const t = [['w', 'warmth', p.warmth], ['z', 'zoom', p.zoom], ['s', 'swirl', p.swirl], ['h', 'haloR', p.haloR]].filter(([, , v]) => fin(v))
    .map(([c, k, v]) => `${c}${dec(k === 'swirl' ? Math.abs(v) / TAIL_LIMITS.swirl[1] : n(k, v))}`); 
  return t.length ? `~${t.join(' ')}` : '';
}
const words = (s) => s.split(/\s+/).filter((w) => w && w !== '·').length;



export function vizLine({ stats = null, viz = null, dream = null, here = false, now = 0, speech = false, staleMs = VIZ().staleMs ?? 2000 } = {}) {
  const v = { ...createVizState(), ...(viz || {}) };
  const r = renderingOf(stats, v);
  if (!r.yes) return `rendering: no (${r.why}) · nothing drawn · layer ${v.layer}`;
  const frame = dream?.frame ?? null;
  const live = v.layer === 'dream' && !!dream?.mounted && !!frame && fin(frame.seq) && frame.seq >= 0;
  const g = live ? clamp01(dream.g) : 0, d = live ? clamp01(dream.d) : 0;
  const clause = relationClause({ g, d, here, prompt: v.shown });
  const what = v.prompt && v.prompt !== v.shown
    ? `requested '${cut(v.prompt, 40)}' ${Math.max(0, Math.round(now - (v.requestedAt ?? now)))} s ago, still showing: ${clause}` : clause;
  const stalled = live && fin(frame.age_ms) && frame.age_ms > staleMs ? 'generator stalled' : null;
  const f = here ? follows(stats) : null;
  const biasKeys = Object.keys(v.bias || {});
  const bias = biasKeys.length ? `bias ${biasKeys.map((k) => `${BIAS_CODE[k] || k}${dec(v.bias[k])}`).join(' ')}${stats.bias ? '' : ' unapplied'}` : null;
  const layer = `layer ${v.layer}${v.preset ? `, preset ${v.preset}` : ''}`;
  const speechPart = `speech-reactive: ${speech ? 'yes' : 'no'}`;
  
  const build = (o) => ['rendering: yes', what, stalled, f && (o.by && f.by ? `${f.where}, ${f.by}` : f.where), layer, o.bias && bias, o.speech && speechPart].filter(Boolean).join(' · ');
  let line = build({ speech: true, by: true, bias: true });
  for (const o of [{ speech: false, by: true, bias: true }, { speech: false, by: false, bias: true }, { speech: false, by: false, bias: false }]) { if (words(line) <= MAX_LINE_WORDS) break; line = build(o); }
  const t = tail(stats);
  return t ? `${line} · ${t}` : line;
}


const band = (x) => (x < 0.34 ? 'low' : x < 0.67 ? 'mid' : 'high');
const srcWord = (s) => { const id = typeof s === 'string' ? s : Array.isArray(s) ? s[0]?.s : ''; const [g, k] = String(id || '?').split('.'); return g === 'A' || g === 'B' ? 'hands' : g === 'face' ? 'face' : (k || g); };


export function soundLine({ snapshot = null, mappings = [], steer = null, swell = null, now = 0 } = {}) {
  if (!snapshot) return 'sound: not running';
  const at = snapshot.anchor?.name ?? 'between anchors';
  const steering = steer && steer.to && fin(steer.endsAt) && steer.endsAt > now;
  const parts = [`at ${at}${steering && steer.to !== at ? `, drifting toward ${cut(steer.to, 20)}` : ''}`, `beat ${snapshot.beatOn ? 'on' : 'off'}`];
  if (fin(swell)) parts.push(`swell ${band(swell)}`);
  const armed = (mappings || []).filter((m) => m && m.kind === 'binding' && m.state === 'armed').slice(0, 3).map((m) => `${srcWord(m.src)}→${cut(m.target, 16)}`);
  parts.push(`live: ${armed.length ? armed.join(', ') : 'none'}`);
  if (steering) parts.push(`steer ${Math.ceil(steer.endsAt - now)} s left`);
  return parts.join(' · ');
}




export function createVizTools({ bus, aura = null, dream = null, presence = () => false, speech = () => false, clock = () => (bus?.state?.runT ?? 0) } = {}) {
  const st = () => { if (!bus.state.viz) bus.state.viz = createVizState(); return bus.state.viz; };
  const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
  const dreamNow = () => (dream ? { mounted: dream.mounted !== false, g: safe(() => dream.g?.(), 0), d: safe(() => dream.d?.(), 0), frame: safe(() => dream.frame?.(), null) } : null);
  const line = () => vizLine({ stats: safe(() => aura?.stats?.() ?? null, null), viz: st(), dream: dreamNow(), here: !!safe(presence, false), now: clock(), speech: !!safe(speech, false) });
  const mounted = () => !!dream && dream.mounted !== false;
  function run(name, args = {}) {
    if (name === 'show_image') {
      const f = dreamNow()?.frame;
      bus.state.viz = requestImage(st(), args.subject, { now: clock(), seq: f?.seq ?? -1 });
      if (mounted()) safe(() => dream.submit?.(args.subject), null);
      return { ok: true, state: `${showImageState(args.subject, { mounted: mounted() })} · ${line()}` };
    }
    const r = renderingOf(safe(() => aura?.stats?.() ?? null, null), st());
    if (!r.yes) return bad(`rendering: no (${r.why})`);
    const a = applyViz(st(), name, args, { dreamMounted: mounted() });
    if (!a.ok) return a;
    bus.state.viz = a.viz;
    return { ok: true, state: line() };
  }
  
  const tick = () => { const f = dreamNow()?.frame; const n = observeFrame(st(), f); if (n !== st()) bus.state.viz = n; return line(); };
  const handlers = () => ({ 'viz.switch': (a) => run('viz_switch', a), 'viz.param': (a) => run('viz_param', a), 'viz.preset': (a) => run('viz_preset', a), 'image.show': (a) => run('show_image', a) });
  return { run, line, tick, handlers };
}
