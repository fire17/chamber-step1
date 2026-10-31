// Ticket flow, NO password: POST ${origin}/v1/chamber/ticket {device} -> {ticket, expires_at}.
// No nonce, no proof, no gate key. device is random, kept in localStorage (try/catch: private mode / blocked storage
// fall back to in-memory). WebCrypto only, so the SAME file runs in the browser and in node tests.
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

let memDevice = null;
export function deviceId(storage = globalThis.localStorage) {
  const KEY = 'chamber.voice.device';
  try { const v = storage?.getItem(KEY); if (v && /^[A-Za-z0-9_-]{8,64}$/.test(v)) return v; } catch {}
  const v = memDevice || hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  memDevice = v;
  try { storage?.setItem(KEY, v); } catch {}
  return v;
}

// One fresh, single-use ticket per call attempt. Throws an Error with .status on refusal.
// NO-PASSWORD contract: POST ${origin}/v1/chamber/ticket {device} -> 200 {ticket, expires_at}
//   400 bad device · 403 origin · 429 rate/busy (Retry-After). No nonce, no proof, no password.
export async function fetchTicket(origin, device, { fetchImpl = globalThis.fetch } = {}) {
  const r = await fetchImpl(`${origin}/v1/chamber/ticket`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device }) });
  if (!r.ok) throw Object.assign(new Error(`ticket ${r.status}`), { status: r.status, retryAfter: Number(r.headers?.get?.('Retry-After')) || null });
  return r.json(); // {ticket, expires_at}
}
