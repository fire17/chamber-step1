



















import { CONDUCTOR, DJ, PHASES, PHASE_EDGES, FIRST_PHASE, CUES, PROBES, srcNames } from './mappings.js';
import { curveProbe } from './curves.js';
import { MappingLayer, AGENT_MAP_CAP, TRUSTED } from './layer.js';

export function pearson(xs, ys) {
  const n = xs.length; if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}



export function agencyProbe(samples, d, cfg = PROBES.agency) {
  const n = samples.length;
  if (n < cfg.minSamples) return { pass: false, n, why: `${n}/${cfg.minSamples} samples` };
  const cp = curveProbe(d.curve);
  const xs = samples.map((s) => s.v), ys = samples.map((s) => (cp.log ? Math.log(Math.max(1e-6, s.y)) : s.y));
  const sign = (Math.sign(d.range[1] - d.range[0]) || 1) * cp.sign, r = pearson(xs, ys) * sign;
  const span = Math.max(...xs) - Math.min(...xs);
  const pass = r >= cfg.minR && span >= cfg.minSpan;
  return { pass, n, r: +r.toFixed(3), span: +span.toFixed(3), why: pass ? 'source and param move together, right direction' : r <= -cfg.minR ? 'WRONG DIRECTION' : span < cfg.minSpan ? 'not enough travel' : 'weak correlation' };
}






export const ONESHOT = { cooldown: 4, each: 8, maxAge: 3, ring: 40, args: { level: { range: [0, 1] }, midi: { range: [60, 96], int: true } } };
const SHOT_NAME = /^[a-z][a-z0-9_-]{0,31}$/; 
const r3 = (v) => (typeof v === 'number' ? +v.toFixed(3) : v);
const groupOf = (src) => srcNames(src)[0]?.split('.')[0];

