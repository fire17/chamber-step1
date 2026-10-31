






import { FLOW } from './flow.js';

const ROOM_VERBS = /^(map\.|binding\.|undo$|stimulus$|phase\.set$)/; 
const short = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 48);

export class SceneFeed {
  
  constructor({ bus, send, now = () => Date.now() / 1000, def = FLOW.scene, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { bus, send, now, def, setTimer, clearTimer, open: new Map(), recentActs: [], last: '', lastT: -Infinity, timer: null, offs: [] });
    if (!bus?.on) return;
    this.offs.push(bus.on('obs.open', (o) => { if (o?.id && o.kind !== 'gone') this.open.set(o.ch, o); else if (o?.kind === 'gone') this.open.delete(o.ch); this.poke(); }));
    this.offs.push(bus.on('obs.close', (o) => { if (o?.ch && this.open.get(o.ch)?.id === o.id) this.open.delete(o.ch); this.poke(); }));
    for (const ev of ['act', 'edit']) this.offs.push(bus.on(ev, (r) => this.#act(r)));
    this.offs.push(bus.on('phase', () => this.poke()));
  }
  #act(r) {
    if (!r?.verb || !ROOM_VERBS.test(r.verb) || r.ok === false) return;
    const a = r.args || {};
    const what = r.verb === 'phase.set' ? `phase -> ${short(a.name)}` : `${r.verb} ${short(a.id ?? a.what ?? a.target ?? '')}`.trim();
    this.recentActs.push(what); if (this.recentActs.length > 3) this.recentActs.shift();
    this.poke();
  }
  text() {
    const s = this.bus?.state || {}, d = this.def;
    const seen = [...this.open.values()].slice(-d.maxItems).map((o) => `${o.id} ${short(o.label || o.ch)}${o.kind === 'seen' ? ' (present)' : ''}`);
    const rd = s.readiness;
    const parts = [
      `phase ${s.phase?.name ?? '?'}`,
      seen.length ? `now: ${seen.join(', ')}` : 'now: nothing moving',
      this.recentActs.length && `room just: ${this.recentActs.join('; ')}`,
      rd && `readouts: ${Math.round(rd.inPhase)} s in phase, ${rd.arms} arms, ${rd.turns} turns, still ${Math.round(rd.stillFor)} s, opening cues ${rd.cuesDone ? 'done' : 'running'}`,
    ];
    return parts.filter(Boolean).join(' | ').slice(0, d.maxChars);
  }
  poke() {
    if (this.timer) return; 
    const wait = Math.max(0, this.lastT + this.def.minGapS - this.now());
    this.timer = this.setTimer(() => this.flush(), wait * 1000);
  }
  flush() {
    this.timer = null;
    const t = this.text();
    if (t === this.last) return false;
    this.last = t; this.lastT = this.now(); this.send(t);
    return true;
  }
  stop() { if (this.timer) this.clearTimer(this.timer); this.timer = null; for (const off of this.offs) off?.(); this.offs = []; }
}
