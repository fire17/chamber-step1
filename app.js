// Chamber Next Gen — Step 2: the walking skeleton.
//   senses (camera -> hand.js / body.js) ──▶ bus.state.sense ──▶ body story (observations, ids)
//                                               │                      │ obs.open wakes
//   static mappings (whole body, always live) ◀─┤                      ▼
//   bindings (life.js, data) ◀── verbs ◀── conductor (one scheduler: cues · dj · readiness policies)
//   pad (synth.js) + beat (beat.js) ◀── targets          │ say ──▶ captions (the Mouth in Step 3)
// The player screen is wordless except the opening's brief captions. The console (d / #dev) is developer-only.
import {
  MAPPINGS, POOL, PHASES, PROGRESSION, VOICINGS, VISION, ENERGY, PRESENCE_HOLD_MS, BODY_HOLD_MS,
  computeTargets, readBlend, readSource, srcNames,
} from './mappings.js';
import { featuresFromLandmarks, synthLandmarks, assignHands, smoothFeatures } from './hand.js';
import { FaceTracker, synthBlendshapes } from './face.js';
import { BodyTracker, EnergyMeter, bodyVisible, posePointsForEnergy, synthPose } from './body.js';
import { Bindings, Progression, voiceLead } from './life.js';
import { Bus } from './bus.js';
import { BodyStory } from './story.js';
import { makeConductor } from './conductor.js';
import { MappingLayer } from './layer.js';
import { SOURCES, TARGETS, TARGET } from './registry.js';
import { CURVES, curveName, curvePos } from './curves.js';
import { Pad } from './synth.js';

// Everything is served from ./vendor (same origin). There is NO CDN fallback by design (CSP in index.html,
// telemetry patched out of the vendored bundle: vendor/VERSIONS.md). Nothing leaves the machine.
const VENDOR = new URL('./vendor/', location.href).href;
const params = new URLSearchParams(location.search);
const FORCE_CPU = params.get('delegate') === 'cpu';
const NO_HANDS = params.get('hands') === '0'; // run on the whole body alone (pose only)
const NO_FACE = params.get('face') === '0'; // face layer off (optional, like hands)
// face delegate: CPU by default (on a weak GPU the face model ran 4.5x slower on GPU than CPU: FACE_INTEGRATION.md)
const FACE_DELEGATE = (params.get('faceDelegate') || 'cpu').toUpperCase();
const FACE_HOLD_MS = 400;
// WHO is at the screen decides the boot. The dev route (#dev / ?dev=1, dev/test only) boots PAUSED, as old Chamber did (PLAN §4
// Step 2, the console: "pause / resume (it boots paused, as old Chamber did)"): the person can be framed first, then
// space resumes. The PLAYER route (the deployed link, no #dev) does not hold: the one start gesture also starts the room.
// (Goni 3EB06DD1/3EB06CD4: on the player route the paused boot read as "no sound" until he pressed space.)
const DEV_ROUTE = location.hash === '#dev' || params.get('dev') === '1';

const $ = (id) => document.getElementById(id);
const video = $('video'), canvas = $('overlay'), ctx2d = canvas.getContext('2d');

const S = {
  phase: 'idle', error: null, delegate: null, poseDelegate: null, handsError: null, faceError: null, faceDelegate: null,
  paused: true, // the room BOOTS PAUSED on the dev route: space / the console resumes it
  dev: false, timeScale: Math.max(0.01, +params.get('timescale') || 1),
  hands: { A: { present: false }, B: { present: false } }, body: { present: false }, face: { present: false },
  lastSeen: { A: 0, B: 0, body: 0, face: 0 }, lastFeat: { A: null, B: null }, bodyFeat: null,
  zone: 0, targets: null, energy: 0, groove: 0, inp: null,
  inject: null, injectPose: null, landmarks: [], pose: null, aIndex: -1,
  perf: { tickFps: VISION.fps, hands: { fps: 0, ms: 0, n: 0 }, pose: { fps: 0, ms: 0, n: 0 }, face: { fps: 0, ms: 0, n: 0 }, tickMs: 0 },
  aura: { x: 0.5, y: 0.55, r: 0.32, a: 0.11, seen: false },
  caption: null, captions: [], // what the player was shown (verification + console)
};
let pad = null, audioCtx = null, hands = null, pose = null, face = null;
let voiceOut = null; // the voice output node (H3 duck key), set by mountVoice's onOutput

// ---------------- the skeleton: one bus, one story, one conductor ----------------
const bus = new Bus();
const bindings = new Bindings(POOL), prog = new Progression(), bodyT = new BodyTracker(), energy = new EnergyMeter(), faceT = new FaceTracker();
const story = new BodyStory(bus);
// the dynamic layer (layer.js): the live static mappings + the bindings, edited only through map.* verbs
const layer = new MappingLayer({ bindings });
const conductor = makeConductor({
  bus, bindings, story, layer,
  sensors: {
    stimulusRms: () => pad?.chimeRms() ?? 0,                               // the stimulus' own tap
    source: (d) => (S.inp ? readBlend(S.inp, d.src, d.mag) : null),       // what the body is doing
    param: (target) => pad?.live()[target],                                // what the audio graph is doing
    sound: () => {                                                         // per-turn snapshot for the trace
      const l = pad?.live(); if (!l) return null;
      const r = (v) => +(+v).toFixed(3);
      return { cutoff: Math.round(l.cutoff), swell: r(l.swell), pan: r(l.pan), voicing: S.zone, notes: l.notes?.join(' '), detune: r(l.detune), reverbWet: r(l.reverbWet), vibrato: r(l.vibrato), tremolo: r(l.tremolo),
        rms: +(pad?.rms() ?? 0).toFixed(4),                                // measured loudness (judge/HOOK.md H4), not a target
        hands: (S.hands.A.present ? 1 : 0) + (S.hands.B.present ? 1 : 0), body: S.body.present };
    },
  },
});
Object.assign(bus.state, { bindings, story, prog }); // every part reads the same live objects
// the effectful verbs live where the effect lives (audio here). The conductor, the console and Step 3's mind call them.
conductor.register('stimulus', ({ what = 'chime', midi, level }) => {
  if (what !== 'chime') return { ok: false, why: `no stimulus '${what}'` };
  if (!pad) return { ok: false, why: 'no audio yet' };
  const at = pad.chime({ midi, level });
  return { ok: true, what, at: +at.toFixed(3) };
});
// `say` stays the conductor's core verb (publish on the bus); captions are ONE subscriber (Step 3 adds the Mouth)
bus.on('say', ({ text, en, show = 3.5, cue }) => {
  S.caption = { text, en, cue, until: bus.state.runT + show };
  S.captions.push({ t: +bus.state.t.toFixed(2), cue, text, en });
  const el = $('caption');
  el.textContent = text; el.title = en || '';
  el.classList.add('on');
});
bus.on('say', (ev) => pad?.duckSay(ev)); // duck under speech (sound/HOOK.md H3): the BACKSTOP key; spoken Director lines only
bus.on('phase', (ph) => pad?.phase(ph)); // sound/HOOK.md H4+H6: ONE entry: transition swell + phase lean on v; boot sets the reference only

