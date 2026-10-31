
















import { ANCHORS, AXES, SpaceState, paramsAt, beatGate, nearestAnchor, vec, modeStep, modeIndexRaw, MODE_LADDER } from './space.js';
import { planBar, kitAt, DrumVoices, STEPS } from './drums.js';
import { DanceEnergy, phaseGain } from './energy.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mag = (x) => (x == null ? null : clamp(Math.abs(x - 0.5) * 2, 0, 1)); 
const mean = (...xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };










export function bodyAxes(inp) {
  const b = inp?.body;
  if (!b || !b.present) return null;
  
  const f = Object.fromEntries(Object.entries(b.f || {}).map(([k, x]) => [k, typeof x === 'number' && !Number.isFinite(x) ? null : x]));
  const n = (x) => (x == null ? 0.5 : clamp(x, 0, 1));
  const e = f.energy ?? 0, g = f.groove ?? 0;
  return {
    arousal: 0.5 + 0.5 * clamp(e, 0, 1),
    valence: mean(n(f.rise), f.armsUp ?? 0.5),
    tension: clamp(0.5 + 0.5 * (n(f.shrug) - 0.5) + 0.25 * (mag(f.headTilt) ?? 0), 0, 1),
    space: mean(1 - n(f.depth), f.reach ?? 0.5),
    groove: 0.5 + 0.5 * clamp(g, 0, 1),
    grain: clamp(0.5 + 0.5 * ((f.elbowBend ?? 0.5) - 0.5) + 0.25 * (mag(f.nod) ?? 0), 0, 1),
  };
}



export function spaceTargets(targets, P, H, v, h) {
  const out = { ...targets };
  if (out.cutoff != null) out.cutoff = clamp(out.cutoff * (P.cutoff / H.cutoff), 60, 16000);
  if (out.resonance != null) out.resonance = clamp(out.resonance * (P.filterQ / H.filterQ), 0.3, 18);
  if (out.reverbWet != null) out.reverbWet = clamp(out.reverbWet + (P.reverbWet - H.reverbWet), 0, 0.9);
  
  
  if (out.trip != null) out.trip = clamp(out.trip + 0.8 * (v[0] - h[0]), 0, 1);
  if (out.detune != null) out.detune = clamp(out.detune + 20 * (v[2] - h[2]), 0, 60);
  return out;
}







export const PHASE_BIAS = Object.freeze({
  orientation: Object.freeze([0, 0, 0, 0, 0, 0]),
  enactment: Object.freeze([0.10, 0.03, 0.04, -0.05, 0.12, 0.05]),
  integration: Object.freeze([-0.08, 0.04, -0.06, 0.12, -0.10, -0.06]),
});
export const PHASE_SLEW = 20; 

export const DRIFT = 0.02; 
export const LOOKAHEAD = 0.12; 

export class SpaceDriver {
  constructor(pad, { home = ANCHORS.chamber, seed = 1, drift = null } = {}) {
    this.pad = pad; this.ctx = pad.ctx; this.home = vec(home); this.H = paramsAt(this.home); this.seed = seed;
    
    
    this.state = new SpaceState(this.home); this.state.drift = 0; this.driftTarget = drift ?? 0;
    this.v = this.state.value(); this.P = paramsAt(this.v);
    this.bindBeat = 0; this.beatOn = false; this.bar = 0; this.nextBar = null; this.barDur = null; this.queue = [];
    this.mode = modeIndexRaw(this.v[1]); this.lastT = this.ctx.currentTime; this.bpmSet = null;
    this.lean = AXES.map(() => 0); this.leanTarget = AXES.map(() => 0); this.directorBias = AXES.map(() => 0); this.phaseName = null; this.biasDirty = false;
    
    const ctx = this.ctx;
    this.out = ctx.createGain(); this.out.gain.value = 0; this.out.connect(pad.sat);
    const send = ctx.createGain(); send.gain.value = 0.18; this.out.connect(send); send.connect(pad.sendBus);
    this.drums = new DrumVoices(ctx, this.out);
    this.dance = new DanceEnergy(); this.danceLead = false;
  }
  
  steer(to, seconds) { this.state.steer(to, seconds); if (!this.driftTarget) this.driftTarget = DRIFT; }
  setPhaseBias(b) { this.directorBias = vec(b).map((x) => x - 0.5); this.biasDirty = true; } 
  
  phase(name) { this.phaseName = name; this.leanTarget = (PHASE_BIAS[name] ?? PHASE_BIAS.orientation).slice(); }
  
