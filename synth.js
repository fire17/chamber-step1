// WebAudio pad, "trippy but warm":
//   5 voices (detuned saw pair + triangle, octave + shimmer layers)
//   -> resonant 24 dB lowpass (slow evolving breath LFO)
//   -> 4-stage phaser (LFO whose own rate drifts)
//   -> stereo chorus (two modulated short delays)
//   -> pan -> swell -> dry / long generated-IR reverb / filtered ping-pong echo (tape wobble, soft-clipped feedback)
//   -> wet returns through a "field" panner (torso lean tilts the room) -> soft saturation -> compressor -> master
// A quiet D drone sits underneath at all times, so silence is never broken. Step 2 adds:
//   a wah (peaking filter after the lowpass; head turn), the floor (drone + a sub an octave down; shoulders),
//   generic modulation (ONE shared LFO at `modRate` -> `vibrato` cents on every pad voice + `tremolo` amplitude
//   depth on the pad; the drone stays still; which body part drives them is data in mappings.js),
//   the beat (beat.js, density from the groove binding) and the chime stimulus with its OWN analyser tap, so
//   the `audible` probe measures the chime itself, not the pad under it (ORACLE §9 move 5).
// The `trip` macro (movement energy) opens the phaser/chorus depth, speeds the LFOs, opens the echo send and the
// filter breath; at rest everything still moves, just slowly.
import { DRONE_MIDI, midiToHz, MAPPINGS, CHORD_GLIDE, BASS_GLIDE, PROGRESSION } from './mappings.js';
import { BeatSynth } from './beat.js';
import { SpaceDriver } from './sound/engine.js';
import { Duck, speechSeconds } from './sound/duck.js';
import { Swell, swellPlan } from './sound/swell.js';
import { PeakGuard } from './sound/master.js';

