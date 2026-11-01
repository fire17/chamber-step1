
























import { FLOW } from './flow.js';


export const FRAMES = FLOW.frames;


export const LOOK = Object.freeze({ maxW: FRAMES.maxW, quality: FRAMES.quality, maxBytes: FRAMES.maxBytes });


export function lookEvent(dataUrl) {
  return { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: dataUrl }] } };
}

const isVideo = (el) => el && 'videoWidth' in el;
const sizeOf = (el) => (isVideo(el) ? [el.videoWidth, el.videoHeight] : [el?.width, el?.height]);

export function captureFrame({ el, presence = () => false, maxW = FRAMES.maxW, quality = FRAMES.quality, maxBytes = FRAMES.maxBytes, doc = globalThis.document, canvas = null } = {}) {
  if (presence !== null) { let here = false; try { here = typeof presence === 'function' && !!presence(); } catch { here = false; } if (!here) return { ok: false, why: 'no one in frame' }; }
  const [sw, sh] = sizeOf(el);
  if (!el || (isVideo(el) && !(el.readyState >= 2)) || !(sw > 0) || !(sh > 0)) return { ok: false, why: 'no frame' };
  const w = Math.min(maxW, sw), h = Math.max(1, Math.round((sh * w) / sw));
  let c = canvas; if (!c) { try { c = doc?.createElement ? doc.createElement('canvas') : null; } catch { c = null; } }
  if (!c?.getContext) return { ok: false, why: 'cannot capture' };
  let url = '';
  try {
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(el, 0, 0, w, h);
    url = c.toDataURL('image/jpeg', quality);
    g.clearRect?.(0, 0, w, h);
  } catch { url = ''; } finally { try { c.width = 0; c.height = 0; } catch {} } 
  if (typeof url !== 'string' || !/^data:image\/jpeg;base64,/.test(url)) return { ok: false, why: 'cannot capture' }; 
  const bytes = url.length;
  if (!(bytes <= maxBytes)) return { ok: false, why: 'frame too large' };
  return { ok: true, dataUrl: url, w, h, bytes };
}




export function captureSized({ widths = [FRAMES.maxW], ...o } = {}) {
  const ws = [...new Set((Array.isArray(widths) ? widths : [widths]).filter((w) => Number.isFinite(w) && w > 0))];
  let last = { ok: false, why: 'no frame' };
  for (let i = 0; i < ws.length; i++) {
    last = captureFrame({ ...o, maxW: ws[i] });
    if (last.ok) return { ...last, fallback: i > 0 };
    if (last.why !== 'frame too large') return last;
  }
  return last;
}

export class LookSlot {
  
  
  
  constructor({ video, presence = () => false, send, doc = globalThis.document, def = {} } = {}) {
    this.video = video; this.presence = presence; this.send = send; this.doc = doc;
    this.def = { ...LOOK, ...def };
    this.count = 0; this.stopped = false;
  }
  request() {
    if (this.stopped || typeof this.send !== 'function') return { ok: false, why: 'the look is off' };
    const f = captureFrame({ el: this.video, presence: this.presence, maxW: this.def.maxW, quality: this.def.quality, maxBytes: this.def.maxBytes, doc: this.doc });
    if (!f.ok) return f;
    let url = f.dataUrl; f.dataUrl = '';
    let sent = false;
    try { sent = this.send(lookEvent(url)) !== false; } catch { sent = false; } 
    url = ''; 
    if (!sent) return { ok: false, why: 'not connected' };
    this.count++;
    return { ok: true, sent: true, w: f.w, h: f.h, bytes: f.bytes };
  }
  stop() { this.stopped = true; }
}
