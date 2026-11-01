





























export const GLIDE = 0.12;






export const REST_GLIDE = 0.9;


export const CHORD_GLIDE = 0.2;
export const BASS_GLIDE = 0.08;


export const PRESENCE_HOLD_MS = 280;

export const BODY_HOLD_MS = 800;






export const VISION = { fps: 30, minFps: 15, adaptAt: 0.75, pattern: ['pose', 'hands', 'pose', 'face'] };






export const ENERGY = { full: 1.4, attack: 0.25, release: 1.6, moving: 0.12, weights: { pose: 1, hands: 0.5 }, grooveSeconds: 3 };










const blend = (...terms) => terms.map(([s, w, o = {}]) => ({ s, w, ...o }));
export const MAPPINGS = {
  
  cutoff:    { src: blend(['body.rise', 1], ['body.nod', 0.5, { inv: true }], ['body.depth', 0.5], ['A.height', 0.45], ['face.squint', 0.4, { inv: true, ctr: true, opt: true }]),
               range: [180, 6500], curve: 'exp', rest: 650, unit: 'Hz', label: 'filter / פילטר' },
  
  detune:    { src: blend(['body.sway', 1, { mag: true, idle: 0 }], ['body.headTilt', 0.4, { mag: true, idle: 0 }], ['A.spread', 0.4, { idle: 0.3 }]),
               range: [3, 32], rest: 6, unit: '¢', label: 'detune / דיטיון' },
  
  shimmer:   { src: blend(['body.energy', 1, { idle: 0 }], ['body.armsUp', 0.8, { idle: 0 }], ['A.openness', 0.4], ['face.browUp', 0.4, { opt: true }]),
               range: [0, 0.2], rest: 0.015, label: 'shimmer / ניצוץ' },
  
  pan:       { src: blend(['body.x', 1], ['body.headTurn', 0.3], ['A.x', 0.4], ['face.lookX', 0.2, { opt: true }]), range: [-0.75, 0.75], rest: 0, label: 'pan / שמאל-ימין' },
  
  
  voicing:   { src: blend(['body.x', 1], ['A.x', 0.4]), zones: 4, hysteresis: 0.05, rest: 'hold', label: 'voicing / פריסה' },
  
  
  
  swell:     { src: blend(['body.here', 1, { idle: 0 }], ['body.energy', 0.7, { idle: 0 }]), range: [0.16, 0.85], rest: 0.16,
               glide: 0.4, restGlide: 1.4, label: 'swell / עוצמה' },
  
  reverbWet: { src: blend(['body.depth', 1, { inv: true }], ['B.height', 0.4]), range: [0.15, 0.8], rest: 0.32, label: 'reverb / הדהוד' },
  
  octave:    { src: blend(['body.armsUp', 1, { idle: 0 }], ['B.openness', 0.4, { idle: 0 }], ['face.smile', 0.5, { opt: true }]), range: [0, 0.3], rest: 0, label: 'octave / אוקטבה' },
  
  trip:      { src: 'body.energy', range: [0.08, 1],    rest: 0.08, glide: 0.5,          label: 'trip / טריפ' },
  feedback:  { src: 'body.energy', range: [0.3, 0.72],  rest: 0.3,  glide: 0.7,          label: 'echo fb / משוב' },
  field:     { src: 'body.lean',   range: [-0.7, 0.7],  rest: 0,    glide: 0.3,          label: 'field / שדה' },
  resonance: { src: 'body.headTilt', mag: true, range: [0.8, 8], curve: 'exp', rest: 0.9, glide: 0.25, label: 'resonance / תהודה' },
  
  
  
  
  
  
  wah:       { src: blend(['body.headTurn', 1], ['face.jawOpen', 0.6, { ctr: true, opt: true }]), range: [380, 2600], curve: 'exp', rest: 900, glide: 0.2, label: 'wah / ואו (head turn)' },
  wahDepth:  { src: blend(['body.headTurn', 1, { mag: true }], ['face.jawOpen', 0.6, { opt: true }]), range: [1.5, 13], rest: 0, glide: 0.25, label: 'wah depth dB' },
  
  
  floor:     { src: 'body.shrug', range: [0.04, 0.34], rest: 0.085, glide: 0.35, label: 'floor / רצפה (shrug)' },
  
  
  
  
  
  
  
  
  vibrato:   { src: blend(['A.depth', 1, { idle: 0 }]), range: [0, 30], rest: 0, glide: 0.25, unit: '¢', label: 'vibrato / ויברטו' },
  tremolo:   { src: null, range: [0, 0.7], rest: 0, label: 'tremolo / טרמולו' },   
  modRate:   { src: blend(['body.energy', 1, { idle: 0 }], ['A.depth', 0.6, { idle: 0 }]), range: [3.4, 6.8], rest: 3.4, glide: 0.4,
               unit: 'Hz', label: 'mod rate / קצב אפנון' },
  
  beat:      { src: null, range: [0, 1], rest: 0, label: 'beat / ביט' },
};





