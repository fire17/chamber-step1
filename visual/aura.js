// Chamber Step 2 visual: the AURA layer (PARITY-1031 effects backlog 6 · 10 · 11). Wordless; no network; no assets.
//
//   import { createAura } from './visual/aura.js';
//   const aura = createAura(canvas, { bus, video });   // see HOOK.md for the exact mount
//
// A feedback light-field that lives ON the person: each frame the previous image is pulled outward from the
// torso (zoom), turned around it (swirl), lightly warped and drifted, faded by the trail time constant, and new
// light is added where the body, the head (a seen face) and the hands are. With nobody there the same feedback
// smears a few slow colour masses into the amorphic first image, which condenses into the person's halo as the
// room wakes. All of the mapping lives in aura-map.js (pure, node-tested); this file only draws it.
//
// Reads (read-only; it never emits, never writes bus.state):
//   bus.state.sense.{energy, groove, inputs.{body, A, B, face}}, bus.state.targets.{swell, cutoff, pan, beat},
//   optional bus.state.speech.level; events 'face.blink', 'say', 'pause'.
// Backends: WebGL2 (half-float trails) -> WebGL1 (8-bit trails) -> Canvas 2D. Renders at a reduced resolution
// (long side <= 640 px, adaptive down to 0.5x if the frame budget is missed) and lets CSS scale it up: it is light.
import { AuraModel, readSnapshot, feedbackCoeffs, MAX_EMITTERS, MAX_RIPPLES } from './aura-map.js';

