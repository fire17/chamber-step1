// The bus: the ONE shared sense/state surface every part reads, plus a tiny pub/sub.
// Pure (no DOM, no audio). Parts hang their live objects here (bindings, story, prog) so the conductor,
// the verbs, the probes and the console all read the same truth; nothing keeps a private copy.
//
// Events (emit(name, data)): obs.open / obs.close (body story), probe (a claim changed state),
// say (a line to deliver), phase (phase changed), edit (a console / external change), act (a verb ran).
export class Bus {
  constructor() { this.subs = {}; this.state = {}; this.reset(); }
  reset() {
    Object.assign(this.state, {
      t: 0,            // life seconds (scaled; freezes on pause): the conductor's clock
      runT: 0,         // real unpaused seconds: the body story's clock (speeds are real)
      sense: { energy: 0, groove: 0, inputs: null },
      phase: null,     // { name, since, why, by }
      claims: {},      // id -> { state: pending|verified|failed|stripped|asked, what, evidence, t }
      cue: null,       // the cue runner's cursor (conductor 'cues' policy)
      off: {},         // policies switched off (verb policy.set; e.g. the console's DJ toggle)
      said: [],        // recent lines delivered by `say`
    });
  }
  on(name, fn) { (this.subs[name] ||= []).push(fn); return () => { this.subs[name] = this.subs[name].filter((f) => f !== fn); }; }
  emit(name, data) { for (const fn of this.subs[name] || []) { try { fn(data); } catch (e) { console.warn('[bus]', name, e); } } }
  claim(id, patch) {
    const c = (this.state.claims[id] ||= { state: 'pending', t: this.state.t });
    Object.assign(c, patch, { t: this.state.t });
    this.emit('probe', { id, ...c });
    return c;
  }
}
