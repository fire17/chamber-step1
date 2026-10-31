// Chamber Next Gen — Step 2 "walking skeleton" (forked from Step 1). ALL the tunable data lives here:
// the static body->sound mappings, the binding POOL the conductor arms / retires, the conductor's policy knobs,
// the phases, the body-story channels, the cues, the probes, the progression and its voicings. The engines that
// read it (life.js, story.js, conductor.js, synth.js, beat.js) contain no per-feature branches: tuning is here.
//
// Sources (all 0..1, in the MIRRORED view the player sees; "bipolar" = 0.5 is centre):
//   A.* / B.*   first / second hand: x (0 left .. 1 right), height (0 bottom .. 1 top),
//               spread (thumb-index; pinch 0 .. wide 1), openness (fist 0 .. open 1),
//               depth (apparent palm size: far from the camera 0 .. close 1; absolute, no baseline, see hand.js)
//   body.here      1 while anyone (a body or a hand) is seen
//   body.energy    overall movement energy (pose weighted 1, hands 0.5; still 0 .. vigorous 1)
//   body.groove    energy averaged over ENERGY.grooveSeconds (movement BUILDING, not a twitch)
//   body.x         where the torso stands across the frame (0 screen-left .. 1 screen-right)
//   body.rise      shoulder line up / down vs a slow baseline, bipolar (stand tall / rise 1, sink / crouch 0)
//   body.lean      torso roll, bipolar (0 = leaning to screen-left, 1 = to screen-right)
//   body.sway      side-to-side drift vs a slow average, bipolar (returns to 0.5 when still)
//   body.headTilt  head roll relative to the shoulders, bipolar
//   body.headTurn  head yaw, bipolar · body.nod: pitch vs a slow baseline, bipolar (1 = chin down)
//   body.shrug     shoulders lifted toward the ears vs a slow baseline, bipolar
//   body.depth     closer (1) / further (0) vs a slow baseline, bipolar
//   body.armsUp    highest wrist vs the shoulders, 0..1 · body.reach: wrist span in shoulder widths, 0..1
//                  (both null while the wrists are out of frame)
// `mag: true` on a bipolar source uses its distance from centre (|v - 0.5| * 2).

// Play glide, seconds (setTargetAtTime time constant).
// WHY 0.12: (a) PARITY BASELINE with the old system's default-binding glide, kept so Goni's
// first "better or worse" play compares like with like; it is to be TUNED by that play.
// (b) First principles: a 120 ms one-pole constant stays under the ~150 ms where control lag
// starts to feel disconnected, while averaging ~4 frames of 30 fps landmark jitter so the
// filter doesn't zipper. Shorter = twitchier; longer = mushy.
export const GLIDE = 0.12;

// Everything below is NEW for Step 1 (nothing else is inherited from the old system):
// first-principles values tagged [guess], to be tuned by play.

// Release glide when a source leaves and params drift back to rest: slow, so a lost hand reads
// as the sound relaxing, not as a dropout. [guess]
export const REST_GLIDE = 0.9;
// Chord / voicing change: upper voices slide to the new (voice-led) notes; long enough to hear
// as a glide, short enough to land before the next gesture. Bass moves faster. [guess]
export const CHORD_GLIDE = 0.2;
export const BASS_GLIDE = 0.08;
// Presence debounce: MediaPipe drops a hand for a few frames on fast moves / motion blur;
// 280 ms (~8 frames at 30 fps) rides over that so the swell doesn't flicker. [guess]
export const PRESENCE_HOLD_MS = 280;
// Body presence is held longer: pose drops out less, and the body is the "someone is here" cue. [guess]
export const BODY_HOLD_MS = 800;

// Vision schedule (T0 budget): ONE inference per tick at <= 30 ticks/s, cycling the pattern. Step 2: pose and
// hands at PARITY (15 fps each). Step 1 ran hands,hands,pose (hands 20 fps, pose 10 fps): the body was sampled at
// half the hands' rate, one of the reasons hands dominated (drift flag, observer-4f). If the mean inference time
// eats > `adaptAt` of the tick budget, the tick rate steps down to `minFps`. [brief + guess]
// face is an optional third model: one slot in four (~7.5 fps at 30 ticks/s). A missing layer's slot goes to pose.
export const VISION = { fps: 30, minFps: 15, adaptAt: 0.75, pattern: ['pose', 'hands', 'pose', 'face'] };