export class Conductor {
  
  
  constructor({ bus, bindings, story, layer = null, sensors = {}, def = { CONDUCTOR, DJ, PHASES, FIRST_PHASE, CUES, PROBES } }) {
    Object.assign(this, { bus, bindings, story, sensors, def });
    this.layer = layer || new MappingLayer({ bindings });
    this.mapCount = {}; 
    this.verbs = {}; this.policies = {}; this.gates = {}; 
    this.cues = JSON.parse(JSON.stringify(def.CUES)); 
    this.registerCore();
    for (const ev of def.CONDUCTOR.wakeOn) bus.on(ev, (d) => this.#wake(ev, d));
    this.reset();
  }
  reset() {
    this.t = 0; this.run = 0; this.n = 0; this.due = {}; this.firm = {}; this.nextTurn = 0; this.woke = [];
    this.ahead = []; this.expects = {}; this.traces = this.traces || []; this.lastMoveT = null; this.mapCount = {};
    this.bus.state.phase = null; this.bus.state.cue = null; this.bus.state.claims = {}; this.bus.state.off = {};
    this.bus.state.oneshots = []; this.shotT = new Map(); this.shotObs = new Map(); 
    
    for (const g of Object.values(this.gates || {})) if (!g.done && g.spokenAt != null) Object.assign(g, { spokenAt: 0, quietSince: null });
    this.#setPhase(this.def.FIRST_PHASE, 'boot', 'first phase');
  }
  register(name, fn) { this.verbs[name] = fn; }
  policy(name, p) { this.policies[name] = p; }
  edges(from = this.bus.state.phase?.name) { return (this.def.PHASE_EDGES ?? PHASE_EDGES)[from] || []; } 
  get phaseDef() { return this.def.PHASES[this.bus.state.phase?.name] || {}; }
  cfg(name) { return { ...this.def[name.toUpperCase()], ...(this.phaseDef[name] || {}) }; }

  
  
  step(dt, dReal = dt) {
    this.t += dt; this.run += dReal;
    this.bus.state.t = this.t; this.bus.state.runT = this.run;
    if ((this.bus.state.sense?.energy ?? 0) >= (this.def.DJ ?? DJ).stillBelow) this.lastMoveT = this.t; 
    while (this.ahead.length && this.ahead[0].due <= this.t) { const a = this.ahead.shift(); a.trace.fired.push(this.#exec(a.act, a.by, a.t0)); }
    this.#probe(); this.#gatesQuiet();
    const debounced = this.woke.length && this.t - (this.lastTurn ?? -1e9) >= this.def.CONDUCTOR.wakeDebounce;
    if (this.t >= this.nextTurn || debounced) this.turn();
  }
  #wake(ev, d) {
    const tag = ev === 'obs.open' ? `${ev} ${d.id} ${d.ch}` : ev === 'probe' ? `${ev} ${d.id} ${d.state}` : ev;
    let any = false;
    for (const p of this.#enabled()) if ((this.policies[p]?.wakeOn || []).includes(ev) && !this.firm[p] && (this.due[p] ?? 0) > this.t) { this.due[p] = this.t; any = true; }
    if (any || ev === 'edit') this.woke.push(tag);
  }
  #enabled() { return (this.phaseDef.policies || []).filter((p) => !this.bus.state.off[p]); }

  
  turn() {
    const s = this.bus.state, trace = {
      n: ++this.n, t: r3(this.t), phase: s.phase.name, woke: this.woke.length ? this.woke.slice(0, 4) : ['timer'],
      sense: { energy: r3(s.sense.energy), groove: r3(s.sense.groove), armed: this.bindings.armed().map((d) => d.id), open: this.story.snapshot().open.map((o) => `${o.id}:${o.ch}`) },
      sound: this.sensors.sound?.() ?? null, 
      policies: [], acts: [], fired: [], wait: 0,
    };
    this.woke = []; this.lastTurn = this.t; this.mapCount = {}; this.phaseTurns = (this.phaseTurns || 0) + 1;
    for (const name of this.#enabled()) {
      if ((this.due[name] ?? 0) > this.t) { trace.policies.push({ name, why: `waiting ${r3(this.due[name] - this.t)} s` }); continue; }
      const p = this.policies[name];
      let out = null;
      try { out = p ? p.fn.call(this, this.#view()) : { why: `no such policy '${name}'`, wait: this.def.CONDUCTOR.waitMax }; }
      catch (e) { out = { why: `policy error: ${e.message}`, wait: this.def.CONDUCTOR.waitMax, error: true }; }
      out ||= { why: 'nothing to do', wait: this.def.CONDUCTOR.waitMax };
      const wait = Math.min(this.def.CONDUCTOR.waitMax, Math.max(this.def.CONDUCTOR.waitMin, out.wait ?? this.def.CONDUCTOR.waitMax));
      this.due[name] = this.t + wait; this.firm[name] = !!out.firm;
      trace.policies.push({ name, why: out.why, wait: r3(wait), ...(out.firm ? { firm: true } : {}), ...(out.error ? { error: true } : {}) });
      for (const act of out.acts || []) {
        if (act.at > 0) { this.#schedule(act, name, trace); trace.acts.push({ ...act, by: name, scheduled: r3(this.t + act.at) }); }
        else trace.acts.push(this.#exec(act, name));
      }
      if (s.phase.name !== trace.phase) break; 
    }
    const dues = this.#enabled().map((p) => this.due[p] ?? this.t);
    trace.wait = r3(Math.min(this.def.CONDUCTOR.waitMax, Math.max(this.def.CONDUCTOR.waitMin, (dues.length ? Math.min(...dues) : this.t + this.def.CONDUCTOR.waitMax) - this.t)));
    this.nextTurn = this.t + trace.wait;
    this.#trace(trace);
    return trace;
  }
  #schedule(act, by, trace) {
    this.ahead.push({ due: this.t + act.at, act: { ...act, at: 0 }, by, trace, t0: this.t });
    this.ahead.sort((a, b) => a.due - b.due);
  }
  #trace(tr) { this.traces.push(tr); if (this.traces.length > this.def.CONDUCTOR.traceRing) this.traces.splice(0, this.traces.length - this.def.CONDUCTOR.traceRing); this.bus.emit('trace', tr); }

  
  #exec(act, by, _t0, extra = {}) {
    const rec = { verb: act.verb, args: act.args || {}, by, t: r3(this.t) };
    if (act.why) rec.why = act.why;
    const fn = Object.hasOwn(this.verbs, act.verb) ? this.verbs[act.verb] : null; 
    try {
      if (!fn) throw new Error(`unknown verb '${act.verb}'`);
      const mapVerb = act.verb.startsWith('map.') || act.verb === 'undo' || /^binding\.(add|rebind|remove)$/.test(act.verb);
      if (mapVerb && !extra.undoing && !TRUSTED.includes(by) && by !== 'cues') {
        const n = this.mapCount[by] || 0;
        if (n >= AGENT_MAP_CAP) { rec.result = { ok: false, why: `cap: ${AGENT_MAP_CAP} map.* verbs per turn for '${by}' (wait for the next turn)` }; rec.ok = false; this.bus.emit('act', rec); return rec; }
        this.mapCount[by] = n + 1;
      }
      rec.result = fn.call(this, act.args || {}, { by, t: this.t, ...(act.why ? { why: act.why } : {}), ...extra }) ?? { ok: true };
      rec.ok = rec.result.ok !== false;
    } catch (e) { rec.ok = false; rec.error = e.message; }
    const claim = act.args?.claim;
    if (claim && rec.ok) {
      this.bus.claim(claim, { state: 'pending', verb: act.verb, args: act.args, firedRun: this.run, firedT: this.t, evidence: null });
      const ex = this.expects[claim]; if (ex) { ex.samples = []; ex.peak = 0; ex.onsetObs = null; }
    }
    this.bus.emit('act', rec);
    return rec;
  }
  
  act(act, by = 'dev') {
    const rec = this.#exec(act, by);
    this.#trace({ n: ++this.n, t: r3(this.t), phase: this.bus.state.phase.name, woke: [`${by} edit`], sense: { energy: r3(this.bus.state.sense.energy) }, sound: this.sensors.sound?.() ?? null, policies: [{ name: by, why: act.why || 'manual edit' }], acts: [rec], fired: [], wait: r3(Math.max(0, this.nextTurn - this.t)) });
    this.bus.emit('edit', rec);
    return rec;
  }
  
  
  actor(by) {
    if (TRUSTED.includes(by) || by === 'cues') throw new Error(`actor('${by}'): a pinned actor must be untrusted`);
    return (verb, args, why) => this.act({ verb, args, why }, by);
  }
  registerCore() {
    const B = this.bindings;
    this.register('binding.arm', function ({ id, obs = null, why = '', force = false, claim = null }, { by }) {
      if (!B.def(id)) return { ok: false, why: `no binding '${id}'` };
      const ok = B.arm(id, { by, obs, why, now: this.t, force, claim });
      return ok ? { ok, state: 'armed' } : { ok, why: `refused: ${B.s[id].phase}${B.owner(B.def(id).target) ? `, target ${B.def(id).target} owned by ${B.owner(B.def(id).target).id}` : ''}` };
    });
    
    
    
    const L = this.layer;
    const mctx = (by, extra) => ({ by, now: this.t, agent: !TRUSTED.includes(by) && by !== 'cues', ...extra });
    this.register('map.create', function (args, { by, ...x }) { return L.create(args, mctx(by, x)); });
    this.register('map.update', function (args, { by, ...x }) { return L.update(args, mctx(by, x)); });
    this.register('map.remove', function (args, { by, ...x }) { return L.remove(args, mctx(by, x)); });
    this.register('undo', function ({ n = 1 } = {}, { by }) {
      if (!Number.isInteger(n) || n < 1 || n > 100) return { ok: false, why: 'n must be an integer 1..100' };
      const done = [];
      for (let i = 0; i < n; i++) {
        const u = L.popUndo(); if (!u) break;
        const rec = this.#exec(u.inverse, by, 0, { undoing: true });
        done.push({ undid: u.verb, id: u.args.id, ok: rec.ok, ...(rec.ok ? {} : { why: rec.result?.why || rec.error }) });
      }
      return done.length ? { ok: done.every((d) => d.ok), undone: done, left: L.undoStack.length } : { ok: false, why: 'nothing to undo' };
    });
    
    this.register('binding.add', function ({ def = {} }, ctx) { return this.verbs['map.create'].call(this, { kind: 'binding', ...def }, ctx); });
    this.register('binding.rebind', function ({ id, force, why, ...patch }, ctx) { return this.verbs['map.update'].call(this, { id, ...patch }, ctx); });
    this.register('binding.remove', function ({ id, why }, ctx) { return this.verbs['map.remove'].call(this, { id, why }, ctx); });
    this.register('binding.retire', function ({ id, why = '' }, { by }) {
      const ok = B.retire(id, { by, why, now: this.t });
      return ok ? { ok, state: 'cooling' } : { ok, why: `not armed (${B.s[id]?.phase ?? 'unknown'})` };
    });
    this.register('binding.disarm', function (args, ctx) { return this.verbs['binding.retire'].call(this, args, ctx); });
    this.register('phase.set', function ({ name, why = '' }, { by }) {
      if (!this.def.PHASES[name]) return { ok: false, why: `no phase '${name}'` };
      const from = this.bus.state.phase?.name;
      if (name === from) return { ok: true, noop: true, phase: name, why: `already in ${name}: a hold, nothing restarts` }; 
      if (!String(why).trim()) return { ok: false, phase: from, why: 'why required' }; 
      const edges = this.edges(from);
      if (!edges.includes(name)) return { ok: false, phase: from, why: `no edge ${from} -> ${name} (allowed: ${edges.join(', ') || 'none'})` };
      this.#setPhase(name, by, why); return { ok: true, phase: name, from };
    });
    
    this.register('say', function (args) { this.bus.state.said.push({ t: r3(this.t), ...args }); this.bus.state.said.splice(0, Math.max(0, this.bus.state.said.length - 20)); this.bus.emit('say', args); return { ok: true, delivered: 'bus' }; });
    this.register('prompt.set', function ({ list = 'opening', cue, say, en }) {
      const c = this.cues[list]?.find((x) => x.id === cue);
      if (!c) return { ok: false, why: `no cue ${list}/${cue}` };
      if (say != null) c.say = say; if (en != null) c.en = en; return { ok: true };
    });
    this.register('policy.set', function ({ name, on }) { this.bus.state.off[name] = !on; return { ok: true, policy: name, on: !!on }; });
    this.register('hold', function ({ why = '' }) { return { ok: true, held: why }; });
    
    
    this.register('session.end', function ({ why = '' }) { this.bus.emit('session.end', { why }); return { ok: true, closing: true, why: String(why).slice(0, 200) }; });
    
    
    
    
    
    
    
    this.register('body.oneshot', function ({ what, obs, why = '', ...rest } = {}, { by, why: actWhy = '' }) { return this.#oneShot({ what, obs, why: why || actWhy, rest }, by); });
  }
  
  oneShot(what, fn) {
    if (typeof what !== 'string' || !SHOT_NAME.test(what)) throw new Error(`oneShot: bad name '${what}' (${SHOT_NAME})`);
    if (typeof fn !== 'function') throw new Error(`oneShot('${what}'): fn must be a function`);
    (this.shots ||= new Map()).set(what, fn);
  }
  #shotCfg() { const ph = this.phaseDef.oneshot; return ph === false ? null : { ...ONESHOT, ...(this.def.ONESHOT || {}), ...(ph || {}) }; }
  #shotEffect(what) {
    if (this.shots?.has(what)) return this.shots.get(what);
    if (what === 'chime' && Object.hasOwn(this.verbs, 'stimulus')) return (args, ctx) => this.verbs.stimulus.call(this, { ...args, what: 'chime' }, ctx);
    return null;
  }
  
  #shotArgs(rest, spec) {
    for (const [k, v] of Object.entries(rest)) {
      const a = spec && Object.hasOwn(spec, k) ? spec[k] : null;
      if (!a) return `arg '${k}' not allowed (allowed: ${Object.keys(spec || {}).join(', ') || 'none'})`;
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${k} must be a finite number`;
      if (a.int && !Number.isInteger(v)) return `${k} must be an integer`;
      if (v < a.range[0] || v > a.range[1]) return `${k} ${v} outside ${a.range[0]}..${a.range[1]}`;
    }
    return null;
  }
  #oneShot({ what, obs, why, rest }, by) {
    const t = this.t, cfg = this.#shotCfg();
    const done = (res) => {
      const ev = { t: r3(t), by, what: what ?? null, obs: typeof obs === 'string' ? obs : null, ok: res.ok !== false, gate: res.gate, why: res.why, ...(res.ch ? { ch: res.ch } : {}) };
      const ring = this.bus.state.oneshots; ring.push(ev); ring.splice(0, Math.max(0, ring.length - (cfg?.ring ?? ONESHOT.ring)));
      this.bus.emit('oneshot', ev);
      return res;
    };
    
    if (typeof obs !== 'string' || !/^o\d+$/.test(obs)) return done({ ok: false, gate: 'cite', why: 'obs id required (an observation id like o12)' });
    const o = this.story?.get?.(obs);
    if (!o) return done({ ok: false, gate: 'cite', why: `no observation '${obs}'` });
    
    if (typeof what !== 'string' || !what) return done({ ok: false, gate: 'ready', why: 'what required' });
    const fx = this.#shotEffect(what);
    if (!fx) return done({ ok: false, gate: 'ready', why: `no one-shot '${what}'` });
    if (!cfg) return done({ ok: false, gate: 'ready', why: `one-shots off in ${this.bus.state.phase?.name}` });
    if (o.kind === 'gone') return done({ ok: false, gate: 'ready', why: `${obs} is a 'gone' observation: nothing to answer` });
    const open = this.story.isOpen ? this.story.isOpen(o) : o.t1 == null;
    const age = open ? 0 : this.run - o.t1;
    if (age > cfg.maxAge) return done({ ok: false, gate: 'ready', why: `${obs} closed ${r3(age)} s ago (> ${cfg.maxAge} s): stale` });
    const key = `${what}:${obs}`;
    if (this.shotObs.has(key)) return done({ ok: false, gate: 'ready', why: `${obs} already answered with '${what}'` });
    const argErr = this.#shotArgs(rest, cfg.args);
    if (argErr) return done({ ok: false, gate: 'args', why: argErr });
    
    const last = Math.max(-Infinity, ...this.shotT.values()), lastW = this.shotT.get(what) ?? -Infinity;
    if (t - last < cfg.cooldown) return done({ ok: false, gate: 'cooldown', why: `cooldown: ${r3(cfg.cooldown - (t - last))} s left (any one-shot)` });
    if (t - lastW < cfg.each) return done({ ok: false, gate: 'cooldown', why: `cooldown: ${r3(cfg.each - (t - lastW))} s left ('${what}')` });
    
    let out; try { out = fx.call(this, { ...rest, obs }, { by, t }); } catch (e) { out = { ok: false, why: `effect error: ${e.message}` }; }
    
    out = out && typeof out === 'object' && !Array.isArray(out) ? Object.fromEntries(Object.entries(out).filter(([, v]) => v === null || (typeof v !== 'object' && typeof v !== 'function'))) : {};
    if (out.ok === false) return done({ ...out, ok: false, gate: 'effect', why: out.why || 'effect refused', ch: o.ch });
    this.shotT.set(what, t); this.shotObs.set(key, obs);
    
    for (const [k, id] of this.shotObs) if (!this.story.get(id)) this.shotObs.delete(k);
    return done({ ...out, ok: true, gate: 'pass', what, obs, ch: o.ch, why: `${why ? `${String(why).slice(0, 200)} · ` : ''}answers ${o.label} (${obs})` });
  }
  #setPhase(name, by, why) {
    const s = this.bus.state;
    s.phase = { name, since: this.t, by, why, goal: this.def.PHASES[name].goal };
    const list = this.def.PHASES[name].cues;
    s.cue = list ? { list, i: 0, stage: null } : null;
    this.due = {}; this.firm = {}; this.nextTurn = this.t; this.phaseTurns = 0; 
    this.bus.emit('phase', s.phase);
  }

  
  expect(claim, spec) { this.expects[claim] = { ...spec, claim, samples: [], peak: 0, onsetObs: null }; }
  #probe() {
    const claims = this.bus.state.claims;
    for (const ex of Object.values(this.expects)) {
      const c = claims[ex.claim];
      if (!c || c.state !== 'pending') continue;
      if (ex.probe === 'audible') {
        const cfg = this.def.PROBES.audible, rms = this.sensors.stimulusRms?.() ?? 0, ms = (this.run - c.firedRun) * 1000;
        ex.peak = Math.max(ex.peak, rms);
        if (ex.peak >= cfg.minRms) this.bus.claim(ex.claim, { state: 'verified', evidence: { probe: 'audible', peakRms: r3(ex.peak * 1000) / 1000, ms: Math.round(ms) } });
        else if (ms > cfg.windowMs) this.bus.claim(ex.claim, { state: 'failed', evidence: { probe: 'audible', peakRms: ex.peak, ms: Math.round(ms), why: 'silent at the tap' } });
      } else if (ex.probe === 'agency') {
        const cfg = this.def.PROBES.agency, d = this.bindings.def(ex.binding), st = this.bindings.s[ex.binding];
        if (!d || st.phase !== 'armed' || st.w < 0.5) continue;
        
        const obs = srcNames(d.src).map((ch) => this.story.moving(ch)).find(Boolean);
        if (!ex.onsetObs) { if (!obs) continue; ex.onsetObs = obs.id; }
        const v = this.sensors.source?.(d), y = this.sensors.param?.(d.target);
        if (v == null || y == null) continue;
        ex.samples.push({ run: this.run, v, y });
        while (ex.samples.length && ex.samples[0].run < this.run - cfg.windowS) ex.samples.shift();
        const res = agencyProbe(ex.samples, d, cfg);
        ex.last = res;
        if (res.pass) this.bus.claim(ex.claim, { state: 'verified', evidence: { probe: 'agency', binding: d.id, obs: ex.onsetObs, r: res.r, span: res.span, n: res.n } });
      }
    }
  }

  
  
  
  
  
  
  gate(name, spec) {
    this.gates[name]?.off();
    const g = { name, spec, wait: false, spokenAt: null, quietSince: null, done: null }, w = spec?.while, sp = spec?.spoken, offs = [];
    if (w) offs.push(this.bus.on(w.event, (d) => { const on = (w.in || []).includes(d?.[w.field]); if (on && !g.wait) Object.assign(g, { spokenAt: null, quietSince: null, done: null }); g.wait = on; }));
    if (sp) offs.push(this.bus.on(sp.event, (d) => { if (g.wait && g.spokenAt == null && Object.entries(sp.match || {}).every(([k, v]) => d?.[k] === v)) g.spokenAt = this.t; }));
    g.off = () => { offs.forEach((f) => f()); if (this.gates[name] === g) delete this.gates[name]; };
    this.gates[name] = g;
    return g;
  }
  #gatesQuiet() {
    for (const g of Object.values(this.gates)) {
      if (g.spokenAt == null || g.done) continue;
      if (this.sensors[g.spec.quiet?.sensor]?.() === true) g.quietSince = null; else g.quietSince ??= this.t;
    }
  }
  gateOpen(name, age) {
    const g = this.gates[name]; if (!g) return { open: true, why: `no gate '${name}' registered` };
    const s = g.spec;
    if (g.done) return { open: true, why: g.done };
    if (!g.wait) return { open: true, why: 'no words are coming' };
    if (g.spokenAt != null && g.quietSince != null && this.t - g.quietSince >= (s.quiet?.s ?? 0)) {
      g.done = `${s.waitFor}: line done at ${r3(g.spokenAt)} s, quiet ${s.quiet?.s ?? 0} s`; return { open: true, why: g.done };
    }
    const max = s.maxWaitS ?? 0;
    if (age >= max) return { open: true, why: `fallback: not '${s.waitFor}' after ${max} s` };
    return { open: false, why: g.spokenAt == null ? 'the spoken line is not done' : 'the voice output still sounds' };
  }

  #view() { return { t: this.t, run: this.run, s: this.bus.state, phase: this.phaseDef, B: this.bindings, story: this.story }; }
}





export const cuesPolicy = {
  wakeOn: ['probe', 'edit'],
  fn({ t, s }) {
    const c = s.cue; if (!c) return null;
    const list = this.cues[c.list] || [];
    const why = [];
    for (let guard = 0; guard < list.length + 2; guard++) {
      const cue = list[c.i];
      if (!cue) return { why: [...why, `cue list '${c.list}' done`].join('; '), wait: this.def.CONDUCTOR.waitMax };
      if (c.stage == null) {
        if (cue.requires && s.claims[cue.requires]?.state !== 'verified') {
          why.push(`skip '${cue.id}': needs claim ${cue.requires} verified (is ${s.claims[cue.requires]?.state ?? 'absent'})`);
          c.i++; continue;
        }
        Object.assign(c, { stage: 'run', t0: t, repaired: false, reoffered: false, gated: false, id: cue.id });
        const acts = [];
        if (cue.say) acts.push({ verb: 'say', args: { text: cue.say, en: cue.en, show: cue.show, cue: cue.id } });
        for (const a of cue.acts || []) acts.push(JSON.parse(JSON.stringify(a)));
        if (cue.until) this.expect(cue.until.claim, cue.until);
        why.push(`start '${cue.id}'`);
        return { acts, why: why.join('; '), wait: cue.until || this.gates[cue.gate] ? 1 : cue.hold || 1 };
      }
      if (c.stage === 'run') {
        if (cue.gate && !c.gated) {
          const gt = this.gateOpen(cue.gate, t - c.t0);
          if (!gt.open) return { why: [...why, `'${cue.id}': gate '${cue.gate}' holds (${gt.why})`].join('; '), wait: 1 };
          c.gated = true; why.push(`'${cue.id}': gate '${cue.gate}' open (${gt.why})`);
        }
        const u = cue.until;
        if (u) {
          const cl = s.claims[u.claim], age = t - c.t0;
          if (cl?.state === 'verified') { Object.assign(c, { stage: 'hold', holdEnd: t + (cue.hold || 0) }); why.push(`'${cue.id}': ${u.claim} verified ${JSON.stringify(cl.evidence)}`); continue; }
          const failed = cl?.state === 'failed' || age >= u.timeout;
          if (failed && u.repair && !c.repaired) {
            c.repaired = true; c.t0 = t;
            return { acts: JSON.parse(JSON.stringify(u.repair)), why: `'${cue.id}': ${u.claim} ${cl?.state === 'failed' ? 'failed' : 'timed out'}: repair once`, wait: 1 };
          }
          if (failed) {
            this.bus.claim(u.claim, { state: 'stripped', evidence: { ...(cl?.evidence || {}), last: this.expects[u.claim]?.last, why: `${u.onFail}: no evidence in ${u.timeout} s` } });
            Object.assign(c, { stage: 'hold', holdEnd: t + (cue.hold || 0) }); why.push(`'${cue.id}': ${u.claim} STRIPPED (no evidence): the room will not claim it`); continue;
          }
          if (u.reoffer && age >= u.reoffer && !c.reoffered && cue.say) {
            c.reoffered = true;
            return { acts: [{ verb: 'say', args: { text: cue.say, en: cue.en, show: cue.show, cue: cue.id, reoffer: true } }], why: `'${cue.id}': no evidence after ${u.reoffer} s: offer again`, wait: 1 };
          }
          const last = this.expects[u.claim]?.last;
          return { why: `'${cue.id}': waiting on ${u.probe} probe for ${u.claim} (${last ? `${last.why}, r ${last.r ?? '-'}` : 'no onset yet'})`, wait: 1 };
        }
        Object.assign(c, { stage: 'hold', holdEnd: c.t0 + (cue.hold || 0) });
      }
      if (c.stage === 'hold') {
        if (t + 1e-6 < c.holdEnd) return { why: [...why, `'${cue.id}': holding ${r3(c.holdEnd - t)} s`].join('; '), wait: c.holdEnd - t, firm: true };
        c.i++; c.stage = null; why.push(`'${cue.id}' done`);
      }
    }
    return { why: why.join('; '), wait: 1 };
  },
};




export const djPolicy = {
  wakeOn: ['obs.open'],
  fn({ s, run, B, story }) {
    const cfg = this.cfg('dj');
    if (s.sense.energy < cfg.stillBelow) return { why: `still (energy ${r3(s.sense.energy)} < ${cfg.stillBelow}): the room breathes and holds`, wait: cfg.waitIdle };
    const sal = (d) => Math.max(0, ...srcNames(d.src).map((ch) => story.salience(ch)));
    const score = (d) => sal(d) * (1 + (cfg.groupBias?.[groupOf(d.src)] ?? 0)) * (1 + cfg.freshBias / (1 + B.s[d.id].arms));
    const armed = B.armed();
    const claimed = (d) => B.s[d.id].claim && s.claims[B.s[d.id].claim]?.state === 'pending';
    for (const d of armed) {
      const st = B.s[d.id], quiet = Math.min(...srcNames(d.src).map((ch) => story.quietFor(ch, run)));
      if (claimed(d)) continue; 
      if (st.armedFor >= d.hold * (cfg.holdScale ?? 1)) return { acts: [{ verb: 'binding.retire', args: { id: d.id, why: `held ${Math.round(st.armedFor)} s` } }], why: `retire ${d.id}: held its time`, wait: cfg.waitAfterAct, firm: true };
      if (st.armedFor >= cfg.minArmed && quiet >= cfg.idleRetire) return { acts: [{ verb: 'binding.retire', args: { id: d.id, why: `${srcNames(d.src).join('+')} quiet ${Math.round(quiet)} s` } }], why: `retire ${d.id}: its source went quiet`, wait: cfg.waitAfterAct, firm: true };
    }
    const cands = B.defs.filter((d) => B.s[d.id].phase === 'idle')
      .map((d) => ({ d, obs: srcNames(d.src).map((ch) => story.moving(ch)).find(Boolean), score: score(d) }))
      .filter((c) => c.obs).sort((a, b) => b.score - a.score);
    if (!cands.length) return { why: `nothing new is moving (armed: ${armed.map((d) => d.id).join(', ') || 'none'})`, wait: cfg.waitIdle };
    const best = cands[0], owner = B.owner(best.d.target);
    const because = `${best.obs.label} (${best.obs.id}, score ${r3(best.score)})`;
    if (!owner && armed.length < cfg.maxArmed) return { acts: [{ verb: 'binding.arm', args: { id: best.d.id, obs: best.obs.id, why: because } }], why: `arm ${best.d.id}: ${because}`, wait: cfg.waitAfterAct, firm: true };
    
    const victim = owner || armed.filter((d) => !claimed(d)).sort((a, b) => score(a) - score(b))[0];
    if (victim && !claimed(victim) && B.s[victim.id].armedFor >= cfg.minArmed && best.score >= cfg.swapMargin * Math.max(0.01, score(victim)))
      return { acts: [{ verb: 'binding.retire', args: { id: victim.id, why: `making room for ${best.d.id}` } }, { verb: 'binding.arm', args: { id: best.d.id, obs: best.obs.id, why: because, force: true } }], why: `swap ${victim.id} -> ${best.d.id}: ${because}`, wait: cfg.waitAfterAct, firm: true };
    return { why: `full (${armed.length}/${cfg.maxArmed}); best candidate ${best.d.id} ${because} not ${cfg.swapMargin}x stronger`, wait: cfg.waitIdle };
  },
};





export const readinessPolicy = {
  wakeOn: [],
  fn({ t, s, B }) {
    const rd = this.phaseDef.readiness || {};
    const r = {
      phase: s.phase.name, inPhase: r3(t - s.phase.since), arms: B.events.filter((e) => e.ev === 'arm' && e.t >= s.phase.since).length,
      turns: this.phaseTurns, stillFor: r3(Math.max(0, t - (this.lastMoveT ?? s.phase.since))),
      cuesDone: !(s.cue && (this.cues[s.cue.list] || [])[s.cue.i]), next: rd.next ?? null, marks: rd.marks ?? null, edges: this.edges(),
    };
    s.readiness = r;
    return { why: `readiness data: ${Math.round(r.inPhase)} s, ${r.arms} arms, ${r.turns} turns, still ${Math.round(r.stillFor)} s${r.cuesDone ? '' : ', cues running'}. The phase holds until the Director judges it complete`, wait: this.def.CONDUCTOR.waitMax };
  },
};

export function makeConductor(opts) {
  const c = new Conductor(opts);
  c.policy('cues', cuesPolicy); c.policy('dj', djPolicy); c.policy('readiness', readinessPolicy);
  return c;
}
