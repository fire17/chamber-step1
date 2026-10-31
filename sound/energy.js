// Dance energy (PARITY-1031 #7, G20): the beat follows how hard the person dances. Pure (no Web Audio), node-testable.
// Input: what the engine already receives every frame, the body features `energy` (point speed, fast attack and slow
// release, body.js EnergyMeter) and `groove` (energy averaged over ENERGY.grooveSeconds = movement that keeps building).
// Output: one slewed value E in 0..1 and what it drives in the generated drums (engine.js):
//  - density: E lifts the pulse density toward and past BEAT_ON (.42). The gate keeps its hysteresis (on above .42,
//    off below .30, space.js beatGate) and changes only on a bar line, so a dance brings the beat in and a pause in the
//    dance does not chop it.
//  - groove: E raises the syncopation / ghost / fill amount of the planned bars, so dancing harder BUILDS the beat
//    (more hits, more push), not just louder.
// Why groove weighs more than energy: a twitch is not a dance. groove only rises when the movement is sustained, so
// the beat answers dancing, while a single wave adds a little at most. The deadzone keeps a still body (sensor noise,
// breathing) at exactly 0. Asymmetric slew: the beat comes in within a few seconds of dancing and leaves slowly when
// the body stops (a recede, not a cut). The phase scales the TARGET (then the slew smooths the scale change):
// orientation stays calm (the energy alone can never arm the beat there), enactment is where the dance leads.
// NaN / Infinity count as 0 (a bad frame must not latch E: Math.min/max pass NaN through, and NaN never recovers)
const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export const DANCE = Object.freeze({
  wGroove: 0.6, wEnergy: 0.4, // sustained movement leads; the instantaneous energy adds the urgency
  deadzone: 0.08,             // below this the body counts as still (E target exactly 0)
  attack: 1.2, release: 3.5,  // s (time constants): in within a few beats of dancing, out over ~10 s
  density: 0.85,              // E 1 -> density .85; E .50 crosses BEAT_ON (.42), E .35 falls under BEAT_OFF (.30)
  groove: 0.5,                // E 1 -> groove halfway from v.groove to 1 (syncopation, ghosts, fills)
  busTau: 1.6,                // s: the drum bus fades in / out over this when the dance leads the beat (loudness slew)
  snap: 2e-3,                 // below this, with a still target, E is 0 (density .0017: under any audible change)
});
// phase -> how much the dance may lead (multiplies the target). orientation: max density .85 * .45 = .38 < BEAT_ON,
// so the room stays calm and leads; enactment: full; integration: settling, only a full dance arms a soft beat.
export const DANCE_PHASE_GAIN = Object.freeze({ orientation: 0.45, enactment: 1, integration: 0.55 });
export const phaseGain = (name) => DANCE_PHASE_GAIN[name] ?? DANCE_PHASE_GAIN.orientation;

// the instantaneous dance target from the frame's inputs (nobody / no body features -> 0)
export function danceTarget(inp, k = DANCE) {
  const b = inp?.body;
  if (!b || !b.present) return 0;
  const f = b.f || {};
  const raw = clamp01(k.wGroove * clamp01(f.groove ?? 0) + k.wEnergy * clamp01(f.energy ?? 0));
  return clamp01((raw - k.deadzone) / (1 - k.deadzone));
}

export class DanceEnergy {
  constructor(k = DANCE) { this.k = k; this.value = 0; this.target = 0; }
  // dt in s (audio clock); gain = phaseGain(phase). Settles exactly on 0, so stillness returns the default path.
  step(inp, dt, gain = 1) {
    const k = this.k, t = (this.target = danceTarget(inp, k) * clamp01(gain));
    if (!Number.isFinite(this.value)) this.value = 0; // defensive: E is always finite after a step
    if (t === 0 && this.value < k.snap) { this.value = 0; return 0; }
    if (!(dt > 0) || !Number.isFinite(dt)) return this.value; // a bad or zero dt holds E
    const tau = t > this.value ? k.attack : k.release;
    this.value += (t - this.value) * (1 - Math.exp(-dt / tau));
    return this.value;
  }
  density() { return this.k.density * this.value; }
  groove(g) { return g + this.k.groove * this.value * (1 - g); }
}
