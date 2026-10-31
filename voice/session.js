// Transport-agnostic voice SESSION: the room's side of the conversation. Knows nothing about WebRTC or WS.
//   model speech  -> say({text, cue:'voice', spoken:true})     (bus 'say'-compatible: captions show it; a Mouth must skip spoken:true)
//   model tool    -> phase allowlist + per-response cap + validateToolCall -> act(verb, args, why) -> function_call_output
//   phase         -> ONLY the Director (the model's switch_phase tool, a semantic judgement) changes phase with a person in
//                    the room. It reaches the conductor as act('phase.set', {name, why}, why, by='voice'). A same-phase call
//                    is a hold (no act, no cue restart). Phases are fluid: any phase may follow any other, `why` required.
//                    The bus 'phase' event is mirrored to the SERVER (transport.setPhase, which re-pins) ONLY when it came from
//                    the Director (by 'voice') or the dev console (by 'dev', dev/test only); any other phase event is not.
//   scene         -> SceneFeed (scene.js): short text notes of what the body/face/room is doing, as context only.
//                    The browser never sends session.update.
//   person        -> start() is the only place the room is asked to speak first; afterwards server VAD answers the
//                    person's own turns. No timers, no always-on loop (MIND rule). The flow itself is data (flow.js).
import { FLOW } from './flow.js';
import { validateToolCall, TOOL_VERBS, STATIC_REGISTRY, MAX_TOOL_CALLS } from './tools.js';
import { SceneFeed } from './scene.js';

export const MIRRORED_BY = Object.freeze(['voice', 'dev']); // whose phase events reach the server

export class VoiceSession {
  // opts: { transport, act(verb,args,why,by) -> rec|Promise<rec>, say(args), bus? ({on,state}), registry?, onStatus?(s), scene? (SceneFeed opts | false) }
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
  start() { if (!this.ended) this.t.start(); }                     // the person's explicit Start tap = the trigger
  setPhase(name, why = '') { if (!FLOW.phases[name] || name === this.phase) return false; this.phase = name; this.#mirror(name, why); return true; }
  // The server re-pin is best effort but NEVER silent: every outcome is traced on the bus ('voice.trace', kind 'phase.mirror')
  // and a refusal (e.g. a gateway without the /phase route: 404) also reaches onStatus as 'phase-unsynced'. The call goes on.
  // Only the LATEST mirror reports (a slower, older result never overwrites a newer one) and nothing reports after stop().
  #seq = 0;
  async #mirror(name, why) {
    if (!this.t.setPhase) return;
    const seq = ++this.#seq;
    let r; try { r = await this.t.setPhase(name, why); } catch { r = { ok: false, status: 0, why: 'setPhase threw' }; }
    if (this.ended || seq !== this.#seq) return;
    const obj = r && typeof r === 'object', ok = r === true || (obj && r.ok === true);
    const failed = r === false || (obj && r.ok === false);
    if (!ok && !failed) return; // the transport reports nothing (test doubles): nothing to trace
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
      case 'response.function_call_arguments.done': return this.runTool(ev); // [unverified event name]
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
      if (v.verb === 'phase.set' && v.args.name === this.phase) rec = { ok: true, result: { ok: true, held: true } }; // a hold: no act, no cue restart
      else try { rec = await this.act(v.verb, v.args, v.args.why || 'voice', 'voice'); } catch (e) { rec = { ok: false, error: 'act threw' }; }
      const ok = rec?.ok !== false && rec?.result?.ok !== false;
      // the verbs land in M5; until then the conductor answers 'unknown verb' and we say so truthfully
      out = ok ? { ok: true } : { ok: false, why: String(rec?.error || rec?.result?.why || 'refused').slice(0, 200) };
      if (ok && v.verb === 'phase.set') this.setPhase(v.args.name, v.args.why); // Director judged the phase used up
    }
    this.t.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(out) } });
    this.t.send({ type: 'response.create' }); // tool continuation (the relay accepts exactly this one)
    return out;
  }
}
