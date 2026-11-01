














import { FLOW } from './flow.js';

const ROOM_VERBS = /^(map\.|binding\.|undo$|stimulus$|phase\.set$)/; 


const cut = (t, n) => (t.length <= n ? t : t.slice(0, /[\ud800-\udbff]/.test(t[n - 1]) ? n - 1 : n));
const short = (v) => cut(String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' '), 48);


const plain = (v) => short(String(v ?? '').replace(/[|,+]/g, ' ')).trim();
const SEP = ' | '; 
const own = (o, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined); 
const SCREEN_VERBS = /^(viz\.|image\.show$)/; 
const LAYER_VERBS = /^(viz\.switch|image\.show)$/; 
const fin = (v) => typeof v === 'number' && Number.isFinite(v);



function band(v, p, prev, hys = 0) {
  if (!fin(v) || !Array.isArray(p?.words) || !p.words.length) return null;
  const [lo, hi] = p.range || [0, 1], x = p.abs ? Math.abs(v) : v, n = p.words.length;
  const f = ((x - lo) / ((hi - lo) || 1)) * n;
  let k = Math.min(n - 1, Math.max(0, Math.floor(f)));
  if (Number.isInteger(prev) && prev >= 0 && prev < n && k !== prev && fin(hys) && hys > 0 && (k > prev ? f < prev + 1 + hys : f > prev - hys)) k = prev;
  return { k, word: p.words[k] };
}








const idKey = (id) => `${typeof id}:${String(id)}`;




const posFin = (v) => fin(v) && v > 0;
export function dwellOf(sd, base = FLOW.scene.screen) {
  const max = posFin(sd?.dwellMaxS) ? sd.dwellMaxS : base.dwellMaxS;
  const d = posFin(sd?.dwellS) ? sd.dwellS : posFin(sd?.dwellDefaultS) ? sd.dwellDefaultS : base.dwellDefaultS;
  return Math.min(d, max);
}
export function steady(render, memo, now, dwellS, params = null, adopt = false) {
  if (!memo) return render;
  if (!render || typeof render !== 'object' || !Array.isArray(render.layers)) { memo.ids = null; return render; }
  const raw = render.layers, rp = render.params, keys = params && typeof params === 'object' ? Object.keys(params) : [];
  const val = (k) => (rp && typeof rp === 'object' ? rp[k] : undefined);
  if (!memo.ids || adopt || !(fin(dwellS) && dwellS > 0)) { 
    const ids = new Map(), byKey = new Map(), order = [], fins = {}; 
    for (const id of raw) { const k = idKey(id); order.push(k); ids.set(k, { said: true, raw: true, since: now }); byKey.set(k, id); }
    for (const k of keys) { const v = val(k), f = fin(v); fins[k] = { said: f, raw: f, since: now, last: f ? v : undefined }; }
    Object.assign(memo, { ids, byKey, order, fin: fins });
    return render;
  }
  const seen = new Map(raw.map((id) => [idKey(id), id]));
  for (const [k, id] of seen) { memo.byKey.set(k, id); if (!memo.ids.has(k)) memo.ids.set(k, { said: false, raw: true, since: now }); }
  const move = (e, r) => { if (e.raw !== r) { e.raw = r; e.since = now; } if (e.said !== e.raw && now - e.since >= dwellS) e.said = e.raw; };
  for (const [k, e] of memo.ids) move(e, seen.has(k));
  for (const k of keys) {
    const v = val(k), f = fin(v), e = memo.fin[k] || (memo.fin[k] = { said: f, raw: f, since: now, last: undefined });
    if (f) e.last = v; move(e, f);
  }
  
  const layers = raw.filter((id) => memo.ids.get(idKey(id)).said);
  memo.order.forEach((k, i) => { if (!seen.has(k) && memo.ids.get(k)?.said) layers.splice(Math.min(i, layers.length), 0, memo.byKey.get(k)); });
  for (const [k, e] of memo.ids) if (!e.said && !e.raw) { memo.ids.delete(k); memo.byKey.delete(k); }
  memo.order = layers.map(idKey);
  let p = rp, held = false;
  for (const k of keys) {
    const e = memo.fin[k], f = fin(val(k));
    if (e.said === f) continue;
    if (!held) { p = rp && typeof rp === 'object' ? { ...rp } : {}; held = true; }
    p[k] = e.said ? e.last : NaN;
  }
  const same = layers.length === raw.length && layers.every((id, i) => id === raw[i]);
  return same && !held ? render : { ...render, layers, params: p };
}