// the aura (visual/AURA-HOOK.md): on by default; ?aura=0 turns it off. It only reads the bus (and the video size).
// Layout through the CSSOM (CSP style-src 'self' allows it; the canvas has no style attribute): over the video, screen-blended.
let aura = null;
if (params.get('aura') !== '0') {
  const el = $('aura');
  if (el) Object.assign(el.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', mixBlendMode: 'screen' });
  // The aura learns pause only from bus 'pause' emits, and the room boots paused without one: this view seeds its
  // pause state at subscription (no global emit, so other 'pause' listeners see nothing new).
  const auraBus = {
    get state() { return bus.state; },
    on(name, fn) { const off = bus.on(name, fn); if (name === 'pause') fn({ paused: S.paused }); return off; },
  };
  import('./visual/aura.js')
    .then(({ createAura }) => {
      if (!el) return;
      aura = createAura(el, { bus: auraBus, video });
      if (S.phase !== 'running') aura.stop(); // no GPU behind the splash: start() runs it once the room is running
    })
    .catch((e) => console.warn('[aura] off:', e?.message || e));
} else $('aura')?.remove();
// renderer failing every frame (aura.js only counts it) -> stop it, hide it, and let the Canvas2D halo take over
let auraCheckT = 0;
function auraLive(now) {
  if (!aura || aura.kind === 'none') return false;
  if (now - auraCheckT > 1000) {
    auraCheckT = now;
    const st = aura.stats();
    if (st.errors >= 10 && st.errors * 2 >= st.frames) {
      console.warn('[aura] renderer failing; Canvas2D halo fallback');
      aura.destroy(); $('aura')?.remove(); aura = null; return false;
    }
  }
  return true;
}

// ---------------- errors (the only place with explanatory text besides captions) ----------------
const ERR = {
  denied:   ['הגישה למצלמה נחסמה. אשרו גישה למצלמה בדפדפן ונסו שוב.', 'Camera permission denied. Allow camera access in the browser, then retry.'],
  nocam:    ['לא נמצאה מצלמה.', 'No camera found. Connect a webcam, then retry.'],
  busy:     ['המצלמה בשימוש של תוכנה אחרת.', 'The camera is in use by another app. Close it, then retry.'],
  insecure: ['הדף חייב לרוץ ב-localhost או https.', 'Camera needs a secure page: open it via localhost or https (not file://).'],
  model:    ['טעינת מודל זיהוי הגוף נכשלה.', 'Body (pose) model failed to load. Check the vendor/ files, then retry.'],
  audio:    ['השמע לא הופעל.', 'Audio could not start in this browser.'],
};
function showError(kind, detail) {
  S.error = { kind, detail: String(detail || '') };
  S.phase = 'error';
  const [he, en] = ERR[kind] || ['שגיאה', 'Error'];
  $('err-he').textContent = he; $('err-en').textContent = en;
  $('err-detail').textContent = S.error.detail;
  $('splash').hidden = true;
  $('error').hidden = false;
  console.warn('[chamber]', kind, detail); // warn, not error: these are handled states
}
$('retry').onclick = () => location.reload();

// ---------------- models: POSE is the instrument (required); HANDS are an optional additive layer ----------------
// Both load in PARALLEL. If pose fails, that is the real error and the player is told. If hands fail (or ?hands=0),
// the room plays on the whole body alone and the dev console shows the note; the player sees nothing.
async function createTask(Cls, fileset, opts) {
  if (!FORCE_CPU) {
    try { return [await Cls.createFromOptions(fileset, opts('GPU')), 'GPU']; }
    catch (e) { console.info('[chamber] GPU delegate unavailable, falling back to CPU:', e?.message || e); }
  }
  return [await Cls.createFromOptions(fileset, opts('CPU')), 'CPU'];
}
async function loadModels() {
  const m = await import('./vendor/tasks-vision/vision_bundle.mjs');
  const fileset = await m.FilesetResolver.forVisionTasks(`${VENDOR}tasks-vision/wasm`);
  const poseP = createTask(m.PoseLandmarker, fileset, (delegate) => ({
    baseOptions: { modelAssetPath: `${VENDOR}pose_landmarker_lite.task`, delegate }, runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5, outputSegmentationMasks: false,
  }));
  const handsP = NO_HANDS ? Promise.reject(new Error('disabled (?hands=0)')) : createTask(m.HandLandmarker, fileset, (delegate) => ({
    baseOptions: { modelAssetPath: `${VENDOR}hand_landmarker.task`, delegate }, runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  }));
  const faceP = NO_FACE ? Promise.reject(new Error('disabled (?face=0)')) : createTask(m.FaceLandmarker, fileset, (delegate) => ({
    baseOptions: { modelAssetPath: `${VENDOR}face_landmarker.task`, delegate: FACE_DELEGATE === 'GPU' ? delegate : 'CPU' }, runningMode: 'VIDEO', numFaces: 1,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  }));
  const [pr, hr, fr] = await Promise.allSettled([poseP, handsP, faceP]);
  if (fr.status === 'fulfilled') [face, S.faceDelegate] = [fr.value[0], FACE_DELEGATE === 'GPU' ? fr.value[1] : 'CPU'];
  else { S.faceError = String(fr.reason?.message || fr.reason); console.info(`[chamber] face OFF (${S.faceError})`); }
  if (hr.status === 'fulfilled') [hands, S.delegate] = hr.value;
  else { S.handsError = String(hr.reason?.message || hr.reason); console.info('[chamber] hands layer off; the body alone plays:', S.handsError); }
  if (pr.status === 'rejected') throw pr.reason; // the body is the instrument: no pose, no room
  [pose, S.poseDelegate] = pr.value;
}
const modelReady = loadModels();
modelReady.catch(() => {}); // surfaced on Start

// ---------------- camera ----------------
async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('insecure'), { kind: 'insecure' });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
  } catch (e) {
    const kind = e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'denied'
      : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' || e.name === 'DevicesNotFoundError' ? 'nocam'
      : e.name === 'NotReadableError' || e.name === 'TrackStartError' ? 'busy' : 'nocam';
    throw Object.assign(e, { kind });
  }
  video.srcObject = stream;
  await video.play();
}