export const POOL = [
  
  { id: 'spread→cutoff', src: 'A.spread', target: 'cutoff', range: [220, 5200], curve: 'exp', hold: 60, cooldown: 40, fadeIn: 0.4, fadeOut: 4, label: 'fingertips open the filter / קצות אצבעות פותחות פילטר' },
  { id: 'sway→shimmer',  src: 'body.sway', mag: true, target: 'shimmer',  range: [0.01, 0.26], hold: 60, cooldown: 30, fadeIn: 4, fadeOut: 6, label: 'sway takes shimmer / נדנוד לוקח ניצוץ' },
  { id: 'lean→echo',     src: 'body.lean', mag: true, target: 'feedback', range: [0.25, 0.82], hold: 90, cooldown: 45, fadeIn: 6, fadeOut: 8, label: 'lean takes echo / הטיה לוקחת משוב' },
  { id: 'nod→cutoff',    src: 'body.nod', target: 'cutoff', range: [4200, 300], curve: 'exp', hold: 50, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'nodding closes the filter / הנהון סוגר פילטר' },
  { id: 'turn→pan',      src: 'body.headTurn', target: 'pan', range: [-0.9, 0.9], hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'facing places the sound / מבט מזיז את הצליל' },
  { id: 'tilt→wah',      src: 'body.headTilt', target: 'wah', range: [380, 2600], curve: 'exp', hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'head tilt sweeps the wah / הטיית ראש מזיזה ואו' },
  { id: 'reach→detune',  src: 'body.reach', target: 'detune', range: [3, 40], hold: 60, cooldown: 40, fadeIn: 3, fadeOut: 5, label: 'open arms widen the detune / ידיים פתוחות מרחיבות' },
  
  
  { id: 'depth→tremolo', src: 'A.depth', target: 'tremolo', range: [0, 0.7], hold: 50, cooldown: 40, fadeIn: 2, fadeOut: 5, label: 'hand closer pulses the sound / יד קרובה מפעימה' },
  { id: 'depth→reverb',  src: 'A.depth', target: 'reverbWet', range: [0.2, 0.85], hold: 50, cooldown: 40, fadeIn: 3, fadeOut: 6, label: 'hand closer opens the room / יד קרובה פותחת חלל' },
  
  
  
  
  
  
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





export const CONDUCTOR = { waitMin: 1, waitMax: 10, wakeOn: ['obs.open', 'probe', 'edit'], wakeDebounce: 0.25, traceRing: 200 };








export const DJ = { maxArmed: 3, minArmed: 15, idleRetire: 14, waitAfterAct: 7, waitIdle: 3, groupBias: { body: 0.25, face: 0 }, freshBias: 0.5, swapMargin: 1.5, stillBelow: 0.12 };








export const PHASES = {
  orientation: {
    goal: 'The person learns how the space works: that movement has meaning here, and that this is a place for imagination, body exploration and release without judgment. The room leads; the person discovers.',
    explicit: 'symbols', policies: ['cues', 'dj', 'readiness'], cues: 'opening', dj: { maxArmed: 2 },
    readiness: { next: 'enactment', marks: { inPhase: 180, arms: 4 } }, 
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




export const PHASE_EDGES = { orientation: ['enactment', 'integration'], enactment: ['orientation', 'integration'], integration: ['orientation', 'enactment'] };




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
  
  presence: [['body', 'person', 'body.pose'], ['A', 'hand A', 'A.present'], ['B', 'hand B', 'B.present'], ['face', 'face', 'face.present']],
};




export const BEAT = {
  gain: 0.8,
  voices: { kick: [0.05, 0.3], shake: [0.15, 0.42], ghost: [0.35, 0.7], hat: [0.42, 0.78], clap: [0.6, 0.9] },
};










export const CUES = {
  opening: [
    { id: 'welcome', gate: 'opening', hold: 3.5 }, 
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




export const PROBES = { audible: { windowMs: 600, minRms: 0.004 }, agency: { windowS: 3, minR: 0.5, minSpan: 0.12, minSamples: 12 } };




export const PROGRESSION = {
  bpm: 72, beatsPerBar: 4, minBars: 8, maxBars: 16, advanceEnergy: 0.45, phraseEnd: true,
  
  chords: [
    { name: 'Dm9',    root: 38, tones: [3, 7, 10, 14] },
    { name: 'B♭maj9', root: 46, tones: [4, 7, 11, 14] },
    { name: 'Fmaj9',  root: 41, tones: [4, 7, 11, 14] },
    { name: 'C6/9',   root: 36, tones: [4, 7, 9, 14] },
    { name: 'Gm9',    root: 43, tones: [3, 7, 10, 14] },
    { name: 'Am11',   root: 45, tones: [3, 7, 10, 17] },
  ],
};



export const VOICINGS = [
  { name: 'deep',   tones: [0, 1, 2, 3], center: 52 },
  { name: 'open',   tones: [2, 3, 1, 4], center: 58 },
  { name: 'air',    tones: [2, 4, 0, 3], center: 63 },
  { name: 'bright', tones: [1, 3, 4, 2], center: 69 },
];
export const DRONE_MIDI = 38; 


export const FEATURES = {
  spreadRaw:   [0.25, 1.4],  
  opennessRaw: [0.9, 1.9],   
  
  
  
  handDepthRaw: [0.09, 0.30],
  leanDeg: 20,               
  headTiltDeg: 25,           
  swayRange: 0.12,           
  swayAvgSeconds: 3,         
  turnRange: 0.35,           
  nodRange: 0.3,             
  shrugRange: 0.18,          
  depthRange: 0.25,          
  baselineSeconds: 12,       
  
  hunchRange: 0.15,          
  twistRange: 0.6,           
  elbowBendDeg: [15, 120],   
  crouchRange: 0.6,          
  armsUpRaw: [-1.0, 1.5],    
  reachRaw: [1.0, 3.5],      
  xRaw: [0.1, 0.9],          
  riseRange: 0.12,           
};


import { mapCurve } from './curves.js';

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);



export const mapRange = (m, v) => mapCurve(m.curve, m.range, v);


export function readSource(inputs, src, mag) {
  const [g, k] = src.split('.');
  const h = inputs[g];
  if (!h || !h.present || h.f[k] == null) return null;
  const v = h.f[k];
  return mag ? clamp01(Math.abs(v - 0.5) * 2) : v;
}


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

export const srcNames = (src) => (src == null ? [] : typeof src === 'string' ? [src] : src.map((t) => t.s));


export function nextZone(x, current, n, h) {
  const raw = Math.min(n - 1, Math.max(0, Math.floor(clamp01(x) * n)));
  if (current == null) return raw;
  const lo = current / n - h, hi = (current + 1) / n + h;
  return x >= lo && x <= hi ? current : raw;
}



export const TARGET_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(MAPPINGS).map(([k, m]) => [k, Object.freeze({ rest: m.rest, restGlide: m.restGlide })])));



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
