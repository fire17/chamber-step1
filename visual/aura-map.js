// Chamber Step 2 visual: the AURA model. Pure (no DOM, no GL, no clock of its own): bus state in, render params out.
// aura.js draws what this returns; aura.test.mjs checks it in node.
//
// What it is (first principles, PARITY-1031 effects backlog items 6, 10, 11):
//   * The light is ATTACHED TO THE PERSON, not pasted over them. The feedback field zooms outward FROM the torso,
//     swirls AROUND the torso (lean and twist set the turn), and drifts where the sound pans and the eyes look.
//     The trails lengthen as movement builds (groove) and shorten in stillness, so a still person comes back into
//     focus. It is driven by the room's slow sound CONTROLS (bus.state.targets: swell, cutoff, pan, beat), never by
//     the audio signal, so it reads as the room answering, not as a meter. (6: trails, zoom, swirl; G19 / O9)
//   * "We see you" (G6) without words: a face that is seen gathers a soft regard-glow at the head. A smile warms
//     and brightens the room, an open jaw opens the head-glow and the outward bloom, raised brows widen the swirl,
//     a squint sharpens (shorter trails), the gaze leans the drift, and a blink sends one slow ripple out from
//     the head. No face = every face term is exactly 0 (they glide there; nothing jumps). (10)
//   * The AMORPHIC FIRST IMAGE (O9 / G12) is the same system with nobody in it: a few colour masses orbit on
//     incommensurate slow periods, and the feedback smears them into a nebula. As someone arrives, `wake` rises
//     (4 s) and the masses CONDENSE into that person's halo. There is no swap, no cut and no second renderer. The
//     room's words (the `say` verb) and speech (an optional bus.state.speech.level, or the person's own jaw
//     activity) STIR it: the masses quicken and brighten. (11)
//
// PHOTOSENSITIVITY / CALM (the still-body contract, tested in aura.test.mjs):
//   * Every input passes a one-pole glide whose time constant is >= MIN_GLIDE (0.25 s), and every output does
//     too, so a per-frame step is bounded by span * dt / 0.25 whatever the input does.
//   * The only periodic terms are the BREATH_HZ breath (0.09 Hz, deeper in stillness) and a beat pulse, a smooth
//     raised cosine at PULSE_HZ (1.2 Hz = 72 bpm) with depth <= 6 %. A blink ripple is a sin² envelope over 1.8 s,
//     with a 1.2 s refractory and at most 2 alive at once. No per-frame randomness anywhere.
//   * The clocks are integrated (phase += rate * dt), so a change of speed never jumps the image, and they never
//     stop: a still body breathes; it does not freeze.
//   * prefers-reduced-motion: zoom, swirl, warp and drift x0.35, no pulse, no ripples (the head glow glints
//     softly instead), a slower breath, shorter trails.
import { DJ } from '../mappings.js';

export const MIN_GLIDE = 0.25;   // s: the floor on every glide (the anti-strobe guarantee lives here)
export const BREATH_HZ = 0.09;   // Hz: the room's breath (~11 s)
export const PULSE_HZ = 1.2;     // Hz: the beat pulse (the progression's 72 bpm; not phase-locked, no beat clock on the bus)
export const MAX_EMITTERS = 8;   // the shader's uniform array size
export const MAX_RIPPLES = 2;
export const RIPPLE = { life: 1.8, refractory: 1.2, peak: 0.22, reach: 0.34, minRegard: 0.35, sightAt: 0.5, sightGap: 4 };
export const REST = { x: 0.5, y: 0.52 };          // where the amorph lives with nobody in the room (screen uv, y down)
export const STILL_BELOW = DJ?.stillBelow ?? 0.12; // the room's own stillness threshold (shared with the auto-DJ)
export const REDUCED = { motion: 0.35, breath: 0.5, tau: 0.6 };

