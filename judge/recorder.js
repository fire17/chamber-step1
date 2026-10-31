










import { createSessionLog } from './session-log.js';

export function startRecorder({ chamber = globalThis.__chamber, soundEvery = 0.25, maxFrames = 20 * 60 * 30, meta = {} } = {}) {
  if (!chamber?.bus) throw new Error('recorder: window.__chamber is not ready (load the room first)');
  const bus = chamber.bus;
  const log = createSessionLog(bus, { bindings: chamber.bindings ?? bus.state.bindings, meta: { kind: 'browser', url: location.href, userAgent: navigator.userAgent, startedAt: new Date().toISOString(), ...meta } });
  
  
  
  
  let nextSound = 0, stopped = false, dropped = 0, errors = 0, warned = false;
  const r = (v) => (typeof v === 'number' ? +v.toFixed(4) : v);
  const onFrame = (d) => { try { step(d); } catch (e) { if (!errors++) console.warn('[recorder] frame failed (counted in meta.frameErrors)', e); } };
  const step = ({ dt, dr } = {}) => {
    if (stopped) return;
    if (log.rec.frames.length < maxFrames) log.frame({ dt, dr }); else dropped++;
    const run = bus.state.runT;
    if (run >= nextSound) {
      const live = chamber.live?.();
      if (live) {
        const f = chamber.features?.() || {};
        log.sound({ cutoff: Math.round(live.cutoff), swell: r(live.swell), pan: r(live.pan), voicing: chamber.state?.zone, notes: live.notes?.join(' '), detune: r(live.detune), reverbWet: r(live.reverbWet), vibrato: r(live.vibrato), tremolo: r(live.tremolo), rms: r(chamber.rms?.() ?? null), hands: (f.A ? 1 : 0) + (f.B ? 1 : 0), body: !!f.body });
      }
      nextSound = run + soundEvery;
    }
  };
  const offFrame = bus.on('frame', onFrame);
  const api = {
    get recording() { return !stopped; },
    record() {
      if (!log.rec.frames.length && !warned) { warned = true; console.warn("[recorder] 0 frames: this build emits no bus 'frame' (judge/HOOK.md H3)"); }
      return log.finish({ droppedFrames: dropped, frameErrors: errors, frameSource: 'bus', endedAt: new Date().toISOString() });
    },
    stop() { if (!stopped) { stopped = true; offFrame(); log.detach(); } return api.record(); },
    json() { return JSON.stringify(api.record()); },
    download(name = `chamber-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`) {
      const url = URL.createObjectURL(new Blob([api.json()], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return name;
    },
  };
  return api;
}