// Stereo, decorrelated, darkening noise tail. Deterministic (xorshift) so every run sounds the same.
function makeImpulse(ctx, seconds = 5.2, decay = 2.3) {
  const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0, seed = ch ? 0x9e3779b9 : 0x2545f491;
    const pre = Math.floor(rate * (ch ? 0.027 : 0.021)); // slightly different pre-delays: wider image
    for (let i = 0; i < len; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const n = ((seed >>> 0) / 4294967296) * 2 - 1;
      const t = i / len;
      const k = 0.3 + 0.62 * t;            // darken the tail over time (warm, not hissy)
      lp += (n - lp) * (1 - k);
      d[i] = i < pre ? 0 : lp * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

function softClip(ctx, drive) {
  const ws = ctx.createWaveShaper(), n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(drive * x) / Math.tanh(drive); }
  ws.curve = c; ws.oversample = '2x';
  return ws;
}

// target id -> how it reaches the audio graph. Order matters only for the call log (verify/golden). The registry's
// TARGET.apply kind (registry.js) names the same split: params | derived | macro | always | zones.
const APPLY = [
  ['cutoff', { params: (p) => [p.cutoffSrc.offset] }],
  ['detune', { params: (p) => [p.detuneSrc.offset] }],
  ['shimmer', { params: (p) => [p.shimmerGain.gain] }],
  ['pan', { params: (p) => [p.panner.pan] }],
  ['swell', { params: (p) => [p.swell.gain] }],
  ['octave', { params: (p) => [p.octaveGain.gain] }],
  ['field', { params: (p) => [p.field.pan] }],
  ['resonance', { params: (p) => [p.filter.Q] }],
  ['feedback', { params: (p) => [p.fbL.gain, p.fbR.gain], map: (v) => Math.min(0.85, v) }], // hard cap < 1
  ['wah', { params: (p) => [p.wah.frequency] }],
  ['wahDepth', { params: (p) => [p.wah.gain] }],
  ['floor', { params: (p) => [p.droneGain.gain] }],
  ['vibrato', { params: (p) => [p.vib.gain] }],
  ['modRate', { params: (p) => [p.mod.frequency] }],
  ['tremolo', { fn: (p, v, gl, t, to) => { to(p.tremAmt.gain, v / 2, gl.tremolo); to(p.trem.gain, 1 - v / 2, gl.tremolo); } }],
  ['floor', { as: 'sub', fn: (p, v, gl, t, to) => to(p.subGain.gain, Math.max(0, v - 0.06) * 1.6, gl.floor) }],
  ['beat', { always: true, fn: (p, v) => { if (v != null) { p.current.beat = v; p.beat.setDensity(v); } } }],
  ['reverbWet', { fn: (p, v, gl) => p.setReverbWet(v, gl.reverbWet) }],
  ['trip', { fn: (p, v, gl) => p.setTrip(v, gl.trip) }],
  // OPTIONAL (proposed; no default mapping drives them, so preset `default` never touches them):
  // vowel 0..1 morphs two formant peaks (F1 300->750 Hz, F2 2300->1100 Hz, "ee" -> "ah"); vowelDepth dB 0..12.
  ['vowel', { fn: (p, v, gl, t, to) => { to(p.vowelF1.frequency, 300 + 450 * v, gl.vowel ?? 0.15); to(p.vowelF2.frequency, 2300 - 1200 * v, gl.vowel ?? 0.15); } }],
  ['vowelDepth', { fn: (p, v, gl, t, to) => { to(p.vowelF1.gain, v, gl.vowelDepth ?? 0.25); to(p.vowelF2.gain, v * 0.8, gl.vowelDepth ?? 0.25); } }],
  // tint -1..1: a tilt EQ on the master bus (-1 dark/warm .. +1 bright), +-6 dB shelves at 250 Hz / 3 kHz
  ['tint', { fn: (p, v, gl, t, to) => { to(p.tintLo.gain, -6 * v, gl.tint ?? 0.4); to(p.tintHi.gain, 6 * v, gl.tint ?? 0.4); } }],
];

export class Pad {
  constructor(ctx, notes) {
    this.ctx = ctx;
    const t = ctx.currentTime;
    const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); return o; };
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const lfo = (f, amt, ...params) => { const o = osc('sine', f), g = gain(amt); o.connect(g); params.forEach((p) => g.connect(p)); return { o, g }; };

    // ---- master: warm soft saturation -> compressor -> gain -> analyser ----
    this.sat = softClip(ctx, 1.35);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18; this.comp.ratio.value = 3; this.comp.attack.value = 0.02; this.comp.release.value = 0.4;
    this.master = gain(0); this.master.gain.setTargetAtTime(0.5, t, 0.8); // fade the whole thing in on start
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 2048;
    this.sat.connect(this.comp); this.comp.connect(this.master); this.master.connect(this.analyser); this.analyser.connect(ctx.destination);

    // ---- wet returns share one "field" panner (torso lean tilts the room) ----
    this.field = ctx.createStereoPanner(); this.field.connect(this.sat);
    this.dry = gain(1); this.dry.connect(this.sat);

    // ---- reverb (long, wide) ----
    this.reverb = ctx.createConvolver(); this.reverb.buffer = makeImpulse(ctx);
    this.wet = gain(0); this.reverb.connect(this.wet); this.wet.connect(this.field);
    this.sendBus = gain(1); this.sendBus.connect(this.reverb);

    // ---- ping-pong echo: dotted-eighth / quarter at the progression tempo, filtered + soft-clipped loop ----
    const beat = 60 / PROGRESSION.bpm; // echoes sit on the progression's grid
    this.echoSend = gain(0.12);
    this.dlL = ctx.createDelay(2); this.dlL.delayTime.value = beat * 0.75;
    this.dlR = ctx.createDelay(2); this.dlR.delayTime.value = beat;
    const fbHP = ctx.createBiquadFilter(); fbHP.type = 'highpass'; fbHP.frequency.value = 180;
    const fbLP = ctx.createBiquadFilter(); fbLP.type = 'lowpass'; fbLP.frequency.value = 2400; // each repeat darker: warm
    const fbSat = softClip(ctx, 1.6);                                                       // loop can never run away
    this.fbL = gain(MAPPINGS.feedback.rest); this.fbR = gain(MAPPINGS.feedback.rest);
    this.echoSend.connect(this.dlL);
    this.dlL.connect(fbHP); fbHP.connect(fbLP); fbLP.connect(fbSat); fbSat.connect(this.fbL); this.fbL.connect(this.dlR);
    this.dlR.connect(this.fbR); this.fbR.connect(this.dlL);
    const echoMerge = ctx.createChannelMerger(2);
    this.dlL.connect(echoMerge, 0, 0); this.dlR.connect(echoMerge, 0, 1);
    this.echoRet = gain(0.6); echoMerge.connect(this.echoRet); this.echoRet.connect(this.field);
    const echoToVerb = gain(0.3); this.echoRet.connect(echoToVerb); echoToVerb.connect(this.sendBus); // repeats melt into the room
    // tape wobble on the echo times (a few cents of drift)
    this.wobble = lfo(0.05, 0.004, this.dlL.delayTime, this.dlR.delayTime);

    // ---- pad chain ----
    this.voiceBus = gain(0.11);
    this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = MAPPINGS.resonance.rest;
    this.filter2 = ctx.createBiquadFilter(); this.filter2.type = 'lowpass'; this.filter2.Q.value = 0.5; // 24 dB/oct, soft edge
    this.voiceBus.connect(this.filter); this.filter.connect(this.filter2);
    // wah: a resonant peak swept by the head turn; 0 dB (transparent) when facing the screen
    this.wah = ctx.createBiquadFilter(); this.wah.type = 'peaking'; this.wah.Q.value = 3.2;
    this.wah.frequency.value = MAPPINGS.wah.rest; this.wah.gain.value = MAPPINGS.wahDepth.rest;
    // cutoff drives both stages; a slow breath LFO moves them (depth opens with trip)
    this.cutoffSrc = ctx.createConstantSource(); this.cutoffSrc.offset.value = MAPPINGS.cutoff.rest;
    this.filter.frequency.value = 0; this.filter2.frequency.value = 0;
    this.cutoffSrc.connect(this.filter.frequency);
    const c2 = gain(1.4); this.cutoffSrc.connect(c2); c2.connect(this.filter2.frequency); this.cutoffSrc.start(t);
    this.breath = lfo(0.043, 180, this.filter.detune, this.filter2.detune);

    // phaser: 4 allpass stages swept in cents around 640 Hz; its LFO rate itself drifts (evolving, never loops exactly)
    this.phIn = gain(1); this.filter2.connect(this.wah); this.wah.connect(this.phIn);
    let node = this.phIn; this.allpass = [];
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.frequency.value = 640 * (1 + i * 0.6); ap.Q.value = 0.7;
      node.connect(ap); node = ap; this.allpass.push(ap);
    }
    this.phWet = gain(0.25); node.connect(this.phWet);
    this.phSum = gain(1); this.phIn.connect(this.phSum); this.phWet.connect(this.phSum);
    this.phLfo = lfo(0.07, 500, ...this.allpass.map((a) => a.detune));
    this.phDrift = lfo(0.011, 0.04, this.phLfo.o.frequency);

    // chorus: two short modulated delays -> L / R (a slow third LFO wanders its depth)
    this.chL = ctx.createDelay(0.05); this.chL.delayTime.value = 0.013;
    this.chR = ctx.createDelay(0.05); this.chR.delayTime.value = 0.019;
    this.chModL = lfo(0.27, 0.0018, this.chL.delayTime);
    this.chModR = lfo(0.33, 0.0018, this.chR.delayTime);
    this.chWander = lfo(0.017, 0.0008, this.chModL.g.gain, this.chModR.g.gain);
    const chMerge = ctx.createChannelMerger(2);
    this.phSum.connect(this.chL); this.phSum.connect(this.chR);
    this.chL.connect(chMerge, 0, 0); this.chR.connect(chMerge, 0, 1);
    this.chWet = gain(0.5); chMerge.connect(this.chWet);
    this.panner = ctx.createStereoPanner();
    this.phSum.connect(this.panner); this.chWet.connect(this.panner);

    // modulation: ONE sine LFO (rate = modRate) feeds both the vibrato (cents on every pad oscillator's detune,
    // adding to the detune spread) and the tremolo (pad amplitude). Both rest at 0 depth: inaudible until driven.
    this.mod = osc('sine', MAPPINGS.modRate.rest);
    this.vib = gain(MAPPINGS.vibrato.rest); this.mod.connect(this.vib);
    this.tremAmt = gain(MAPPINGS.tremolo.rest / 2); this.mod.connect(this.tremAmt);
    this.swell = gain(MAPPINGS.swell.rest);
    // tremolo: gain = (1 - d/2) + (d/2) * lfo, so depth d swings the pad between 1 - d and 1 (never louder than dry)
    this.trem = gain(1 - MAPPINGS.tremolo.rest / 2); this.tremAmt.connect(this.trem.gain);
    this.panner.connect(this.trem); this.trem.connect(this.swell);
    this.swell.connect(this.dry); this.swell.connect(this.sendBus); this.swell.connect(this.echoSend);

    // shared detune (cents): +d on saw A, -d on saw B; saw B also drifts slowly by itself
    this.detuneSrc = ctx.createConstantSource(); this.detuneSrc.offset.value = MAPPINGS.detune.rest; this.detuneSrc.start(t);
    this.detuneNeg = gain(-1); this.detuneSrc.connect(this.detuneNeg);
    this.drift = lfo(0.029, 3);

    // layers
    this.octaveGain = gain(0); this.octaveGain.connect(this.voiceBus);
    this.shimmerGain = gain(MAPPINGS.shimmer.rest);
    this.shimmerHP = ctx.createBiquadFilter(); this.shimmerHP.type = 'highpass'; this.shimmerHP.frequency.value = 900;
    this.shimmerGain.connect(this.shimmerHP); this.shimmerHP.connect(this.panner); // sparkle skips the lowpass, goes to fx
    this.shimmerFlutter = gain(1); this.shimmerFlutter.connect(this.shimmerGain);
    this.flutter = lfo(0.23, 0.35, this.shimmerFlutter.gain);

    // ---- voices ----
    this.notes = notes.slice();
    this.voices = notes.map((m, i) => {
      const f = midiToHz(m);
      const sA = osc('sawtooth', f), sB = osc('sawtooth', f), tri = osc('triangle', f);
      const oct = osc('triangle', f * 2), sh = osc('sine', f * 4);
      this.detuneSrc.connect(sA.detune); this.detuneNeg.connect(sB.detune); this.drift.g.connect(sB.detune);
      for (const o of [sA, sB, tri, oct, sh]) this.vib.connect(o.detune);
      sh.detune.value = (i - 2) * 4;
      const g = gain(i === 0 ? 1.15 : 0.85); // bass voice a bit stronger
      const gt = gain(1.3);
      sA.connect(g); sB.connect(g); tri.connect(gt); gt.connect(g); g.connect(this.voiceBus);
      oct.connect(this.octaveGain);
      if (i > 0) sh.connect(this.shimmerFlutter);
      return { sA, sB, tri, oct, sh };
    });

    // ---- drone floor (always on, under the swell, outside the filter) ----
    this.droneGain = gain(0); this.droneGain.gain.setTargetAtTime(0.085, t, 1.2);
    const droneLP = ctx.createBiquadFilter(); droneLP.type = 'lowpass'; droneLP.frequency.value = 520;
    const d1 = osc('triangle', midiToHz(DRONE_MIDI));
    const d2 = osc('sawtooth', midiToHz(DRONE_MIDI + 7)); d2.detune.value = 3;
    const d2g = gain(0.35);
    d1.connect(droneLP); d2.connect(d2g); d2g.connect(droneLP); droneLP.connect(this.droneGain);
    this.droneGain.connect(this.dry); this.droneGain.connect(this.sendBus);
    // sub: an octave under the drone, its level a continuous function of the floor (shoulders)
    this.subGain = gain(0); const sub = osc('sine', midiToHz(DRONE_MIDI - 12)); sub.connect(this.subGain); this.subGain.connect(this.dry);

    // ---- beat (density from the groove binding) ----
    this.beat = new BeatSynth(ctx, this.sat, this.sendBus);

    // ---- chime stimulus: its own bus + analyser tap (the audible probe reads THIS, not the master) ----
    this.chimeBus = gain(0.5); this.chimeTap = ctx.createAnalyser(); this.chimeTap.fftSize = 1024;
    this.chimeBus.connect(this.chimeTap); this.chimeBus.connect(this.dry); this.chimeBus.connect(this.sendBus);
    this.chimes = 0;

    // ---- OPTIONAL vowel formants + master tint: created LAST (every earlier node id is unchanged), and
    // transparent at rest (peaking / shelf filters at 0 dB gain pass the signal unchanged).
    const peak = (f, q) => { const b = ctx.createBiquadFilter(); b.type = 'peaking'; b.frequency.value = f; b.Q.value = q; b.gain.value = 0; return b; };
    const shelf = (type, f) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = 0; return b; };
    this.vowelF1 = peak(300, 6); this.vowelF2 = peak(2300, 8);
    this.wah.disconnect(this.phIn); this.wah.connect(this.vowelF1); this.vowelF1.connect(this.vowelF2); this.vowelF2.connect(this.phIn);
    this.tintLo = shelf('lowshelf', 250); this.tintHi = shelf('highshelf', 3000);
    this.comp.disconnect(this.master); this.comp.connect(this.tintLo); this.tintLo.connect(this.tintHi); this.tintHi.connect(this.master);
    // ---- OPTIONAL duck under speech (sound/duck.js): created after the tint (earlier node ids unchanged), unity at rest
    this.ducker = new Duck(ctx);
    this.tintHi.disconnect(this.master); this.tintHi.connect(this.ducker.input); this.ducker.connect(this.master);
    // ---- peak guard (sound/master.js PeakGuard): a true-peak rider at -3 dBFS + a soft ceiling at -1 dBFS between the
    // master gain and the analyser. Created last; exactly transparent while the signal stays under -3 dBFS.
    this.guard = new PeakGuard(ctx);
    this.master.disconnect(this.analyser); this.master.connect(this.guard.input); this.guard.listen(this.master); this.guard.connect(this.analyser);

    this.current = {};
    this.setReverbWet(MAPPINGS.reverbWet.rest, 0.01);
    this.setTrip(MAPPINGS.trip.rest, 0.01);
  }

  // A bell on the key (D): inharmonic partials, each with its own decay. Returns the audio-clock fire time.
  chime({ midi = 74, at = 0, level = 1 } = {}) {
    const ctx = this.ctx, t = Math.max(ctx.currentTime, at || 0) + 0.005, f = midiToHz(midi);
    for (const [ratio, amp, dec] of [[1, 0.5, 3.2], [2.0, 0.22, 2.2], [2.76, 0.16, 1.6], [5.4, 0.08, 0.9], [8.93, 0.04, 0.5]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * ratio;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp * level, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dec);
      o.connect(g); g.connect(this.chimeBus); o.start(t); o.stop(t + dec + 0.05);
    }
    this.chimes++;
    return t;
  }
  #rmsOf(an) {
    const a = new Float32Array(an.fftSize); an.getFloatTimeDomainData(a);
    let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  }
  chimeRms() { return this.#rmsOf(this.chimeTap); }

  setReverbWet(w, tc) {
    const t = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(w * 1.15, t, tc);
    this.dry.gain.setTargetAtTime(1 - w * 0.5, t, tc);
  }

  // the trip macro (0..1): depth + speed of everything that moves
  setTrip(v, tc) {
    const t = this.ctx.currentTime, to = (p, x) => { p.cancelScheduledValues(t); p.setTargetAtTime(x, t, tc); };
    to(this.phLfo.g.gain, 350 + 1500 * v);             // phaser sweep, cents
    to(this.phLfo.o.frequency, 0.05 + 0.28 * v);       // phaser speed, Hz
    to(this.phWet.gain, 0.2 + 0.55 * v);               // notch depth
    to(this.chModL.g.gain, 0.0012 + 0.0042 * v);       // chorus depth, s
    to(this.chModR.g.gain, 0.0012 + 0.0042 * v);
    to(this.chModL.o.frequency, 0.22 + 0.6 * v);
    to(this.chModR.o.frequency, 0.29 + 0.7 * v);
    to(this.chWet.gain, 0.35 + 0.45 * v);
    to(this.breath.g.gain, 160 + 640 * v);              // filter breath, cents
    to(this.breath.o.frequency, 0.04 + 0.12 * v);
    to(this.echoSend.gain, 0.08 + 0.42 * v);           // movement opens the echo
    to(this.wobble.g.gain, 0.003 + 0.006 * v);
  }

  // MIDI notes [bass, 4 upper] from voiceLead(); bass moves quicker than the upper voices.
  setNotes(notes, tc = CHORD_GLIDE) {
    const t = this.ctx.currentTime;
    notes.forEach((m, i) => {
      if (this.notes[i] === m) return;
      const v = this.voices[i], f = midiToHz(m), g = i === 0 ? BASS_GLIDE : tc;
      for (const [o, mul] of [[v.sA, 1], [v.sB, 1], [v.tri, 1], [v.oct, 2], [v.sh, 4]]) {
        o.frequency.cancelScheduledValues(t); o.frequency.setTargetAtTime(f * mul, t, g);
      }
    });
    this.notes = notes.slice();
  }

  // targets/glides from computeTargets() + living bindings; only re-schedules when a value really changes.
  apply(targets, glides) {
    const t = this.ctx.currentTime;
    const changed = (key, v) => {
      const prev = this.current[key];
      if (prev !== undefined && Math.abs(prev - v) < 1e-4 * (Math.abs(v) + 1)) return false;
      this.current[key] = v; return true;
    };
    this.ducker.tick(t); // duck follower / timed holds (no-op at rest: schedules nothing)
    this.guard.tick(t); // peak rider (schedules nothing while the true peak is under -3 dBFS)
    if (this.spaceDriver) targets = this.spaceDriver.transform(targets); // continuous v-space (only after pad.space())
    const glideTo = (p, v, tc) => { p.cancelScheduledValues(t); p.setTargetAtTime(v, t, tc); };
    // ONE generic loop over the APPLY table (same order as before => identical call log). A target the table does
    // not know is ignored; a target absent from `targets` is not touched (so new targets are opt-in, e.g. vowel).
    for (const [key, a] of APPLY) {
      const v = targets[key];
      if (v == null && !a.always) continue;
      if (a.always) { a.fn(this, v, glides, t); continue; }
      if (!changed(a.as ?? key, a.map ? a.map(v) : v)) continue;
      if (a.fn) a.fn(this, v, glides, t, glideTo);
      else for (const p of a.params(this)) glideTo(p, a.map ? a.map(v) : v, glides[a.glide ?? key]);
    }
  }

  // The continuous sound space (sound/engine.js, SOUND-ARCH.md). Opt-in and additive: until space() is called the
  // Pad is exactly the step2 pad. space(opts) returns the driver (steer / setPhaseBias / snapshot); sense(inp) runs
  // once per frame with the shared inputs (body -> axes, slew, generated drums). Without a driver, sense() is a no-op.
  space(opts) {
    if (!this.spaceDriver) { this.spaceDriver = new SpaceDriver(this, opts); if (this.phaseName) this.spaceDriver.phase(this.phaseName); } // a phase seen before space() still leans
    return this.spaceDriver;
  }
  sense(inp) { return this.spaceDriver ? this.spaceDriver.sense(inp) : null; }

  // Duck under speech (sound/duck.js). Transparent until used. duck(a) sets a level 0..1; duckFor(s) holds a timed
  // duck that releases itself; duckSay({text, spoken}) is the bus 'say' fallback key (spoken lines only);
  // voiceKey(node) follows the voice output itself (preferred: it hears what actually plays). Returns a detach fn.
  duck(amount = 1) { this.ducker.set(amount); }
  duckFor(seconds, amount = 1) { this.ducker.hold(seconds, amount); }
  duckSay(ev) { if (ev?.spoken) this.ducker.hold(speechSeconds(ev.text)); }
  voiceKey(node) { return this.ducker.key(node); }

  // Transition swells (sound/swell.js). Feed it every bus 'phase' event ({name, by}); the first phase and the boot /
  // dev-reset re-boot are not changes, so they only set the reference. A lift into a livelier phase, a settle into a
  // calmer one; the arrival lands on a bar line when the generated beat is on. Nothing is built before the first swell.
  // ONE entry for bus 'phase' (#4 + #6): the transition swell, and the phase lean on the space (only if pad.space()).
  phase(ev) { const r = this.phaseSwell(ev); this.spaceDriver?.phase(ev?.name ?? ev); return r; }
  phaseSwell(ev) {
    const name = ev?.name ?? ev, from = this.phaseName ?? null; this.phaseName = name;
    if (ev?.by === 'boot') return null;
    const plan = swellPlan(from, name); if (!plan) return null;
    if (!this.swellFx) this.swellFx = new Swell(this.ctx, { dry: this.dry, send: this.sendBus });
    const d = this.spaceDriver, quant = d?.beatOn ? { nextBar: d.nextBar, barDur: d.barDur } : null;
    return this.swellFx.play(plan, { quant });
  }

  // freeze / thaw: the audio clock stops, so every glide and LFO resumes exactly where it was
  suspend() { return this.ctx.suspend(); }
  resume() { return this.ctx.resume(); }

  // live (gliding) values read back from the audio graph
  live() {
    return {
      cutoff: this.cutoffSrc.offset.value,
      detune: this.detuneSrc.offset.value,
      shimmer: this.shimmerGain.gain.value,
      pan: this.panner.pan.value,
      swell: this.swell.gain.value,
      octave: this.octaveGain.gain.value,
      reverbWet: this.wet.gain.value / 1.15,
      trip: (this.echoSend.gain.value - 0.08) / 0.42,
      feedback: this.fbL.gain.value,
      field: this.field.pan.value,
      resonance: this.filter.Q.value,
      wah: this.wah.frequency.value,
      wahDepth: this.wah.gain.value,
      floor: this.droneGain.gain.value,
      vibrato: this.vib.gain.value,
      tremolo: this.tremAmt.gain.value * 2,
      modRate: this.mod.frequency.value,
      beat: this.beat.density,
      beatHits: this.beat.hits,
      notes: this.notes.slice(),
      ...(this.spaceDriver ? { space: this.spaceDriver.snapshot() } : {}),
      ...(this.ducker.used || this.ducker.analyser ? { duck: this.ducker.snapshot() } : {}),
      ...(this.swellFx ? { transition: { count: this.swellFx.count, last: this.swellFx.last } } : {}),
      guard: this.guard.snapshot(),
      time: this.ctx.currentTime,
    };
  }

  rms() { return this.#rmsOf(this.analyser); }
}