// Movement energy: mean landmark speed in shoulder-widths/s that counts as "full" energy, and
// the attack / release time constants (fast up, slow down = a breath, not a twitch). [guess]
// weights: each channel's speed is weighted before the channels are combined (max). Fingertips move far faster
// than a torso for the same intent, so the hands count at 0.5: a wiggling hand alone can't max the room. [guess]
// grooveSeconds: body.groove = energy averaged over this long ("movement building", what the beat follows).
export const ENERGY = { full: 1.4, attack: 0.25, release: 1.6, moving: 0.12, weights: { pose: 1, hands: 0.5 }, grooveSeconds: 3 };

// The static mappings: always live, from the first frame, no AI in the loop.
// `src` is ONE source ('body.lean') or a BLEND: [{ s, w, inv, mag, idle }, ...] = the weighted mean of its terms
// (inv: 1 - v; mag: |v - 0.5| * 2; idle: the value an ABSENT term counts at, default 0.5 = the centre of a bipolar
// source, so a hand appearing or leaving never jumps the sound; opt: an ABSENT term is skipped entirely (weight
// and value), so an optional layer like the face adds nothing at all until it is seen; ctr: centre a 0..1
// one-sided source (0 -> 0.5, 1 -> 1) so its neutral pose does not pull the blend). The blend is absent (-> `rest`) only when every
// term is. The BODY carries most of the weight on every core control and the hands are a layer on top
// (CONCLUSION 76ba58df:17 "body movement the main influencer"; Goni: hands + face dominated Step 1). A blend is
// data, not a branch: re-weighting the body vs the hands is editing numbers here. Body sources: see body.js.
const blend = (...terms) => terms.map(([s, w, o = {}]) => ({ s, w, ...o }));
export const MAPPINGS = {
  // brightness: standing tall / rising, lifting the chin, coming closer; the hand's height adds on top
  cutoff:    { src: blend(['body.rise', 1], ['body.nod', 0.5, { inv: true }], ['body.depth', 0.5], ['A.height', 0.45], ['face.squint', 0.4, { inv: true, ctr: true, opt: true }]),
               range: [180, 6500], curve: 'exp', rest: 650, unit: 'Hz', label: 'filter / פילטר' },
  // width: swaying and tilting the head widen the detune; the fingertips add
  detune:    { src: blend(['body.sway', 1, { mag: true, idle: 0 }], ['body.headTilt', 0.4, { mag: true, idle: 0 }], ['A.spread', 0.4, { idle: 0.3 }]),
               range: [3, 32], rest: 6, unit: '¢', label: 'detune / דיטיון' },
  // sparkle: whole-body movement and raised arms; an open hand adds
  shimmer:   { src: blend(['body.energy', 1, { idle: 0 }], ['body.armsUp', 0.8, { idle: 0 }], ['A.openness', 0.4], ['face.browUp', 0.4, { opt: true }]),
               range: [0, 0.2], rest: 0.015, label: 'shimmer / ניצוץ' },
  // where you stand (and where you face) places the pad; the hand adds
  pan:       { src: blend(['body.x', 1], ['body.headTurn', 0.3], ['A.x', 0.4], ['face.lookX', 0.2, { opt: true }]), range: [-0.75, 0.75], rest: 0, label: 'pan / שמאל-ימין' },
  // Where you stand BENDS the progression's voicing in 4 zones (it never picks the chord: the auto-DJ does).
  // Hysteresis 0.05 (~5% of the width, well over landmark jitter) stops edge flicker. [guess]
  voicing:   { src: blend(['body.x', 1], ['A.x', 0.4]), zones: 4, hysteresis: 0.05, rest: 'hold', label: 'voicing / פריסה' },
  // Swell: ONE continuous function of someone being here + whole-body movement energy (hands are one contributor
  // to that energy, weighted 0.5). Nobody: the floor (+ the drone in synth.js): silence is never broken. Someone
  // still: ~0.57. Moving fully: 0.85. Step 1's hand-vs-body tier (0.8 vs 0.45) is gone (drift flag, observer-4f).
  swell:     { src: blend(['body.here', 1, { idle: 0 }], ['body.energy', 0.7, { idle: 0 }]), range: [0.16, 0.85], rest: 0.16,
               glide: 0.4, restGlide: 1.4, label: 'swell / עוצמה' },
  // the room: step back = more room, come closer = drier; the second hand's height adds
  reverbWet: { src: blend(['body.depth', 1, { inv: true }], ['B.height', 0.4]), range: [0.15, 0.8], rest: 0.32, label: 'reverb / הדהוד' },
  // raised arms lift the octave layer; the second hand opening adds
  octave:    { src: blend(['body.armsUp', 1, { idle: 0 }], ['B.openness', 0.4, { idle: 0 }], ['face.smile', 0.5, { opt: true }]), range: [0, 0.3], rest: 0, label: 'octave / אוקטבה' },
  // The "trip" macro: movement opens chorus/phaser depth, LFO rates, delay send and filter breath.
  trip:      { src: 'body.energy', range: [0.08, 1],    rest: 0.08, glide: 0.5,          label: 'trip / טריפ' },
  feedback:  { src: 'body.energy', range: [0.3, 0.72],  rest: 0.3,  glide: 0.7,          label: 'echo fb / משוב' },
  field:     { src: 'body.lean',   range: [-0.7, 0.7],  rest: 0,    glide: 0.3,          label: 'field / שדה' },
  resonance: { src: 'body.headTilt', mag: true, range: [0.8, 8], curve: 'exp', rest: 0.9, glide: 0.25, label: 'resonance / תהודה' },
  // FACE default blends (optional layer): every face term is `opt`, so with no face the sound is exactly the
  // old one; with a face the body still carries most of the weight. jawOpen sings the wah (vowel) and deepens
  // it, squint darkens the cutoff, browUp adds shimmer, a smile lifts the octave colour layer (the chord's tint; a dedicated
  // tint node in synth.js is proposed to the sound lane), gaze nudges the pan. [guess]
  // Step 2: the head TURN is a wah. Facing the screen = a faint peak; turning sweeps a resonant peak
  // low (screen-left) .. high (screen-right) and deepens it. [guess]
  wah:       { src: blend(['body.headTurn', 1], ['face.jawOpen', 0.6, { ctr: true, opt: true }]), range: [380, 2600], curve: 'exp', rest: 900, glide: 0.2, label: 'wah / ואו (head turn)' },
  wahDepth:  { src: blend(['body.headTurn', 1, { mag: true }], ['face.jawOpen', 0.6, { opt: true }]), range: [1.5, 13], rest: 0, glide: 0.25, label: 'wah depth dB' },
  // Step 2: the SHOULDERS lift the floor. A shrug swells the drone + a sub an octave under it (the body's weight
  // in the sound); dropped shoulders sink it back. [guess]
  floor:     { src: 'body.shrug', range: [0.04, 0.34], rest: 0.085, glide: 0.35, label: 'floor / רצפה (shrug)' },
  // Step 2: generic MODULATION targets (synth.js: one shared LFO -> pitch and amplitude). Any source can drive them,
  // statically here or through a POOL binding the DJ arms and retires: nothing in the engine knows about depth.
  // Default wiring, one blend term each: the hand's DEPTH (A.depth, apparent palm size) deepens the vibrato
  // (hand toward the camera = more wobble, "closer" reads as intensity); the WHOLE BODY's movement + the hand's
  // depth speed the shared LFO (still and far: a slow sway; moving or close: a singer's ~6.5 Hz). Close, ~+-30 ¢
  // is unmistakable but still on pitch; a usual hand (depth ~0.25) is a faint few cents. A.depth counts idle 0
  // (= far), so a hand arriving at arm's length or leaving never jumps the sound; no hand -> rest over REST_GLIDE.
  // These are not core controls (the body keeps every core blend); re-routing them is editing this data. [guess]
  vibrato:   { src: blend(['A.depth', 1, { idle: 0 }]), range: [0, 30], rest: 0, glide: 0.25, unit: '¢', label: 'vibrato / ויברטו' },
  tremolo:   { src: null, range: [0, 0.7], rest: 0, label: 'tremolo / טרמולו' },   // binding-only (see POOL), like beat
  modRate:   { src: blend(['body.energy', 1, { idle: 0 }], ['A.depth', 0.6, { idle: 0 }]), range: [3.4, 6.8], rest: 3.4, glide: 0.4,
               unit: 'Hz', label: 'mod rate / קצב אפנון' },
  // The beat's density (0..1). No static source: silent until the pool's groove->beat binding is armed (see BEAT).
  beat:      { src: null, range: [0, 1], rest: 0, label: 'beat / ביט' },
};