// Hard ranges for every param (also the test oracle for "bounded outputs").
export const LIMITS = {
  gain: [0.12, 1], warmth: [0, 1], tau: [0.25, 1.8], zoom: [0, 0.32], swirl: [-1.2, 1.2], swirlR: [0.12, 0.6],
  driftX: [-0.05, 0.05], driftY: [-0.05, 0.05], warp: [0, 1], pulseAmp: [0, 0.06],
  ax: [0, 1], ay: [0, 1], hx: [0, 1], hy: [0, 1], haloR: [0.06, 0.45],
  wake: [0, 1], regard: [0, 1], stir: [0, 1],
};
// Output glides [up, down] in seconds (all >= MIN_GLIDE). Anchor glides are the "someone is here" values; with
// nobody seen, the anchor drifts home over ANCHOR_HOME s.
export const OUT_GLIDE = {
  gain: [0.5, 1.0], warmth: [0.8], tau: [0.8], zoom: [0.6, 1.0], swirl: [0.9], swirlR: [0.8], driftX: [1.0], driftY: [1.0],
  warp: [0.8], pulseAmp: [0.8, 1.6], ax: [0.5], ay: [0.5], hx: [0.35], hy: [0.35], haloR: [0.8],
};
export const ANCHOR_HOME = 3.0;
// Input (source) glides [up, down], s.
export const IN_GLIDE = {
  wake: [4, 8], regard: [1.5, 2.5], stir: [0.8, 2.5],
  smile: [0.6, 1.2], jaw: [0.3, 0.7], brow: [0.6, 1.2], squint: [0.8, 1.2], lookX: [0.8], lookY: [0.8],
  energy: [0.5, 1.5], groove: [1.0, 2.0], swellN: [0.6, 1.4], cutN: [1.2], pan: [1.5], beat: [0.8, 1.6], still: [5, 1.2],
  lean: [0.8], twist: [0.8], here: [0.6, 2.0],
};
// The palette: indigo (filter closed) -> rose -> amber (filter open). Linear RGB 0..1.
export const PALETTE = [[0.34, 0.36, 0.95], [0.86, 0.42, 0.74], [1.0, 0.64, 0.32]];

// ---------------------------------------------------------------- helpers (pure)
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (fin(v) ? v : d);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;

// One-pole glide; tau clamped >= MIN_GLIDE. Exact for any dt (frame-rate independent).
export function glide(cur, target, dt, tau) {
  const k = 1 - Math.exp(-dt / Math.max(MIN_GLIDE, tau));
  return cur + (target - cur) * k;
}
const pick = (spec, up) => Math.max(MIN_GLIDE, (up ? spec[0] : spec[1] ?? spec[0]));

// Per-frame feedback coefficients for a trail time constant tau: the old image keeps `decay`, new light enters at
// `feed` = 1 - decay, so an emitter of intensity i settles at exactly i whatever the trail length or the frame rate.
export function feedbackCoeffs(tau, dt) {
  const d = Math.exp(-Math.max(0, dt) / Math.max(MIN_GLIDE, tau));
  return { decay: d, feed: 1 - d };
}

export function palette(w) {
  const x = clamp01(w) * (PALETTE.length - 1), i = Math.min(PALETTE.length - 2, Math.floor(x)), t = x - i;
  return PALETTE[i].map((c, k) => lerp(c, PALETTE[i + 1][k], t));
}
const toWhite = (c, t) => c.map((v) => lerp(v, 1, t));

// Map a mirrored camera-normalised point (body.js / hand.js cx, cy) to screen uv (y down) under `object-fit:
// cover`, the way the stage shows #video. view = { cw, ch, vw, vh }.
export function coverUV(cx, cy, view = {}) {
  const cw = num(view.cw, 16) || 16, ch = num(view.ch, 9) || 9, vw = num(view.vw, 640) || 640, vh = num(view.vh, 480) || 480;
  const s = Math.max(cw / vw, ch / vh), w = vw * s, h = vh * s, ox = (cw - w) / 2, oy = (ch - h) / 2;
  return [clamp01((ox + cx * w) / cw), clamp01((oy + cy * h) / ch)];
}

