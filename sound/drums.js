











const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const STEPS = 16;
const FLOOR = 0.3;


export function metricWeight(step) {
  const s = ((step % STEPS) + STEPS) % STEPS;
  if (s === 0) return 1;            
  if (s === 8) return 0.8;          
  if (s % 4 === 0) return 0.6;      
  if (s % 2 === 0) return 0.4;      
  return 0.2;                       
}

export function anticipation(step) {
  const here = metricWeight(step), next = metricWeight(step + 1);
  return clamp01((next - here) / 0.8);
}

export function hash01(...k) {
  let h = 0x811c9dc5;
  for (const x of k) { h ^= (x | 0) + 0x9e37; h = Math.imul(h, 0x01000193); h ^= h >>> 15; }
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}




export const VOICES = {
  kick:  { entry: 0.30, span: 0.45 },
  hat:   { entry: 0.38, span: 0.55 },
  back:  { entry: 0.46, span: 0.35 },
  ghost: { entry: 0.62, span: 0.38 },
  open:  { entry: 0.70, span: 0.30 },
};


export function salience(voice, step, a, g, entropy = 0) {
  const w = metricWeight(step), ant = anticipation(step), q = step % 4;
  switch (voice) {
    case 'kick': {
      
      
      const quarters = q === 0 ? 0.55 + 0.45 * w : 0.25 * w;
      const backbeatClash = step === 4 || step === 12 ? 0.45 * g : 0;
      return quarters - backbeatClash + 0.85 * g * ant * (1 - 0.4 * a) + entropy;
    }
    case 'back': 
      return (step === 4 || step === 12 ? 1 : 0) + (step === 15 ? 0.5 * g : 0) + entropy * 0.5;
    case 'hat': {
      
      
      const off8 = step % 4 === 2 ? 1 : 0, on8 = q === 0 ? 0.62 : 0, six = step % 2 ? 0.25 + 0.35 * a : 0;
      return off8 + on8 + six + entropy;
    }
    case 'ghost': 
      return step % 2 ? (0.45 + 0.4 * g) * (ant + (metricWeight(step - 1) >= 0.6 ? 0.6 : 0)) + entropy : 0;
    case 'open': 
      return step % 4 === 2 ? 0.7 + 0.3 * (step === 14 ? 1 : a) : 0;
    default: return 0;
  }
}


export function hitVelocity(voice, step, p, entropy = 0) {
  const V = VOICES[voice], L = clamp01((p.density - V.entry) / V.span);
  if (L <= 0) return 0;
  const s = salience(voice, step, p.arousal, p.groove, entropy);
  
  
  const clear = clamp01((s - (1 - (1 - FLOOR) * L)) / 0.3);
  if (clear <= 0) return 0;
  const accent = 0.55 + 0.45 * metricWeight(step) * (0.5 + 0.5 * p.arousal);
  const scale = voice === 'ghost' ? 0.35 : voice === 'open' ? 0.6 : 1;
  return clear * accent * scale;
}




export function planBar(bar, p, { seed = 1, fill = 0, only = null, master = 1 } = {}) {
  const ev = [], stepDur = 60 / p.bpm / 4;
  const swingOff = (2 * p.swing - 1) * stepDur;          
  for (const voice of Object.keys(VOICES)) {
    if (only && !only.includes(voice)) continue;
    for (let step = 0; step < STEPS; step++) {
      const ent = (hash01(seed, bar, step, voice.length) - 0.5) * 0.24 * p.groove;
      let vel = hitVelocity(voice, step, p, ent);
      
      if (fill > 0 && step >= 12 && (voice === 'back' || voice === 'ghost')) vel = Math.max(vel, fill * (0.4 + 0.15 * (step - 12)) * (step % 2 ? 0.7 : 1));
      vel *= master;
      if (vel < 0.03) continue;
      let offset = step % 2 ? swingOff : 0;
      if (voice !== 'kick') offset += p.layBack * (voice === 'back' ? 1 : 0.6);
      offset += p.jitter * (hash01(seed, bar, step, 7 + voice.length) - 0.5) * (voice === 'kick' ? 0.3 : 1) * 2;
      ev.push({ voice, step, vel: Math.min(1, vel), offset: Math.max(0, offset) });
    }
  }
  return ev;
}



export const MEMBRANE = [1, 1.594, 2.136, 2.296, 2.653];

