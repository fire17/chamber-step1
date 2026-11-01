










import { deviceId, fetchTicket } from './gate.js';
import { WebRtcTransport, RelayWsTransport, connectWithFallback, createTrace, tracePath } from './transport.js';
import { VoiceSession } from './session.js';
import { registryFromDescribe } from './tools.js';
import { FLOW, langOf } from './flow.js'; 
import { definePcm16Worklet } from './pcm16-worklet.js';
import { FrameFeed, FRAMES } from './frames.js';



export function pcm16WorkletUrl(metaUrl = import.meta.url, { Blob: B = globalThis.Blob, URL: U = globalThis.URL } = {}) {
  if (/^https?:/.test(metaUrl)) return new U('./pcm16-worklet.js', metaUrl).toString();
  return U.createObjectURL(new B([`(${definePcm16Worklet.toString()})();`], { type: 'text/javascript' }));
}



export const VOICE_CONFIG = Object.freeze({
  gatewayOrigin: 'https://31-97-114-221.sslip.io',
  relayOrigin: '',        
  outputGain: 0.9,
});


export function voiceEnabled(loc = globalThis.location, cfg = VOICE_CONFIG) {
  let v = null; try { v = new URLSearchParams(loc?.search || '').get('voice'); } catch {}
  return v === '1' || (!!cfg?.gatewayOrigin && v !== '0');
}


export function traceRoute(loc = globalThis.location) {
  let q = null; try { q = new URLSearchParams(loc?.search || ''); } catch {}
  return loc?.hash === '#dev' || q?.get('dev') === '1' || q?.get('debug') === '1';
}

export function framesWanted(loc = globalThis.location, def = FRAMES) {
  let q = null; try { q = new URLSearchParams(loc?.search || '').get('fps'); } catch {}
  return !!def?.on && q !== '0';
}



export function langWanted(loc = globalThis.location, on = FLOW.langParam === true) {
  if (!on) return FLOW.lang;
  let q = null; try { q = new URLSearchParams(loc?.search || '').get('lang'); } catch {}
  return langOf(q);
}
const msgOf = (e) => String(e?.message ?? e ?? 'error').slice(0, 120);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] != null).map((k) => [k, o[k]]));

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };





























export const ACTIVE_MAX_MS = 60000;