// The binding POOL (Step 2): every candidate body -> sound binding the auto-DJ (the conductor's DJ policy) may arm.
// An armed binding fades in and TAKES OVER its target (cross-fade over the static mapping above), is held
// for `hold` s, retires (fades out), cools down, and may be armed again later. WHO arms what and when is the
// DJ policy, not this table. Most of the pool is torso + head, so the whole body gets its turn. [guess]
export const POOL = [
  // the opening's binding ("now move your fingertips"): armed by the cue, fast fade so the change is felt as yours
  { id: 'spread→cutoff', src: 'A.spread', target: 'cutoff', range: [220, 5200], curve: 'exp', hold: 60, cooldown: 40, fadeIn: 0.4, fadeOut: 4, label: 'fingertips open the filter / קצות אצבעות פותחות פילטר' },
  { id: 'sway→shimmer',  src: 'body.sway', mag: true, target: 'shimmer',  range: [0.01, 0.26], hold: 60, cooldown: 30, fadeIn: 4, fadeOut: 6, label: 'sway takes shimmer / נדנוד לוקח ניצוץ' },
  { id: 'lean→echo',     src: 'body.lean', mag: true, target: 'feedback', range: [0.25, 0.82], hold: 90, cooldown: 45, fadeIn: 6, fadeOut: 8, label: 'lean takes echo / הטיה לוקחת משוב' },
  { id: 'nod→cutoff',    src: 'body.nod', target: 'cutoff', range: [4200, 300], curve: 'exp', hold: 50, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'nodding closes the filter / הנהון סוגר פילטר' },
  { id: 'turn→pan',      src: 'body.headTurn', target: 'pan', range: [-0.9, 0.9], hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'facing places the sound / מבט מזיז את הצליל' },
  { id: 'tilt→wah',      src: 'body.headTilt', target: 'wah', range: [380, 2600], curve: 'exp', hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'head tilt sweeps the wah / הטיית ראש מזיזה ואו' },
  { id: 'reach→detune',  src: 'body.reach', target: 'detune', range: [3, 40], hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'open arms widen the detune / ידיים פתוחות מרחיבות' },
  // hand depth as a DJ binding (Step 2): pushing the hand toward the camera takes over the tremolo (a pulsing
  // swell on the shared LFO) or the room (closer = the room blooms, the opposite way to the body's depth). [guess]
  { id: 'depth→tremolo', src: 'A.depth', target: 'tremolo', range: [0, 0.7], hold: 50, cooldown: 40, fadeIn: 2, fadeOut: 5, label: 'hand closer pulses the sound / יד קרובה מפעימה' },
  { id: 'depth→reverb',  src: 'A.depth', target: 'reverbWet', range: [0.2, 0.85], hold: 50, cooldown: 40, fadeIn: 3, fadeOut: 6, label: 'hand closer opens the room / יד קרובה פותחת חלל' },
  // the beat layer: armed when movement builds (its source opens an observation), density follows the groove
  // continuously, so it thins out as the body settles long before the binding retires
  // ---- face + extra body dimensions: generic SOURCES armed like any other binding (no hard-coded face->sound
  // path anywhere; the DJ, the console or a future agent arms / retires / rebinds these at runtime). [guess] ranges.
  // face.*: jawOpen smile squint blink browUp pucker cheekPuff 0..1, lookX lookY 0..1 (0.5 = centre), blinkPulse 0|1
  // body.*: hunch twist (bipolar, 0.5 = neutral), elbowBend crouch 0..1 (null when the joints are not in frame)
  { id: 'jaw→vowel',     src: 'face.jawOpen', target: 'wah', range: [420, 1600], curve: 'exp', hold: 50, cooldown: 40, fadeIn: 1.5, fadeOut: 4, label: 'open mouth sings the vowel / פה פתוח שר תנועה' },
  { id: 'squint→dark',   src: 'face.squint', target: 'cutoff', range: [3800, 380], curve: 'exp', hold: 50, cooldown: 40, fadeIn: 2, fadeOut: 5, label: 'squinting darkens / מצמוץ מחשיך' },
  { id: 'brow→shimmer',  src: 'face.browUp', target: 'shimmer', range: [0.01, 0.28], hold: 50, cooldown: 40, fadeIn: 2, fadeOut: 5, label: 'raised brows shimmer / גבות מורמות מנצנצות' },
  { id: 'brow→octave',   src: 'face.browUp', target: 'octave', range: [0, 0.3], hold: 50, cooldown: 40, fadeIn: 2, fadeOut: 5, label: 'raised brows lift an octave / גבות מרימות אוקטבה' },
  { id: 'smile→bright',  src: 'face.smile', target: 'reverbWet', range: [0.2, 0.7], hold: 50, cooldown: 40, fadeIn: 3, fadeOut: 6, label: 'a smile opens the room / חיוך פותח חלל' },
  { id: 'gaze→pan',      src: 'face.lookX', target: 'pan', range: [-0.8, 0.8], hold: 50, cooldown: 40, fadeIn: 2, fadeOut: 5, label: 'your gaze places the sound / המבט מזיז את הצליל' },
  { id: 'hunch→floor',   src: 'body.hunch', target: 'floor', range: [0.05, 0.32], hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 6, label: 'hunching deepens the floor / התכנסות מעמיקה' },
  { id: 'twist→field',   src: 'body.twist', target: 'field', range: [-0.7, 0.7], hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'twisting turns the field / סיבוב מסובב שדה' },
  { id: 'elbow→detune',  src: 'body.elbowBend', target: 'detune', range: [3, 36], hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'bent arms widen / ידיים כפופות מרחיבות' },
  { id: 'crouch→cutoff', src: 'body.crouch', target: 'cutoff', range: [3600, 300], curve: 'exp', hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'crouching closes the filter / כריעה סוגרת' },
  { id: 'groove→beat',   src: 'body.groove', target: 'beat', range: [0, 1], hold: 90, cooldown: 20, fadeIn: 1.5, fadeOut: 6, label: 'movement builds the beat / תנועה בונה ביט' },
];

