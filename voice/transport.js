// Swappable voice TRANSPORT. Everything above this (session.js: turns, tool allowlist, verbs, say) is transport-agnostic.
//
// Interface (both classes):
//   await t.connect(ticket)      open; resolves when the event channel is usable. Throws Error{status, fallback?}.
//   t.send(event)                a realtime client event (object)
//   t.on(name, fn) -> off        'event' (server event object) · 'status' ({state,...}) · 'close' ({code, why})
//   await t.close()              idempotent; hangs up / closes and releases mic + peer
//   t.start()                    the person's Start tap (the only room-speaks-first trigger)
//   t.setPhase(name)             tell the SERVER the phase; it re-pins instructions + tools (browser never sends session.update)
//   t.scene(text)                a scene note (labels + observation ids; no frames, no landmarks) as context, never a response
//   audio hooks:                 t.kind ('webrtc' | 'relay-ws'); webrtc: opts.mic (MediaStream) + 'remote-track' event;
//                                relay-ws: t.appendAudio(base64Pcm16) + 'audio' event (base64 PCM16 delta)
//
// PRIMARY  WebRtcTransport: SDP offer -> POST ${origin}/v1/realtime/calls (Bearer ticket, x-chamber-device) -> raw SDP 201
//          + Location handle. Media browser<->model direct. Events on the 'oai-events' datachannel. Server-side the core
//          holds a sideband WS (?call_id=) for pinning, tool gating, cutoff, ledger. Hangup = POST <Location>/hangup with the
//          SAME Authorization: Bearer <ticket> + x-chamber-device as the call (the gateway accepts the call's ticket past its
//          exp for this; a relative Location resolves against the origin). Never a call to Location itself.
// FALLBACK RelayWsTransport: WS ${wsOrigin}/v1/realtime, subprotocols ['chamber.v1', 'ticket.<t>', 'device.<id>'].

class Emitter {
  constructor() { this.subs = {}; }
  on(n, fn) { (this.subs[n] ||= []).push(fn); return () => { this.subs[n] = this.subs[n].filter((f) => f !== fn); }; }
  emit(n, d) { for (const fn of this.subs[n] || []) { try { fn(d); } catch (e) { console.warn('[voice]', n, e); } } }
}
const err = (msg, extra = {}) => Object.assign(new Error(msg), extra);

// The call trace: a ring buffer of the last `cap` timestamped transitions (peer + ICE states, datachannel open/close/error,
// each fetch's PATH + status, every close/stop/hangup with its stage and why). It is what explains a dropped call.
// It NEVER holds a ticket, a gateKey, a header, an SDP body or a password: fetches record the path only (the opaque call
// handle masked as :h), and every string is scrubbed again on the way in (belt and braces).
const SCRUB = /(Bearer\s*\S*|cht_[A-Za-z0-9._-]*|v=0[^]*)/g;
const clean = (v) => (typeof v === 'string' ? v.replace(SCRUB, '[redacted]').slice(0, 160) : v);
export const tracePath = (u) => String(u ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0].replace(/(\/calls\/)[^/]+/, '$1:h') || '/';
export function createTrace(cap = 200, now = () => Date.now()) {
  const buf = [], subs = new Set();
  const t0 = now();
  return {
    push(kind, fields = {}) {
      const rec = { t: now(), dt: now() - t0, kind: clean(String(kind)) };
      for (const [k, v] of Object.entries(fields)) if (v !== undefined && (v === null || typeof v !== 'object')) rec[k] = clean(v);
      buf.push(rec); if (buf.length > cap) buf.splice(0, buf.length - cap);
      for (const fn of subs) { try { fn(rec); } catch {} }
      return rec;
    },
    list: () => buf.map((r) => ({ ...r })),
    text: () => JSON.stringify(buf, null, 0).replace(/\},\{/g, '},\n{'),
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    get size() { return buf.length; },
  };
}

