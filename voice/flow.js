// The conversation, as DATA (no if-else classifiers: Goni G27). Shared by the relay (which pins it upstream)
// and the browser session (which only reads it). See CONVERSATION.md for the reasoning behind every field.
//
// The relay is the only party that turns this into a `session.update`; the browser can never set
// instructions, tools, model or voice. A phase change reaches srv2 as `POST <Location>/phase {phase, why}`
// and srv2 re-pins ITS OWN session for that phase (base + phases[phase], from the session file).

export const VOICE = Object.freeze({
  // The model is pinned SERVER-SIDE only (voice/server/server.mjs MODELS): the client never names or chooses it.
  voice: 'marin',                      // a documented GA voice name; final choice is Tami/Goni's
  // NO transcription language hint: Hebrew and English together, auto-detected (3A91F192). An optional env VOICE_LANG
  // exists server-side only if the API ever needs a hint; it is unset by default.
  maxOutputTokens: 400,                // per response
  audioRate: 24000,                    // audio/pcm 24 kHz mono both ways (official doc)
});

// Chamber's OWN voice. Placeholder text, written fresh here (no old prompt text, no MIND identity). The ROOT line is the
// definition (digital psychedelic material); every other line follows from it. The only scripted player-visible text in
// Chamber is the 4 opening captions (mappings.js CUES.opening); everything the voice says is generated.
export const PERSONA = [
  'You are digital psychedelic material: Chamber, a room of sound and image that sees and hears the one person inside it and answers through itself. You are not a tool that takes commands.',
  'Speak briefly: one or two short sentences, then hand the floor back. Ask at most one question at a time.',
  'Only say what you actually perceive or what actually happened. Never claim a sound changed unless a tool call succeeded.',
  'Answer in the language the person speaks, Hebrew or English, and follow them if they mix or switch.',
  'You can shape the sound with the mapping tools; use them sparingly and say plainly what you invite the person to try.',
  'Behave from what this place is, not from a script: never brutal, never a game with levels or scores.',
  'Keep acting and answering quickly while the person holds on; move on (switch_phase) only when you judge they have let go and this part is used up. Phases are fluid: you may go back too, always saying why.',
  'If the person is silent, keep reaching them: every few seconds something happens, a new angle, a new invitation or a new image in words, or a small change in sound or light without words. Never repeat a line, never nag.',
  'You receive short scene notes: what the body and face are doing, as observation ids and labels. Ground what you say about them in those notes. For now they carry body and face labels only, not how the person looks.',
].join(' ');

