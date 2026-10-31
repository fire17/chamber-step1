









import { deviceId, fetchTicket } from './gate.js';
import { WebRtcTransport, RelayWsTransport, connectWithFallback, createTrace, tracePath } from './transport.js';
import { VoiceSession } from './session.js';
import { registryFromDescribe } from './tools.js';
import { definePcm16Worklet } from './pcm16-worklet.js';



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
const msgOf = (e) => String(e?.message ?? e ?? 'error').slice(0, 120);

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

export function mountVoice({ bus, chamber, getAudioCtx = () => null, config = {}, onOutput } = {}) {
  const cfg = { ...VOICE_CONFIG, ...config, ...(onOutput ? { onOutput } : {}) }; 
  if (!voiceEnabled(globalThis.location, cfg)) return null;
  try { globalThis.localStorage?.removeItem('chamber.gate.pw'); } catch {} 
  const device = deviceId();
  const state = { phase: 'ready', transport: null };
  let session = null, transport = null, mic = null, out = null, worklet = null, playAt = 0;
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
    async unlock() {}, 
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
        const rtcOpts = { origin: cfg.gatewayOrigin, device, mic, trace, ...(cfg.RTCPeerConnection ? { RTCPeerConnection: cfg.RTCPeerConnection } : {}), ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}), ...(cfg.graceMs != null ? { graceMs: cfg.graceMs } : {}), ...(cfg.iceTimeoutMs != null ? { iceTimeoutMs: cfg.iceTimeoutMs } : {}) };
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
        session = new VoiceSession({ transport: t, bus, registry,
          act: (verb, args, why, by) => chamber.act(verb, args, why, by), 
          say: (args) => bus?.emit?.('say', args), 
          onStatus: (s) => { setState({ link: s.state }); if (s.state === 'ended') api.stop(`call ended: ${s.why || s.code || ''}`); } });
      } catch (e) { warn('new VoiceSession', e); session = null; return; }
      try { session.start(); } catch (e) { warn('session.start', e); } 
    },
    trace: () => trace.list(),
    traceText: () => trace.text(),
    async stop(why = 'stop') {
      const s = session, t = transport; session = null; transport = null;
      trace.push('stop', { stage: 'mount', why: String(why) });
      try { worklet?.disconnect(); } catch {} worklet = null;
      try { mic?.getTracks().forEach((tr) => tr.stop()); } catch {} mic = null;
      if (s) await s.stop(why); else if (t) await t.close(why);
      if (state.phase !== 'error') setState({ phase: 'ready', transport: null });
    },
  };
}
