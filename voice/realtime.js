// Chamber voice: the browser mount. ON when a gateway origin is configured (opt out with ?voice=0), or forced with ?voice=1.
// No password. Nothing connects until the person
// taps Start. One Start = one fresh single-use ticket = one call. WebRTC first; the relay WS only as a fallback.
//
//   mountVoice({ bus, chamber, getAudioCtx, config, onOutput }) -> { unlock(password), start(), stop(), state, trace() } | null
//     bus          step2 Bus (say / phase events)
//     chamber      window.__chamber (act(verb, args, why), describe())
//     getAudioCtx  () => the step2 AudioContext (created by app.js start() on the person's gesture), or null
//     config       overrides VOICE_CONFIG; gatewayOrigin is the ONE voice gateway (== the one extra CSP connect-src entry).
//     onOutput     optional (node) => …, top-level or in config: called once with the voice output GainNode (sound/HOOK.md H3).
import { deviceId, fetchTicket } from './gate.js';
import { WebRtcTransport, RelayWsTransport, connectWithFallback, createTrace, tracePath } from './transport.js';
import { VoiceSession } from './session.js';
import { registryFromDescribe } from './tools.js';
import { definePcm16Worklet } from './pcm16-worklet.js';

// The worklet module URL: the file itself when this module has a real http(s) URL (dev page); a blob module built from the
// same function when the app is booted from a blob (the deployed gate page), where a relative file URL cannot resolve.
export function pcm16WorkletUrl(metaUrl = import.meta.url, { Blob: B = globalThis.Blob, URL: U = globalThis.URL } = {}) {
  if (/^https?:/.test(metaUrl)) return new U('./pcm16-worklet.js', metaUrl).toString();
  return U.createObjectURL(new B([`(${definePcm16Worklet.toString()})();`], { type: 'text/javascript' }));
}

// gatewayOrigin: the voice gateway (CONTRACT-srv2). It must equal, byte for byte, the one extra CSP connect-src entry in
// step2/index.html and step1-deploy/gate/index.html; release/gate.mjs (VOICE_ORIGIN) fails the build on any mismatch.
export const VOICE_CONFIG = Object.freeze({
  gatewayOrigin: 'https://31-97-114-221.sslip.io',
  relayOrigin: '',        // fallback relay (not deployed: the relay needs subprotocol ticket auth upstream)
  outputGain: 0.9,
});

// ?voice=1 forces it on; otherwise it is on whenever a gateway is configured, unless the page says ?voice=0.
export function voiceEnabled(loc = globalThis.location, cfg = VOICE_CONFIG) {
  let v = null; try { v = new URLSearchParams(loc?.search || '').get('voice'); } catch {}
  return v === '1' || (!!cfg?.gatewayOrigin && v !== '0');
}

// The call-trace panel (trace-panel.js) shows on the dev route (#dev / ?dev=1, dev/test only) and on ?debug=1; never otherwise.
export function traceRoute(loc = globalThis.location) {
  let q = null; try { q = new URLSearchParams(loc?.search || ''); } catch {}
  return loc?.hash === '#dev' || q?.get('dev') === '1' || q?.get('debug') === '1';
}
const msgOf = (e) => String(e?.message ?? e ?? 'error').slice(0, 120);

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