// ---------------- the conductor (conductor.js): one scheduler, one decision per turn ----------------
// A turn = { acts: [verb calls], wait }. wait is clamped to 1..10 s (PLAN §2 Director cadence); a bus event
// the conductor subscribes to (a new observation, a probe result, a console edit) wakes it early.
// wakeDebounce: a burst of events wakes at most one turn per this many seconds.
export const CONDUCTOR = { waitMin: 1, waitMax: 10, wakeOn: ['obs.open', 'probe', 'edit'], wakeDebounce: 0.25, traceRing: 200 };

// The auto-DJ binding policy: SCORES every idle binding in the pool by how active its source is in the body
// story right now (an open observation, cited by id), arms the best one, retires a binding that has held its
// time or whose source has gone quiet. One binding per target. When every slot is taken, a clearly stronger
// candidate (swapMargin x) may replace the weakest binding that has held minArmed s. stillBelow: below this
// movement energy the room breathes and holds, so the DJ neither arms nor retires (quiet is an instrument).
// groupBias: a score bonus per source group (body sources get +25%, so the whole body is preferred over a hand
// for the same salience); freshBias favours bindings armed fewer times. Phase blocks override these. [guess]
export const DJ = { maxArmed: 3, minArmed: 15, idleRetire: 14, waitAfterAct: 7, waitIdle: 3, groupBias: { body: 0.25, face: 0 }, freshBias: 0.5, swapMargin: 1.5, stillBelow: 0.12 };