// ---------------- start: one gesture unlocks audio; the player's room then plays, the dev route's waits PAUSED ----------------
let starting = false;
async function start() {
  if (starting) return; starting = true;
  $('start').disabled = true; $('splash').classList.add('waking');
  try {
    // created AND resumed synchronously inside the gesture (before any await): WebKit / iOS only unlock audio here
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} // Safari Audio Session API: WebAudio plays past the iOS silent switch (no-op elsewhere)
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    audioCtx.onstatechange = syncResumeCue;
    await audioCtx.resume();
    pad = new Pad(audioCtx, voiceLead(null, prog.chord, S.zone));
    if (voiceOut) pad.voiceKey(voiceOut); // the voice started before the pad: key the duck on its output now (H3)
    pad.phase({ name: bus.state.phase?.name, by: 'boot' }); // H4: seed the swell reference (the pad is born after the boot phase event)
    if (DEV_ROUTE) await audioCtx.suspend(); // the dev route holds: boots paused. The player's context stays running
  } catch (e) { return showError('audio', e?.message || e); }
  S.phase = 'starting';
  try { await startCamera(); } catch (e) { return showError(e.kind || 'nocam', `${e.name || ''} ${e.message || ''}`); }
  try { await modelReady; } catch (e) { return showError('model', e?.message || e); }
  $('splash').hidden = true;
  S.phase = 'running';
  aura?.start(); // held stopped behind the splash (see the aura mount)
  showPaused(S.paused);
  lastFrame = performance.now();
  if (!DEV_ROUTE) await setPaused(false); // the player route: the same verb space calls (emits `pause` on the bus)
  requestAnimationFrame(loop);
}
$('start').onclick = start;
// No sound while running = a visible way back in: the resume orb (wordless; Hebrew aria-label). Shown when the room is paused
// (space / r, the #dev boot) OR when the browser holds the audio although the room plays (iOS 'interrupted':
// camera prompt, a call, an app switch). A tap is a fresh gesture, so WebKit resumes there.
function showPaused(p) {
  document.body.classList.toggle('paused', p);
  syncResumeCue();
}
function syncResumeCue() {
  $('resume').hidden = !(S.phase === 'running' && (S.paused || (audioCtx && audioCtx.state !== 'running')));
}
$('resume').onclick = () => { if (S.paused) setPaused(false); else audioCtx?.resume(); };
// any touch or key while the room should play also re-takes the audio (resume() inside that gesture)
for (const ev of ['pointerdown', 'touchend', 'keydown']) addEventListener(ev, () => {
  if (audioCtx && S.phase === 'running' && !S.paused && audioCtx.state !== 'running') audioCtx.resume();
}, { capture: true, passive: true });

// ---------------- vision: one inference per tick, cycling VISION.pattern (pose, hands at parity) ----------------
let lastTick = 0, tickN = 0, lastTs = 0, lastVideoTime = { hands: -1, pose: -1, face: -1 }, perfT0 = performance.now();
function nextTs(now) { lastTs = Math.max(now, lastTs + 1); return lastTs; } // strictly increasing across both tasks

function tick(now) {
  const t = now / 1000;
  if (S.inject) S.landmarks = S.inject.map(synthLandmarks);
  if (S.injectPose) S.pose = S.injectPose.none ? null : synthPose(S.injectPose);
  const canReal = video.readyState >= 2;
  const kind = VISION.pattern[tickN++ % VISION.pattern.length];
  // a missing optional layer (hands / face) gives its slot to pose
  const which = kind === 'hands' && (hands || S.inject) ? 'hands' : kind === 'face' && (face || S.injectFace) ? 'face' : 'pose';
  if (which === 'face') {
    let res = S.injectFace ? (S.injectFace.none ? null : synthBlendshapes(S.injectFace)) : undefined;
    if (res === undefined && face && canReal && video.currentTime !== lastVideoTime.face) {
      lastVideoTime.face = video.currentTime;
      const t0 = performance.now();
      res = face.detectForVideo(video, nextTs(now));
      track(S.perf.face, performance.now() - t0);
    }
    if (res !== undefined) updateFace(now, res);
    return;
  }
  if (which === 'hands' && !S.inject && hands && canReal && video.currentTime !== lastVideoTime.hands) {
    lastVideoTime.hands = video.currentTime;
    const t0 = performance.now();
    const res = hands.detectForVideo(video, nextTs(now));
    track(S.perf.hands, performance.now() - t0);
    S.landmarks = res.landmarks || [];
  } else if (which === 'pose' && !S.injectPose && pose && canReal && video.currentTime !== lastVideoTime.pose) {
    lastVideoTime.pose = video.currentTime;
    const t0 = performance.now();
    const res = pose.detectForVideo(video, nextTs(now));
    track(S.perf.pose, performance.now() - t0);
    S.pose = res.landmarks?.[0] || null;
  }
  if (which === 'hands') updateHands(now, t); else updateBody(now, t);
}
function track(p, ms) {
  p.n++;
  if (p.n <= 10) { p.ms = ms; return; } // warm-up: not representative
  p.ms = p.ms * 0.85 + ms * 0.15;
  S.perf.tickMs = S.perf.tickMs ? S.perf.tickMs * 0.9 + ms * 0.1 : ms;
  if (S.perf.tickFps > VISION.minFps && S.perf.tickMs > VISION.adaptAt * (1000 / S.perf.tickFps)) S.perf.tickFps = VISION.minFps;
}
function updateHands(now, t) {
  const feats = S.landmarks.map(featuresFromLandmarks);
  const { A, B } = assignHands(feats, S.lastFeat.A);
  S.aIndex = A ? feats.indexOf(A) : -1;
  for (const [k, f] of [['A', A], ['B', B]]) {
    if (f) {
      S.lastFeat[k] = smoothFeatures(S.hands[k].present ? S.lastFeat[k] : null, f, S.inject ? 1 : 0.5);
      S.lastSeen[k] = now;
      S.hands[k] = { present: true, f: S.lastFeat[k] };
    } else if (now - S.lastSeen[k] > PRESENCE_HOLD_MS) S.hands[k] = { present: false };
  }
  const pts = S.landmarks.flatMap((lm) => [0, 4, 8, 12, 20].map((i) => lm[i]));
  if (pts.length) energy.observe('hands', pts, S.bodyFeat?.shoulderW || 0.28, t);
}
function updateBody(now, t) {
  const lm = S.pose;
  if (lm && bodyVisible(lm)) {
    const f = bodyT.update(lm, t);
    if (S.injectPose?.sway != null) f.sway = S.injectPose.sway;
    S.bodyFeat = f; S.lastSeen.body = now; S.body = { present: true, f };
    energy.observe('pose', posePointsForEnergy(lm), f.shoulderW, t);
  } else if (now - S.lastSeen.body > BODY_HOLD_MS) { S.body = { present: false }; S.bodyFeat = null; }
}

// face: generic SOURCES only (face.*). No face->sound path lives here; POOL bindings / blends decide (mappings.js).
function updateFace(now, res) {
  const r = faceT.update(res);
  if (r.present) {
    S.lastSeen.face = now;
    S.face = { present: true, f: { ...r.f, blinkPulse: r.blinkOnset ? 1 : 0 } };
    if (r.blinkOnset) bus.emit('face.blink', { t: now / 1000, n: faceT.blinks });
  } else if (now - S.lastSeen.face > FACE_HOLD_MS) S.face = { present: false };
}