export function screenLine(render, viz, def = FLOW.scene.screen, max = def?.maxChars ?? Infinity, memo = null) {
  if (!def || !render || !Array.isArray(render.layers)) return '';
  const name = viz?.preset ? plain(viz.preset) : '';
  const preset = name && def.preset ? `${def.preset.replace('<name>', () => name)}${render.applied ? '' : def.unapplied || ''}` : null;
  const words = {}, params = render.params; 
  const word = (k) => {
    if (!Object.hasOwn(words, k)) {
      const b = band(params?.[k], own(def.params, k), memo ? memo[k] : undefined, def.hysteresis);
      words[k] = b ? b.word : null;
      if (memo) { if (b) memo[k] = b.k; else delete memo[k]; }
    }
    return words[k];
  };
  const says = (id, withBands) => {
    const row = typeof id === 'string' ? own(def.layers, id) : undefined;
    if (!row || typeof row.says !== 'string') return plain(id) || def.unnamed || 'unnamed layer'; 
    const bands = withBands && Array.isArray(row.params) ? row.params.map(word).filter(Boolean) : [];
    return bands.length ? `${row.says} (${bands.join(', ')})` : row.says;
  };
  if (memo) for (const id of render.layers) { const row = typeof id === 'string' ? own(def.layers, id) : undefined; if (Array.isArray(row?.params)) row.params.forEach(word); }
  const n = render.layers.length, caption = def.caption?.[render.caption ? 'on' : 'off'];
  const build = (o) => {
    const drawn = render.layers.slice(0, o.keep).map((id) => says(id, o.params));
    if (o.keep < n && def.more) drawn.push(def.more);
    const parts = [n ? drawn.join(def.join || ', ') : def.nothing, o.preset && preset, o.paused && render.paused && def.paused, caption];
    return `${def.label}: ${parts.filter(Boolean).join(', ')}`;
  };
  const o = { params: true, preset: true, keep: n, paused: true };
  let line = build(o);
  for (const what of Array.isArray(def.drop) ? def.drop : []) {
    if (line.length <= max) return line;
    if (what === 'layers') for (o.keep = n - 1; o.keep >= 1 && (line = build(o)).length > max; o.keep--);
    else if (Object.hasOwn(o, what)) o[what] = false;
    line = build(o);
  }
  if (line.length <= max) return line;
  o.keep = 0; line = build(o);
  return line.length <= max ? line : ''; 
}

export class SceneFeed {
  