// ---------------------------------------------------------------- the snapshot: bus.state -> plain numbers
// Reads ONLY: state.sense.{energy, groove, inputs.{body, A, B, face}}, state.targets.{swell, cutoff, pan, beat}, and
// the optional state.speech.level. Anything missing, non-finite or not `present` -> its idle value. Never throws.
export function readSnapshot(state) {
  const st = state && typeof state === 'object' ? state : {};
  const sense = st.sense && typeof st.sense === 'object' ? st.sense : {};
  const inp = sense.inputs && typeof sense.inputs === 'object' ? sense.inputs : {};
  const grp = (k) => { const g = inp[k]; return g && g.present && g.f && typeof g.f === 'object' ? g.f : null; };
  const bf = grp('body'), A = grp('A'), B = grp('B'), F = grp('face');
  const T = st.targets && typeof st.targets === 'object' ? st.targets : {};
  const pose = !!(bf && inp.body.pose !== false && fin(bf.cx) && fin(bf.cy));
  return {
    here: bf ? clamp01(num(bf.here, 1)) : 0,
    energy: clamp01(num(sense.energy, 0)),
    groove: clamp01(num(sense.groove, 0)),
    body: pose ? {
      cx: clamp01(bf.cx), cy: clamp01(bf.cy), sw: clamp(num(bf.shoulderW, 0.22), 0.02, 0.9),
      lean: clamp01(num(bf.lean, 0.5)), twist: clamp01(num(bf.twist, 0.5)),
    } : null,
    hands: [A, B].filter((h) => h && fin(h.cx) && fin(h.cy))
      .map((h) => ({ cx: clamp01(h.cx), cy: clamp01(h.cy), open: clamp01(num(h.openness, 0.5)), depth: clamp01(num(h.depth, 0.3)) })),
    face: F ? {
      smile: clamp01(num(F.smile, 0)), jaw: clamp01(num(F.jawOpen, 0)), brow: clamp01(num(F.browUp, 0)),
      squint: clamp01(num(F.squint, 0)), lookX: clamp01(num(F.lookX, 0.5)), lookY: clamp01(num(F.lookY, 0.5)),
    } : null,
    swell: clamp(num(T.swell, 0.16), 0, 1.5),
    cutoff: clamp(num(T.cutoff, 650), 20, 20000),
    pan: clamp(num(T.pan, 0), -1, 1),
    beat: clamp01(num(T.beat, 0)),
    speech: clamp01(num(st.speech?.level, 0)),
  };
}

// ---------------------------------------------------------------- the model
// step(snap, dt, opts) -> frame. opts: { view, reduced, paused, events: { blink: bool, say: seconds|0 } }.
// Deterministic: the same sequence of inputs gives the same frames.
const AMORPH = [ // [fx, fy, phase x, phase y, hue offset]: incommensurate slow orbits (cycles per amorph-second)
  [0.071, 0.053, 0.00, 0.31, -0.22], [0.047, 0.089, 0.47, 0.12, 0.18],
  [0.061, 0.037, 0.71, 0.63, 0.05], [0.083, 0.059, 0.23, 0.88, 0.30],
];

export class AuraModel {
  constructor() { this.reset(); }
  reset() {
    this.t = 0;
    this.clk = { breath: 0, pulse: 0, amorph: 0, flow: 0 };
    this.src = { wake: 0, regard: 0, stir: 0, smile: 0, jaw: 0, brow: 0, squint: 0, lookX: 0.5, lookY: 0.5, energy: 0, groove: 0,
      swellN: 0, cutN: 0.36, pan: 0, beat: 0, still: 1, lean: 0.5, twist: 0.5, here: 0 };
    this.out = null;          // glided outputs (initialised on the first step from the first targets)
    this.sayLeft = 0;         // seconds of `say` stir left
    this.jawPrev = null; this.jawAct = 0;
    this.ripples = []; this.lastRipple = -1e9;
    this.glint = 0; this.glintAge = null; // reduced-motion stand-in for a ripple
    this.faceGone = 1e9;      // seconds since a face was last seen (first-sight detection)
    this.sightArmed = true;   // a face acquired after >= RIPPLE.sightGap s without one sends ONE ripple
    this.lastHead = null;     // last known head position (screen uv)
    this.sw = 0.22;           // last known shoulder width
  }