export function mountVoice({ bus, chamber, getAudioCtx = () => null, config = {}, onOutput } = {}) {
  const cfg = { ...VOICE_CONFIG, ...config, ...(onOutput ? { onOutput } : {}) }; // onOutput top-level (app.js:688) or in config
  if (!voiceEnabled(globalThis.location, cfg)) return null;
  try { globalThis.localStorage?.removeItem('chamber.gate.pw'); } catch {} // the old room gate saved a password here: drop it once
  const device = deviceId();
  const state = { phase: 'ready', transport: null };
  let session = null, transport = null, mic = null, out = null, worklet = null, playAt = 0;
  const setState = (s) => { Object.assign(state, s); bus?.emit?.('voice', { ...state }); };
  const trace = cfg.trace || createTrace(200); // the call trace (transport.js): paths + states + why, never secrets
  const fetchImpl = cfg.fetchImpl || globalThis.fetch?.bind(globalThis);
  const tracedFetch = async (u, init) => { // the ticket fetches (nonce, ticket): path + status only
    try { const r = await fetchImpl(u, init); trace.push('fetch', { stage: 'ticket', path: tracePath(u), status: r?.status ?? 0 }); return r; }
    catch (e) { trace.push('fetch', { stage: 'ticket', path: tracePath(u), status: 0, msg: 'unreachable' }); throw e; }
  };
  if (cfg.tracePanel ?? traceRoute()) import('./trace-panel.js').then(({ mountTracePanel }) => mountTracePanel({ trace })).catch((e) => trace.push('panel.error', { stage: 'panel', msg: msgOf(e) }));

  function outputNode() {
    const ctx = getAudioCtx(); if (!ctx) return null;
    if (!out) {
      out = ctx.createGain(); out.gain.value = cfg.outputGain; out.connect(ctx.destination); // beside the pad master, not through its saturator
      try { cfg.onOutput?.(out); } catch {} // sound/HOOK.md H3: the pad's duck follower keys on the voice output itself (real time, not at transcript.done)
    }
    return out;
  }
  function playPcm16(b64) { // relay path: 24 kHz PCM16 deltas, scheduled back to back
    const node = outputNode(); if (!node) return;
    const ctx = node.context, bytes = b64ToBytes(b64), n = bytes.length >> 1, dv = new DataView(bytes.buffer);
    const buf = ctx.createBuffer(1, n, 24000), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 0x8000;
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(node);
    playAt = Math.max(playAt, ctx.currentTime + 0.05); src.start(playAt); playAt += buf.duration;
  }
  function playRemote(stream) { // webrtc path. Chrome only pulls remote audio into WebAudio when an element also holds it.
    const node = outputNode(); if (!node || !stream?.getAudioTracks) return;
    const el = new Audio(); el.muted = true; el.srcObject = stream; el.play?.().catch(() => {});
    node.context.createMediaStreamSource(stream).connect(node);
  }
  async function startMicWorklet(t) {
    const ctx = getAudioCtx(); if (!ctx || !mic) return;
    await ctx.audioWorklet.addModule(pcm16WorkletUrl());
    worklet = new AudioWorkletNode(ctx, 'chamber-pcm16');
    worklet.port.onmessage = (e) => t.appendAudio(bytesToB64(e.data));
    ctx.createMediaStreamSource(mic).connect(worklet); // not connected to destination: the mic is never played back
  }

  return {
    state,
    async unlock() {}, // no password any more: kept as a no-op for old callers
    async start() {
      if (session || transport) return;
      if (!cfg.gatewayOrigin && !cfg.relayOrigin) return setState({ phase: 'unconfigured' }); // the default: no endpoint
      setState({ phase: 'connecting', warn: null });
      trace.push('start', { stage: 'start' });
      const api = this;
      // (1) BEFORE the call exists: mic, ticket, connect. A throw here is a failed start: release everything (stop()).
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
      // (2) AFTER the transport connected the call is LIVE. Nothing below may hang it up: a throw is traced and shown as
      // a warning on the live state, and the call goes on. Only the transport's own close (or stop()) ends it.
      const t = transport;
      t.on('close', (c) => { trace.push('call.closed', { stage: 'transport', code: c?.code ?? null, why: c?.why ?? '' }); if (!session && transport === t) api.stop(`call closed: ${c?.why || c?.code || ''}`); });
      setState({ phase: 'live', transport: t.kind });
      const warn = (st, e) => { trace.push('live.warn', { stage: st, msg: msgOf(e) }); setState({ phase: 'live', warn: `${st}: ${msgOf(e)}`.slice(0, 80) }); };
      if (t.kind === 'relay-ws') { try { await startMicWorklet(t); } catch (e) { warn('mic worklet', e); } }
      let registry; try { registry = registryFromDescribe(chamber?.describe?.()); } catch (e) { warn('registryFromDescribe', e); }
      try {
        session = new VoiceSession({ transport: t, bus, registry,
          act: (verb, args, why, by) => chamber.act(verb, args, why, by), // by='voice': the mount must honour it (HOOK.md §2)
          say: (args) => bus?.emit?.('say', args), // captions subscribe; a future Mouth must skip spoken:true lines
          onStatus: (s) => { setState({ link: s.state }); if (s.state === 'ended') api.stop(`call ended: ${s.why || s.code || ''}`); } });
      } catch (e) { warn('new VoiceSession', e); session = null; return; }
      try { session.start(); } catch (e) { warn('session.start', e); } // the person's tap IS the trigger
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