const VS = `attribute vec2 aPos; varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// The feedback pass. Works in SCREEN space (y down), lengths in min-dimension units (uAsp = size / minDim).
const FS_FEED = `precision highp float;
varying vec2 vUv;
uniform sampler2D uPrev;
uniform vec2 uAsp, uAnchor, uDrift;
uniform float uDt, uZoom, uSwirl, uSwirlR, uWarp, uFlow, uDecay, uFeed, uFloor;
uniform vec4 uE[${MAX_EMITTERS}]; uniform vec3 uC[${MAX_EMITTERS}];
uniform vec4 uR[${MAX_RIPPLES}];
vec2 flowField(vec2 q, float t) {
  return vec2(sin(q.y * 4.1 + t * 0.71) + 0.6 * sin(q.y * 2.3 - q.x * 1.7 - t * 0.43),
              cos(q.x * 3.7 - t * 0.63) + 0.6 * cos(q.x * 1.9 + q.y * 2.1 + t * 0.37));
}
void main() {
  vec2 s = vec2(vUv.x, 1.0 - vUv.y);
  vec2 P = s * uAsp, A = uAnchor * uAsp;
  vec2 d = P - A;
  float r = length(d);
  // inverse map: where did this pixel's light come from one frame ago?
  float ang = -uSwirl * uDt * (0.25 + 0.75 * exp(-(r * r) / (uSwirlR * uSwirlR)));
  float ca = cos(ang), sa = sin(ang);
  vec2 q = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y) * (1.0 - uZoom * uDt);
  q += 0.06 * uWarp * uDt * flowField(q * 2.2, uFlow);
  q -= uDrift * uDt;
  vec2 back = (q + A) / uAsp;
  vec3 prev = texture2D(uPrev, vec2(back.x, 1.0 - back.y)).rgb;
  float inside = step(0.0, back.x) * step(back.x, 1.0) * step(0.0, back.y) * step(back.y, 1.0);
  vec3 add = vec3(0.0);
  for (int k = 0; k < ${MAX_EMITTERS}; k++) {
    vec2 e = uE[k].xy * uAsp - P;
    add += uC[k] * uE[k].w * exp(-dot(e, e) / max(1e-4, uE[k].z * uE[k].z));
  }
  for (int k = 0; k < ${MAX_RIPPLES}; k++) {
    float rr = length(uR[k].xy * uAsp - P) - uR[k].z;
    add += vec3(1.0, 0.92, 0.82) * uR[k].w * exp(-(rr * rr) / 0.0009);
  }
  vec3 c = prev * inside * uDecay + add * uFeed - uFloor;
  gl_FragColor = vec4(clamp(c, 0.0, 4.0), 1.0);
}`;

// The display pass: exposure + soft tone curve + a STATIC dither (no per-frame noise: no flicker).
const FS_SHOW = `precision highp float;
varying vec2 vUv;
uniform sampler2D uTex; uniform float uGain;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb * uGain;
  c = 1.0 - exp(-1.7 * c);
  float n = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  gl_FragColor = vec4(c + n / 255.0, 1.0);
}`;

export const BUDGET = { longSide: 640, minScale: 0.5, slowMs: 1000 / 40, recoverMs: 1000 / 55 };

function reducedQuery() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return null; }
}

export function createAura(canvas, { bus = null, video = null, force = null } = {}) {
  const model = new AuraModel();
  const mq = reducedQuery();
  let reduced = !!mq?.matches;
  const onMq = (e) => { reduced = !!e.matches; };
  try { mq?.addEventListener?.('change', onMq); } catch {}
  const ev = { blink: false, say: 0 };
  let paused = false;
  const offs = [];
  if (bus?.on) {
    offs.push(bus.on('face.blink', () => { ev.blink = true; }));
    offs.push(bus.on('say', (d) => { ev.say = Math.max(ev.say, Math.min(8, +d?.show || 4)); }));
    offs.push(bus.on('pause', (d) => { paused = !!d?.paused; }));
  }

  // ---------------- backend
  let gl = null, kind = '2d';
  const ctxOpts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' };
  if (force !== '2d') {
    if (force !== 'webgl1') { try { gl = canvas.getContext('webgl2', ctxOpts); if (gl) kind = 'webgl2'; } catch {} }
    if (!gl) { try { gl = canvas.getContext('webgl', ctxOpts); if (gl) kind = 'webgl1'; } catch {} }
  }
  const R = gl ? makeGL(gl, kind) : null;
  if (gl && !R) { gl = null; kind = '2d'; }
  const C2 = gl ? null : make2D(canvas);
  if (!gl && !C2) kind = 'none';

  // ---------------- sizing + adaptive quality
  let scale = 1, w = 0, h = 0, slowFor = 0, fastFor = 0, ema = 1000 / 60;
  function size() {
    const cw = Math.max(1, canvas.clientWidth || canvas.width || 1), ch = Math.max(1, canvas.clientHeight || canvas.height || 1);
    const base = Math.min(1, BUDGET.longSide / Math.max(cw, ch));
    const nw = Math.max(16, Math.round(cw * base * scale)), nh = Math.max(16, Math.round(ch * base * scale));
    if (nw !== w || nh !== h) { w = nw; h = nh; canvas.width = w; canvas.height = h; R?.resize(w, h); C2?.resize(w, h); }
    return { cw, ch };
  }

  // ---------------- frame
  let raf = 0, last = 0, running = false;
  const st = { frames: 0, ms: 0, msMax: 0, fps: 0, fpsN: 0, fpsT: 0, scale: 1, kind, reduced, lastParams: null, errors: 0 };
  function frame(now) {
    raf = running ? requestAnimationFrame(frame) : 0;
    const dt = last ? Math.min(0.1, Math.max(0, (now - last) / 1000)) : 1 / 60;
    if (last) ema += ((now - last) - ema) * 0.05;
    last = now;
    renderOnce(dt);
    // adaptive: a sustained slow frame rate drops the resolution (never below minScale); a sustained fast one recovers
    if (ema > BUDGET.slowMs) { slowFor += dt; fastFor = 0; } else if (ema < BUDGET.recoverMs) { fastFor += dt; slowFor = 0; }
    if (slowFor > 2 && scale > BUDGET.minScale) { scale = Math.max(BUDGET.minScale, scale * 0.75); slowFor = 0; }
    if (fastFor > 8 && scale < 1) { scale = Math.min(1, scale / 0.75); fastFor = 0; }
    st.fpsN++; if (now - st.fpsT >= 1000) { st.fps = (st.fpsN * 1000) / (now - st.fpsT || 1); st.fpsN = 0; st.fpsT = now; }
  }
  function renderOnce(dt) {
    const t0 = performance.now();
    try {
      const { cw, ch } = size();
      const view = { cw, ch, vw: video?.videoWidth || 640, vh: video?.videoHeight || 480 };
      const f = model.step(readSnapshot(bus?.state), dt, { view, reduced, paused, events: { blink: ev.blink, say: ev.say } });
      ev.blink = false; ev.say = 0;
      const minDim = Math.min(cw, ch), asp = [cw / minDim, ch / minDim];
      if (R) R.draw(f, dt, asp); else if (C2) C2.draw(f, dt, asp);
      st.lastParams = f.params;
    } catch (e) { st.errors++; if (st.errors < 4) console.warn('[aura]', e); }
    const ms = performance.now() - t0;
    st.frames++; st.ms += (ms - st.ms) * 0.05; st.msMax = Math.max(st.msMax * 0.995, ms);
    st.scale = scale; st.reduced = reduced;
    return ms;
  }
  const api = {
    kind,
    start() { if (!running && kind !== 'none') { running = true; last = 0; raf = requestAnimationFrame(frame); } return api; },
    stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; return api; },
    destroy() { api.stop(); offs.forEach((off) => { try { off(); } catch {} }); try { mq?.removeEventListener?.('change', onMq); } catch {} R?.destroy(); },
    reset() { model.reset(); R?.clear(); C2?.clear(); },
    // one synchronous frame with a given dt; finish = force GPU completion (1-px read) so the cost is measurable
    renderOnce(dt = 1 / 60, finish = false) { const t0 = performance.now(); renderOnce(dt); if (finish) R?.finish(); C2 && finish && C2.finish(); return performance.now() - t0; },
    stats: () => ({ ...st, w, h, params: st.lastParams && { ...st.lastParams } }),
    model,
  };
  return kind === 'none' ? api : api.start();
}

// ================================================================ WebGL
function makeGL(gl, kind) {
  const isGL2 = kind === 'webgl2';
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = (fs) => {
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  };
  let feed, show;
  try { feed = prog(FS_FEED); show = prog(FS_SHOW); } catch (e) { console.warn('[aura] GL compile failed, 2D fallback:', e?.message || e); return null; }
  const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // trail precision: half-float when the GPU can render to it, else 8-bit with a decay floor (no stuck residue)
  let half = false;
  if (isGL2 && gl.getExtension('EXT_color_buffer_float')) half = true;
  const fmt = () => (half ? [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT] : [gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE]);
  const mk = (w, h) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    const [ifmt, f, ty] = fmt(); gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, f, ty, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { t, fb, w, h, ok };
  };
  let A = null, B = null;
  const E = new Float32Array(MAX_EMITTERS * 4), Cc = new Float32Array(MAX_EMITTERS * 3), RR = new Float32Array(MAX_RIPPLES * 4);
  const free = (x) => { if (x) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.fb); } };
  const R = {
    half,
    resize(w, h) {
      let a = mk(w, h), b = mk(w, h);
      if (half && !(a.ok && b.ok)) { free(a); free(b); half = false; a = mk(w, h); b = mk(w, h); }
      if (A) { // carry the trails across a resize (no blank frame): one plain copy pass from the old texture
        // the feed shader with zero motion, decay 1 and feed 0 is an exact resampling copy
        gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb); gl.viewport(0, 0, w, h);
        gl.useProgram(feed.p); setFeedStatic(A.t); gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      free(A); free(B); A = a; B = b;
    },
    clear() { for (const x of [A, B]) if (x) { gl.bindFramebuffer(gl.FRAMEBUFFER, x.fb); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); } },
    draw(f, dt, asp) {
      if (!A) return;
      const p = f.params, { decay, feed: fd } = feedbackCoeffs(p.tau, dt);
      // ---- feedback: B <- T(A) * decay + emitters * feed
      gl.bindFramebuffer(gl.FRAMEBUFFER, B.fb); gl.viewport(0, 0, B.w, B.h);
      gl.useProgram(feed.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, A.t);
      const u = feed.u;
      gl.uniform1i(u.uPrev, 0); gl.uniform2f(u.uAsp, asp[0], asp[1]); gl.uniform2f(u.uAnchor, p.ax, p.ay);
      gl.uniform2f(u.uDrift, p.driftX, p.driftY); gl.uniform1f(u.uDt, dt); gl.uniform1f(u.uZoom, p.zoom);
      gl.uniform1f(u.uSwirl, p.swirl); gl.uniform1f(u.uSwirlR, p.swirlR); gl.uniform1f(u.uWarp, p.warp);
      gl.uniform1f(u.uFlow, p.flowT); gl.uniform1f(u.uDecay, decay); gl.uniform1f(u.uFeed, fd);
      gl.uniform1f(u.uFloor, half ? 0 : 0.51 / 255);
      E.fill(0); Cc.fill(0); RR.fill(0);
      f.emitters.slice(0, MAX_EMITTERS).forEach((e, k) => { E.set([e.x, e.y, e.r, e.i], k * 4); Cc.set(e.col, k * 3); });
      f.ripples.slice(0, MAX_RIPPLES).forEach((r, k) => RR.set([r.x, r.y, r.radius, r.i], k * 4));
      gl.uniform4fv(u.uE, E); gl.uniform3fv(u.uC, Cc); gl.uniform4fv(u.uR, RR);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // ---- display
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(show.p); gl.bindTexture(gl.TEXTURE_2D, B.t); gl.uniform1i(show.u.uTex, 0); gl.uniform1f(show.u.uGain, p.gainOut);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [A, B] = [B, A];
    },
    finish() { const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; },
    destroy() { free(A); free(B); A = B = null; gl.deleteProgram(feed.p); gl.deleteProgram(show.p); gl.deleteBuffer(vbo); },
  };
  function setFeedStatic(tex) {
    const u = feed.u; gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.uPrev, 0); gl.uniform2f(u.uAsp, 1, 1); gl.uniform2f(u.uAnchor, 0.5, 0.5); gl.uniform2f(u.uDrift, 0, 0);
    gl.uniform1f(u.uDt, 0); gl.uniform1f(u.uZoom, 0); gl.uniform1f(u.uSwirl, 0); gl.uniform1f(u.uSwirlR, 0.3); gl.uniform1f(u.uWarp, 0);
    gl.uniform1f(u.uFlow, 0); gl.uniform1f(u.uDecay, 1); gl.uniform1f(u.uFeed, 0); gl.uniform1f(u.uFloor, 0);
    gl.uniform4fv(u.uE, new Float32Array(MAX_EMITTERS * 4)); gl.uniform3fv(u.uC, new Float32Array(MAX_EMITTERS * 3)); gl.uniform4fv(u.uR, new Float32Array(MAX_RIPPLES * 4));
  }
  return R;
}

// ================================================================ Canvas 2D fallback (global swirl/zoom only; 8-bit trails)
function make2D(canvas) {
  let g; try { g = canvas.getContext('2d', { alpha: false }); } catch { return null; }
  if (!g) return null;
  const buf = document.createElement('canvas'), b = buf.getContext('2d', { alpha: false });
  const css = (c, a) => `rgba(${Math.round(255 * Math.min(1, c[0]))},${Math.round(255 * Math.min(1, c[1]))},${Math.round(255 * Math.min(1, c[2]))},${a})`;
  return {
    resize(w, h) { buf.width = w; buf.height = h; b.drawImage(canvas, 0, 0, w, h); g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.drawImage(buf, 0, 0); },
    clear() { g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height); },
    draw(f, dt, asp) {
      const w = canvas.width, h = canvas.height, md = Math.min(w, h), p = f.params;
      // 8-bit trails stick at low values for slow decays: keep the 2D decay <= 0.92 per frame
      const d2 = Math.min(feedbackCoeffs(p.tau, dt).decay, 0.92), f2 = 1 - d2;
      b.globalCompositeOperation = 'copy'; b.drawImage(canvas, 0, 0);
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      g.save(); g.globalAlpha = d2;
      const ax = p.ax * w, ay = p.ay * h;
      g.translate(ax + p.driftX * dt * md, ay + p.driftY * dt * md); g.rotate(p.swirl * dt * 0.6); g.scale(1 + p.zoom * dt, 1 + p.zoom * dt); g.translate(-ax, -ay);
      g.drawImage(buf, 0, 0); g.restore();
      g.globalCompositeOperation = 'lighter';
      // steady state of (old * d2 + a) is a / (1 - d2): add i * f2 so an emitter settles near its intensity
      const k = f2 * p.gainOut * 2.2;
      for (const e of f.emitters) {
        const x = e.x * w, y = e.y * h, r = Math.max(1, e.r * md * 1.6), a = Math.min(1, e.i * k);
        const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, css(e.col, a)); gr.addColorStop(1, css(e.col, 0));
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      for (const r of f.ripples) {
        g.strokeStyle = `rgba(255,235,210,${Math.min(1, r.i * 2)})`; g.lineWidth = Math.max(1, 0.02 * md);
        g.beginPath(); g.arc(r.x * w, r.y * h, r.radius * md, 0, Math.PI * 2); g.stroke();
      }
      g.globalCompositeOperation = 'source-over';
    },
    // force completion for timing: read 1 px through a scratch canvas (keeps the main context GPU-backed)
    finish() { const t = (this._t ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 })), tg = t.getContext('2d', { willReadFrequently: true }); tg.drawImage(canvas, 0, 0, 1, 1); tg.getImageData(0, 0, 1, 1); },
  };
}
