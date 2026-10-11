---
status: draft
priority: later
---

# Automation

**Status:** Design only (2026-08-05). The shape below was settled in a
design discussion; no implementation is started or committed. The doc
exists so the decided parts don't get re-litigated when the work begins.

**Goal:** parameters change over time — fader rides, filter sweeps, pan
drift — authored declaratively in project YAML, rendered
deterministically through the build graph, and evaluable in real time by
the audio engine when live playback needs them.

## 1 The landscape

Breakpoint automation lanes are universal — every DAW has them.
LFO-as-modulator is not universal, but it is the clear direction of the
modern generation:

- **Logic**: breakpoint lanes only; the Modulator MIDI FX can wiggle
  MIDI-controllable parameters, but it is bolted on, not a modulation
  system.
- **Ableton**: automation (absolute breakpoints) is distinct from
  modulation (relative clip envelopes, unlinkable so they loop at their
  own length — a poor man's LFO); arbitrary-parameter LFOs arrive only
  via the Max for Live LFO device, one of the most-installed M4L devices
  in existence.
- **Bitwig**: the modulation-first design — LFOs, envelopes, random,
  macros attach to any parameter as first-class citizens.
- **Reaper**: built-in parameter modulation (LFO + audio follower on any
  FX parameter). **FL Studio**: an LFO tool directly on automation
  clips.

Conclusion: breakpoints are table stakes; first-class generators are
where DAWs are heading, not an exotic detour. And the hard part of a
universal modulation system — realtime routing and lane UI — is exactly
the part Field's declarative model sidesteps.

## 2 Decisions (DECIDED, 2026-08-05)

1. **Two authoring layers, one compile target.** Breakpoint curves and
   generators both resolve to the same control signal when evaluated —
   the renderer sees a parameter value as a function of time and never
   knows which spelling produced it. Rejected: breakpoints-only (the
   Logic position) — an LFO is four diffable YAML fields where the baked
   equivalent is a hundred breakpoints no diff can read; and
   generators-only — a hand-drawn ride is irreplaceable, and breakpoints
   are what every migration path (DAW import, recorded fader moves)
   produces.
2. **Control rate only; audio-rate modulation is SuperCollider's job.**
   Field automation modulates *parameters*, not samples. Anything that
   wants audio-rate modulation — FM, ring-mod textures, sample-rate
   signal routing — belongs in an `.scd` recipe on the sc-render path
   (or, later, live SC). This keeps the automation model small and puts
   the complexity where a real signal language already lives.
3. **Curves are pure functions of time, so offline and realtime cannot
   disagree.** A breakpoint curve or generator is deterministic and
   stateless — value = f(position) through the tempo map, no feedback,
   no dependence on evaluation history. The offline render evaluates the
   same definition the realtime engine
   ([audio-engine.md](../../audio-engine.md)) will evaluate when live
   playback and the recording era arrive: realtime is a second
   *consumer*, never a second *implementation*. This is a standing
   constraint on every generator admitted to the union: if it cannot be
   evaluated statelessly at an arbitrary transport position (locate,
   loop wrap), it does not get in.
4. **Generators are a discriminated union, like inserts.** `lfo` first —
   shape, rate, depth, phase — with seeded random and friends joining
   additively later (the `effect:`/`insertSchema` precedent). Musical
   rates use musical time arrays ([musical-time.md](../musical-time/readme.md)):
   `rate: [1]` is one cycle per bar, grid-locked through the tempo map
   the way `loop.every` is. Envelope followers are deliberately *not* on
   the list: a follower is a function of the audio signal's history, not
   of time — the §2.3 admission test's first catch. Offline it would be
   easy and realtime it is running state, the first step toward the
   signal-graph runtime this design refuses to become; it lives on SC's
   side of the boundary unless a later decision record admits it as
   offline-only.
5. **Realtime cost is bounded and small — this is not SC.** Per audio
   block: sample position → musical position (the tempo map), one
   binary-search-plus-lerp per breakpoint lane or one closed-form
   oscillator evaluation per LFO, a standard anti-zipper smoother per
   parameter. No signal graph, no buses, no modulator-of-modulator
   routing, no dynamic node creation — targets are fixed parameter
   addresses declared in YAML. Every shipping DAW's realtime automation
   is this exact shape; the realtime era's hard costs (AU hosting, delay
   compensation) exist with or without automation.

## 3 Open questions

1. **Stage mapping.** Insert parameters bake into stems (content — the
   [effects.md](../effects/readme.md) §5 cost model), but fader/pan curves should
   likely live at the *mix* stage like static `gain_db`/`pan` do, so
   riding a fader re-runs only the cheap sum and never invalidates a
   stem. Leaning yes; decide when speccing.
2. **Attachment points.** Track lanes (Logic-style), clip envelopes
   (Ableton-style), or both — and whether curves live in the track file
   or the reserved `automation/` song directory
   ([project-model.md](../../project-model.md)).
3. **Control interval.** Offline render could evaluate per-sample;
   realtime wants block-rate. Whether the contract fixes an interval so
   render and live playback match exactly, or tolerates divergence
   within recipe-reproducibility
   ([build-graph.md](../../build-graph.md) "Determinism policy").
4. **v1 parameter set.** Which parameters are automatable first — insert
   params, clip gain, mix faders — and what the action-key impact of
   each is.
5. **Where the tempo map runs** (added 2026-10-10). Decision 5 has the
   engine convert sample position to musical position every block, but
   the daemon never learns what a bar is: positions arrive as samples
   (playback.md §3.6, realtime.md §1). Realtime curves either compile
   to the sample domain in the CLI, which matters for tempo-locked LFOs,
   or a new decision admits the tempo map to the daemon. Settle this
   before speccing, and amend decision 5 with the answer.