// Phases are STATE with a rationale (Goni 3A7CB2CC): what the phase is for, how explicit the room may be,
// which policies may propose acts, the knobs those policies run with, and READINESS readouts. NO timer exits
// (Tami + Goni, observer file session-20261031-1717-semantic-gates): a phase changes ONLY by an explicit
// phase.set: the Director's semantic judgement that the phase is used up (Step 3, switch_phase), or the dev
// console (dev/test only). With a participant in the room, only the Director changes phase. `readiness` is
// DATA the Director reads (time in phase, arms, turns, stillness) next to `next` and reference `marks`; it
// never fires anything. The room never waits: cues / the DJ keep acting every <= 10 s; only the phase holds. [guess]
export const PHASES = {
  orientation: {
    goal: 'The person learns how the space works: that movement has meaning here, and that this is a place for imagination, body exploration and release without judgment. The room leads; the person discovers.',
    explicit: 'symbols', policies: ['cues', 'dj', 'readiness'], cues: 'opening', dj: { maxArmed: 2 },
    readiness: { next: 'enactment', marks: { inPhase: 180, arms: 4 } }, // marks = reference readouts, never triggers
  },
  enactment: {
    goal: 'The person acts it out. More of the body answers at once; the groove may build.',
    explicit: 'reflect', policies: ['dj', 'readiness'], dj: { maxArmed: 3 },
    readiness: { next: 'integration', marks: { inPhase: 600 } },
  },
  integration: {
    goal: 'Settling. Fewer bindings, longer holds; the room thins out around the person.',
    explicit: 'open', policies: ['dj'], dj: { maxArmed: 1, holdScale: 1.6 },
  },
};
export const FIRST_PHASE = 'orientation';
// The phase EDGES a phase.set may take. Phases are FLUID (G21; Goni 3A91F192: "the question of exactly when is not
// relevant"; voice/flow.js): every phase may move to every other one, back moves included, orientation too. A move
// needs a non-empty `why` (the Director's reason). A same-phase phase.set is a no-op (a hold), never a restart. The
// dev reset (`r`, dev/test only) re-boots the conductor into orientation and the opening cues.
export const PHASE_EDGES = { orientation: ['enactment', 'integration'], enactment: ['orientation', 'integration'], integration: ['orientation', 'enactment'] };