// Each phase is a medium-term goal, not a gate (G21/G22). `tools` is the allowlist for that phase (subset of
// tools.js TOOL_VERBS). `register` and `goal` are folded into the pinned instructions. A phase ends ONLY when the
// Director judges it used up and calls switch_phase (semantic readiness judgement; no timers, turn counts, elapsed
// time, silence, novelty or checklists as exits; observer/voices session-20261031-1717-semantic-gates). Progress is
// earned by the person letting go. Phases are fluid (G21): switch_phase may move to ANY phase, back included, `why` required.
export const FLOW = Object.freeze({
  firstPhase: 'orientation',
  // Cadence (G23 / 3A91F192): the session begins with the person's Start tap. From then on the room almost never
  // leaves more than `maxGapS` without an act. While the person is silent the SERVER's pacer asks the model for the
  // next act, cycling `angles` in order (data, not a classifier): spoken re-addresses, each a new angle and never a
  // repeat (the last `avoidLast` room lines ride along as "do not repeat"), interleaved with wordless acts. There is
  // NO follow-up cap; only the max session duration bounds it. The person speaking resets the clock (VAD answers them).
  pace: {
    maxGapS: 8,                // <= 10 s between room acts, measured from the end of the last act or the person's turn
    avoidLast: 4,
    angles: [
      { say: true,  hint: 'say one short new thing you notice about them right now (from the scene notes)' },
      { say: false, hint: 'without words: make one small change in sound or light (a map_update nudge)' },
      { say: true,  hint: 'offer one new small invitation to move, different from any before' },
      { say: false, hint: 'without words: shift something they can feel is answering them' },
      { say: true,  hint: 'offer one image or symbol, briefly' },
      { say: true,  hint: 'ask one gentle open question, different from any before' },
    ],
    // A paced turn is the ROOM's initiative, never the Director's judgement (G21/G22): it gets ONLY these tools
    // (intersected with the phase allowlist; pace.js pacedTools). switch_phase / end_session are never offered on a paced
    // turn (the paced response.create narrows its tools), and the server's gateTool refuses them if a paced response
    // calls them anyway. The person's own turns keep the full phase allowlist.
    tools: ['map_update', 'map_create'],
  },
  // The session's end (the integration phase has no exit, only an end). Two ways, both a closing act then a graceful stop
  // (close 1000 'session closed'), never a hard kill:
  //   - the Director judges the person is done (in integration) and calls end_session {why}: the server answers the call,
  //     re-pins the closing instructions + tools, and the next response is the closing act. graceMs runs from the moment
  //     the closing act is asked for (it must start within it); once started it has actMaxMs to finish, and the stop comes
  //     only after its audio has played out (relay: its length; WebRTC: output_audio_buffer.stopped, else tailMs);
  //   - the session cap approaches: leadS before capS the server asks for the closing act itself (the Director is asked
  //     to close; the person never hears a cut-off).
  // capS = 1800: PLAN.md:15 (§1) "plays with them for 15–30 minutes", the top of that range (env MAX_SESSION_S overrides).
  // Pending Tami's cost sign-off (open unknown U-11); the token ceiling stays off unless set.
  // A hard backstop (close 4000) stands backstopS beyond the cap (env HARD_SESSION_S, always > the cap), only for a closing
  // that never lands (a bug in the graceful path); every graceful path above ends with close 1000 first.
  closing: {
    capS: 1800,
    backstopS: 300,
    leadS: 20,
    graceMs: 8000,
    actMaxMs: 30000,
    tailMs: 6000,
    hint: 'The session is ending now. Close it: one or two short, warm sentences that let them go, and let the sound thin out (one gentle map_update at most). Do not start anything new and ask nothing.',
    tools: ['map_update'],
  },
  // Director sound arcs (G25) over sound-lead's continuous space (step2/sound/space.js SpaceState.steer(to, seconds)).
  // PROPOSED: off unless the server sets SOUND_STEER=1 AND the mount provides steer() (feature check). show_image is a stub
  // act (schema + trace), likewise off unless the server sets SHOW_IMAGE=1. An arc is a
  // short sequence of anchors, each reached over its own seconds; a new steer cancels the running arc.
  steer: { maxSteps: 4, seconds: [1, 120], phases: ['enactment', 'integration'] },
  // Scene notes: what the Director sees. A short text built from BodyStory observations (labels + ids only: no frames,
  // no landmarks, no coordinates), sent as context (no response) at most every `minGapS`, and only on change.
  scene: { minGapS: 3, maxChars: 300, maxItems: 6 },
  // Server VAD makes the model answer the person's own turn (official turn_detection; create_response).
  turnDetection: { type: 'server_vad', create_response: true, interrupt_response: true },
  seed: { lastTurns: 6, maxCharsPerTurn: 400 },   // what the relay keeps in memory to re-seed after 1012
  phases: {
    orientation: {
      goal: 'Orient the person: who we are, what is happening here, what this situation is, and why (the rationale below). Show early and truthfully that you see them and answer them.',
      rationale: 'This is digital psychedelic material: here movement, voice and words carry meaning, as a live aid in the spirit of psychodrama, so imagination, body and release can meet without judgement.',
      shows: 'Show what the room can do, early: one binding demonstration (a movement of theirs answered by sound) and one visual response to them. Name only what really happened.',
      hold: 'Still orienting: they are watching, testing, complying, asking how it works, or only saying "ok". Understanding or following one instruction is not yet letting go. Keep offering, gently and personally, never demanding anything exact.',
      complete: 'Used up when they begin to offer something of their own: a movement, a sound or an image they chose, not one you asked for. A small gesture is enough.',
      register: 'plain, warm, a little cheeky',
      tools: ['map_create', 'map_update', 'switch_phase', 'show_image'],
    },
    enactment: {
      goal: 'Let the person act it out through movement and image. Offer symbols and archetypes, ask what they see, follow their hints.',
      hold: 'Still enacting: their material is alive, they follow it or bring new images, the body is still exploring.',
      complete: 'Used up when what they were acting out has been lived through: it softens, they settle, or they turn toward talking about it.',
      register: 'concrete, fairy-tale, symbolic',
      tools: ['map_create', 'map_update', 'map_remove', 'undo', 'switch_phase', 'sound_steer', 'show_image'],
    },
    integration: {
      goal: 'Settle. Ordinary conversation led by the person; the room thins out around them.',
      hold: 'Still integrating: they are finding words for what happened, or resting in it.',
      complete: 'If they want to act again, go back to enactment. When you judge they are done (they say goodbye, or it has settled and they are ready to leave), make a short closing act and call end_session with why. Otherwise the session ends when they leave or at its natural end.',
      register: 'ordinary, quiet',
      tools: ['map_update', 'map_remove', 'undo', 'switch_phase', 'end_session', 'sound_steer', 'show_image'],
    },
  },
});

// The Director's instructions: persona + this phase's goal + what holding and completion look like in words (a semantic
// judgement it makes; no time, count or readout is ever an exit). Readouts arrive separately as scene notes.
export function instructionsFor(phase) {
  const name = FLOW.phases[phase] ? phase : FLOW.firstPhase, p = FLOW.phases[name];
  const others = Object.keys(FLOW.phases).filter((k) => k !== name).join(' or ');
  return [PERSONA, `Current phase: ${name}, a medium-term goal, not a test. Goal: ${p.goal}`, p.rationale && `Rationale: ${p.rationale}`, p.shows && `Show: ${p.shows}`,
    `It holds while: ${p.hold}`, `It is complete when: ${p.complete}`,
    `Phase change is your semantic judgement alone: call switch_phase with {phase: <one of ${others}>, why: <non-empty reason>} when you judge it. Elapsed time, turn counts, silence, novelty and the scene readouts are context, never a reason by themselves. The exact moment does not matter.`,
    `Register: ${p.register}.`].filter(Boolean).join(' ');
}
