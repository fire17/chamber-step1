// Dev-only call-trace panel (dev/test only). realtime.js loads it ONLY on the dev route (#dev / ?dev=1) or ?debug=1;
// the player view never requests this file, so it stays wordless. It shows the voice call trace (transport.js
// createTrace: states, fetch paths + statuses, every close/stop/hangup with its stage and why; never a ticket, key,
// header, SDP body or password) and a wordless copy button (a glyph) that puts the whole trace on the clipboard as JSON lines.
// The panel's own chrome is WORDLESS (a count, a copy glyph, a check/cross): ?debug=1 also works on the player route, and the
// player view carries no words. Only the trace lines themselves (states, paths, whys) are text, and only on these routes.
// Styling is set through the CSSOM (element.style), which the 'self'-only CSP allows; no inline <style>, no remote URL.
export function mountTracePanel({ trace, doc = globalThis.document, max = 12 } = {}) {
  if (!trace || !doc?.body) return null;
  const old = doc.getElementById('voice-trace'); if (old) old.remove();
  const box = doc.createElement('div'); box.id = 'voice-trace';
  Object.assign(box.style, { position: 'fixed', left: '8px', bottom: '8px', zIndex: 2147483000, maxWidth: '46vw', font: '11px/1.35 ui-monospace, Menlo, monospace',
    color: '#cfe', background: 'rgba(0,0,0,.72)', border: '1px solid #345', borderRadius: '6px', padding: '6px 8px', pointerEvents: 'auto' });
  const head = doc.createElement('div'); Object.assign(head.style, { display: 'flex', gap: '8px', alignItems: 'center' });
  const title = doc.createElement('span'); title.textContent = '\u25CF'; title.setAttribute('aria-hidden', 'true');
  const count = doc.createElement('span'); count.id = 'voice-trace-count'; count.style.opacity = '.7';
  const copy = doc.createElement('button'); copy.id = 'voice-trace-copy'; copy.type = 'button'; copy.textContent = '\u29C9'; copy.setAttribute('aria-label', 'copy');
  Object.assign(copy.style, { font: 'inherit', color: '#cfe', background: '#123', border: '1px solid #456', borderRadius: '4px', cursor: 'pointer', padding: '1px 6px' });
  const log = doc.createElement('pre'); log.id = 'voice-trace-log'; Object.assign(log.style, { margin: '4px 0 0', whiteSpace: 'pre-wrap', maxHeight: '30vh', overflow: 'auto' });
  head.append(title, count, copy); box.append(head, log); doc.body.append(box);

  const line = (r) => `${String(r.dt).padStart(6)}ms ${r.kind}${Object.entries(r).filter(([k]) => !['t', 'dt', 'kind'].includes(k)).map(([k, v]) => ` ${k}=${v}`).join('')}`;
  const render = () => { const l = trace.list(); count.textContent = `${l.length}`; log.textContent = l.slice(-max).map(line).join('\n'); };
  const off = trace.on(render); render();

  copy.addEventListener('click', async () => {
    const text = trace.text();
    let ok = false;
    try { await globalThis.navigator?.clipboard?.writeText(text); ok = true; } catch {}
    if (!ok) { // fallback: a hidden textarea + execCommand (older browsers, no clipboard permission)
      try { const ta = doc.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; doc.body.append(ta); ta.select(); ok = doc.execCommand?.('copy') === true; ta.remove(); } catch {}
    }
    box.dataset.copied = ok ? String(text.length) : 'failed';
    copy.textContent = ok ? '\u2713' : '\u2717'; setTimeout(() => { copy.textContent = '\u29C9'; }, 1200);
  });
  return { el: box, render, stop: () => { off(); box.remove(); } };
}