// ---------------- main loop ----------------
let lastFrame = 0;
// the inputs every reader shares (mappings, bindings, story, probes): body.f carries the whole-body sources
function inputs() {
  const anyone = S.body.present || S.hands.A.present || S.hands.B.present;
  const bf = S.body.present ? S.body.f : {};
  return { A: S.hands.A, B: S.hands.B, face: S.face, body: { present: anyone, pose: S.body.present, f: { ...bf, here: anyone ? 1 : 0, energy: S.energy, groove: S.groove } } };
}
function loop(now) {
  if (S.phase !== 'running') return;
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000)); lastFrame = now;
  // vision keeps running while paused, so the console still shows the camera + pose; nothing else advances
  if (now - lastTick >= 1000 / S.perf.tickFps - 1) { lastTick = now; tick(now); }
  if (!S.paused) {
    S.energy = S.injectPose?.energy ?? energy.step(now / 1000);
    S.groove += (S.energy - S.groove) * (1 - Math.exp(-dt / ENERGY.grooveSeconds)); // movement BUILDING
    const lifeDt = dt * S.timeScale, runT = bus.state.runT + dt;
    const inp = (S.inp = inputs());
    bus.state.sense = { energy: S.energy, groove: S.groove, inputs: inp };
    story.update(inp, runT);            // observations open / close (and wake the conductor)
    bindings.update(lifeDt);            // fades
    conductor.step(lifeDt, dt);         // the one scheduler: turns, scheduled-ahead acts, probes
    bus.emit('frame', { dt: lifeDt, dr: dt }); // the exact input frame (judge/HOOK.md H3): the recorder + replay read this stream
    const changed = prog.tick(lifeDt, S.energy);
    const { targets, glides, zone } = layer.compute(inp, S.zone); // statics + live bindings (preset `default` == MAPPINGS + POOL)
    if (changed || zone !== S.zone) pad.setNotes(voiceLead(pad.notes, prog.chord, zone));
    S.zone = zone; S.targets = targets; bus.state.targets = targets;
    pad.apply(targets, glides);
    pad.beat.pump();
    if (S.caption && bus.state.runT >= S.caption.until) { $('caption').classList.remove('on'); S.caption = null; }
  }
  if (now - perfT0 >= 1000) {
    for (const k of ['hands', 'pose', 'face']) { const p = S.perf[k]; p.fps = ((p.n - (p.n0 || 0)) * 1000) / (now - perfT0); p.n0 = p.n; }
    perfT0 = now;
  }
  draw(now);
  if (S.dev) renderConsole(now);
  requestAnimationFrame(loop);
}

// ---------------- pause / reset controls ----------------
async function setPaused(p) {
  if (!pad || S.phase !== 'running' || p === S.paused) return S.paused;
  S.paused = p;
  showPaused(p); // before the await: the cue hides on the tap itself
  if (p) await pad.suspend(); else { await pad.resume(); lastFrame = performance.now(); }
  bus.emit('pause', { paused: p });
  return S.paused;
}
// quick reset (between people): everything back to the first phase, and the room PAUSED again
async function reset() {
  await setPaused(true);
  layer.reset(); bindings.defs = POOL.map((d) => ({ ...d })); bindings.reset(); prog.reset(); bodyT.reset(); faceT.reset(); energy.reset(); story.reset();
  bus.reset(); Object.assign(bus.state, { bindings, story, prog });
  conductor.traces.length = 0; conductor.reset();
  Object.assign(S, { energy: 0, groove: 0, zone: 0, caption: null, captions: [], inp: null,
    hands: { A: { present: false }, B: { present: false } }, body: { present: false }, face: { present: false }, lastFeat: { A: null, B: null },
    bodyFeat: null, landmarks: [], pose: null, lastSeen: { A: 0, B: 0, body: 0, face: 0 }, aura: { x: 0.5, y: 0.55, r: 0.32, a: 0.11, seen: false } });
  $('caption').classList.remove('on');
  aura?.reset();
  if (pad) pad.setNotes(voiceLead(pad.notes, prog.chord, 0));
  mapsSig = ''; // the mappings editor rebuilds (the preset is back to default)
  return true;
}
function setDev(on) {
  S.dev = !!on;
  document.body.classList.toggle('dev', S.dev);
  $('console').hidden = !S.dev;
  const h = S.dev ? '#dev' : '';
  if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
}
addEventListener('hashchange', () => setDev(location.hash === '#dev'));
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, select, textarea')) return; // typing in the console
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (S.phase === 'idle') { start(); return; }
    setPaused(!S.paused);
  } else if (e.key === 'd' || e.key === 'D') setDev(!S.dev);
  else if ((e.key === 'r' || e.key === 'R') && S.dev) reset(); // dev route only (mappings.js:207, C10): a stray r never resets a participant ('d' still opens dev; not gated here)
  else if ((e.key === 'j' || e.key === 'J') && window.__chamber.startRecorder) { // dev route only: J starts / saves a session
    const c = window.__chamber;
    if (c.recorder?.recording) { c.recorder.download(); c.recorder.stop(); } else c.recorder = c.startRecorder();
  }
  else if (e.key === 'Enter' && S.phase === 'idle') start();
});

