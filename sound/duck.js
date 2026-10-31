
















export const BROAD_DB = -4;
export const PRESENCE_DB = -6;
export const PRESENCE_HZ = 2000, PRESENCE_Q = 0.7; 
export const ATTACK = 0.04, RELEASE = 0.35, HOLD = 0.3; 
export const OPEN_DB = -42, CLOSE_DB = -50; 
export const CHARS_PER_SECOND = 15; 

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const dbToGain = (d) => Math.pow(10, d / 20);


export function speechSeconds(text) { return clamp(String(text ?? '').length / CHARS_PER_SECOND, 0.8, 20); }

export class Duck {
  constructor(ctx) {
    this.ctx = ctx;
    
    
    
    this.gain = ctx.createGain(); this.gain.gain.value = 1;
    this.band = ctx.createBiquadFilter(); this.band.type = 'bandpass'; this.band.frequency.value = PRESENCE_HZ; this.band.Q.value = PRESENCE_Q;
    this.cut = ctx.createGain(); this.cut.gain.value = 0;
    this.gain.connect(this.band); this.band.connect(this.cut);
    this.input = this.gain;
    this.manual = 0; this.until = 0; this.timed = 0; this.keyOpen = false; this.lastLoud = -1;
    this.analyser = null; this.buf = null; this.level = 0; this.used = false; this.keyDb = -Infinity;
  }
  connect(dest) { this.gain.connect(dest); this.cut.connect(dest); return dest; }
  
  target(now = this.ctx.currentTime) { return Math.max(this.manual, this.keyOpen ? 1 : 0, now < this.until ? this.timed : 0); }
  #glide(now, force = false) {
    const a = this.target(now);
    if (a === this.level && !force) return;
    const tc = a >= this.level ? ATTACK : RELEASE;
    this.level = a; this.used = true;
    const g = this.gain.gain, p = this.cut.gain, k = (x) => -(1 - dbToGain(PRESENCE_DB * x)); 
    g.cancelScheduledValues(now); g.setTargetAtTime(dbToGain(BROAD_DB * a), now, tc);
    p.cancelScheduledValues(now); p.setTargetAtTime(k(a), now, tc);
    
    const after = Math.max(this.manual, this.keyOpen ? 1 : 0);
    if (now < this.until && after < a) { g.setTargetAtTime(dbToGain(BROAD_DB * after), this.until, RELEASE); p.setTargetAtTime(k(after), this.until, RELEASE); }
  }
  set(amount) { this.manual = clamp(+amount || 0, 0, 1); this.#glide(this.ctx.currentTime); }
  hold(seconds, amount = 1) {
    const now = this.ctx.currentTime;
    this.until = Math.max(this.until, now + clamp(+seconds || 0, 0, 60)); this.timed = Math.max(now < this.until ? this.timed : 0, clamp(+amount || 0, 0, 1));
    this.#glide(now, true); 
  }
  
  key(node) {
    this.unkey();
    const an = this.ctx.createAnalyser(); an.fftSize = 1024; node.connect(an);
    this.analyser = an; this.keyNode = node; this.buf = new Float32Array(an.fftSize);
    return () => this.unkey();
  }
  unkey() {
    if (this.analyser) { try { this.keyNode.disconnect(this.analyser); } catch {} }
    this.analyser = null; this.keyNode = null; this.keyOpen = false; this.#glide(this.ctx.currentTime);
  }
  
  tick(now = this.ctx.currentTime) {
    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.buf);
      let s = 0; for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
      const db = (this.keyDb = 10 * Math.log10(s / this.buf.length + 1e-24));
      if (db > (this.keyOpen ? CLOSE_DB : OPEN_DB)) { this.keyOpen = true; this.lastLoud = now; }
      else if (this.keyOpen && now - this.lastLoud > HOLD) this.keyOpen = false;
    }
    if (this.analyser || this.level !== 0 || this.until > 0) this.#glide(now);
  }
  snapshot() { return { level: this.level, keyed: !!this.analyser, keyOpen: this.keyOpen, keyDb: +this.keyDb.toFixed(1), gain: this.gain.gain.value, presenceDb: +(20 * Math.log10(1 + this.cut.gain.value)).toFixed(2) }; }
}
