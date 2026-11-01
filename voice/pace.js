














import { FLOW, instructionsFor } from './flow.js';
import { toolDefs as allToolDefs } from './tools.js';

const NEVER_PACED = Object.freeze(['switch_phase', 'end_session']); 
export function pacedTools(phase, def = FLOW.pace) {
  const allow = FLOW.phases[phase]?.tools || [];
  return def.tools.filter((t) => allow.includes(t) && !NEVER_PACED.includes(t));
}

export class Pacer {
  
  
  
  constructor({ send, phase = () => FLOW.firstPhase, lang = FLOW.lang, gapMs = FLOW.pace.maxGapS * 1000, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (h) => clearTimeout(h), def = FLOW.pace, onAct = () => {}, toolDefs = allToolDefs(), presence = () => true }) {
    Object.assign(this, { send, phase, lang, gapMs, setTimer, clearTimer, def, onAct, toolDefs, presence, i: 0, recent: [], timer: null, playTimer: null, busy: false, speaking: false, playing: false, started: false, stopped: false });
  }
  
  onUpstream(ev) {
    switch (ev?.type) {
      case 'response.created': this.started = true; this.busy = true; this.#clear(); break;
      case 'response.done': this.busy = false; this.#arm(); break;
      case 'input_audio_buffer.speech_started': this.speaking = true; this.#clear(); break;
      case 'input_audio_buffer.speech_stopped': this.speaking = false; this.#arm(); break; 
      case 'output_audio_buffer.started': this.playing = true; this.#clear(); this.#guardPlay(); break; 
      case 'output_audio_buffer.stopped': case 'output_audio_buffer.cleared': this.#played(); break;  
      case 'response.output_audio_transcript.done': if (ev.transcript) this.#remember(String(ev.transcript)); break;
    }
  }
  person() { this.#clear(); if (this.started) this.#arm(); } 
  stop() { this.stopped = true; this.#clear(); this.#unguardPlay(); }

  #remember(line) { this.recent.push(line.slice(0, 160)); if (this.recent.length > this.def.avoidLast) this.recent.shift(); }
  #clear() { if (this.timer) this.clearTimer(this.timer); this.timer = null; }
  
  #played() { this.playing = false; this.#unguardPlay(); this.#arm(); }
  #guardPlay() { this.#unguardPlay(); this.playTimer = this.setTimer(() => { this.playTimer = null; if (this.playing) this.#played(); }, this.gapMs * (this.def.playMaxGaps ?? 4)); }
  #unguardPlay() { if (this.playTimer) this.clearTimer(this.playTimer); this.playTimer = null; }
  #held() { return this.stopped || this.busy || this.speaking || this.playing; }
  #arm() { this.#clear(); if (!this.started || this.#held()) return; this.timer = this.setTimer(() => this.#fire(), this.gapMs); }
  #fire() {
    this.timer = null;
    if (this.#held()) return;
    if (!this.presence()) { this.timer = this.setTimer(() => this.#fire(), this.gapMs); return; } 
    const a = this.def.angles[this.i++ % this.def.angles.length];
    const avoid = a.say && this.recent.length ? ` Do not repeat or rephrase any of these earlier lines: ${JSON.stringify(this.recent)}.` : '';
    const how = a.say ? 'Speak one or two short sentences.' : 'Use no words this time: act only through one tool call.';
    const phase = this.phase(), allow = pacedTools(phase, this.def);
    const defs = this.toolDefs.filter((t) => allow.includes(t.name)), names = defs.map((t) => t.name); 
    
    
    this.send({ type: 'response.create', response: { instructions: `${instructionsFor(phase, this.lang)} The person is silent. Now: ${a.hint}. ${how}${avoid}`,
      tools: defs, tool_choice: a.say ? 'auto' : (names.length ? 'required' : 'none') } }); 
    this.busy = true; 
    this.onAct({ n: this.i, say: a.say, tools: names });
    
    this.timer = this.setTimer(() => { this.busy = false; this.#arm(); }, this.gapMs * 2);
  }
}
