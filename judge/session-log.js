




export const SCHEMA = 'chamber.session/v0';

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const r4 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);

export function compactInputs(inp) {
  if (!inp) return null;
  const out = {};
  for (const k of ['A', 'B', 'body']) {
    const h = inp[k];
    if (!h || !h.present) { out[k] = { present: false }; continue; }
    const f = {};
    for (const [fk, fv] of Object.entries(h.f || {})) if (typeof fv === 'number' || fv === null) f[fk] = r4(fv);
    out[k] = { present: true, ...(h.pose != null ? { pose: !!h.pose } : {}), f };
  }
  return out;
}

export function createSessionLog(bus, { bindings = bus.state.bindings, meta = {} } = {}) {
  const rec = {
    schema: SCHEMA, meta: { startedAt: null, ...clone(meta) },
    traces: [], story: [], sound: [], events: [], claims: {}, probes: [], said: [], phases: [], edits: [], pauses: [], frames: [],
  };
  const T = () => r4(bus.state.t ?? 0), R = () => r4(bus.state.runT ?? 0);
  const byId = new Map(), seen = new WeakSet(), offs = [];
  const on = (ev, fn) => offs.push(bus.on(ev, fn));
  on('trace', (tr) => rec.traces.push(clone(tr)));
  on('obs.open', (o) => { const c = { ...clone(o), lt: T() }; byId.set(o.id, c); rec.story.push(c); });
  on('obs.close', (o) => { const c = byId.get(o.id); if (c) Object.assign(c, clone(o), { lt: c.lt, lt1: T() }); });
  on('probe', (p) => { rec.probes.push({ t: T(), ...clone(p) }); rec.claims[p.id] = clone(bus.state.claims[p.id] ?? p); });
  on('say', (a) => rec.said.push({ t: T(), ...clone(a) }));
  on('phase', (p) => rec.phases.push({ t: T(), name: p.name, by: p.by, why: p.why }));
  on('edit', (e) => rec.edits.push({ t: T(), verb: e.verb, args: clone(e.args), by: e.by }));
  on('pause', (p) => rec.pauses.push({ t: T(), run: R(), paused: !!p.paused }));
  
  
  if (bus.state.phase) rec.phases.push({ t: T(), name: bus.state.phase.name, by: bus.state.phase.by, why: bus.state.phase.why, start: true });
  
  const pollBindings = () => { for (const e of bindings?.events || []) if (!seen.has(e)) { seen.add(e); rec.events.push({ ...clone(e), t: r4(e.t) }); } };
  for (const e of bindings?.events || []) seen.add(e); 
  return {
    rec,
    
    frame({ dt, dr, energy = bus.state.sense?.energy, groove = bus.state.sense?.groove, inputs = bus.state.sense?.inputs }) {
      pollBindings();
      rec.frames.push({ t: T(), run: R(), dt: r4(dt), dr: r4(dr), energy: r4(energy ?? 0), groove: r4(groove ?? 0), inputs: compactInputs(inputs) });
    },
    
    sound(s) { if (s) rec.sound.push({ t: T(), energy: r4(bus.state.sense?.energy ?? 0), ...clone(s) }); },
    finish(extra = {}) {
      pollBindings();
      for (const [id, c] of Object.entries(bus.state.claims || {})) rec.claims[id] = clone(c);
      Object.assign(rec.meta, clone(extra), { endT: T(), endRun: R() });
      return rec;
    },
    detach() { for (const off of offs.splice(0)) off(); },
  };
}