// ---------------- player drawing: soft additive glow + the breathing aura (wordless) ----------------
const HAND_CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const POSE_CONN = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24]];
const POSE_HEAD = [0, 2, 5, 7, 8];
function coverMap(cw, ch) {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const s = Math.max(cw / vw, ch / vh), w = vw * s, h = vh * s;
  return { ox: (cw - w) / 2, oy: (ch - h) / 2, w, h };
}
function glowPath(g, segs, col, k) {
  for (const [w, a] of [[16 * k, 0.05], [7 * k, 0.12], [2 * k, 0.55]]) {
    g.strokeStyle = `rgba(${col},${a})`; g.lineWidth = w;
    g.beginPath(); for (const [x1, y1, x2, y2] of segs) { g.moveTo(x1, y1); g.lineTo(x2, y2); } g.stroke();
  }
}
function glowDot(g, x, y, r, col, a) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(1, `rgba(${col},0)`);
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}
function draw(now) {
  const dpr = window.devicePixelRatio || 1, cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, cw, ch);
  const m = coverMap(cw, ch);
  const P = (p) => [m.ox + (1 - p.x) * m.w, m.oy + p.y * m.h]; // mirrored to match the video
  const k = Math.max(0.6, m.w / 1280);
  ctx2d.lineCap = 'round';
  ctx2d.globalCompositeOperation = 'lighter';
  const breathe = 0.85 + 0.15 * Math.sin(now / 900) + 0.4 * S.energy;
  if (!auraLive(now)) drawAura(now, m, P); // the Canvas2D halo is the fallback only (?aura=0 / no aura): the two never stack
  if (S.pose && S.body.present) {
    const lm = S.pose, col = '150,170,255', ok = (i) => (lm[i].visibility ?? 1) > 0.5;
    glowPath(ctx2d, POSE_CONN.filter(([a, b]) => ok(a) && ok(b)).map(([a, b]) => [...P(lm[a]), ...P(lm[b])]), col, k * 1.4);
    for (const i of POSE_HEAD) if (ok(i)) { const [x, y] = P(lm[i]); glowDot(ctx2d, x, y, 14 * k * breathe, col, 0.22); }
  }
  S.landmarks.forEach((lm, idx) => {
    const col = idx === S.aIndex ? '255,190,120' : '150,205,255';
    glowPath(ctx2d, HAND_CONN.map(([a, b]) => [...P(lm[a]), ...P(lm[b])]), col, k);
    for (const i of [4, 8, 12, 16, 20]) { const [x, y] = P(lm[i]); glowDot(ctx2d, x, y, 22 * k * breathe, col, 0.35); }
  });
  ctx2d.globalCompositeOperation = 'source-over';
}
let auraT = 0;
function auraTarget() {
  const hs = S.landmarks;
  if (S.pose && S.body.present) {
    const lm = S.pose, sx = (lm[11].x + lm[12].x) / 2, sy = (lm[11].y + lm[12].y) / 2;
    const hipOk = (lm[23].visibility ?? 1) > 0.5 && (lm[24].visibility ?? 1) > 0.5;
    const hy = hipOk ? (lm[23].y + lm[24].y) / 2 : sy + 0.35;
    const sw = Math.hypot(lm[11].x - lm[12].x, lm[11].y - lm[12].y);
    return { x: sx, y: (sy * 2 + hy) / 3 - 0.05, r: Math.min(0.75, Math.max(0.22, sw * 1.9)), a: 0.24 + 0.45 * S.energy, seen: true };
  }
  if (hs.length) {
    let x = 0, y = 0; for (const lm of hs) { x += lm[9].x; y += lm[9].y; } x /= hs.length; y /= hs.length;
    return { x, y, r: 0.24, a: 0.22 + 0.45 * S.energy, seen: true };
  }
  return { x: 0.5, y: 0.55, r: 0.32, a: 0.11, seen: false };
}
function drawAura(now, m, P) {
  const dt = Math.min(0.1, Math.max(0, (now - (auraT || now)) / 1000)); auraT = now;
  const t = auraTarget(), A = S.aura;
  const kPos = 1 - Math.exp(-dt / 0.35), kA = 1 - Math.exp(-dt / (t.a > A.a ? 0.6 : 2.2));
  if (!S.paused) { A.x += (t.x - A.x) * kPos; A.y += (t.y - A.y) * kPos; A.r += (t.r - A.r) * kPos; A.a += (t.a - A.a) * kA; A.seen = t.seen; }
  const breath = 0.75 + 0.25 * Math.sin(now / 1400);
  const [x, y] = P(A), r = A.r * Math.min(m.w, m.h) * (0.92 + 0.08 * breath) * (1 + 0.25 * S.energy);
  const a = A.a * breath, g = ctx2d.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255,190,130,${a})`); g.addColorStop(0.45, `rgba(255,160,110,${a * 0.45})`);
  g.addColorStop(0.75, `rgba(150,140,255,${a * 0.14})`); g.addColorStop(1, 'rgba(150,140,255,0)');
  ctx2d.fillStyle = g; ctx2d.beginPath(); ctx2d.arc(x, y, r, 0, Math.PI * 2); ctx2d.fill();
}

// ---------------- the developer console (d / #dev): never part of the player view ----------------
const BAR_KEYS = Object.keys(MAPPINGS).filter((k) => k !== 'voicing');
const fmtSrc = (src, mag) => (src == null ? '(binding only)' : typeof src === 'string' ? `${src}${mag ? ' |·|' : ''}` : src.map((t) => `${t.s}${t.mag ? '|·|' : ''}${t.inv ? '⁻' : ''}·${t.w}`).join(' + '));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r2 = (v) => (typeof v === 'number' ? v.toFixed(2) : v ?? '·');
function buildConsole() {
  $('c-phase').innerHTML = Object.keys(PHASES).map((p) => `<option value="${p}">${p}</option>`).join('');
  $('c-phase').onchange = (e) => conductor.act({ verb: 'phase.set', args: { name: e.target.value, why: 'console' }, why: 'dev console (dev/test only) set the phase'  }, 'dev');
  $('c-pause').onclick = () => setPaused(!S.paused);
  $('c-reset').onclick = () => reset();
  $('c-dj').onchange = (e) => conductor.act({ verb: 'policy.set', args: { name: 'dj', on: e.target.checked }, why: 'dev console toggled the auto-DJ'  }, 'dev');
  buildBindTable();
  $('c-bind').onclick = (e) => {
    const b = e.target.closest('button[data-verb]'); if (!b) return;
    const id = b.closest('tr').dataset.id;
    conductor.act({ verb: b.dataset.verb, args: { id, force: true, why: 'console' }, why: `dev console ${b.dataset.verb}`  }, 'dev');
  };
  $('bars').innerHTML = BAR_KEYS.map((k) => `
    <div class="bar" data-k="${k}" title="${esc(fmtSrc(MAPPINGS[k].src, MAPPINGS[k].mag))}">
      <span class="lbl">${esc(MAPPINGS[k].label)}</span><span class="track"><span class="fill"></span></span><span class="val"></span>
    </div>`).join('');
  buildMapsEditor();
  $('c-cues').innerHTML = conductor.cues.opening.filter((c) => c.say != null).map((c) => `
    <label>${esc(c.id)}${c.requires ? ` <small>(needs ${esc(c.requires)})</small>` : ''}<input data-cue="${esc(c.id)}" dir="rtl" value="${esc(c.say)}"></label>`).join('');
  $('c-cues').onchange = (e) => {
    const cue = e.target.dataset.cue; if (!cue) return;
    conductor.act({ verb: 'prompt.set', args: { list: 'opening', cue, say: e.target.value }, why: 'dev console edited a prompt'  }, 'dev');
  };
}
// bar position: the inverse of the LIVE mapping's curve (a removed static falls back to the registry range)
function norm01(k, v) {
  const m = layer.statics[k] || MAPPINGS[k];
  return curvePos(m.curve, m.range || TARGET[k].range, v);
}
// ---- the bindings table: rebuilt whenever the live binding set changes (map.create / map.remove at runtime) ----
let bindSig = '';
function buildBindTable() {
  bindSig = bindings.defs.map((d) => `${d.id}|${d.target}|${JSON.stringify(d.src)}`).join(';');
  $('c-bind').innerHTML = `<tr><th>binding</th><th>src → target</th><th>state</th><th>obs · by · why</th><th></th></tr>` + bindings.defs.map((d) => `
    <tr data-id="${esc(d.id)}"><td>${esc(d.id)}</td><td class="dim">${esc(fmtSrc(d.src, d.mag))} → ${esc(d.target)}</td><td class="st"></td><td class="why"></td>
    <td><button data-verb="binding.arm">arm</button><button data-verb="binding.retire">retire</button></td></tr>`).join('');
}
// ---- the mappings editor (#dev only): every live mapping, inline range / curve / weight -> map.update, create
// (source x target from the registries), remove, undo. Every edit is a traced verb through conductor.act. ----
let mapsSig = '';
let mapsMsg = ''; // the last edit's result line (survives the editor rebuild)
const setMapsMsg = (m) => { mapsMsg = m; $('c-maps-msg').textContent = m; mapsSig = ''; };
const mapAct = (verb, args, why) => { const r = conductor.act({ verb, args, why }, 'dev'); setMapsMsg(`${verb} ${args.id ?? ''}: ${r.ok ? 'ok' : '✗ ' + (r.result?.why || r.error)}`); return r; };
function buildMapsEditor() {
  const L = layer.list();
  mapsSig = JSON.stringify(L.map((m) => [m.id, m.range, m.curve, m.weight, m.src, m.target]));
  const curveOpts = (c) => CURVES.map((n) => `<option${curveName(c) === n ? ' selected' : ''}>${n}</option>`).join('');
  const bindable = SOURCES.filter((x) => x.bindable);
  $('c-maps').innerHTML = `<table id="c-maps-t"><tr><th>id</th><th>kind</th><th>src → target</th><th>range</th><th>curve</th><th>weight</th><th></th></tr>`
    + L.map((m) => `<tr data-id="${esc(m.id)}" data-kind="${m.kind}" class="${m.removing ? 'removed' : ''}"><td>${esc(m.id)}</td><td class="dim">${m.kind}</td><td class="dim">${esc(fmtSrc(m.src, m.mag))} → ${esc(m.target)}</td>`
      + (m.range ? `<td><input class="lo" size="5" value="${+m.range[0].toPrecision(4)}"><input class="hi" size="5" value="${+m.range[1].toPrecision(4)}"></td><td><select class="cv">${curveOpts(m.curve)}</select></td>` : '<td class="dim">zones</td><td></td>')
      + `<td>${m.range ? `<input class="wt" type="number" min="0" max="1" step="0.05" value="${m.weight}">` : ''}</td><td><button data-do="remove">remove</button></td></tr>`).join('')
    + `</table><div class="c-maps-new">new <select id="c-new-kind"><option>binding</option><option>static</option></select>
      <select id="c-new-src">${bindable.map((x) => `<option value="${x.id}">${x.id}</option>`).join('')}</select> →
      <select id="c-new-tgt">${TARGETS.filter((t) => t.id !== 'voicing').map((t) => `<option value="${t.id}">${t.id}</option>`).join('')}</select>
      <button id="c-new-go">create</button> <button id="c-undo">undo</button> <span id="c-maps-msg" class="dim">${esc(mapsMsg)}</span></div>`;
}
function wireMapsEditor() {
  const box = $('c-maps');
  box.onchange = (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.matches('.lo, .hi')) {
      const range = [+tr.querySelector('.lo').value, +tr.querySelector('.hi').value], cur = layer.list().find((m) => m.id === id)?.range;
      if (cur && cur[0] === range[0] && cur[1] === range[1]) return; // a no-op edit is not an undo step
      mapAct('map.update', { id, range }, 'console: range');
    } else if (e.target.matches('.cv')) mapAct('map.update', { id, curve: e.target.value }, 'console: curve');
    else if (e.target.matches('.wt')) mapAct('map.update', { id, weight: Math.max(0, Math.min(1, +e.target.value)) }, 'console: weight');
  };
  box.onclick = (e) => {
    if (e.target.id === 'c-undo') { const r = conductor.act({ verb: 'undo', args: { n: 1 }, why: 'console: undo' }, 'dev'); setMapsMsg(r.ok ? `undid ${r.result.undone.map((u) => `${u.undid} ${u.id}`).join(', ')}` : `✗ ${r.result?.why}`); return; }
    if (e.target.id === 'c-new-go') {
      const kind = $('c-new-kind').value, src = $('c-new-src').value, target = $('c-new-tgt').value, T = TARGET[target];
      const id = kind === 'static' ? target : `${src.replace(/^(body|face)\./, '')}→${target}`;
      const range = T.range ? [...T.range] : [...T.safe];
      mapAct('map.create', kind === 'static' ? { kind, id, src, range, curve: layer.statics[target]?.curve ?? MAPPINGS[target]?.curve } : { kind, id, src, target, range, curve: MAPPINGS[target]?.curve }, 'console: create');
      return;
    }
    if (e.target.dataset.do === 'remove') mapAct('map.remove', { id: e.target.closest('tr').dataset.id }, 'console: remove');
  };
}
wireMapsEditor();
function fmt(k, v) {
  if (k === 'cutoff' || k === 'wah') return `${Math.round(v)} Hz`;
  if (k === 'detune' || k === 'vibrato') return `${v.toFixed(1)} ¢`;
  if (k === 'modRate') return `${v.toFixed(1)} Hz`;
  if (k === 'pan' || k === 'field') return (v >= 0 ? 'R ' : 'L ') + Math.abs(v).toFixed(2);
  return v.toFixed(2);
}
const camCtx = $('c-cam').getContext('2d');
function drawCam() {
  const W = $('c-cam').width, H = $('c-cam').height;
  camCtx.save(); camCtx.fillStyle = '#000'; camCtx.fillRect(0, 0, W, H);
  camCtx.translate(W, 0); camCtx.scale(-1, 1); // mirrored, like the player sees it
  if (video.readyState >= 2) camCtx.drawImage(video, 0, 0, W, H);
  camCtx.restore();
  const P = (p) => [(1 - p.x) * W, p.y * H];
  camCtx.lineWidth = 2; camCtx.lineCap = 'round';
  if (S.pose) {
    const lm = S.pose, ok = (i) => (lm[i].visibility ?? 1) > 0.5;
    camCtx.strokeStyle = S.body.present ? '#8fa6ff' : '#555';
    camCtx.beginPath(); for (const [a, b] of POSE_CONN) if (ok(a) && ok(b)) { camCtx.moveTo(...P(lm[a])); camCtx.lineTo(...P(lm[b])); } camCtx.stroke();
    camCtx.fillStyle = '#ffd59a'; for (const i of POSE_HEAD) if (ok(i)) { const [x, y] = P(lm[i]); camCtx.fillRect(x - 2, y - 2, 4, 4); }
  }
  S.landmarks.forEach((lm, idx) => {
    camCtx.strokeStyle = idx === S.aIndex ? '#ffbe78' : '#96cdff';
    camCtx.beginPath(); for (const [a, b] of HAND_CONN) { camCtx.moveTo(...P(lm[a])); camCtx.lineTo(...P(lm[b])); } camCtx.stroke();
  });
  camCtx.fillStyle = '#fff'; camCtx.font = '11px ui-monospace, Menlo, monospace';
  camCtx.fillText(`${S.inject ? 'hands: INJECTED' : 'hands: camera'} · ${S.injectPose ? 'pose: INJECTED' : 'pose: camera'}`, 6, H - 6);
}
function fmtArgs(a) { return Object.entries(a || {}).filter(([k]) => k !== 'en').map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 24) : JSON.stringify(v)}`).join(' '); }
function fmtTrace(tr) {
  const acts = [...tr.acts, ...tr.fired].map((a) => `${a.verb}(${fmtArgs(a.args)})${a.scheduled != null ? `@${a.scheduled}` : a.ok === false ? ` ✗ ${a.error || a.result?.why || ''}` : ' ✓'}`);
  return `#${tr.n} t${tr.t} [${tr.phase}] woke ${tr.woke.join(', ')} · e${r2(tr.sense?.energy)} g${r2(tr.sense?.groove)}${tr.sense?.open?.length ? ` · open ${tr.sense.open.join(' ')}` : ''}\n`
    + tr.policies.map((p) => `   ${p.name}: ${p.why}${p.wait != null ? ` (wait ${p.wait})` : ''}`).join('\n')
    + (acts.length ? `\n   → ${acts.join('\n   → ')}` : '') + `\n   next turn in ${tr.wait} s`;
}
let lastDev = 0, lastCam = 0;
function renderConsole(now) {
  if (now - lastCam > 66) { lastCam = now; drawCam(); }
  if (now - lastDev < 150) return; lastDev = now;
  const s = bus.state, live = pad.live(), inp = S.inp || inputs();
  $('c-run').textContent = S.paused ? '❚❚ PAUSED (space / resume)' : '▶ running';
  $('c-run').classList.toggle('paused', S.paused);
  $('c-pause').textContent = S.paused ? 'resume' : 'pause';
  if (document.activeElement !== $('c-phase')) $('c-phase').value = s.phase?.name;
  $('c-dj').checked = !s.off?.dj;
  $('c-goal').textContent = s.phase ? `${s.phase.goal}\n(explicit: ${PHASES[s.phase.name].explicit} · policies: ${PHASES[s.phase.name].policies.join(', ')} · since t${s.phase.since.toFixed(0)} by ${s.phase.by}: ${s.phase.why})` : '';
  const cue = s.cue && conductor.cues[s.cue.list]?.[s.cue.i];
  $('c-cue').textContent = s.cue ? `cue ${s.cue.list}[${s.cue.i}] ${cue ? `${cue.id} · ${s.cue.stage ?? 'next'}` : 'done'}${S.caption ? ` · showing “${S.caption.en}”` : ''}` : 'no cue list in this phase';
  if (bindings.defs.map((d) => `${d.id}|${d.target}|${JSON.stringify(d.src)}`).join(';') !== bindSig) buildBindTable();
  if (!(document.activeElement?.matches?.('#c-maps input, #c-maps select')) && JSON.stringify(layer.list().map((m) => [m.id, m.range, m.curve, m.weight, m.src, m.target])) !== mapsSig) buildMapsEditor();
  for (const tr of $('c-bind').querySelectorAll('tr[data-id]')) {
    const st = bindings.s[tr.dataset.id];
    if (!st) { tr.className = 'removed'; continue; } // binding.remove'd at runtime
    tr.className = st.phase;
    tr.querySelector('.st').textContent = `${st.phase} w${st.w.toFixed(2)}${st.phase === 'armed' ? ` ${st.armedFor.toFixed(0)}s` : st.phase === 'cooling' ? ` ${st.coolFor.toFixed(0)}s` : ''}`;
    tr.querySelector('.why').textContent = st.by ? `${st.obs ?? '-'} · ${st.by} · ${st.why ?? ''}` : '';
  }
  for (const el of $('bars').children) {
    const k = el.dataset.k, v = live[k];
    el.querySelector('.fill').style.width = `${(Math.max(0, Math.min(1, norm01(k, v))) * 100).toFixed(1)}%`;
    el.querySelector('.val').textContent = fmt(k, v);
    el.classList.toggle('on', srcNames(layer.statics[k]?.src).some((n) => readSource(inp, n) != null));
    el.classList.toggle('living', !!bindings.owner(k));
  }
  const p = S.perf, ps = prog.snapshot(), bf = S.body.present ? S.body.f : null;
  $('c-perf').textContent = `hands ${S.inject ? 'inject' : hands ? p.hands.fps.toFixed(0) + ' fps' : 'OFF (' + S.handsError + ') — body only'} ${p.hands.ms.toFixed(1)} ms ${S.delegate || ''} · pose ${S.injectPose ? 'inject' : p.pose.fps.toFixed(0) + ' fps'} ${p.pose.ms.toFixed(1)} ms ${S.poseDelegate || '?'} · face ${S.injectFace ? 'inject' : face ? p.face.fps.toFixed(0) + ' fps ' + p.face.ms.toFixed(1) + ' ms ' + (S.faceDelegate || '') : 'OFF (' + S.faceError + ')'} · tick ${p.tickFps}/s · life ×${S.timeScale}`;
  $('state').textContent = [
    `chord ${ps.chord} (${ps.index + 1}/${PROGRESSION.chords.length}) · bar ${ps.bar + 1} · voicing ${VOICINGS[S.zone].name} · notes ${live.notes.join(' ')}`,
    `energy ${S.energy.toFixed(2)} · groove ${S.groove.toFixed(2)} · beat ${live.beat.toFixed(2)} (${live.beatHits} hits) · hands ${S.hands.A.present ? 'A' : '·'}${S.hands.B.present ? 'B' : '·'} · body ${bf ? 'yes' : '·'}`,
    bf ? ['x', 'rise', 'lean', 'sway', 'headTilt', 'headTurn', 'nod', 'shrug', 'depth', 'armsUp', 'reach'].map((k) => `${k} ${r2(bf[k])}`).join(' · ') : '',
  ].join('\n');
  $('c-claims').textContent = Object.entries(s.claims).map(([id, c]) => `${id} ${c.state} ${c.verb ?? ''} ${c.evidence ? JSON.stringify(c.evidence) : ''}`).join('\n') || '(none)';
  const snap = story.snapshot(10);
  $('c-story').textContent = `open: ${snap.open.map((o) => `${o.id} ${o.label} (${o.peak.toFixed(2)})`).join(' · ') || 'nothing moving'}\n`
    + snap.recent.slice().reverse().map((o) => `${o.id} t${o.t0.toFixed(1)} ${o.kind} ${o.label}${o.t1 != null ? ` → ${o.end ?? 'closed'} t${o.t1.toFixed(1)}` : ''}`).join('\n');
  $('c-trace').textContent = conductor.traces.slice(-14).reverse().map(fmtTrace).join('\n');
}
buildConsole();
setDev(location.hash === '#dev' || params.get('dev') === '1');