// The body story (story.js): every channel is watched the same way. mode 'change': activity = smoothed
// |d value / dt| (units/s). mode 'level': activity = the value itself. An observation opens above `on` and
// closes below `off` (hysteresis). Per-channel overrides are tuning, not branches. [guess]
export const STORY = {
  tc: 0.5, on: 0.3, off: 0.12, ring: 120,
  channels: {
    'body.lean': { label: 'torso leaning' }, 'body.sway': { label: 'swaying side to side' },
    'body.headTilt': { label: 'head tilting' }, 'body.headTurn': { label: 'head turning' },
    'body.nod': { label: 'nodding' }, 'body.shrug': { label: 'shoulders lifting' },
    'body.depth': { label: 'moving closer / further' }, 'body.armsUp': { label: 'arms rising' },
    'body.reach': { label: 'arms opening' }, 'body.x': { label: 'moving across the room' },
    'body.rise': { label: 'rising / sinking' },
    'body.groove': { label: 'movement building', mode: 'level', on: 0.3, off: 0.16 },
    'A.spread': { label: 'fingertips opening' }, 'A.height': { label: 'hand rising' },
    'A.openness': { label: 'hand opening' }, 'A.x': { label: 'hand travelling' }, 'A.depth': { label: 'hand coming closer / further' },
    'B.height': { label: 'second hand rising' }, 'B.openness': { label: 'second hand opening' },
    'body.hunch': { label: 'hunching / opening up' }, 'body.twist': { label: 'torso twisting' },
    'body.elbowBend': { label: 'arms bending' }, 'body.crouch': { label: 'crouching' },
    'face.jawOpen': { label: 'mouth opening' }, 'face.smile': { label: 'smiling' }, 'face.squint': { label: 'squinting' },
    'face.browUp': { label: 'brows lifting' }, 'face.lookX': { label: 'gaze travelling' },
  },
  // presence channels (seen / gone observations): data, so a new optional layer is one row
  presence: [['body', 'person', 'body.pose'], ['A', 'hand A', 'A.present'], ['B', 'hand B', 'B.present'], ['face', 'face', 'face.present']],
};

// The beat is a binding target like any other: `beat` (0..1 density). Its static mapping rests at 0; the
// pool's groove->beat binding drives it from body.groove (energy averaged over ENERGY.grooveSeconds). The drum
// voices fade in CONTINUOUSLY with density (each voice: a smoothstep [from, to]): no levels, no classifier. [guess]
export const BEAT = {
  gain: 0.8,
  voices: { kick: [0.05, 0.3], shake: [0.15, 0.42], ghost: [0.35, 0.7], hat: [0.42, 0.78], clap: [0.6, 0.9] },
};

// Cues (the conductor's 'cues' policy): an ordered list of cue records, all DATA. A cue: says a line (`say`,
// verb `say`: a faded caption now, the Mouth in Step 3), runs `acts` (verb calls; `at` = seconds after the
// cue starts — the conductor schedules them ahead), waits `until` a probe passes on a claim (`timeout`,
// `reoffer` = say again at that time, `repair` = acts to retry once, `onFail` 'strip' | 'continue'), then
// holds `hold` seconds. `requires: claimId` skips the cue unless that claim was verified (never say
// "that's you" without agency evidence). Times are life-seconds. The opening (PLAN §4 Step 2):
// "Now we'll hear a sound <chime>. Now move your fingertips <spread -> filter>. That's you." then it asks.
export const CUES = {
  opening: [
    { id: 'welcome', hold: 3.5 },
    { id: 'chime', say: 'עכשיו נשמע צליל', en: "Now we'll hear a sound", show: 3.2,
      acts: [{ verb: 'stimulus', args: { what: 'chime', claim: 'a1' }, at: 1.6 }],
      until: { probe: 'audible', claim: 'a1', timeout: 3, repair: [{ verb: 'stimulus', args: { what: 'chime', claim: 'a1', repair: true } }], onFail: 'strip' },
      hold: 3 },
    { id: 'fingertips', say: 'עכשיו הזיזו לאט את קצות האצבעות', en: 'Now move your fingertips, slowly', show: 4.5,
      acts: [{ verb: 'binding.arm', args: { id: 'spread→cutoff', claim: 'a2', force: true } }],
      until: { probe: 'agency', claim: 'a2', binding: 'spread→cutoff', timeout: 60, reoffer: 25, onFail: 'strip' } },
    { id: 'thatsyou', say: 'זה אתם.', en: "That's you.", show: 3.2, requires: 'a2', hold: 4.5 },
    { id: 'ask', say: 'מה אתם שומעים?', en: 'What do you hear?', show: 5, hold: 7 },
  ],
};
// The probes claims rest on (ORACLE §9 moves 5, 7, 8). Thresholds frozen here, before a run.
// audible: the stimulus' RMS at its own tap within `windowMs` of firing. agency (ANY binding): after its source
// opens an observation (a volitional onset), source value and target param (log for exp curves) must correlate
// with the SIGN the binding's range implies, over `windowS`, with real source travel.
export const PROBES = { audible: { windowMs: 600, minRms: 0.004 }, agency: { windowS: 3, minR: 0.5, minSpan: 0.12, minSamples: 12 } };

