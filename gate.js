// Generic password gate (no app code here). Decrypts app.enc (AES-256-GCM, key = PBKDF2-SHA256)
// and boots the decrypted app. Format of app.enc: magic "CHG1" | iter u32 BE | salt[16] | iv[12] | ciphertext+tag.
const KEY = 'chamber.gate.pw';
const $ = (id) => document.getElementById(id);
const te = new TextEncoder(), td = new TextDecoder();
let blobP = null;
const getBlob = () => (blobP ||= fetch('app.enc', { cache: 'no-cache' }).then((r) => {
  if (!r.ok) throw new Error('fetch ' + r.status);
  return r.arrayBuffer();
}));

async function decrypt(pw) {
  const buf = new Uint8Array(await getBlob());
  if (td.decode(buf.slice(0, 4)) !== 'CHG1') throw new Error('bad format');
  const iter = new DataView(buf.buffer).getUint32(4);
  const salt = buf.slice(8, 24), iv = buf.slice(24, 36), ct = buf.slice(36);
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct); // throws on wrong password
  return JSON.parse(td.decode(pt));
}

function boot(app) {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = URL.createObjectURL(new Blob([app.css], { type: 'text/css' }));
  document.head.appendChild(css);
  document.getElementById('gate-css')?.remove();
  document.title = app.title || document.title;
  document.body.innerHTML = app.body;
  const js = URL.createObjectURL(new Blob([app.js], { type: 'text/javascript' }));
  return import(js);
}

async function tryPw(pw, remember) {
  const app = await decrypt(pw);
  if (remember) { try { localStorage.setItem(KEY, pw); } catch {} }
  await boot(app);
}

const form = $('gate-form'), input = $('gate-pw'), msg = $('gate-msg'), btn = $('gate-btn');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  btn.disabled = true; msg.textContent = '…';
  try { await tryPw(input.value, true); }
  catch (err) {
    console.warn('gate: unlock failed', err && err.name);
    msg.textContent = err && err.name === 'OperationError' ? 'סיסמה שגויה' : 'שגיאה בטעינה, נסו שוב';
    btn.disabled = false; input.select();
  }
});

(async () => {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  if (saved) {
    try { await tryPw(saved, false); return; }
    catch { try { localStorage.removeItem(KEY); } catch {} }
  }
  form.hidden = false; input.focus();
})();