// ---------------- debug hook (verify/headless.mjs; also the console's API surface) ----------------
window.__chamber = {
  state: S, bus, conductor, bindings, story, layer,
  get phase() { return S.phase; },
  get delegate() { return S.delegate; },
  get poseDelegate() { return S.poseDelegate; },
  get handsError() { return S.handsError; },
  get handsLoaded() { return !!hands; },
  get faceError() { return S.faceError; },
  get faceLoaded() { return !!face; },
  // injectFace({jawOpen, smile, squint, blink, browUp, pucker, cheekPuff, gazeX, gazeY}) through the real face.js path;
  // null = stop injecting; {none: true} = "no face"
  injectFace(p) { S.injectFace = p == null ? null : p.none ? { none: true } : { ...p }; },
  modelReady: () => modelReady.then(() => true),
  // injectHand({x, y, spread, openness}) or injectHand(handA, handB). null = stop injecting; [] = "no hands".
  injectHand(...hs) {
    if (hs[0] == null) { S.inject = null; return; }
    if (Array.isArray(hs[0])) hs = hs[0];
    S.inject = hs.filter(Boolean).map((h) => ({ ...h, y: h.y ?? (h.height != null ? 0.92 - 0.8 * h.height + 0.015 : 0.5) }));
  },
  // injectPose({x, y, lean, headTilt, turn, nod, shrug, width, armsUp, reach, sway?, energy?}) through the real
  // feature path (synthPose -> BodyTracker). null = stop; { none: true } = "no body".
  injectPose(p) { S.injectPose = p == null ? null : p.none ? { none: true } : { ...p }; },
  clearInject() { S.inject = null; S.injectPose = null; S.injectFace = null; },
  pause: () => setPaused(true), resume: () => setPaused(false), get paused() { return S.paused; },
  reset, setDev, setTimeScale: (x) => { S.timeScale = Math.max(0.01, +x || 1); },
  // the same verbs the conductor calls
  act: (verb, args, why) => conductor.act({ verb, args, why }, 'dev'),
  setPhase: (name) => conductor.act({ verb: 'phase.set', args: { name, why: 'hook' } }, 'dev'),
  arm: (id) => conductor.act({ verb: 'binding.arm', args: { id, force: true, why: 'hook' } }, 'dev'),
  retire: (id) => conductor.act({ verb: 'binding.retire', args: { id, why: 'hook' } }, 'dev'),
  editCue: (cue, say) => conductor.act({ verb: 'prompt.set', args: { list: 'opening', cue, say } }, 'dev'),
  traces: (n = 200) => JSON.parse(JSON.stringify(conductor.traces.slice(-n))),
  claims: () => JSON.parse(JSON.stringify(bus.state.claims)),
  bphase: () => bus.state.phase && { ...bus.state.phase },
  cue: () => bus.state.cue && { ...bus.state.cue },
  captions: () => S.captions.slice(),
  storySnap: (n) => story.snapshot(n),
  bindingsSnap: () => ({ bindings: bindings.snapshot(), events: bindings.events.slice() }),
  progression: () => prog.snapshot(),
  live: () => pad?.live(),
  targets: () => S.targets && { ...S.targets },
  features: () => ({ A: S.hands.A.present ? { ...S.hands.A.f } : null, B: S.hands.B.present ? { ...S.hands.B.f } : null, body: S.body.present ? { ...S.body.f } : null, face: S.face.present ? { ...S.face.f } : null, energy: S.energy, groove: S.groove }),
  perf: () => JSON.parse(JSON.stringify(S.perf)),
  rms: () => pad?.rms() ?? 0,
  duck: () => pad?.ducker?.snapshot() ?? null, // H3 duck state (dev/test)
  swell: () => (pad ? { ref: pad.phaseName ?? null, count: pad.swellFx?.count ?? 0, last: pad.swellFx?.last ?? null } : null), // H4 (dev/test)
  chimeRms: () => pad?.chimeRms() ?? 0,
  audioState: () => audioCtx?.state,
  aura: () => ({ ...S.aura }),
  auraLayer: () => (aura ? { kind: aura.kind, ...aura.stats() } : null), // visual/AURA-HOOK.md §4 (dev/test)
  // a frozen read-only snapshot of the LIVE mapping set (writes go through act('map.*', ...))
  get mappings() { return layer.snapshot(); },
  describe: () => layer.describe(), // schema chamber.mapping/1 (sources, targets, curves, verbs, caps, preset)
  undo: (n = 1) => conductor.act({ verb: 'undo', args: { n }, why: 'hook' }, 'dev'),
};
// the session recorder (judge/recorder.js; judge/HOOK.md H2) loads on the dev route only (#dev, dev/test only).
// The player route never requests it. Read-only on the room: it subscribes to the bus and reads the hook's getters.
if (DEV_ROUTE) import('./judge/recorder.js').then(({ startRecorder }) => { window.__chamber.startRecorder = startRecorder; });