export function continuationGate(t, { trace = null, now = Date.now, activeMaxMs = ACTIVE_MAX_MS, voidOn = FLOW.voidOn || [] } = {}) {
  const rs = new Map(), callRid = new Map(), active = new Map(), out = new Map(), answered = new Set(); 
  let afterOutput = false, closing = false, echo = false, seq = 0;
  const direct = t.kind !== 'relay-ws';
  const rec = (rid) => { let r = rs.get(rid); if (!r) { r = { meta: null, seen: false, wait: [], calls: new Set(), outs: new Set(), audio: false, done: false, sent: false, voided: false }; rs.set(rid, r); if (rs.size > 64) rs.delete(rs.keys().next().value); } return r; };
  const note = (rid, why) => { try { trace?.push('continuation', { stage: 'gate', rid: String(rid).slice(0, 40), why }); } catch {} };
  
  const tag = (ev, act) => {
    const meta = ev.response?.metadata, eid = ev.event_id || `chamber_${act}_${++seq}`;
    out.set(eid, now()); if (out.size > 64) out.delete(out.keys().next().value); 
    return { ...ev, event_id: eid, response: { ...(ev.response || {}), metadata: { ...(meta || {}), chamber_act: meta?.chamber_act || act, chamber_eid: eid } } };
  };
  const fresh = (m) => { const at = now(); for (const [id, t0] of m) if (!(at - t0 <= activeMaxMs)) m.delete(id); return m.size; };
  const live = () => fresh(active);
  const answer = (eid) => { out.delete(eid); answered.add(eid); if (answered.size > 64) answered.delete(answered.values().next().value); };
  
  const mark = (r, md) => { const act = md?.chamber_act; if (!act) return; r.meta = String(act); if (direct) echo = true; if (md.chamber_eid != null) answer(String(md.chamber_eid)); };
  const settle = (rid) => {
    const r = rs.get(rid); if (!r || !r.done || r.sent) return;
    if (closing || r.meta || !r.seen || !r.calls.size || r.audio) return; 
    if (r.outs.size < r.calls.size) return; 
    r.sent = true;
    if (r.voided) return note(rid, 'skip: the person spoke after this turn began: void (D11)'); 
    if (!echo) return note(rid, 'skip: no echo seen: not provably the person\'s turn'); 
    if (r.wait.some((eid) => !answered.has(eid))) return note(rid, 'skip: a room create outstanding at its created is still unanswered: ambiguous');
    if (live()) return note(rid, 'skip: another response is active');
    t.send(tag({ type: 'response.create' }, 'continuation')); note(rid, 'R7: one continuation');
  };
  const callOf = (ev) => (ev.type === 'response.function_call_arguments.done' ? ev.call_id
    : ev.type === 'response.output_item.done' && ev.item?.type === 'function_call' ? ev.item.call_id : null);
  const off = t.on('event', (ev) => {
    const rid = ev?.response?.id ?? ev?.response_id;
    
    
    if (voidOn.includes(ev?.type)) { for (const r of rs.values()) if (r.seen && !r.sent) r.voided = true; return; }
    
    if (rid != null && ev.type !== 'response.created' && ev.type !== 'response.done' && !rs.get(rid)?.done) active.set(rid, now());
    switch (ev?.type) {
      case 'response.created': { const md = ev.response?.metadata, r = rec(rid ?? '?'); r.seen = true;
        if (md?.chamber_act) mark(r, md); 
        else if (fresh(out)) r.wait = [...out.keys()]; 
        active.set(rid ?? '?', now()); return; }
      case 'response.done': { active.delete(rid ?? '?'); const r = rec(rid ?? '?'); r.done = true;
        mark(r, ev.response?.metadata); 
        if (hasAudio(ev.response)) r.audio = true; return settle(rid ?? '?'); }
      case 'error': { const eid = ev.error?.event_id; if (eid != null && out.has(String(eid))) answer(String(eid)); return; } 
      case 'output_audio_buffer.started': case 'response.output_audio.delta': case 'response.output_audio_transcript.delta': case 'response.output_audio_transcript.done':
        if (rid != null) rec(rid).audio = true; return;
      default: { const id = callOf(ev); if (id) { const r = rec(rid ?? '?'); r.calls.add(id); callRid.set(id, rid ?? '?'); if (callRid.size > 256) callRid.delete(callRid.keys().next().value); } }
    }
  });
  const send = (ev) => {
    if (ev?.type === 'conversation.item.create' && ev.item?.type === 'function_call_output') {
      const ok = t.send(ev); const rid = callRid.get(ev.item.call_id);
      if (ok && rid != null) {
        rs.get(rid)?.outs.add(ev.item.call_id); afterOutput = true;
        
        queueMicrotask(() => { afterOutput = false; settle(rid); });
      }
      return ok;
    }
    if (ev?.type === 'response.create') {
      const act = ev.response?.metadata?.chamber_act;
      if (act === 'closing') closing = true;
      if (afterOutput && act !== 'closing') { afterOutput = false; return true; } 
      afterOutput = false;
      return t.send(tag(ev, 'room'));
    }
    return t.send(ev);
  };
  
  const start = () => (t.kind === 'relay-ws' ? t.start() : t.send(tag({ type: 'response.create' }, 'start')));
  
  const view = { kind: t.kind, send, on: (n, fn) => t.on(n, fn), close: (why) => t.close(why), start,
    get maxMessageSize() { return t.maxMessageSize ?? null; } };
  for (const k of ['setPhase', 'scene', 'item', 'deleteItems', 'appendAudio']) if (typeof t[k] === 'function') view[k] = (...a) => t[k](...a);
  if (typeof t.respond === 'function') view.respond = (response) => t.send(tag(response ? { type: 'response.create', response } : { type: 'response.create' }, 'room')); 
  return { transport: view, closing: () => { closing = true; }, stop: () => { closing = true; try { off(); } catch {} } }; 
}



export function frameHooks(s) {
  const o = {};
  if (typeof s?.itemSeq === 'function') o.seq = () => s.itemSeq();
  if (typeof s?.onFrameBurst === 'function') o.onBurst = (b) => s.onFrameBurst(b);
  return o;
}