  sense(inp) {
    const now = this.ctx.currentTime, dt = clamp(now - this.lastT, 0, 0.25); this.lastT = now;
    this.state.setBody(bodyAxes(inp));
    this.state.drift += (this.driftTarget - this.state.drift) * (1 - Math.exp(-dt / 10));
    const k = 1 - Math.exp(-dt / PHASE_SLEW);
    if (this.biasDirty || this.lean.some((x, i) => x !== this.leanTarget[i])) {
      this.lean = this.lean.map((x, i) => (Math.abs(this.leanTarget[i] - x) < 1e-6 ? this.leanTarget[i] : x + (this.leanTarget[i] - x) * k));
      this.state.phase = this.lean.map((x, i) => x + this.directorBias[i]); this.biasDirty = false;
    }
    this.v = this.state.step(dt); this.P = paramsAt(this.v);
    this.dance.step(inp, dt, phaseGain(this.phaseName));
    this.#retuneEcho();
    this.#pump(now);
    return this.v;
  }
  transform(targets) {
    this.bindBeat = targets.beat ?? 0;
    const out = spaceTargets(targets, this.P, this.H, this.v, this.home);
    out.beat = 0; 
    return out;
  }
  density() { const e = this.dance.density(); return e > 0 ? Math.max(this.bindBeat, this.P.density, e) : Math.max(this.bindBeat, this.P.density); }
  
  #retuneEcho() {
    const bpm = this.P.bpm;
    if (this.bpmSet != null && Math.abs(bpm - this.bpmSet) < 0.5) return;
    if (this.bpmSet == null && Math.abs(bpm - this.H.bpm) < 0.5) { this.bpmSet = bpm; return; }
    const t = this.ctx.currentTime, beat = 60 / bpm;
    for (const [d, k] of [[this.pad.dlL, 0.75], [this.pad.dlR, 1]]) { d.delayTime.cancelScheduledValues(t); d.delayTime.setTargetAtTime(beat * k, t, 2); }
    this.bpmSet = bpm;
  }
  
  
  #pump(now) {
    
    if (this.nextBar == null || this.nextBar + 2 * (this.barDur || 0) < now) { this.nextBar = now + 0.05; this.queue = []; }
    while (this.nextBar < now + LOOKAHEAD) {
      const p = this.P, d = this.density();
      const was = this.beatOn; this.beatOn = beatGate(this.beatOn, d);
      
      
      
      
      
      const e = this.dance.density(), leadNow = e > 0 && e >= Math.max(this.bindBeat, p.density);
      if (this.beatOn) this.danceLead = (was && this.danceLead) || leadNow;
      if (was !== this.beatOn) {
        const g = this.out.gain, lead = this.beatOn ? leadNow : this.danceLead;
        g.cancelScheduledValues(this.nextBar); g.setTargetAtTime(this.beatOn ? 1 : 0, this.nextBar, lead ? Math.max(this.dance.k.busTau, 30 / p.bpm * 2) : 30 / p.bpm * 2);
      }
      if (!this.beatOn) this.danceLead = false;
      this.mode = modeStep(this.mode, this.v[1]);
      this.barDur = (60 / p.bpm) * 4;
      const kit = (this.kit = kitAt(this.v)), step = this.barDur / STEPS, t0 = this.nextBar;
      if (this.beatOn) {
        const gr = this.dance.value > 0 ? this.dance.groove(this.v[4]) : this.v[4]; 
        const plan = planBar(this.bar, { density: d, arousal: this.v[0], groove: gr, swing: p.swing, layBack: p.layBack, jitter: p.jitter, bpm: p.bpm },
          { seed: this.seed, fill: this.bar % 8 === 7 ? 0.5 * gr : 0 });
        for (const e of plan) this.queue.push({ t: t0 + e.step * step + e.offset, voice: e.voice, vel: e.vel, kit });
        this.queue.sort((x, y) => x.t - y.t);
      }
      this.bar++; this.nextBar += this.barDur;
    }
    while (this.queue.length && this.queue[0].t < now + LOOKAHEAD) {
      const e = this.queue.shift();
      if (e.t >= now - 0.01) this.drums.hit(e.voice, Math.max(e.t, now), e.vel, e.kit);
    }
  }
  snapshot() {
    return { v: this.v.map((x) => +x.toFixed(3)), axes: AXES, anchor: nearestAnchor(this.v), bpm: +this.P.bpm.toFixed(2), density: +this.density().toFixed(3),
      beatOn: this.beatOn, bar: this.bar, hits: this.drums.hits, mode: MODE_LADDER[this.mode],
      phase: this.phaseName, lean: this.lean.map((x) => +x.toFixed(3)), dance: +this.dance.value.toFixed(3), danceLead: this.danceLead };
  }
}