// The auto-DJ progression: slow, D aeolian, moves on by itself. A chord holds for minBars..maxBars;
// past minBars it advances early on a burst of energy or at a phrase end (movement settling after
// a burst). The body bends the voicing (MAPPINGS.voicing) but never replaces the chord. [guess]
export const PROGRESSION = {
  bpm: 72, beatsPerBar: 4, minBars: 8, maxBars: 16, advanceEnergy: 0.45, phraseEnd: true,
  // root = bass MIDI note; tones = semitones above root for [3rd, 5th, 7th, 9th/11th]
  chords: [
    { name: 'Dm9',    root: 38, tones: [3, 7, 10, 14] },
    { name: 'B♭maj9', root: 46, tones: [4, 7, 11, 14] },
    { name: 'Fmaj9',  root: 41, tones: [4, 7, 11, 14] },
    { name: 'C6/9',   root: 36, tones: [4, 7, 9, 14] },
    { name: 'Gm9',    root: 43, tones: [3, 7, 10, 14] },
    { name: 'Am11',   root: 45, tones: [3, 7, 10, 17] },
  ],
};
// The four voicing zones (hand x, left -> right). tones index the chord: 0 root, 1 3rd, 2 5th,
// 3 7th, 4 9th. Upper voices are voice-led (nearest note to where each voice was) inside a
// register window around `center` (MIDI). Zone 2 drops the 3rd: open, suspended air. [guess]
export const VOICINGS = [
  { name: 'deep',   tones: [0, 1, 2, 3], center: 52 },
  { name: 'open',   tones: [2, 3, 1, 4], center: 58 },
  { name: 'air',    tones: [2, 4, 0, 3], center: 63 },
  { name: 'bright', tones: [1, 3, 4, 2], center: 69 },
];
export const DRONE_MIDI = 38; // D2: the floor under every chord of the progression

// Feature calibration (raw ratio -> 0..1), used by hand.js / body.js. [guess, from synthetic + photo hands]
export const FEATURES = {
  spreadRaw:   [0.25, 1.4],  // |thumbTip-indexTip| / palm size
  opennessRaw: [0.9, 1.9],   // mean |fingertip-wrist| / palm size
  // robust palm size (frame units, see hand.js) that maps to A.depth 0..1, log-scaled (size ~ 1 / distance).
  // 0.09 ~ arm's length from a laptop webcam, 0.30 ~ a hand a hand-span from the lens; 0.12 (a usual hand,
  // synthLandmarks' default) reads ~0.24. [guess]
  handDepthRaw: [0.09, 0.30],
  leanDeg: 20,               // shoulder roll at which lean saturates
  headTiltDeg: 25,           // head roll (vs shoulders) at which tilt saturates
  swayRange: 0.12,           // shoulder-centre drift (frame widths) at which sway saturates
  swayAvgSeconds: 3,         // the slow average sway is measured against
  turnRange: 0.35,           // nose offset along the ear axis (ear widths) at which head turn saturates
  nodRange: 0.3,             // nose offset across the ear axis vs its baseline (ear widths) at which nod saturates
  shrugRange: 0.18,          // shoulder-line rise vs nose (shoulder widths, vs its baseline) at which shrug saturates
  depthRange: 0.25,          // shoulder-width ratio vs its baseline at which depth saturates (+-25%)
  baselineSeconds: 12,       // the slow baseline nod / depth are measured against (a held posture drifts home)
  // extra body dimensions (face-integration proposal): [guess] ranges, calibrated on synthPose only
  hunchRange: 0.15,          // nose-forward-of-shoulders (MediaPipe z units) vs baseline at which hunch saturates
  twistRange: 0.6,           // shoulder depth difference / shoulder width at which twist saturates
  elbowBendDeg: [15, 120],   // elbow bend (180 - interior angle): nearly straight .. folded
  crouchRange: 0.6,          // hip-line drop below its baseline, in shoulder widths, at which crouch reaches 1
  armsUpRaw: [-1.0, 1.5],    // highest wrist above the shoulder line, in shoulder widths
  reachRaw: [1.0, 3.5],      // wrist-to-wrist span, in shoulder widths
  xRaw: [0.1, 0.9],          // shoulder-centre x on the mirrored screen that maps to body.x 0..1 (outer 10% saturate)
  riseRange: 0.12,           // shoulder-line rise vs its baseline (frame heights) at which body.rise saturates
};

