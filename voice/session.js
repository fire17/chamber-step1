
























import { FLOW, instructionsFor } from './flow.js';
import { validateToolCall, TOOL_VERBS, STATIC_REGISTRY, MAX_TOOL_CALLS, toolDefs } from './tools.js';
import { SceneFeed } from './scene.js';
import { Pacer, pacedTools } from './pace.js';
import { paces } from './kinds.js';

export const MIRRORED_BY = Object.freeze(['voice', 'dev']); 




export const turnDetection = (mode = 'talk') => ({ ...FLOW.turnDetection, ...(FLOW.voiceModes?.[mode] || {}) });
export const audioUpdate = (mode = 'talk') => ({ type: 'session.update', session: { audio: { input: { turn_detection: turnDetection(mode) } } } });




export const PHASE_CAUSES = Object.freeze(['switch_phase', 'rule:<id>', 'backstop:<id>', 'dev']);
export function causeOk(cause, rules = FLOW.rules) {
  const c = String(cause ?? '');
  if (c === 'switch_phase' || c === 'dev') return true;
  if (c.startsWith('rule:')) return rules.some((r) => `rule:${r.id}` === c);
  return /^backstop:[a-z][a-z0-9_-]*$/.test(c);
}
const phaseOrder = () => Object.keys(FLOW.phases);
const ruleTarget = (r, from) => (r.to === 'next' ? phaseOrder()[phaseOrder().indexOf(from) + 1] : r.to);








export class PhaseGate {
  constructor({ now = Date.now, rules = FLOW.rules, floor = FLOW.floor } = {}) {
    Object.assign(this, { now, rules, floor, enteredAt: now(), changes: [], fired: {}, seen: {}, landingUntil: 0, speechUntil: 0 });
  }
  muted() { const t = this.now(); return t < this.landingUntil || t < this.speechUntil; }
  check({ from, to, cause, why }) {
    if (!causeOk(cause, this.rules)) return { ok: false, why: `unknown phase cause '${String(cause).slice(0, 40)}'` };
    if (!FLOW.phases[to]) return { ok: false, why: `no phase '${String(to).slice(0, 40)}'` };
    if (to === from) return { ok: true, held: true };
    if (String(cause).startsWith('backstop:')) return { ok: false, why: 'a backstop only ends or holds; it never moves the phase' };
    if (!String(why ?? '').trim()) return { ok: false, why: 'why required' };
    const t = this.now();
    if (cause !== 'dev' && t < this.landingUntil) return { ok: false, why: 'the last phase change is still landing; try again in a moment' };
    const b = this.floor.phaseBudget, w = b.windowS * 1000, recent = this.changes.filter((x) => t - x < w);
    if (recent.length >= b.max) return { ok: false, budget: true, why: `phase changes are settling; try after ${Math.max(1, Math.ceil((recent[0] + w - t) / 1000))} s` };
    return { ok: true };
  }
  commit({ cause }) {
    const t = this.now();
    this.changes = this.changes.filter((x) => t - x < this.floor.phaseBudget.windowS * 1000); this.changes.push(t);
    this.enteredAt = t; this.landingUntil = t + this.floor.landingS * 1000; this.seen = {};
    if (String(cause).startsWith('rule:')) this.fired[cause.slice(5)] = t;
  }
  landed() { this.landingUntil = 0; }
  speechStopped() { this.speechUntil = this.now() + this.floor.speechMuteS * 1000; }
  observe(ev, from) {
    if (!ev || this.muted()) return null; 
    const t = this.now();
    for (const r of this.rules) {
      if (r.off || !(r.from === from || r.from === '*') || r.on?.event !== ev.event) continue;
      const to = ruleTarget(r, from);
      if (!FLOW.phases[to] || to === from) continue;
      if (r.on.spontaneous && !ev.spontaneous) continue;
      const within = (r.on.withinS ?? 0) * 1000, hits = (this.seen[r.id] = [...(this.seen[r.id] || []).filter((x) => t - x <= within), t]);
      if (hits.length < (r.on.count ?? 1)) continue;
      if (t - this.enteredAt < (r.dwellS ?? 0) * 1000) continue;
      if (this.fired[r.id] != null && t - this.fired[r.id] < (r.cooldownS ?? 0) * 1000) continue;
      return { to, cause: `rule:${r.id}`, why: r.why };
    }
    return null;
  }
}


