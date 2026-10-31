// The space driver: connects the continuous v-space (space.js) to the existing Pad. It stays dormant until
// pad.space() is called, and the default pad is untouched without it.
//
// Design (SOUND-ARCH §2, §4):
//  - The Pad's existing body mappings keep working. The space moves the whole field RELATIVE TO HOME:
//    every transformed target is target ∘ (paramsAt(v) vs paramsAt(home)). At v == home the transform is the
//    identity (exact), so enabling the space changes nothing until v leaves home.
//  - Body -> axes (bodyAxes) produces OFFSETS centred on 0.5 (0.5 = no push). SpaceState clamps them to
//    ±BODY_MAX and slews them, so the body steers the field but never throws it.
//  - Drums: drums.js plans one bar at a time from paramsAt(v). Tempo, swing and kit are fixed per bar, and the
//    beat gate only changes on a bar line (a musically quantised discrete change). Events are dispatched to the
//    audio clock through a short look-ahead window.
//  - The groove->beat binding (targets.beat) still arms the beat. In space mode it feeds the new drums, the
//    density is max(binding, paramsAt density, dance), and the old fixed-pattern BeatSynth is held at 0.
//  - Dance energy (#7, G20; energy.js): a slewed E from the body's energy + groove lifts the density (so dancing arms
//    the beat through the same BEAT_ON/BEAT_OFF hysteresis) and the planned groove (so dancing harder builds it).
//    Stillness lets E settle to exactly 0, which is the pre-#7 path bit for bit. Orientation caps it under BEAT_ON.
import { ANCHORS, AXES, SpaceState, paramsAt, beatGate, nearestAnchor, vec, modeStep, modeIndexRaw, MODE_LADDER } from './space.js';
import { planBar, kitAt, DrumVoices, STEPS } from './drums.js';
import { DanceEnergy, phaseGain } from './energy.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mag = (x) => (x == null ? null : clamp(Math.abs(x - 0.5) * 2, 0, 1)); // bipolar feature -> 0..1 excursion
const mean = (...xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// Body -> axis offsets (0.5 = no push; null = nobody, so the body offsets relax home).
// Each axis reads features whose meaning matches it, so the mapping is legible, not arbitrary:
//  arousal  <- movement energy (activation is the arousal dimension; Russell 1980). Stillness = no push.
//  valence  <- upright, open posture: rise + arms up (expansive posture goes with positive affect; Riskind 1984).
//  tension  <- shrug + head-tilt excursion (raised shoulders are a guarding posture).
//  space    <- stepping back + open reach (a bigger personal space reads as a bigger room).
//  groove   <- groove, the slow integral of energy (movement that keeps building, i.e. dancing).
//  grain    <- bent elbows + nod excursion (angular, percussive motion -> brighter, grittier timbre).
// Absent features count as neutral (0.5), so a partial pose never pulls an axis.
export function bodyAxes(inp) {
  const b = inp?.body;
  if (!b || !b.present) return null;
  // a non-finite feature (NaN / Infinity from one bad frame) counts as absent: SpaceState would latch it for good
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

// Field transform relative to home. Pure: (targets, P = paramsAt(v), H = paramsAt(home), v, h) -> new targets.
// Multiplicative where the ear hears ratios (frequency, Q), additive where it hears differences (mix, depth).
export function spaceTargets(targets, P, H, v, h) {
  const out = { ...targets };
  if (out.cutoff != null) out.cutoff = clamp(out.cutoff * (P.cutoff / H.cutoff), 60, 16000);
  if (out.resonance != null) out.resonance = clamp(out.resonance * (P.filterQ / H.filterQ), 0.3, 18);
  if (out.reverbWet != null) out.reverbWet = clamp(out.reverbWet + (P.reverbWet - H.reverbWet), 0, 0.9);
  // arousal speeds and deepens everything that moves (the trip macro); tension widens the beating between saws
  // (more roughness, Plomp & Levelt 1965) by up to ~20 cents
  if (out.trip != null) out.trip = clamp(out.trip + 0.8 * (v[0] - h[0]), 0, 1);
  if (out.detune != null) out.detune = clamp(out.detune + 20 * (v[2] - h[2]), 0, 60);
  return out;
}

// Phase bias (PARITY-1031 #6, G22): each conductor phase leans the vector a little, as DATA (offsets centred on 0).
// orientation: none, the room leads from home. enactment: more body answers and the groove may build (arousal,
// groove and grain up; the room tightens a touch). integration: settling (arousal, groove and tension down; the
// room opens). Small on purpose: the phase is a lean, the Director and the body do the steering. On its own no
// phase arms the beat from home (density stays far under BEAT_ON). Slewed with PHASE_SLEW, so a phase change is
// a slow turn that the transition swell (#4) marks.
export const PHASE_BIAS = Object.freeze({
  orientation: Object.freeze([0, 0, 0, 0, 0, 0]),
  enactment: Object.freeze([0.10, 0.03, 0.04, -0.05, 0.12, 0.05]),
  integration: Object.freeze([-0.08, 0.04, -0.06, 0.12, -0.10, -0.06]),
});
export const PHASE_SLEW = 20; // s (time constant)

export const DRIFT = 0.02; // the wander amplitude once steering starts (SOUND-ARCH §2)
export const LOOKAHEAD = 0.12; // s: dispatch window on the audio clock (frame jitter at 30 fps is ~33 ms)

export class SpaceDriver {
  constructor(pad, { home = ANCHORS.chamber, seed = 1, drift = null } = {}) {
    this.pad = pad; this.ctx = pad.ctx; this.home = vec(home); this.H = paramsAt(this.home); this.seed = seed;
    // drift (the ±0.02 never-loop wander) starts at 0 so the default stays the default; it fades in (τ 10 s) once the
    // Director steers, or at once via opts.drift (dev flag `?drift=`)
    this.state = new SpaceState(this.home); this.state.drift = 0; this.driftTarget = drift ?? 0;
    this.v = this.state.value(); this.P = paramsAt(this.v);
    this.bindBeat = 0; this.beatOn = false; this.bar = 0; this.nextBar = null; this.barDur = null; this.queue = [];
    this.mode = modeIndexRaw(this.v[1]); this.lastT = this.ctx.currentTime; this.bpmSet = null;
    this.lean = AXES.map(() => 0); this.leanTarget = AXES.map(() => 0); this.directorBias = AXES.map(() => 0); this.phaseName = null; this.biasDirty = false;
    // drums: their own bus into the Pad's saturation stage, plus a little room (like the old beat bus)
    const ctx = this.ctx;
    this.out = ctx.createGain(); this.out.gain.value = 0; this.out.connect(pad.sat);
    const send = ctx.createGain(); send.gain.value = 0.18; this.out.connect(send); send.connect(pad.sendBus);
    this.drums = new DrumVoices(ctx, this.out);
    this.dance = new DanceEnergy(); this.danceLead = false;
  }
  // Director surface (all continuous; SpaceState slews)
  steer(to, seconds) { this.state.steer(to, seconds); if (!this.driftTarget) this.driftTarget = DRIFT; }
  setPhaseBias(b) { this.directorBias = vec(b).map((x) => x - 0.5); this.biasDirty = true; } // explicit, centred on 0.5; sums with the phase lean
  // the conductor phase -> its lean (PHASE_BIAS), slewed. Unknown names lean nowhere.
  phase(name) { this.phaseName = name; this.leanTarget = (PHASE_BIAS[name] ?? PHASE_BIAS.orientation).slice(); }
  // per frame: body -> offsets, advance the vector on the audio clock (so a suspended context freezes it), pump drums
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
    out.beat = 0; // the fixed-pattern BeatSynth is replaced by the generated drums
    return out;
  }
  density() { const e = this.dance.density(); return e > 0 ? Math.max(this.bindBeat, this.P.density, e) : Math.max(this.bindBeat, this.P.density); }
  // the echo grid follows the tempo (dotted eighth / quarter), gliding like tape (2 s); identity at home (72 BPM)
  #retuneEcho() {
    const bpm = this.P.bpm;
    if (this.bpmSet != null && Math.abs(bpm - this.bpmSet) < 0.5) return;
    if (this.bpmSet == null && Math.abs(bpm - this.H.bpm) < 0.5) { this.bpmSet = bpm; return; }
    const t = this.ctx.currentTime, beat = 60 / bpm;
    for (const [d, k] of [[this.pad.dlL, 0.75], [this.pad.dlR, 1]]) { d.delayTime.cancelScheduledValues(t); d.delayTime.setTargetAtTime(beat * k, t, 2); }
    this.bpmSet = bpm;
  }
  // Bars are planned whole, one look-ahead before their downbeat: tempo, kit, gate and mode are frozen per bar
  // (the quantised discrete changes), and the events go into a time-ordered queue on the audio clock.
  #pump(now) {
    // first run, or the clock jumped past whole bars (a stalled tab): restart the grid just ahead
    if (this.nextBar == null || this.nextBar + 2 * (this.barDur || 0) < now) { this.nextBar = now + 0.05; this.queue = []; }
    while (this.nextBar < now + LOOKAHEAD) {
      const p = this.P, d = this.density();
      const was = this.beatOn; this.beatOn = beatGate(this.beatOn, d);
      // the gate is a bar-line event; the drum bus enters / leaves over about two bars (time constant = half a bar).
      // When the dance leads the density, the bus moves slower (busTau): it arrives with the dance and recedes with it.
      // danceLead is a latch over the beat's life: set on any bar (entry included) where the dance leads the density,
      // read at the closing bar, cleared once the beat is off. It must be latched: by the bar where the gate closes, E
      // has already decayed under v's own density, so a same-bar check would miss a beat the dance brought and held.
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
        const gr = this.dance.value > 0 ? this.dance.groove(this.v[4]) : this.v[4]; // dancing harder builds the groove
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