export const METAL = [1, Math.SQRT2, Math.sqrt(3), Math.sqrt(5), Math.sqrt(7), Math.sqrt(11)];
export function kitAt(v) {
  const [ar, , te, sp, gr, gn] = v.map(clamp01);
  return {
    kick: {
      f0: 90 + 140 * ar,                    
      f1: 58 - 16 * (1 - gn),               
      sweep: 0.012 + 0.03 * (1 - ar),       
      decay: 0.12 + 0.35 * (1 - ar) * (1 - 0.5 * gr) + 0.1 * sp,
      click: 0.08 + 0.5 * gn * ar,          
      drive: 1 + 3 * gn,
    },
    back: {
      f0: 150 + 90 * gn,                    
      tone: 0.6 - 0.35 * gn,                
      noiseBand: 1200 + 3500 * gn,
      decay: 0.09 + 0.18 * (1 - ar) + 0.08 * sp,
      claps: smooth(0.4, 0.9, ar * (0.5 + 0.5 * gr)), 
    },
    hat: { base: 320 + 220 * gn, hp: 6500 + 3500 * gn, closed: 0.025 + 0.05 * (1 - ar), open: 0.18 + 0.3 * sp, level: 0.5 + 0.2 * te },
  };
}


export class DrumVoices {
  constructor(ctx, out) {
    this.ctx = ctx; this.hits = 0;
    this.bus = ctx.createGain(); this.bus.gain.value = 0.7; this.bus.connect(out);
    const n = ctx.sampleRate, b = ctx.createBuffer(1, n, n), d = b.getChannelData(0);
    let s = 0x2f6b1d3; for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; d[i] = ((s >>> 0) / 4294967296) * 2 - 1; }
    this.noise = b;
  }
  #env(param, t, peak, attack, tau, end) {
    param.setValueAtTime(0, t); param.linearRampToValueAtTime(peak, t + attack);
    param.setTargetAtTime(0, t + attack, tau); param.setTargetAtTime(0, end - 0.012, 0.003);
  }
  #noise(t, end, offset) { const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.loop = true; s.start(t, offset % 0.9); s.stop(end); return s; }
  hit(voice, t, vel, kit) {
    const ctx = this.ctx, g = ctx.createGain(); g.connect(this.bus); this.hits++;
    const done = [];
    if (voice === 'kick') {
      const k = kit.kick, end = t + k.decay * 4;
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(k.f0, t); o.frequency.setTargetAtTime(k.f1, t, k.sweep);
      const a = ctx.createGain(); this.#env(a.gain, t, 0.9 * vel, 0.001, k.decay, end); o.connect(a); a.connect(g);
      o.start(t); o.stop(end); done.push(o);
      const n = this.#noise(t, t + 0.02, t * 7.3), f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 3000; f.Q.value = 0.8;
      const c = ctx.createGain(); this.#env(c.gain, t, k.click * vel, 0.0005, 0.003, t + 0.02); n.connect(f); f.connect(c); c.connect(g);
    } else if (voice === 'back' || voice === 'ghost') {
      const b = kit.back, end = t + b.decay * 4 + 0.05, lvl = vel * 0.55;
      MEMBRANE.slice(0, 3).forEach((r, i) => {
        const o = ctx.createOscillator(); o.frequency.value = b.f0 * r; const a = ctx.createGain();
        this.#env(a.gain, t, lvl * b.tone * (1 - b.claps) / (1 + i), 0.001, b.decay * (0.6 - 0.12 * i), end); o.connect(a); a.connect(g); o.start(t); o.stop(end); done.push(o);
      });
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = b.noiseBand; f.Q.value = 0.7 + 0.8 * b.claps; f.connect(g);
      const bursts = 1 + Math.round(3 * b.claps);       
      for (let i = 0; i < bursts; i++) {
        const t0 = t + i * 0.009, last = i === bursts - 1, n = this.#noise(t0, end, t * 3.1 + i), a = ctx.createGain();
        this.#env(a.gain, t0, lvl * (1 - b.tone * (1 - b.claps)) * (last ? 1 : 0.7), 0.0008, last ? b.decay : 0.006, end); n.connect(a); a.connect(f);
      }
    } else {
      const h = kit.hat, dec = voice === 'open' ? h.open : h.closed, end = t + dec * 5 + 0.02;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = h.hp; hp.connect(g);
      const a = ctx.createGain(); this.#env(a.gain, t, vel * 0.12 * h.level, 0.0008, dec, end); a.connect(hp);
      for (const r of METAL) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = h.base * r * 2; o.connect(a); o.start(t); o.stop(end); done.push(o); }
    }
    if (done.length) done[0].onended = () => { try { g.disconnect(); } catch {   } };
  }
}