const CLOSING_RETRY_ON = Object.freeze(FLOW.closing.retryOn ?? ['conversation_already_has_active_response']);

export class VoiceSession {
  
  
  constructor({ transport, act, say, bus = null, registry = STATIC_REGISTRY, onStatus = () => {}, scene = {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, presence = null, phaseGate = null }) {
    Object.assign(this, { t: transport, act, say, bus, registry, onStatus, phaseSync: null, phase: FLOW.firstPhase, perResponse: new Map(), offs: [], ended: false,
      setTimer, clearTimer, now, pacer: null, pacedRids: new Set(), seenCalls: new Set(), activeRids: new Set(), closing: null });
    this.phaseGate = phaseGate || new PhaseGate({ now: () => this.now() }); 
    
    
    if (paces(FLOW.pace.direct, transport.kind)) {
      this.pacer = new Pacer({ send: (e) => { if (this.ended || this.closing) return; e.response = e.response || {}; e.response.metadata = { chamber_act: 'paced' }; this.t.send(e); },
        phase: () => this.phase, setTimer, clearTimer, toolDefs: toolDefs(registry), ...(typeof presence === 'function' ? { presence } : {}) });
      this.offs.push(() => this.pacer.stop());
    }
    this.offs.push(transport.on('event', (ev) => this.onEvent(ev)));
    this.offs.push(transport.on('status', (s) => onStatus(s)));
    this.offs.push(transport.on('close', (c) => { this.ended = true; this.#clearClosing(); this.pacer?.stop(); onStatus({ state: 'ended', ...c }); }));
    const offPhase = bus?.on?.('phase', (p) => { if (p && MIRRORED_BY.includes(p.by)) this.setPhase(p.name, p.why, p.cause || (p.by === 'dev' ? 'dev' : 'switch_phase')); });
    if (typeof offPhase === 'function') this.offs.push(offPhase);
    this.scene = scene && bus?.on && transport.scene ? new SceneFeed({ bus, send: (text) => { if (!this.ended) transport.scene(text); }, ...scene }) : null;
    if (this.scene) this.offs.push(() => this.scene.stop());
  }
  start() { if (!this.ended) this.t.start(); }                     
  
  
  
  setPhase(name, why = '', cause = 'switch_phase') {
    if (!FLOW.phases[name] || name === this.phase) return false;
    if (!causeOk(cause) || String(cause).startsWith('backstop:')) { this.#trace({ kind: 'phase.refused', cause: String(cause).slice(0, 40), from: this.phase, to: name }); return false; }
    const from = this.phase; this.phase = name;
    this.phaseGate.commit({ from, to: name, cause, why });
    this.#trace({ kind: 'phase.cause', cause, from, to: name, why: String(why || '').slice(0, 200) });
    this.#mirror(name, why); return true;
  }
  
  voiceMode(mode) { if (this.ended || !FLOW.voiceModes?.[mode]) return false; this.t.send(audioUpdate(mode)); return true; }
  #trace(rec) { try { this.bus?.emit?.('voice.trace', rec); } catch {} }
  
  
  
  #seq = 0;
  async #mirror(name, why) {
    if (!this.t.setPhase) { this.phaseGate.landed(); return; }
    const seq = ++this.#seq;
    let r; try { r = await this.t.setPhase(name, why); } catch { r = { ok: false, status: 0, why: 'setPhase threw' }; }
    if (seq === this.#seq) this.phaseGate.landed(); 
    if (this.ended || seq !== this.#seq) return;
    const obj = r && typeof r === 'object', ok = r === true || (obj && r.ok === true);
    const failed = r === false || (obj && r.ok === false);
    if (!ok && !failed) return; 
    const rec = { kind: 'phase.mirror', phase: name, ok, status: obj ? r.status ?? null : null, ...(ok ? {} : { why: String((obj && r.why) || 'refused').slice(0, 80) }) };
    this.phaseSync = rec;
    try { this.bus?.emit?.('voice.trace', rec); } catch {}
    if (!ok) this.onStatus({ state: 'phase-unsynced', phase: name, status: rec.status });
  }
  async stop(why = 'session stop') { this.ended = true; this.#clearClosing(); this.activeRids.clear(); this.pacer?.stop(); for (const off of this.offs) { try { off(); } catch {} } await this.t.close(why); }

  
  
  
  
  #startClosing(why) {
    if (this.closing) return; 
    const c = this.closing = { rid: null, t0: this.now(), why, asked: false, pending: false, retried: false, created: false, audio: false, tail: null, max: null, done: false };
    c.max = this.setTimer(() => { c.max = null; this.#closed(); }, FLOW.closing.actMaxMs); 
    this.pacer?.stop();
    if (!this.ended) this.t.send(audioUpdate('closing')); 
    if (this.activeRids.size) c.pending = true; else this.#askClosing();
    this.onStatus({ state: 'closing', why });
  }
  #askClosing() {
    const c = this.closing; if (!c || c.done || this.ended) return;
    c.pending = false; c.asked = true;
    this.t.send({ type: 'response.create', response: { instructions: `${instructionsFor(this.phase)} ${FLOW.closing.hint}`,
      tools: toolDefs(this.registry).filter((t) => FLOW.closing.tools.includes(t.name)), tool_choice: 'auto', metadata: { chamber_act: 'closing' } } });
  }
  #tail() { const c = this.closing; if (!c || c.done || c.tail) return; c.tail = this.setTimer(() => { c.tail = null; this.#closed(); }, FLOW.closing.tailMs); }
  #closed() { const c = this.closing; if (!c || c.done) return; c.done = true; this.#clearClosing(); if (!this.ended) this.onStatus({ state: 'ended', why: 'end_session' }); }
  #clearClosing() {
    const c = this.closing; if (!c) return;
    if (c.tail) this.clearTimer(c.tail); if (c.max) this.clearTimer(c.max); c.tail = c.max = null;
  }
  #trackClosing(ev) {
    const c = this.closing; if (!c || c.done) return;
    const rid = ev.response?.id ?? ev.response_id;
    switch (ev.type) {
      case 'response.created': { 
        const act = ev.response?.metadata?.chamber_act;
        if (!c.rid && act !== 'paced' && (act === 'closing' || (c.asked && !c.created))) c.rid = rid ?? '?';
        if (c.asked) c.created = true; return;
      }
      
      
      case 'output_audio_buffer.started':
        if (c.rid && (!ev.response_id || ev.response_id === c.rid)) { c.audio = true; if (c.tail) { this.clearTimer(c.tail); c.tail = null; } }
        return;
      case 'output_audio_buffer.stopped': case 'output_audio_buffer.cleared': 
        if (c.rid && c.audio && (!ev.response_id || ev.response_id === c.rid)) this.#tail(); return;
      case 'response.output_audio_transcript.done': case 'response.output_audio.delta': if (c.rid && rid === c.rid) c.audio = true; return;
      case 'response.done': 
        if (c.pending && !this.activeRids.size) return this.#askClosing();
        if (c.rid && rid === c.rid && !c.audio && !hasAudio(ev.response)) this.#tail(); return;
      case 'error': 
        if (c.asked && !c.rid && !c.retried && CLOSING_RETRY_ON.includes(ev.error?.code)) { c.retried = true; if (this.activeRids.size) c.pending = true; else this.#askClosing(); }
        return;
    }
  }

  async onEvent(ev) {
    if (this.pacer) { try { this.pacer.onUpstream(ev); } catch {} } 
    if (ev?.type === 'response.created') { const id = ev.response?.id ?? '?'; this.activeRids.add(id); if (this.activeRids.size > 16) this.activeRids.delete(this.activeRids.values().next().value); }
    else if (ev?.type === 'response.done') { const id = ev.response?.id ?? '?'; this.activeRids.delete(id); if (id === '?') this.activeRids.clear(); }
    this.#trackClosing(ev);
    switch (ev?.type) {
      case 'response.output_audio_transcript.done':
        if (ev.transcript) this.say({ text: String(ev.transcript).slice(0, 600), cue: 'voice', spoken: true });
        return;
      case 'response.created': {
        const rid = ev.response?.id;
        if (rid && ev.response?.metadata?.chamber_act === 'paced') { this.pacedRids.add(rid); if (this.pacedRids.size > 64) this.pacedRids.delete(this.pacedRids.values().next().value); }
        return;
      }
      case 'response.function_call_arguments.done': return this.#call(ev); 
      case 'response.output_item.done': 
        if (ev.item?.type === 'function_call') return this.#call({ call_id: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments, response_id: ev.response_id });
        return;
      case 'response.done': this.perResponse.delete(ev.response?.id); return;
      case 'error': this.onStatus({ state: 'error', code: ev.error?.code || ev.error?.type || 'error' }); return;
    }
  }

  
  #call(ev) {
    const id = ev.call_id;
    if (id) { if (this.seenCalls.has(id)) return; this.seenCalls.add(id); if (this.seenCalls.size > 256) this.seenCalls.delete(this.seenCalls.values().next().value); }
    return this.runTool(ev);
  }

  async runTool(ev) {
    const rid = ev.response_id || '?';
    const n = (this.perResponse.get(rid) || 0) + 1; this.perResponse.set(rid, n);
    const output = (out) => this.t.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(out) } });
    const name = String(ev.name).slice(0, 40);
    if (this.closing) { 
      let out;
      if (ev.name === 'end_session') out = { ok: true, closing: true };
      else if (!FLOW.closing.tools.includes(ev.name)) out = { ok: false, why: `tool '${name}' not allowed while closing` };
      else {
        const v = n > MAX_TOOL_CALLS ? { ok: false, why: `more than ${MAX_TOOL_CALLS} tool calls in one response` } : validateToolCall(ev.name, ev.arguments, this.registry);
        if (!v.ok) out = { ok: false, why: v.why };
        else { let rec; try { rec = await this.act(v.verb, v.args, v.args.why || 'voice', 'voice'); } catch { rec = { ok: false, error: 'act threw' }; }
          out = rec?.ok !== false && rec?.result?.ok !== false ? { ok: true } : { ok: false, why: String(rec?.error || rec?.result?.why || 'refused').slice(0, 200) }; }
      }
      output(out); return out;
    }
    const allowed = FLOW.phases[this.phase]?.tools || [];
    const paced = this.pacedRids.has(rid);
    let out;
    const v = !allowed.includes(ev.name) ? { ok: false, why: `tool '${name}' not allowed in ${this.phase}` }
      : paced && !pacedTools(this.phase).includes(ev.name) ? { ok: false, why: `tool '${name}' not allowed on a paced turn` } 
      : n > MAX_TOOL_CALLS ? { ok: false, why: `more than ${MAX_TOOL_CALLS} tool calls in one response` }
      : validateToolCall(ev.name, ev.arguments, this.registry);
    let closing = false;
    if (!v.ok) out = { ok: false, why: v.why };
    else {
      let rec;
      const gate = v.verb === 'phase.set' && v.args.name !== this.phase ? this.phaseGate.check({ from: this.phase, to: v.args.name, cause: 'switch_phase', why: v.args.why }) : null;
      if (v.verb === 'phase.set' && v.args.name === this.phase) rec = { ok: true, result: { ok: true, held: true } }; 
      else if (gate && !gate.ok) { rec = { ok: false, error: gate.why }; if (gate.budget) this.#trace({ kind: 'phase.budget', from: this.phase, to: v.args.name, why: gate.why }); } 
      else try { rec = await this.act(v.verb, v.args, v.args.why || 'voice', 'voice'); } catch (e) { rec = { ok: false, error: 'act threw' }; }
      const ok = rec?.ok !== false && rec?.result?.ok !== false;
      
      out = ok ? { ok: true } : { ok: false, why: String(rec?.error || rec?.result?.why || 'refused').slice(0, 200) };
      if (ok && v.verb === 'phase.set') this.setPhase(v.args.name, v.args.why, 'switch_phase'); 
      closing = ok && rec?.result?.closing === true && !this.ended && !this.closing;
      if (closing) out = { ok: true, closing: true };
    }
    output(out);
    if (closing) this.#startClosing(String(v.args.why || '').slice(0, 200)); 
    
    
    else if (paced) this.t.send({ type: 'response.create', response: { tools: toolDefs(this.registry).filter((t) => pacedTools(this.phase).includes(t.name)), tool_choice: 'auto', metadata: { chamber_act: 'paced' } } });
    else this.t.send({ type: 'response.create' }); 
    return out;
  }
}


function hasAudio(resp) {
  for (const item of resp?.output || []) for (const c of item?.content || []) if (c?.type === 'output_audio' || c?.type === 'audio') return true;
  return false;
}
