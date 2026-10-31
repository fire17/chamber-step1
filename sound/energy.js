














const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export const DANCE = Object.freeze({
  wGroove: 0.6, wEnergy: 0.4, 
  deadzone: 0.08,             
  attack: 1.2, release: 3.5,  
  density: 0.85,              
  groove: 0.5,                
  busTau: 1.6,                
  snap: 2e-3,                 
});


export const DANCE_PHASE_GAIN = Object.freeze({ orientation: 0.45, enactment: 1, integration: 0.55 });
export const phaseGain = (name) => DANCE_PHASE_GAIN[name] ?? DANCE_PHASE_GAIN.orientation;


export function danceTarget(inp, k = DANCE) {
  const b = inp?.body;
  if (!b || !b.present) return 0;
  const f = b.f || {};
  const raw = clamp01(k.wGroove * clamp01(f.groove ?? 0) + k.wEnergy * clamp01(f.energy ?? 0));
  return clamp01((raw - k.deadzone) / (1 - k.deadzone));
}

export class DanceEnergy {
  constructor(k = DANCE) { this.k = k; this.value = 0; this.target = 0; }
  
  step(inp, dt, gain = 1) {
    const k = this.k, t = (this.target = danceTarget(inp, k) * clamp01(gain));
    if (!Number.isFinite(this.value)) this.value = 0; 
    if (t === 0 && this.value < k.snap) { this.value = 0; return 0; }
    if (!(dt > 0) || !Number.isFinite(dt)) return this.value; 
    const tau = t > this.value ? k.attack : k.release;
    this.value += (t - this.value) * (1 - Math.exp(-dt / tau));
    return this.value;
  }
  density() { return this.k.density * this.value; }
  groove(g) { return g + this.k.groove * this.value * (1 - g); }
}