// ---------------- voice (ON by default; ?voice=0 is the kill switch; voice/HOOK.md §1) ----------------
// Dynamic import: with ?voice=0 not one byte of voice code loads (mountVoice's own voiceEnabled() agrees: '0' -> null).
// The voice acts as 'voice' ONLY (conductor.actor pins
// the provenance: untrusted, so AGENT_MAP_CAP + bindable-only apply; a Director phase.set traces by 'voice'), never 'dev'.
if (params.get('voice') !== '0') {
  import('./voice/realtime.js').then(({ mountVoice }) => {
    const voiceAct = conductor.actor('voice');
    const chamber = { ...window.__chamber, act: (verb, args, why) => voiceAct(verb, args, why) };
    window.__chamber.voiceAct = voiceAct; // dev/test: the exact act the mount hands the voice session
    // no config: VOICE_CONFIG's gatewayOrigin is live. Nothing connects on load: start() needs unlock() first and the orb tap
    // H3 preferred duck key: a follower on the voice output node (inert until the voice lane calls onOutput)
    const onOutput = (node) => { voiceOut = node; pad?.voiceKey(node); };
    const voice = window.__chamber.voice = mountVoice({ bus, chamber, getAudioCtx: () => audioCtx, onOutput });
    // the start orb is the call's start control (wordless): the same tap that wakes the room asks for the call. It runs after
    // start()'s synchronous part, so audioCtx exists. Locked (no unlock yet) = a no-op: no mic, no request.
    if (voice) $('start').addEventListener('click', () => { voice.start().catch?.(() => {}); });
  });
}