  step(snap, dt, opts = {}) {
    dt = fin(dt) ? clamp(dt, 0, 0.1) : 0;
    const s = snap || readSnapshot(null);
    const view = opts.view || {};
    const reduced = !!opts.reduced, paused = !!opts.paused;
    const ev = opts.events || {};
    const motion = reduced ? REDUCED.motion : 1;
    this.t += dt;

    // ---- sources (glided). Paused = calm: the room's motion terms rest, the presence terms hold.
    const S = this.src, g = (k, target) => { S[k] = glide(S[k], target, dt, pick(IN_GLIDE[k], target > S[k])); };
    const face = s.face;
    g('here', s.here);
    g('wake', s.here > 0 ? 1 : 0);
    g('regard', face ? 1 : 0);
    g('smile', face ? face.smile : 0); g('jaw', face ? face.jaw : 0); g('brow', face ? face.brow : 0);
    g('squint', face ? face.squint : 0); g('lookX', face ? face.lookX : 0.5); g('lookY', face ? face.lookY : 0.5);
    g('energy', paused ? 0 : s.energy); g('groove', paused ? 0 : s.groove);
    g('swellN', clamp01((s.swell - 0.16) / (0.85 - 0.16)));
    g('cutN', clamp01(Math.log(s.cutoff / 180) / Math.log(6500 / 180)));
    g('pan', s.pan); g('beat', paused ? 0 : s.beat);
    g('still', 1 - smoothstep(0.35 * STILL_BELOW, 1.35 * STILL_BELOW, paused ? 0 : s.energy));
    g('lean', s.body ? s.body.lean : 0.5); g('twist', s.body ? s.body.twist : 0.5);
    // stir: the room speaking (say), speech level, or the person's own jaw moving (talking / singing)
    if (fin(ev.say) && ev.say > 0) this.sayLeft = Math.max(this.sayLeft, Math.min(8, ev.say));
    this.sayLeft = Math.max(0, this.sayLeft - dt);
    const jawNow = face ? face.jaw : 0;
    const jawRate = this.jawPrev == null || dt <= 0 ? 0 : Math.abs(jawNow - this.jawPrev) / dt;
    this.jawPrev = face ? jawNow : null;
    this.jawAct = glide(this.jawAct, clamp01(jawRate * 0.25), dt, 0.6);
    g('stir', Math.max(this.sayLeft > 0 ? 1 : 0, s.speech, this.jawAct));
    const W = S.wake, R = S.regard;

    // ---- clocks (integrated, never stop: paused only slows them)
    const slow = paused ? 0.3 : 1;
    this.clk.breath += dt * BREATH_HZ * (reduced ? REDUCED.breath : 1);
    this.clk.pulse += dt * PULSE_HZ;
    this.clk.amorph += dt * (0.6 + 1.2 * S.stir) * motion * slow;
    this.clk.flow += dt * (0.4 + 1.2 * S.energy + 0.4 * S.stir) * motion * slow;
    const breath = Math.sin(TAU * this.clk.breath);

    // ---- where the person is (screen uv)
    let anchorT = null, headT = null;
    const vAsp = num(view.vw, 640) / num(view.vh, 480);
    if (s.body) {
      const b = s.body;
      this.sw = b.sw;
      anchorT = coverUV(b.cx, b.cy + 0.35 * b.sw * vAsp, view);
      headT = coverUV(b.cx, b.cy - 0.7 * b.sw * vAsp, view);
    } else if (s.hands.length) {
      const hx = s.hands.reduce((a, h) => a + h.cx, 0) / s.hands.length, hy = s.hands.reduce((a, h) => a + h.cy, 0) / s.hands.length;
      anchorT = coverUV(hx, hy, view);
    }
    const cw = num(view.cw, 16) || 16, ch = num(view.ch, 9) || 9, vw = num(view.vw, 640) || 640, vh = num(view.vh, 480) || 480;
    const scale = Math.max(cw / vw, ch / vh), minDim = Math.min(cw, ch);
    const swScreen = (this.sw * vw * scale) / minDim; // shoulder width in min-dimension units

    // ---- target params
    const tauBody = lerp(0.5, 1.6, S.groove) * (1 - 0.35 * S.squint * R);
    let tau = lerp(1.4, tauBody, W);
    if (reduced) tau *= REDUCED.tau;
    const leanB = (S.lean - 0.5) * 2, twistB = (S.twist - 0.5) * 2;
    const T = {
      gain: 0.3 + 0.55 * lerp(0.2, S.swellN, W) + 0.15 * S.smile * R + 0.1 * S.stir,
      warmth: 0.08 + 0.78 * S.cutN + 0.25 * S.smile * R,
      tau,
      zoom: (lerp(0.05, 0.03, W) + 0.14 * S.energy + 0.05 * S.swellN * W + 0.08 * S.jaw * R + 0.05 * S.brow * R + 0.05 * S.stir) * motion,
      swirl: (0.07 + 0.7 * leanB + 0.35 * twistB) * (0.6 + 0.8 * S.energy) * motion,
      swirlR: lerp(0.38, 0.14 + 0.55 * swScreen, W) + 0.08 * S.brow * R,
      driftX: (0.02 * S.pan + 0.035 * (S.lookX - 0.5) * 2 * R) * motion,
      driftY: (-0.03 * (S.lookY - 0.5) * 2 * R) * motion,
      warp: (0.25 + 0.35 * S.energy + 0.35 * (1 - W) + 0.3 * S.stir) * motion,
      pulseAmp: reduced ? 0 : 0.06 * S.beat,
      haloR: 0.9 * swScreen,
    };
    // anchor + head: follow the person; with nobody seen, hold, then drift home
    const home = W < 0.2;
    const aT = anchorT || (home ? [REST.x, REST.y] : this.out ? [this.out.ax, this.out.ay] : [REST.x, REST.y]);
    T.ax = aT[0]; T.ay = aT[1];
    if (headT) this.lastHead = headT;
    const hT = headT || this.lastHead || [aT[0], Math.max(0, aT[1] - 0.16)];
    T.hx = hT[0]; T.hy = hT[1];
    for (const k in T) T[k] = clamp(T[k], LIMITS[k][0], LIMITS[k][1]);

    // ---- output glides
    if (!this.out) this.out = { ...T };
    const O = this.out;
    for (const k in T) {
      let tauK = pick(OUT_GLIDE[k], T[k] > O[k]);
      if ((k === 'ax' || k === 'ay') && !anchorT) tauK = ANCHOR_HOME;
      O[k] = clamp(glide(O[k], T[k], dt, tauK), LIMITS[k][0], LIMITS[k][1]);
    }

    // ---- blink -> ripple (rate-limited; regard-gated; reduced motion: a soft glint instead)
    // first sight (G6, "we see you"): a face arriving after a gap sends one ripple once regard is half in
    this.faceGone = face ? 0 : this.faceGone + dt;
    if (this.faceGone >= RIPPLE.sightGap) this.sightArmed = true;
    const sight = face && this.sightArmed && R >= RIPPLE.sightAt;
    if (sight) this.sightArmed = false;
    if ((sight || (ev.blink && face && R >= RIPPLE.minRegard)) && this.t - this.lastRipple >= RIPPLE.refractory) {
      this.lastRipple = this.t;
      if (reduced) this.glintAge = 0;
      else if (this.ripples.length < MAX_RIPPLES) this.ripples.push({ x: O.hx, y: O.hy, age: 0 });
    }
    for (const r of this.ripples) r.age += dt;
    this.ripples = this.ripples.filter((r) => r.age < RIPPLE.life);
    if (this.glintAge != null) { this.glintAge += dt; if (this.glintAge >= RIPPLE.life) this.glintAge = null; }
    const env = (age) => Math.sin(Math.PI * clamp01(age / RIPPLE.life)) ** 2;
    this.glint = this.glintAge == null ? 0 : env(this.glintAge);
    const ripples = this.ripples.map((r) => ({
      x: r.x, y: r.y, radius: 0.03 + RIPPLE.reach * clamp01(r.age / RIPPLE.life) ** 0.6, i: RIPPLE.peak * R * env(r.age),
    }));

    // ---- emitters (screen uv, y down; r in min-dimension units; i = settled intensity 0..1; col linear RGB)
    const em = [];
    const base = palette(O.warmth);
    // the person's halo: where they stand, sized by their body, breathing
    em.push({ x: O.ax, y: O.ay, r: O.haloR, i: 0.5 * W * S.here * (0.6 + 0.4 * S.swellN) * (1 + 0.12 * breath), col: base });
    // the regard glow at the head: exists only while a face is (or was just) seen; 0 with no face, exactly
    em.push({ x: O.hx, y: O.hy, r: 0.05 + 0.05 * S.jaw + 0.02 * S.smile,
      i: R * (0.32 + 0.25 * S.smile + 0.15 * this.glint), col: toWhite(palette(O.warmth + 0.2), 0.35) });
    // hands: small lights that leave the brightest trails
    s.hands.slice(0, 2).forEach((h, k) => {
      const [x, y] = coverUV(h.cx, h.cy, view);
      em.push({ x, y, r: 0.035 + 0.05 * h.depth, i: 0.3 + 0.3 * h.open, col: palette(O.warmth + (k ? -0.3 : 0.15)) });
    });
    // the amorph: free with nobody here, condensed into the halo as the room wakes
    const cx = lerp(REST.x, O.ax, W), cy = lerp(REST.y, O.ay, W), orbit = lerp(0.2, 0.06, W) * (1 + 0.4 * S.stir);
    for (const [fx, fy, px, py, hue] of AMORPH) {
      if (em.length >= MAX_EMITTERS) break;
      const a = this.clk.amorph;
      em.push({ x: clamp01(cx + orbit * Math.sin(TAU * (fx * a + px))), y: clamp01(cy + 0.8 * orbit * Math.cos(TAU * (fy * a + py))),
        r: lerp(0.15, 0.07, W), i: (0.42 - 0.3 * W) * (1 + 0.6 * S.stir) * (1 + 0.08 * breath), col: palette(O.warmth + hue) });
    }
    for (const e of em) { e.i = clamp(e.i, 0, 1); e.r = clamp(e.r, 0.01, 0.5); }

    // ---- display terms: breath (deeper in stillness) and the beat pulse (a smooth raised cosine)
    const breathDepth = (0.04 + 0.07 * S.still) * (reduced ? REDUCED.breath : 1);
    const pulse = O.pulseAmp * 0.5 * (1 - Math.cos(TAU * this.clk.pulse));
    const gainOut = clamp(O.gain * (1 + breathDepth * breath) * (1 + pulse), 0, 1.2);
    const luma = gainOut + ripples.reduce((a, r) => a + r.i * 0.5, 0);

    return {
      t: this.t,
      params: { ...O, gainOut, breath, pulse, flowT: this.clk.flow, wake: W, regard: R, stir: S.stir, still: S.still },
      emitters: em, ripples, luma,
    };
  }
}
