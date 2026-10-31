






import { STORY, readSource } from './mappings.js';


const PRESENCE = (STORY.presence || [['body', 'person', 'body.pose'], ['A', 'hand A', 'A.present'], ['B', 'hand B', 'B.present']])
  .map(([k, label, path]) => { const [g, f] = path.split('.'); return [k, label, (i) => !!i[g]?.[f]]; });

export class BodyStory {
  constructor(bus = null, def = STORY) { this.bus = bus; this.def = def; this.reset(); }
  reset() { this.n = 0; this.ch = {}; this.obs = []; this.open = {}; this.present = {}; }
  cfg(ch) { return { ...this.def, mode: 'change', ...(this.def.channels[ch] || {}) }; }
  channels() { return Object.keys(this.def.channels); }
  #push(o) {
    o.id = `o${++this.n}`; this.obs.push(o);
    if (this.obs.length > this.def.ring) this.obs.splice(0, this.obs.length - this.def.ring);
    this.bus?.emit('obs.open', o);
    return o;
  }
  #close(ch, t, why) { const o = this.open[ch]; if (!o) return; o.t1 = t; o.end = why; delete this.open[ch]; this.bus?.emit('obs.close', o); }
  
  update(inputs, t) {
    for (const [k, label, seen] of PRESENCE) {
      const on = seen(inputs);
      if (on === !!this.present[k]?.on) continue;
      if (this.present[k]?.obs) { this.present[k].obs.t1 = t; this.bus?.emit('obs.close', this.present[k].obs); }
      this.present[k] = { on, obs: this.#push({ ch: k, kind: on ? 'seen' : 'gone', label, t0: t }) };
    }
    for (const ch of this.channels()) {
      const c = this.cfg(ch), v = readSource(inputs, ch);
      const s = (this.ch[ch] ||= { act: 0, v: null, pt: null, lastMove: -Infinity });
      if (v == null) { this.#close(ch, t, 'lost'); Object.assign(s, { v: null, pt: null, act: 0 }); continue; }
      if (c.mode === 'level') s.act = v;
      else if (s.v != null && t > s.pt) { const dt = t - s.pt; s.act += (Math.abs(v - s.v) / dt - s.act) * (1 - Math.exp(-dt / c.tc)); }
      s.v = v; s.pt = t;
      let o = this.open[ch];
      if (!o && s.act >= c.on) o = this.open[ch] = this.#push({ ch, kind: 'moving', label: c.label, t0: t, peak: s.act, from: +v.toFixed(3) });
      else if (o && s.act < c.off) { this.#close(ch, t, 'settled'); o = null; }
      if (o) { o.peak = Math.max(o.peak, s.act); o.to = +v.toFixed(3); s.lastMove = t; }
    }
  }
  moving(ch) { return this.open[ch] || null; }
  
  salience(ch) { return (this.ch[ch]?.act ?? 0) / this.cfg(ch).on; }
  quietFor(ch, t) { const s = this.ch[ch]; return s ? t - s.lastMove : Infinity; }
  presence(k) { return this.present[k]?.on ? this.present[k].obs : null; }
  
  
  get(id) {
    if (typeof id !== 'string' || !/^o\d+$/.test(id)) return null;
    return this.obs.find((o) => o.id === id) || Object.values(this.open).find((o) => o.id === id)
      || Object.values(this.present).map((p) => p.obs).find((o) => o?.id === id) || null;
  }
  isOpen(o) { return !!o && o.t1 == null; }
  recent(n = 12) { return this.obs.slice(-n); }
  snapshot(n = 24) { return { open: Object.values(this.open).map((o) => ({ ...o })), recent: this.recent(n).map((o) => ({ ...o })) }; }
}