export class WebRtcTransport extends Emitter {
  // opts: { origin, device, mic?: MediaStream, RTCPeerConnection?, fetchImpl?, iceTimeoutMs?, graceMs?, trace? }
  //   graceMs: how long a 'disconnected' peer may stay so before the call is failed (ICE often recovers); 'failed' fails at once.
  constructor(opts) {
    super(); this.kind = 'webrtc';
    this.o = { fetchImpl: globalThis.fetch?.bind(globalThis), RTCPeerConnection: globalThis.RTCPeerConnection, iceTimeoutMs: 3000, graceMs: 5000, ...opts };
    this.trace = this.o.trace || createTrace(); this.closed = false; this.graceTimer = null;
  }
  async #fetch(stage, u, init) { // every fetch is traced by PATH + status only (never headers, bodies or tickets)
    try { const r = await this.o.fetchImpl(u, init); this.trace.push('fetch', { stage, path: tracePath(u), status: r?.status ?? 0 }); return r; }
    catch (e) { this.trace.push('fetch', { stage, path: tracePath(u), status: 0, msg: 'unreachable' }); throw e; }
  }
  #peerState(pc) {
    const st = pc.connectionState;
    this.trace.push('pc.connectionState', { state: st });
    if (this.closed) return;
    if (st === 'failed') { this.#clearGrace(); this.#fail(1006, 'peer failed'); return; }
    if (st === 'closed') { this.#clearGrace(); this.#fail(1006, 'peer closed'); return; } // a peer closed under us (not by close())
    if (st === 'connected') { if (this.graceTimer) this.trace.push('pc.recovered', { state: st }); this.#clearGrace(); return; }
    // 'connecting'/'new' after 'disconnected' keeps the armed grace running (still not connected); only 'connected' clears it.
    if (st === 'disconnected' && !this.graceTimer) {
      this.trace.push('pc.grace', { ms: this.o.graceMs });
      this.graceTimer = setTimeout(() => { this.graceTimer = null; if (!this.closed && this.pc === pc && pc.connectionState !== 'connected') this.#fail(1006, `peer disconnected > ${this.o.graceMs} ms`); }, this.o.graceMs);
    }
  }
  #clearGrace() { if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; } }
  async connect(ticket) {
    const { origin, device, mic } = this.o;
    if (!origin) throw err('no voice gateway origin configured', { status: 0, fallback: true });
    if (!this.o.RTCPeerConnection) throw err('no RTCPeerConnection', { status: 0, fallback: true });
    this.ticket = ticket; // kept in memory only, for the hangup's Authorization (same caller as the call)
    const pc = this.pc = new this.o.RTCPeerConnection();
    try {
      if (mic) for (const tr of mic.getAudioTracks()) pc.addTrack(tr, mic);
      else pc.addTransceiver?.('audio', { direction: 'recvonly' });
      pc.ontrack = (e) => this.emit('remote-track', e.streams?.[0] || e.track);
      const dc = this.dc = pc.createDataChannel('oai-events');
      dc.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } this.emit('event', ev); };
      dc.onclose = () => { this.trace.push('dc.close', {}); if (!this.closed) this.#fail(1006, 'datachannel closed'); };
      dc.onerror = (e) => { this.trace.push('dc.error', { msg: String(e?.error?.message || e?.message || 'error') }); };
      dc.onopen = () => this.trace.push('dc.open', {});
      pc.onconnectionstatechange = () => this.#peerState(pc);
      pc.oniceconnectionstatechange = () => this.trace.push('pc.iceConnectionState', { state: pc.iceConnectionState });
      await pc.setLocalDescription(await pc.createOffer());
      const sdp = pc.localDescription.sdp;
      let r;
      try {
        r = await this.#fetch('calls', `${origin}/v1/realtime/calls`, { method: 'POST', cache: 'no-store', body: sdp,
          headers: { Authorization: `Bearer ${ticket}`, 'Content-Type': 'application/sdp', 'x-chamber-device': device } });
      } catch (e) { throw err('calls unreachable', { status: 0, fallback: true }); }
      if (r.status !== 201) { await r.text().catch(() => ''); throw err(`calls ${r.status}`, { status: r.status, fallback: r.status >= 500 || r.status === 404 }); }
      const ct = r.headers.get('content-type') || '', loc = r.headers.get('location') || '';
      // the opaque handle; hangup = <location>/hangup. Kept BEFORE body validation so a bad answer still frees the call.
      // The Bearer ticket follows this Location (hangup, phase), so it must stay on the gateway's own origin.
      const where = loc ? new URL(loc, origin) : null;
      if (where && where.origin !== new URL(origin).origin) throw err('calls Location is off the gateway origin', { status: 201, fallback: true });
      if (where) this.location = where.toString();
      const answer = await r.text();
      if (!/application\/sdp/i.test(ct) || !answer.startsWith('v=0')) throw err('calls answer is not raw SDP', { status: 201, fallback: true });
      if (!loc) throw err('calls answer has no Location', { status: 201, fallback: true });
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      await this.#dcOpen();
      this.trace.push('connected', { transport: this.kind });
      this.emit('status', { state: 'ready', transport: this.kind });
    } catch (e) { this.trace.push('connect.error', { stage: 'connect', msg: String(e?.message || e), status: e?.status ?? null }); await this.#teardown('connect failed'); throw e; }
  }
  #dcOpen() {
    if (this.dc.readyState === 'open') return Promise.resolve();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(err('datachannel open timeout', { status: 0, fallback: true })), this.o.iceTimeoutMs);
      const prev = this.dc.onopen; this.dc.onopen = (e) => { clearTimeout(t); prev?.(e); res(); };
    });
  }
  send(ev) { if (this.dc?.readyState === 'open') { this.dc.send(JSON.stringify(ev)); return true; } return false; }
  start() { return this.send({ type: 'response.create' }); }
  // scene notes (labels + ids only) as context, no response. [unverified: system-role conversation items]
  scene(text) { return this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `[scene] ${text}` }] } }); }
  // Phase re-pin: POST <Location>/phase (the Location the 201 returned, already resolved against the origin; the same
  // place hangup goes), body {phase, why} + 'name' (kept ONLY because the local mock voice/server/server.mjs reads .name;
  // srv2 reads {phase, why}). No fallback to any other path. Resolves {ok, status, why?}; never throws.
  // A gateway without the route answers 404: the caller (session.js) traces that as a visible degrade, not a crash.
  async setPhase(name, why = '') {
    if (!this.location) return { ok: false, status: 0, why: 'no call handle' };
    try {
      const r = await this.#fetch('phase', `${this.location}/phase`, { method: 'POST', cache: 'no-store',
        headers: { Authorization: `Bearer ${this.ticket}`, 'Content-Type': 'application/json', 'x-chamber-device': this.o.device },
        body: JSON.stringify({ phase: name, why: String(why || 'phase change').slice(0, 200), name }) });
      await r.text?.().catch(() => '');
      return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, why: `phase ${r.status}` };
    } catch { return { ok: false, status: 0, why: 'phase unreachable' }; }
  }
  async #fail(code, why) { if (this.closed) return; this.trace.push('fail', { stage: 'transport', code, why }); await this.close(why); this.emit('close', { code, why }); }
  async close(why = 'close') { if (this.closed) return; this.closed = true; this.trace.push('close', { stage: 'transport', why }); await this.#teardown(why); }
  async #teardown(why = 'teardown') {
    this.#clearGrace();
    const loc = this.location, ticket = this.ticket; this.location = null; this.ticket = null;
    if (this.dc) { this.dc.onclose = null; this.dc.onmessage = null; }
    if (this.dc) { this.dc.onerror = null; this.dc.onopen = null; }
    if (this.pc) { this.pc.onconnectionstatechange = null; this.pc.oniceconnectionstatechange = null; this.pc.ontrack = null; }
    try { this.dc?.close(); } catch {}
    try { this.pc?.getSenders?.().forEach((s) => s.track?.stop()); } catch {}
    try { this.pc?.close(); } catch {}
    this.pc = null; this.dc = null;
    if (loc) { this.trace.push('hangup', { stage: 'teardown', why }); try { const r = await this.#fetch('hangup', `${loc}/hangup`, { method: 'POST', cache: 'no-store', headers: { Authorization: `Bearer ${ticket}`, 'x-chamber-device': this.o.device } }); await r?.text?.().catch(() => ''); } catch {} }
  }
}

export class RelayWsTransport extends Emitter {
  // opts: { wsOrigin, device, WebSocketImpl?, wsOptions? (node tests only: e.g. {headers:{Origin}}) }
  constructor(opts) { super(); this.kind = 'relay-ws'; this.o = { WebSocketImpl: globalThis.WebSocket, ...opts }; this.trace = this.o.trace || createTrace(); this.closed = false; }
  connect(ticket) {
    const { wsOrigin, device, WebSocketImpl, wsOptions } = this.o;
    if (!wsOrigin) return Promise.reject(err('no relay origin configured', { status: 0 }));
    return new Promise((res, rej) => {
      const ws = this.ws = new WebSocketImpl(`${wsOrigin}/v1/realtime`, ['chamber.v1', `ticket.${ticket}`, `device.${device}`], wsOptions);
      let opened = false;
      ws.onopen = () => { opened = true; this.trace.push('ws.open', {}); this.emit('status', { state: 'open', transport: this.kind }); res(); };
      ws.onerror = () => { if (!opened) rej(err('relay ws refused', { status: 0 })); };
      ws.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.type === 'chamber.status') return this.emit('status', ev);
        if (ev.type === 'response.output_audio.delta') this.emit('audio', ev.delta);
        this.emit('event', ev);
      };
      ws.onclose = (e) => { this.closed = true; this.trace.push('ws.close', { code: e.code, why: String(e.reason || '') }); if (opened) this.emit('close', { code: e.code, why: e.reason }); else rej(err(`relay ws closed ${e.code}`, { status: 0 })); };
    });
  }
  send(ev) { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(ev)); return true; } return false; }
  start() { return this.send({ type: 'chamber.start' }); }
  setPhase(name) { return this.send({ type: 'chamber.phase', name }); }
  scene(text) { return this.send({ type: 'chamber.scene', text }); } // the relay wraps it as a context item, never a response
  appendAudio(b64) { return this.send({ type: 'input_audio_buffer.append', audio: b64 }); }
  async close(why = 'close') { if (this.closed) return; this.closed = true; this.trace.push('close', { stage: 'transport', why }); try { this.ws?.close(1000); } catch {} }
}

// Primary then fallback. A fresh single-use ticket per attempt (a ticket = one upstream session).
// getTicket: async () => ticketString.  Returns the connected transport.
export async function connectWithFallback({ getTicket, primary, fallback, onFallback = () => {} }) {
  if (primary) {
    try { await primary.connect(await getTicket()); return primary; }
    catch (e) { await primary.close?.(); if (!e.fallback || !fallback) throw e; onFallback(e); }
  }
  await fallback.connect(await getTicket());
  return fallback;
}
