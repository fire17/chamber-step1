



















import { KINDS } from './kinds.js'; 

class Emitter {
  constructor() { this.subs = {}; }
  on(n, fn) { (this.subs[n] ||= []).push(fn); return () => { this.subs[n] = this.subs[n].filter((f) => f !== fn); }; }
  emit(n, d) { for (const fn of this.subs[n] || []) { try { fn(d); } catch (e) { console.warn('[voice]', n, e); } } }
}
const err = (msg, extra = {}) => Object.assign(new Error(msg), extra);





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


export const HANGUP_TIMEOUT_MS = 3000;

export const HIDDEN_MS_DEFAULT = null;

export class WebRtcTransport extends Emitter {
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  #win = null; #doc = null; #hiddenTimer = null; #hiddenAt = null;
  #onHide = () => this.#leave('pagehide'); 
  #onVis = () => {
    const ms = this.o.hiddenMs;
    if (ms == null || ms < 0 || this.closed || !this.#doc) return; 
    if (this.#doc.visibilityState === 'hidden') {
      if (this.#hiddenAt != null) return;
      this.#hiddenAt = this.o.now();
      if (ms === 0) return this.#leave('hidden');
      this.trace.push('page.hidden', { ms });
      this.#hiddenTimer = setTimeout(() => { this.#hiddenTimer = null; if (!this.closed && this.#doc?.visibilityState === 'hidden') this.#leave('hidden'); }, ms);
    } else if (this.#hiddenAt != null) {
      const away = this.o.now() - this.#hiddenAt; this.#hiddenAt = null;
      if (this.#hiddenTimer) { clearTimeout(this.#hiddenTimer); this.#hiddenTimer = null; }
      if (away >= ms) return this.#leave('hidden'); 
      this.trace.push('page.visible', { away });
    }
  };
  constructor(opts) {
    super(); this.kind = KINDS.direct;
    this.o = { fetchImpl: globalThis.fetch?.bind(globalThis), RTCPeerConnection: globalThis.RTCPeerConnection, iceTimeoutMs: 3000, graceMs: 5000, hiddenMs: HIDDEN_MS_DEFAULT, hangupTimeoutMs: HANGUP_TIMEOUT_MS, now: Date.now, ...opts };
    this.trace = this.o.trace || createTrace(); this.closed = false; this.graceTimer = null;
  }
  #leave(why) { this.#fail(why, why); } 
  #beacon(url, body) {
    const b = this.o.beacon ?? (globalThis.navigator?.sendBeacon ? (u, d) => globalThis.navigator.sendBeacon(u, d) : null);
    if (!b) return false;
    try { const blob = typeof Blob === 'function' ? new Blob([body], { type: 'text/plain' }) : body; return b(url, blob) === true; } catch { return false; }
  }
  async #fetch(stage, u, init) { 
    try { const r = await this.o.fetchImpl(u, init); this.trace.push('fetch', { stage, path: tracePath(u), status: r?.status ?? 0 }); return r; }
    catch (e) { this.trace.push('fetch', { stage, path: tracePath(u), status: 0, msg: 'unreachable' }); throw e; }
  }
  #peerState(pc) {
    const st = pc.connectionState;
    this.trace.push('pc.connectionState', { state: st });
    if (this.closed) return;
    if (st === 'failed') { this.#clearGrace(); this.#fail(1006, 'peer failed'); return; }
    if (st === 'closed') { this.#clearGrace(); this.#fail(1006, 'peer closed'); return; } 
    if (st === 'connected') { if (this.graceTimer) this.trace.push('pc.recovered', { state: st }); this.#clearGrace(); return; }
    
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
    this.ticket = ticket; 
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
      
      
      const where = loc ? new URL(loc, origin) : null;
      if (where && where.origin !== new URL(origin).origin) throw err('calls Location is off the gateway origin', { status: 201, fallback: true });
      if (where) this.location = where.toString();
      if (where) { 
        this.#win = this.o.win ?? globalThis; this.#win.addEventListener?.('pagehide', this.#onHide);
        this.#doc = this.o.doc ?? globalThis.document ?? null; this.#doc?.addEventListener?.('visibilitychange', this.#onVis);
      }
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
  
  item(item, previousItemId) { return this.send({ type: 'conversation.item.create', ...(previousItemId ? { previous_item_id: previousItemId } : {}), item }); }
  respond(response) { return this.send(response ? { type: 'response.create', response } : { type: 'response.create' }); }
  deleteItems(ids = []) { let n = 0; for (const id of ids) if (id && this.send({ type: 'conversation.item.delete', item_id: String(id) })) n++; return n; }
  start() { return this.send({ type: 'response.create' }); }
  
  scene(text) { return this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `[scene] ${text}` }] } }); }
  
  
  
  
  
  async setPhase(name, why) {
    if (!this.location) return { ok: false, status: 0, why: 'no call handle' };
    if (!String(why ?? '').trim()) return { ok: false, status: 0, why: 'no why' };
    try {
      const r = await this.#fetch('phase', `${this.location}/phase`, { method: 'POST', cache: 'no-store',
        headers: { Authorization: `Bearer ${this.ticket}`, 'Content-Type': 'application/json', 'x-chamber-device': this.o.device },
        body: JSON.stringify({ phase: name, why: String(why).slice(0, 200) }) });
      await r.text?.().catch(() => '');
      return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, why: `phase ${r.status}` };
    } catch { return { ok: false, status: 0, why: 'phase unreachable' }; }
  }
  get maxMessageSize() { return this.pc?.sctp?.maxMessageSize ?? null; } 
  async #fail(code, why) { if (this.closed) return; this.trace.push('fail', { stage: 'transport', code, why }); await this.close(why); this.emit('close', { code, why }); }
  async close(why = 'close') { if (this.closed) return; this.closed = true; this.trace.push('close', { stage: 'transport', why }); await this.#teardown(why); }
  async #teardown(why = 'teardown') {
    this.#clearGrace();
    if (this.#win) { try { this.#win.removeEventListener?.('pagehide', this.#onHide); } catch {} this.#win = null; }
    if (this.#doc) { try { this.#doc.removeEventListener?.('visibilitychange', this.#onVis); } catch {} this.#doc = null; }
    if (this.#hiddenTimer) { clearTimeout(this.#hiddenTimer); this.#hiddenTimer = null; }
    const loc = this.location, ticket = this.ticket; this.location = null; this.ticket = null;
    if (this.dc) { this.dc.onclose = null; this.dc.onmessage = null; }
    if (this.dc) { this.dc.onerror = null; this.dc.onopen = null; }
    if (this.pc) { this.pc.onconnectionstatechange = null; this.pc.oniceconnectionstatechange = null; this.pc.ontrack = null; }
    try { this.dc?.close(); } catch {}
    try { this.pc?.getSenders?.().forEach((s) => s.track?.stop()); } catch {}
    try { this.pc?.close(); } catch {}
    this.pc = null; this.dc = null;
    if (loc) await this.#hangup(loc, ticket, why);
  }
  
  
  
  async #hangup(loc, ticket, why) {
    const url = `${loc}/hangup`;
    this.trace.push('hangup', { stage: 'teardown', why });
    let p = null;
    try {
      if (typeof this.o.fetchImpl !== 'function') throw new Error('no fetch');
      p = this.o.fetchImpl(url, { method: 'POST', cache: 'no-store', keepalive: true, headers: { Authorization: `Bearer ${ticket}`, 'x-chamber-device': this.o.device } });
    } catch {
      const sent = this.#beacon(url, JSON.stringify({ ticket, device: this.o.device, why: String(why).slice(0, 60) }));
      this.trace.push('fetch', { stage: 'hangup', path: tracePath(url), status: 0, msg: sent ? 'beacon' : 'unsent' });
      return;
    }
    
    
    const ms = Number.isFinite(this.o.hangupTimeoutMs) && this.o.hangupTimeoutMs >= 0 ? this.o.hangupTimeoutMs : HANGUP_TIMEOUT_MS;
    let timer = null;
    const bound = new Promise((res) => { timer = setTimeout(() => res('timeout'), ms); });
    const answered = Promise.resolve(p).then(async (r) => { await r?.text?.().catch(() => ''); return r; });
    try {
      const r = await Promise.race([answered, bound]);
      if (r === 'timeout') this.trace.push('fetch', { stage: 'hangup', path: tracePath(url), status: 0, msg: 'timeout', ms });
      else this.trace.push('fetch', { stage: 'hangup', path: tracePath(url), status: r?.status ?? 0 });
    } catch { this.trace.push('fetch', { stage: 'hangup', path: tracePath(url), status: 0, msg: 'unreachable' }); }
    finally { clearTimeout(timer); answered.catch(() => {}); }
  }
}

export class RelayWsTransport extends Emitter {
  
  constructor(opts) { super(); this.kind = KINDS.relay; this.o = { WebSocketImpl: globalThis.WebSocket, ...opts }; this.trace = this.o.trace || createTrace(); this.closed = false; }
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
  scene(text) { return this.send({ type: 'chamber.scene', text }); } 
  appendAudio(b64) { return this.send({ type: 'input_audio_buffer.append', audio: b64 }); }
  async close(why = 'close') { if (this.closed) return; this.closed = true; this.trace.push('close', { stage: 'transport', why }); try { this.ws?.close(1000); } catch {} }
}



export async function connectWithFallback({ getTicket, primary, fallback, onFallback = () => {} }) {
  if (primary) {
    try { await primary.connect(await getTicket()); return primary; }
    catch (e) { await primary.close?.(); if (!e.fallback || !fallback) throw e; onFallback(e); }
  }
  await fallback.connect(await getTicket());
  return fallback;
}
