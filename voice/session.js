











import { FLOW } from './flow.js';
import { validateToolCall, TOOL_VERBS, STATIC_REGISTRY, MAX_TOOL_CALLS } from './tools.js';
import { SceneFeed } from './scene.js';

export const MIRRORED_BY = Object.freeze(['voice', 'dev']); 

export class VoiceSession {
  
  constructor({ transport, act, say, bus = null, registry = STATIC_REGISTRY, onStatus = () => {}, scene = {} }) {
    Object.assign(this, { t: transport, act, say, bus, registry, onStatus, phaseSync: null, phase: FLOW.firstPhase, perResponse: new Map(), offs: [], ended: false });
    this.offs.push(transport.on('event', (ev) => this.onEvent(ev)));
    this.offs.push(transport.on('status', (s) => onStatus(s)));
    this.offs.push(transport.on('close', (c) => { this.ended = true; onStatus({ state: 'ended', ...c }); }));
    const offPhase = bus?.on?.('phase', (p) => { if (p && MIRRORED_BY.includes(p.by)) this.setPhase(p.name, p.why); });
    if (typeof offPhase === 'function') this.offs.push(offPhase);
    this.scene = scene && bus?.on && transport.scene ? new SceneFeed({ bus, send: (text) => { if (!this.ended) transport.scene(text); }, ...scene }) : null;
    if (this.scene) this.offs.push(() => this.scene.stop());
  }
  start() { if (!this.ended) this.t.start(); }                     
  setPhase(name, why = '') { if (!FLOW.phases[name] || name === this.phase) return false; this.phase = name; this.#mirror(name, why); return true; }
  
  
  
  #seq = 0;
  async #mirror(name, why) {
    if (!this.t.setPhase) return;
    const seq = ++this.#seq;
    let r; try { r = await this.t.setPhase(name, why); } catch { r = { ok: false, status: 0, why: 'setPhase threw' }; }
    if (this.ended || seq !== this.#seq) return;
    const obj = r && typeof r === 'object', ok = r === true || (obj && r.ok === true);
    const failed = r === false || (obj && r.ok === false);
    if (!ok && !failed) return; 
    const rec = { kind: 'phase.mirror', phase: name, ok, status: obj ? r.status ?? null : null, ...(ok ? {} : { why: String((obj && r.why) || 'refused').slice(0, 80) }) };
    this.phaseSync = rec;
    try { this.bus?.emit?.('voice.trace', rec); } catch {}
    if (!ok) this.onStatus({ state: 'phase-unsynced', phase: name, status: rec.status });
  }
  async stop(why = 'session stop') { this.ended = true; for (const off of this.offs) { try { off(); } catch {} } await this.t.close(why); }

  async onEvent(ev) {
    switch (ev?.type) {
      case 'response.output_audio_transcript.done':
        if (ev.transcript) this.say({ text: String(ev.transcript).slice(0, 600), cue: 'voice', spoken: true });
        return;
      case 'response.function_call_arguments.done': return this.runTool(ev); 
      case 'response.done': this.perResponse.delete(ev.response?.id); return;
      case 'error': this.onStatus({ state: 'error', code: ev.error?.code || ev.error?.type || 'error' }); return;
    }
  }

  async runTool(ev) {
    const rid = ev.response_id || '?';
    const n = (this.perResponse.get(rid) || 0) + 1; this.perResponse.set(rid, n);
    const allowed = FLOW.phases[this.phase]?.tools || [];
    let out;
    const v = !allowed.includes(ev.name) ? { ok: false, why: `tool '${String(ev.name).slice(0, 40)}' not allowed in ${this.phase}` }
      : n > MAX_TOOL_CALLS ? { ok: false, why: `more than ${MAX_TOOL_CALLS} tool calls in one response` }
      : validateToolCall(ev.name, ev.arguments, this.registry);
    if (!v.ok) out = { ok: false, why: v.why };
    else {
      let rec;
      if (v.verb === 'phase.set' && v.args.name === this.phase) rec = { ok: true, result: { ok: true, held: true } }; 
      else try { rec = await this.act(v.verb, v.args, v.args.why || 'voice', 'voice'); } catch (e) { rec = { ok: false, error: 'act threw' }; }
      const ok = rec?.ok !== false && rec?.result?.ok !== false;
      
      out = ok ? { ok: true } : { ok: false, why: String(rec?.error || rec?.result?.why || 'refused').slice(0, 200) };
      if (ok && v.verb === 'phase.set') this.setPhase(v.args.name, v.args.why); 
    }
    this.t.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(out) } });
    this.t.send({ type: 'response.create' }); 
    return out;
  }
}