function hasAudio(resp) {
  for (const item of resp?.output || []) for (const c of item?.content || []) if (c?.type === 'output_audio' || c?.type === 'audio') return true;
  return false;
}

export function mountVoice({ bus, chamber, getAudioCtx = () => null, config = {}, onOutput } = {}) {
  const cfg = { ...VOICE_CONFIG, ...config, ...(onOutput ? { onOutput } : {}) }; 
  if (!voiceEnabled(globalThis.location, cfg)) return null;
  const device = deviceId();
  const state = { phase: 'ready', transport: null };
  let session = null, transport = null, frames = null, gate = null, mic = null, out = null, worklet = null, playAt = 0;
  const setState = (s) => { Object.assign(state, s); bus?.emit?.('voice', { ...state }); };
  const trace = cfg.trace || createTrace(200); 
  const fetchImpl = cfg.fetchImpl || globalThis.fetch?.bind(globalThis);
  const tracedFetch = async (u, init) => { 
    try { const r = await fetchImpl(u, init); trace.push('fetch', { stage: 'ticket', path: tracePath(u), status: r?.status ?? 0 }); return r; }
    catch (e) { trace.push('fetch', { stage: 'ticket', path: tracePath(u), status: 0, msg: 'unreachable' }); throw e; }
  };
  if (cfg.tracePanel ?? traceRoute()) import('./trace-panel.js').then(({ mountTracePanel }) => mountTracePanel({ trace })).catch((e) => trace.push('panel.error', { stage: 'panel', msg: msgOf(e) }));

  function outputNode() {
    const ctx = getAudioCtx(); if (!ctx) return null;
    if (!out) {
      out = ctx.createGain(); out.gain.value = cfg.outputGain; out.connect(ctx.destination); 
      try { cfg.onOutput?.(out); } catch {} 
    }
    return out;
  }
  function playPcm16(b64) { 
    const node = outputNode(); if (!node) return;
    const ctx = node.context, bytes = b64ToBytes(b64), n = bytes.length >> 1, dv = new DataView(bytes.buffer);
    const buf = ctx.createBuffer(1, n, 24000), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 0x8000;
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(node);
    playAt = Math.max(playAt, ctx.currentTime + 0.05); src.start(playAt); playAt += buf.duration;
  }
  function playRemote(stream) { 
    const node = outputNode(); if (!node || !stream?.getAudioTracks) return;
    const el = new Audio(); el.muted = true; el.srcObject = stream; el.play?.().catch(() => {});
    node.context.createMediaStreamSource(stream).connect(node);
  }
  async function startMicWorklet(t) {
    const ctx = getAudioCtx(); if (!ctx || !mic) return;
    await ctx.audioWorklet.addModule(pcm16WorkletUrl());
    worklet = new AudioWorkletNode(ctx, 'chamber-pcm16');
    worklet.port.onmessage = (e) => t.appendAudio(bytesToB64(e.data));
    ctx.createMediaStreamSource(mic).connect(worklet); 
  }

  return {
    state,
    async start() {
      if (session || transport) return;
      if (!cfg.gatewayOrigin && !cfg.relayOrigin) return setState({ phase: 'unconfigured' }); 
      setState({ phase: 'connecting', warn: null });
      trace.push('start', { stage: 'start' });
      const api = this;
      
      let stage = 'getUserMedia';
      try {
        mic = await (cfg.getUserMedia || ((c) => navigator.mediaDevices.getUserMedia(c)))({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        stage = 'connect';
        const ticketOrigin = cfg.gatewayOrigin || cfg.relayOrigin.replace(/^ws/, 'http');
        const getTicket = async () => (await fetchTicket(ticketOrigin, device, { fetchImpl: tracedFetch })).ticket;
        const rtcOpts = { origin: cfg.gatewayOrigin, device, mic, trace, ...(cfg.RTCPeerConnection ? { RTCPeerConnection: cfg.RTCPeerConnection } : {}), ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}), ...(cfg.graceMs != null ? { graceMs: cfg.graceMs } : {}), ...(cfg.iceTimeoutMs != null ? { iceTimeoutMs: cfg.iceTimeoutMs } : {}),
          ...pick(cfg, ['win', 'doc', 'beacon', 'hiddenMs', 'hangupTimeoutMs']) }; 
        const primary = cfg.gatewayOrigin ? new WebRtcTransport(rtcOpts) : null;
        const fallback = cfg.relayOrigin ? new RelayWsTransport({ wsOrigin: cfg.relayOrigin, device, trace }) : null;
        primary?.on('remote-track', playRemote);
        fallback?.on('audio', playPcm16);
        transport = await connectWithFallback({ getTicket, primary, fallback, onFallback: (e) => { trace.push('fallback', { stage: 'connect', msg: msgOf(e) }); setState({ fallbackWhy: e.message }); } });
      } catch (e) {
        trace.push('start.error', { stage, msg: msgOf(e), status: e?.status ?? null });
        await api.stop(`start failed at ${stage}`);
        setState({ phase: e?.status === 429 ? 'busy' : 'error', why: String(e?.status ?? e?.message ?? 'error').slice(0, 60) });
        return;
      }
      
      
      const t = transport;
      t.on('close', (c) => { trace.push('call.closed', { stage: 'transport', code: c?.code ?? null, why: c?.why ?? '' }); if (!session && transport === t) api.stop(`call closed: ${c?.why || c?.code || ''}`); });
      setState({ phase: 'live', transport: t.kind });
      const warn = (st, e) => { trace.push('live.warn', { stage: st, msg: msgOf(e) }); setState({ phase: 'live', warn: `${st}: ${msgOf(e)}`.slice(0, 80) }); };
      if (t.kind === 'relay-ws') { try { await startMicWorklet(t); } catch (e) { warn('mic worklet', e); } }
      let registry; try { registry = registryFromDescribe(chamber?.describe?.()); } catch (e) { warn('registryFromDescribe', e); }
      try {
        
        
        gate = continuationGate(t, { trace, ...(cfg.now ? { now: cfg.now } : {}) }); 
        session = new VoiceSession({ transport: gate.transport, bus, registry, ...pick(cfg, ['setTimer', 'clearTimer', 'now']),
          lang: langWanted(), trace: (kind, fields) => trace.push(kind, fields), 
          ...(typeof chamber?.presence === 'function' ? { presence: chamber.presence } : {}),
          video: chamber?.video ?? null, viz: chamber?.viz ?? null,
          act: (verb, args, why, by) => chamber.act(verb, args, why, by), 
          say: (args) => bus?.emit?.('say', args), 
          onStatus: (s) => { setState({ link: s.state }); if (s.state === 'closing') { frames?.stop(); gate?.closing(); } if (s.state === 'ended') api.stop(`call ended: ${s.why || s.code || ''}`); } });
      } catch (e) { warn('new VoiceSession', e); session = null; return; }
      try { session.start(); } catch (e) { warn('session.start', e); } 
      
      
      const fdef = FRAMES;
      if (framesWanted(globalThis.location, fdef) && fdef.transports?.includes(t.kind) && chamber?.video) {
        try {
          frames = new FrameFeed({ send: (e) => t.send(e), sources: { camera: chamber.video, rendered: chamber.viewCanvas ?? null },
            presence: chamber.presence ?? (() => false), maxMessageSize: () => t.maxMessageSize ?? null, trace, ...frameHooks(session) });
          if (typeof session?.attachFrames === 'function') session.attachFrames(frames); 
          t.on('event', (ev) => frames?.onEvent(ev)); 
        } catch (e) { warn('frames', e); frames = null; }
      }
    },
    trace: () => trace.list(),
    traceText: () => trace.text(),
    async stop(why = 'stop') {
      const s = session, t = transport; session = null; transport = null;
      try { frames?.stop(); } catch {} frames = null;
      try { gate?.stop(); } catch {} gate = null;
      trace.push('stop', { stage: 'mount', why: String(why) });
      try { worklet?.disconnect(); } catch {} worklet = null;
      try { mic?.getTracks().forEach((tr) => tr.stop()); } catch {} mic = null;
      if (s) await s.stop(why); else if (t) await t.close(why);
      if (state.phase !== 'error') setState({ phase: 'ready', transport: null });
    },
  };
}
