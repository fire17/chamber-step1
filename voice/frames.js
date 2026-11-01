


































import { captureFrame, captureSized, FRAMES } from './look.js';

export { FRAMES };


export const FRAME_DEFAULTS = Object.freeze({
  fpsMax: 2, 
  maxHeld: 30, 
  pruneGapS: 10, 
  queueKeep: 2, 
  speechHoldS: 30, 
  lookMaxW: 512, 
  labels: Object.freeze({ rendered: 'the screen as rendered, not the camera, not a turn', look: 'camera, the closer look you asked for, not a turn' }),
});
export const frameDef = (def = FRAMES) => ({ ...FRAME_DEFAULTS, ...def, labels: { ...FRAME_DEFAULTS.labels, ...(def?.labels || {}) } });

const monotonic = () => (globalThis.performance?.now ? globalThis.performance.now() / 1000 : Date.now() / 1000);


export function frameEvent(id, text, dataUrl) {
  return { type: 'conversation.item.create', item: { id, type: 'message', role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: dataUrl }] } };
}

export class FrameFeed {
  
  
  
  
  
  constructor({ send, sources = {}, presence = () => false, maxMessageSize = () => null, clock = monotonic, seq = null, onBurst = null,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h), doc = globalThis.document, def = FRAMES, trace = null } = {}) {
    Object.assign(this, { send, presence, maxMessageSize, clock, setTimer, clearTimer, doc, trace, onBurst });
    this.def = frameDef(def);
    let own = 0; this.seq = typeof seq === 'function' ? seq : () => ++own;
    this.t0 = clock(); this.held = []; this.timers = new Map(); this.last = new Map(); this.canvas = null; this.stopped = false;
    this.els = { ...sources }; this.fps = {}; this.expired = []; this.queue = []; this.lastBurst = -Infinity;
    this.paused = null; this.speaking = false; this.speechAt = 0;
    this.counts = { sent: 0, skipped: 0, bytes: 0, deleted: 0, lines: 0, why: {} };
    const on = [];
    for (const [name, src] of Object.entries(this.def.sources || {})) {
      const fps = this.#clampFps(src?.fps); this.fps[name] = fps;
      if (!(fps > 0) || !this.els[name]) continue;
      on.push(`${name}@${fps}`); this.#arm(name);
    }
    this.#trace('frames.on', { sources: on.join(' ') || 'none', keep: this.def.keep, pruneAt: this.def.pruneAt }); 
  }
  #clampFps(f) { return Number.isFinite(f) && f > 0 ? Math.min(f, this.def.fpsMax) : 0; }
  #trace(kind, f) { try { this.trace?.push?.(kind, f); } catch {} }
  #arm(name) {
    if (this.stopped || this.timers.has(name) || !(this.fps[name] > 0)) return;
    this.timers.set(name, this.setTimer(() => { this.timers.delete(name); this.#tick(name); this.#arm(name); }, 1000 / this.fps[name]));
  }
  #disarm(name) { const h = this.timers.get(name); if (h !== undefined) { try { this.clearTimer(h); } catch {} this.timers.delete(name); } }
  #skip(why) {
    const c = this.counts; c.skipped++;
    if (!c.why[why]) this.#trace('frames.skip', { why }); 
    c.why[why] = (c.why[why] || 0) + 1;
  }
  #cap() {
    let m = null; try { m = this.maxMessageSize?.(); } catch { m = null; }
    return Number.isFinite(m) && m > 0 ? Math.min(this.def.maxBytes, m - this.def.sctpMarginB) : this.def.maxBytes;
  }
  #here(src) { if (!src?.needsPresence) return true; try { return !!this.presence?.(); } catch { return false; } }
  #scratch() { if (!this.canvas) { try { this.canvas = this.doc?.createElement ? this.doc.createElement('canvas') : null; } catch { this.canvas = null; } } return this.canvas; }
  #label(name, src) { return src?.label ?? this.def.labels[name] ?? (name === 'camera' ? this.def.label : `${name}, not a turn`); }
  #stamp(t, n, kind, label) { return `[t+${(t - this.t0).toFixed(1)} #${n} ${kind}] ${label}`; }
  #wipeQueue() { for (const q of this.queue) q.url = ''; this.queue = []; }

  #tick(name) {
    if (this.stopped || typeof this.send !== 'function') return;
    if (this.paused) return this.#skip('paused');
    if (this.speaking && this.clock() - this.speechAt > this.def.speechHoldS) this.#speechEnd('hold'); 
    const el = this.els[name], src = this.def.sources?.[name];
    if (!el) return this.#skip('no source');
    if (!this.#here(src)) return this.#skip('no one in frame');
    if ('currentTime' in el) { 
      const ct = el.currentTime;
      if (this.last.has(name) && ct === this.last.get(name)) return this.#skip('no new frame');
      this.last.set(name, ct);
    }
    if (!this.speaking && this.held.length >= this.def.maxHeld) { this.#prune(); if (this.held.length >= this.def.maxHeld) return this.#skip('window full'); }
    const d = this.def;
    const f = captureFrame({ el, presence: null, maxW: d.maxW, quality: d.quality, maxBytes: this.#cap(), doc: this.doc, canvas: this.#scratch() });
    if (!f.ok) return this.#skip(f.why);
    const t = this.clock(), label = this.#label(name, src);
    let url = f.dataUrl; f.dataUrl = '';
    if (this.speaking) { 
      this.queue.push({ t, label, url, bytes: f.bytes }); url = '';
      while (this.queue.length > Math.max(0, d.queueKeep)) { this.queue.shift().url = ''; this.#skip('dropped while speaking'); }
      return;
    }
    this.#post(t, 'frame', label, url, f.bytes); url = '';
  }
  
  #post(t, kind, label, url, bytes) {
    if (this.held.length >= this.def.maxHeld) { this.#prune(); if (this.held.length >= this.def.maxHeld) { this.#skip('window full'); return null; } } 
    const n = this.seq(), id = `fr_${n}`; 
    let sent = false;
    try { sent = this.send(frameEvent(id, this.#stamp(t, n, kind, label), url)) !== false; } catch { sent = false; }
    url = ''; 
    if (!sent) { this.#skip('not sent'); return null; }
    this.counts.sent++; this.counts.bytes += bytes;
    this.held.push(id);
    if (this.held.length >= this.def.pruneAt) this.#prune();
    return { id, n };
  }
  #prune(force = false) { 
    const now = this.clock();
    if (now - this.lastBurst < this.def.pruneGapS) return false;
    const drop = (force || this.held.length >= this.def.pruneAt || this.held.length >= this.def.maxHeld) ? this.held.splice(0, Math.max(0, this.held.length - this.def.keep)) : [];
    const lines = this.expired.splice(0);
    if (!drop.length && !lines.length) return false;
    this.lastBurst = now;
    for (const item_id of [...drop, ...lines]) { try { this.send({ type: 'conversation.item.delete', item_id }); } catch {} }
    this.counts.deleted += drop.length; this.counts.lines += lines.length;
    this.#trace('frames.burst', { frames: drop.length, lines: lines.length });
    try { this.onBurst?.({ frames: drop.length, lines: lines.length }); } catch {}
    return true;
  }
  #speechStart() { if (!this.speaking) { this.speaking = true; this.speechAt = this.clock(); } }
  #speechEnd(why) {
    if (!this.speaking) return;
    this.speaking = false;
    const q = this.queue; this.queue = [];
    if (this.stopped || this.paused) { for (const x of q) x.url = ''; return; }
    for (const x of q) { const url = x.url; x.url = ''; this.#post(x.t, 'frame', x.label, url, x.bytes); }
    if (why === 'hold') this.#trace('frames.flush', { why });
  }

  
  
  onEvent(ev) {
    switch (ev?.type) {
      case 'input_audio_buffer.speech_started': return this.#speechStart();
      case 'input_audio_buffer.committed': case 'input_audio_buffer.cleared': return this.#speechEnd('commit');
      default: return undefined;
    }
  }
  pause(why = 'paused') { if (this.stopped || this.paused) return; this.paused = String(why); this.#wipeQueue(); this.#trace('frames.pause', { why: this.paused }); }
  resume() { if (this.stopped || !this.paused) return; this.paused = null; this.last.clear(); this.#trace('frames.resume', {}); }
  setFps(name, fps) {
    if (this.stopped || !(name in (this.def.sources || {}))) return false;
    this.fps[name] = this.#clampFps(fps); this.#disarm(name);
    if (this.els[name]) this.#arm(name);
    this.#trace('frames.fps', { source: name, fps: this.fps[name] });
    return this.fps[name];
  }
  expire(ids) { 
    if (this.stopped) return 0;
    let k = 0;
    for (const id of Array.isArray(ids) ? ids : [ids]) if (typeof id === 'string' && id && id.length <= 32 && !this.expired.includes(id)) { this.expired.push(id); k++; }
    return k;
  }
  burst() { return this.stopped ? false : this.#prune(true); }
  
  
  look() {
    if (this.stopped || typeof this.send !== 'function') return { ok: false, why: 'the look is off' };
    if (this.paused) return { ok: false, why: 'paused' };
    const el = this.els.camera, src = this.def.sources?.camera;
    if (!el) return { ok: false, why: 'no camera' };
    if (!this.#here(src)) return { ok: false, why: 'no one in view' };
    if (this.held.length >= this.def.maxHeld) { this.#prune(); if (this.held.length >= this.def.maxHeld) return { ok: false, why: 'window full' }; }
    const d = this.def;
    const f = captureSized({ el, presence: null, widths: [d.lookMaxW, d.maxW], quality: d.quality, maxBytes: this.#cap(), doc: this.doc, canvas: this.#scratch() });
    if (!f.ok) return { ok: false, why: f.why };
    let url = f.dataUrl; f.dataUrl = '';
    const r = this.#post(this.clock(), 'look', this.#label('look'), url, f.bytes); url = '';
    if (!r) return { ok: false, why: 'not connected' };
    return { ok: true, sent: true, id: r.id, n: r.n, w: f.w, h: f.h, bytes: f.bytes, fallback: f.fallback, speaking: this.speaking };
  }
  stats() {
    const c = this.counts;
    return { sent: c.sent, skipped: c.skipped, bytes: c.bytes, deleted: c.deleted, lines: c.lines, held: this.held.length, queued: this.queue.length,
      paused: !!this.paused, speaking: this.speaking, why: { ...c.why } };
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const h of this.timers.values()) { try { this.clearTimer(h); } catch {} }
    this.timers.clear(); this.#wipeQueue(); this.held = []; this.expired = []; this.last.clear(); this.canvas = null;
    const s = this.stats(); this.#trace('frames.off', { sent: s.sent, skipped: s.skipped, bytes: s.bytes, deleted: s.deleted });
  }
}