// ---------- pure helpers (no DOM, node-testable) ----------
import { mapCurve } from './curves.js';

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// mapping / binding def -> target value. The curve registry (curves.js) takes exactly the old float path for
// 'exp' / 'lin' / undefined, so preset `default` is byte-identical (verify/golden).
export const mapRange = (m, v) => mapCurve(m.curve, m.range, v);

// inputs: { A: {present, f}, B: {present, f}, body: {present, f} }. Returns the 0..1 value or null.
export function readSource(inputs, src, mag) {
  const [g, k] = src.split('.');
  const h = inputs[g];
  if (!h || !h.present || h.f[k] == null) return null;
  const v = h.f[k];
  return mag ? clamp01(Math.abs(v - 0.5) * 2) : v;
}

// A mapping's value: one source or a blend (see MAPPINGS). null = every term absent.
export function readBlend(inputs, src, mag) {
  if (src == null) return null;
  if (typeof src === 'string') return readSource(inputs, src, mag);
  let sum = 0, W = 0, any = false;
  for (const t of src) {
    let v = readSource(inputs, t.s, t.mag);
    if (v == null) { if (t.opt) continue; v = t.idle ?? 0.5; } else { any = true; if (t.ctr) v = 0.5 + v / 2; }
    sum += t.w * (t.inv ? 1 - v : v); W += t.w;
  }
  return any && W > 0 ? sum / W : null;
}
// the source names a mapping reads (for the console / tests)
export const srcNames = (src) => (src == null ? [] : typeof src === 'string' ? [src] : src.map((t) => t.s));

// Zone choice with hysteresis: stay in the current zone until x leaves it by more than h.
export function nextZone(x, current, n, h) {
  const raw = Math.min(n - 1, Math.max(0, Math.floor(clamp01(x) * n)));
  if (current == null) return raw;
  const lo = current / n - h, hi = (current + 1) / n + h;
  return x >= lo && x <= hi ? current : raw;
}

// The registered targets and their defaults (rest / restGlide), frozen from preset `default` (MAPPINGS): a target
// whose static mapping was removed at runtime (map.remove) rests here.
export const TARGET_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(MAPPINGS).map(([k, m]) => [k, Object.freeze({ rest: m.rest, restGlide: m.restGlide })])));
// Static mappings -> { targets, glides, zone }. Armed pool bindings are layered on by life.js (Bindings.apply).
// statics: { target: mapping } (default: MAPPINGS = preset `default`; the live MappingLayer passes its own table).
// `weight` (0..1, live-editable; absent = 1) cross-fades a static mapping from the target's rest to its value.
export function computeTargets(inputs, zone, statics = MAPPINGS) {
  const targets = {}, glides = {};
  let newZone = zone ?? 0;
  for (const key in TARGET_DEFAULTS) {
    const m = statics[key];
    if (key === 'voicing') {
      const x = m ? readBlend(inputs, m.src) : null;
      if (x != null) newZone = nextZone(x, zone, m.zones, m.hysteresis);
      targets.voicing = newZone; glides.voicing = CHORD_GLIDE;
      continue;
    }
    const v = m ? readBlend(inputs, m.src, m.mag) : null;
    if (v != null) {
      const y = mapRange(m, v);
      targets[key] = m.weight == null ? y : m.rest * (1 - m.weight) + y * m.weight; glides[key] = m.glide ?? GLIDE;
    } else { const d = m ?? TARGET_DEFAULTS[key]; targets[key] = d.rest; glides[key] = d.restGlide ?? REST_GLIDE; }
  }
  return { targets, glides, zone: newZone };
}