  constructor({ bus, send, now = () => Date.now() / 1000, def = FLOW.scene, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { bus, send, now, def, setTimer, clearTimer, open: new Map(), recentActs: [], last: '', lastT: -Infinity, timer: null, offs: [] });
    if (!bus?.on) return;
    this.offs.push(bus.on('obs.open', (o) => { if (o?.id && o.kind !== 'gone') this.open.set(o.ch, o); else if (o?.kind === 'gone') this.open.delete(o.ch); this.poke(); }));
    this.offs.push(bus.on('obs.close', (o) => { if (o?.ch && this.open.get(o.ch)?.id === o.id) this.open.delete(o.ch); this.poke(); }));
    for (const ev of ['act', 'edit']) this.offs.push(bus.on(ev, (r) => this.#act(r)));
    this.offs.push(bus.on('phase', () => this.poke()));
    
    
    
    this.bands = {}; 
    this.held = {}; 
    this.lastScreen = this.#screen();
    for (const ev of ['say', 'pause']) this.offs.push(bus.on(ev, () => this.#check()));
    this.lastCheck = -Infinity;
    this.offs.push(bus.on('frame', () => { const t = this.now(); this.#observe(); if (t - this.lastCheck >= (this.def.screen?.checkS ?? Infinity)) { this.lastCheck = t; this.#check(); } }));
  }
  
  #screen(adopt = false) {
    try {
      const s = this.bus?.state || {}, d = this.def;
      return screenLine(this.#held(s.screen, adopt), s.viz, d.screen, Math.min(d.screen?.maxChars ?? Infinity, (d.maxChars ?? Infinity) - SEP.length), this.bands);
    } catch { return ''; }
  }
  
  #held(render, adopt = false) { const sd = this.def.screen; return steady(render, this.held, this.now(), dwellOf(sd), sd?.params, adopt); }
  
  
  #observe() { try { this.#held(this.bus?.state?.screen); } catch {   } }
  #check(adopt = false) { const sc = this.#screen(adopt); if (sc === this.lastScreen) return; this.lastScreen = sc; this.poke(); }
  #act(r) {
    if (r?.verb && SCREEN_VERBS.test(r.verb)) { this.#check(r.ok === true && LAYER_VERBS.test(r.verb)); return; } 
    if (!r?.verb || !ROOM_VERBS.test(r.verb) || r.ok === false) return;
    const a = r.args || {};
    const what = r.verb === 'phase.set' ? `phase -> ${short(a.name)}` : `${r.verb} ${short(a.id ?? a.what ?? a.target ?? '')}`.trim();
    this.recentActs.push(what); if (this.recentActs.length > 3) this.recentActs.shift();
    this.poke();
  }
  text() {
    const s = this.bus?.state || {}, d = this.def;
    const seen = [...this.open.values()].slice(-d.maxItems).map((o) => `${o.id} ${short(o.label || o.ch)}${o.kind === 'seen' ? ' (present)' : ''}`);
    const rd = s.readiness;
    const screen = this.lastScreen = this.#screen(); 
    const tail = screen ? `${SEP}${screen}` : '', room = Math.max(0, d.maxChars - tail.length);
    
    
    
    const line = (k, a) => [
      `phase ${s.phase?.name ?? '?'}`,
      seen.length ? `now: ${[...(k < seen.length ? [d.more ?? 'more'] : []), ...seen.slice(seen.length - k)].join(', ')}` : 'now: nothing moving',
      a && `room just: ${this.recentActs.slice(-a).join('; ')}`,
      rd && `readouts: ${Math.round(rd.inPhase)} s in phase, ${rd.arms} arms, ${rd.turns} turns, still ${Math.round(rd.stillFor)} s, opening cues ${rd.cuesDone ? 'done' : 'running'}`,
    ].filter(Boolean).join(SEP);
    let k = seen.length, a = this.recentActs.length, rest = line(k, a);
    if (!tail) return rest.slice(0, d.maxChars); 
    while (rest.length > room && k > 0) rest = line(--k, a);
    while (rest.length > room && a > 0) rest = line(k, --a);
    return `${rest.slice(0, room)}${tail}`; 
  }
  poke() {
    if (this.timer) return; 
    const wait = Math.max(0, this.lastT + this.def.minGapS - this.now());
    this.timer = this.setTimer(() => this.flush(), wait * 1000);
  }
  flush() {
    this.timer = null;
    const t = this.text();
    if (t === this.last) return false;
    this.last = t; this.lastT = this.now(); this.send(t);
    return true;
  }
  stop() { if (this.timer) this.clearTimer(this.timer); this.timer = null; for (const off of this.offs) off?.(); this.offs = []; }
}
