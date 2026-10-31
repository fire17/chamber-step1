




export function definePcm16Worklet() {
  class Pcm16Out extends AudioWorkletProcessor {
    constructor() { super(); this.ratio = sampleRate / 24000; this.pos = 0; this.buf = new Int16Array(2400); this.n = 0; this.prev = 0; }
    process(inputs) {
      const ch = inputs[0]?.[0];
      if (!ch) return true;
      while (this.pos < ch.length) {
        const i = Math.floor(this.pos), f = this.pos - i;
        const a = i === 0 ? this.prev : ch[i - 1], b = ch[i] ?? a;
        const s = Math.max(-1, Math.min(1, a + (b - a) * f));
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
        this.pos += this.ratio;
      }
      this.pos -= ch.length; this.prev = ch[ch.length - 1];
      return true;
    }
  }
  registerProcessor('chamber-pcm16', Pcm16Out);
}
if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') definePcm16Worklet();
