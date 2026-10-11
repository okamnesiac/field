---
status: in-progress
priority: now
---

# Live SuperCollider

**Goal:** the voice `field keys` plays reaches the daemon's live graph as
an input on its MIDI track, so the inserts on that track and on every
track above it process what you play, as they process the track's takes.

## 1 Problem

`field keys` plays an instrument in its own `scsynth`, which writes
straight to the output device
([keyboard-instrument.md](../keyboard-instrument/readme.md) §2.6). A
track's inserts run inside `field-audiod`. So when you arm a MIDI track
under a bus with an EQ ([arming.md](../arming/readme.md) §2.1), you hear
the instrument dry, and `field keys` says so.

Two things in the daemon stand in the way, not one:

- **Nothing carries audio between Field's processes.** There is no
  shared memory, pipe, or socket carrying audio anywhere in `native/`,
  `src/`, or `sc/`; IPC is NDJSON over a Unix socket and OSC to
  `scsynth` (`docs/architecture.md`).
- **A live session renders every track but the output track ahead of
  time.** `native/audiod/src/live.h` describes the engine as
  "just-in-time offline rendering": every source is a committed or
  built file, so a non-output track renders in full when the session
  loads (`live.cpp` `produceUntil`), and only the output track mixes
  and runs its chain per block (`renderBlock`, `runChain`). A voice
  played by hand has no future to render, so the tracks between it and
  `main` cannot be pre-rendered.

`docs/build-graph.md` already classes "a SuperCollider node played by
hand" as live-only, never cached, and `realtime/readme.md` expects that
"capture becomes an input node… monitoring falls out of the same
callback". This plan builds the input node and the live tracks it
needs, and the transport that brings the voice to it.

## 2 Solution

A live session gains an `input` window kind: a source the daemon reads
each block from outside the session. Every track on the path from an
input up to `main` becomes a *live* track, which mixes and runs its
chain in the audio callback instead of rendering at load; its siblings
fed only by files stay pre-rendered, and the freeze never collapses a
live track into a stem. The voice reaches the input through a shared
memory ring: a small `scsynth` plugin, `FieldOut`, writes the voice host's
output into it, and the daemon reads it with a jitter buffer and drift
correction. `field keys` asks the daemon to put an input on each armed
MIDI track and points the voice host at that ring instead of the device.

*Amended (2026-10-11, as built in chunk 1):* the tracks on an input's
path do not trade their pre-rendering for per-block evaluation, as this
section first said ("Every track on the path from an input up to `main`
becomes a *live* track, which mixes and runs its chain in the audio
callback instead of rendering at load"). The song renders exactly as
before, and the input travels beside it through a second instance of
each chain on its path, summed into `main` before `main`'s own chain.
§9 describes that overlay and why it replaced the first design. The
freeze still never collapses a track on the path.

### 2.1 Flow

1. You run `field keys creek/track:keys-bus`. Arming resolves it to the
   MIDI track `keys` under it (arming.md §2.1).
2. `field keys` asks the daemon for a live input on `keys`. The daemon
   creates a ring, loads the song's session if none is loaded, marks
   `keys`, `keys-bus`, and every track above them live, and answers with
   the ring's name.
3. The voice host plays into `FieldOut.ar(ring)` rather than `Out.ar(0)`.
   Its `scsynth` still runs on a device, the same one the daemon uses,
   so the two callbacks share a clock.
4. Each block, the daemon reads the ring into the input window, runs
   `keys`'s inserts, mixes it into `keys-bus`, runs the EQ, and so on up
   to `main`, beside the pre-rendered tracks.
5. With the transport stopped, the live tracks still run, so you can
   play over silence (§7 question 2). With it playing, you play over the
   song.
6. When `field keys` exits, the daemon drops the input and the live
   marking, and the session renders as before.

### 2.2 Shapes

| Shape | Change |
| --- | --- |
| Session window kinds (`src/audiod/session.ts`, `live.h`) | Adds `input`, naming a ring: `{kind: "input", ring, channels}`. |
| Live tracks (`live.cpp`) | A track with an input below it evaluates per block; `comp_delay` on its path becomes non-zero for the first time. |
| Freeze (`src/graph/live.ts`) | A track with an input below it is never collapsed into its stem. |
| Daemon protocol | `input` op: attach a ring to a track, answer its name; `input_close`. |
| Voice host | `FIELD_RING` in its environment: play into `FieldOut` instead of the device. |
| `FieldOut` (new, `native/sc-fieldout/`) | An `scsynth` UGen plugin writing its input into a POSIX shared-memory, single-producer, single-consumer ring. |

*Amended (2026-10-11, as built in chunk 1):* the input window is
`{input: <name>, gain_db, pan?}`, where the name is the source the
daemon resolves, a ring from chunk 2 on; the channel count is always
two, as every other window's. The "Live tracks" row is §9's overlay,
and `comp_delay` stays zero, because the overlay runs late by its own
chain latency instead of delaying the song.

## 3 Why this design

Three ways to bring the voice in were weighed:

- **A shared-memory ring from a `scsynth` plugin (chosen).** A crash in
  the voice cannot take the daemon down, it needs no third-party driver,
  and the voice host's interface stays as it is. It is the most new
  code: a native SC plugin built per platform, and a reader with a
  jitter buffer and drift handling.
- **The daemon hosting the voice.** No SuperCollider AU or VST3 exists,
  so this means embedding `libscsynth` with a driver the daemon pulls
  each block: one clock and sample-accurate MIDI, at the price of a
  patched SC build, synthesis inside the daemon's callback, and a GPLv3
  library beside JUCE. Rejected.
- **A loopback device the daemon captures.** BlackHole, or a Core Audio
  process tap on macOS 14.2 and later, extending `arm`'s duplex open to
  a persistent stereo input. The least SC work and the fastest
  prototype, but a third-party driver or a Mac-only API, its own clock,
  about three buffers of latency, and the microphone permission in the
  way. Kept as the fallback if §7 question 1 goes against the plugin.

The input window is built first and alone, because host monitoring of a
microphone (`docs/audio-engine.md` "Monitoring") needs exactly the same
live tracks with the capture input as the source.

## 4 Acceptance criteria

| # | Do | Expect |
| --- | --- | --- |
| 1 | In a session test, feed an `input` window a known signal under a track with an EQ and a limiter. | The output equals the offline render of the same signal through the same chain, within the limiter's tolerance. |
| 2 | Load a session with an input under `keys-bus`. | `keys`, `keys-bus`, and the tracks above them are live; a sibling fed by a file is still pre-rendered. |
| 3 | Run `field keys creek/track:keys-bus` where `keys-bus` has a 700 Hz lowpass, and play. | You hear the instrument through the lowpass; the instrument's line no longer says dry. |
| 4 | Measure the added latency: a click from the voice host to the device, through the ring and back out. | At most one daemon block plus one device buffer more than playing straight to the device. |
| 5 | Play for an hour. | No dropout or click from the ring running empty or full. |

## 5 Cost

The live path runs in the audio callback, so its cost is per block:
the chains of every live track, which today run once at load. A typical
path is the MIDI track and one or two buses, each with a few built-in
inserts. The ring adds one copy per block per input. Latency is the
jitter buffer, at least one of the larger of the two processes' blocks.

## 6 Rollout

1. **The input window and live tracks,** fed in tests by a synthetic
   source. Criteria 1 and 2.
2. **`FieldOut` and the daemon's reader,** with the jitter buffer and
   drift handling. Criteria 4 and 5.
3. **`field keys` through it.** Criterion 3.
4. **Host monitoring of a microphone** through the same live tracks,
   with the capture input as the source.

## 7 Open questions

1. **The transport.** The plan recommends the shared-memory ring.
   Justin decides between it and the loopback prototype before chunk 2.
   Taken as recommended (2026-10-11): Justin started the work without
   choosing otherwise, so chunk 2 builds the ring. Choosing the loopback
   prototype instead reopens this before chunk 2 lands.
2. **Playing with the transport stopped.** Live tracks running while the
   song is stopped need the callback to run with no playhead; the plan
   assumes they do. Justin confirms before chunk 3. Taken as assumed
   (2026-10-11), on the same start: chunk 3 runs the overlay and
   `main`'s chain while the song is stopped.
3. **Several armed tracks under one bus.** Each armed MIDI track gets its
   own input and ring, so a bus with two armed tracks sums two live
   inputs. Decided with arming.md chunk 3, which settles how armed
   tracks are held.

## 8 Background

The survey behind this plan, as the code stood on 2026-10-11:

- **Window kinds:** `file`, `track`, and `receive` (`src/audiod/session.ts`; `native/audiod/src/live.h`).
- **Insert kinds:** eq, limit, reverb, plate, hall, and hosted `plugin`.
- **Hosted plugins are inserts only,** with an empty `MidiBuffer`, so no instrument plugin exists to host a voice.
- **The recording input** reaches only the capture queue and the peak meter (`Player::processBlock`); no monitor path exists, because recording.md chose Apollo-direct monitoring for V1.
- **Changing a live session** swaps the whole session at a block boundary (the `session` op); there are no per-insert edits.
- **The voice host** runs `scsynth` with a hardware buffer of 128 frames; the daemon takes JUCE's default buffer.

## 9 The overlay

What an input reaches is evaluated per block beside the song rather than
in place of it. Each block, in the audio callback:

1. Each input window reads its source, one block of stereo.
2. Each track the input reaches, children first, mixes its inputs and
   the overlay blocks of the live tracks it reads, with each window's
   gain and pan, then runs a second instance of its own chain. A
   pre-tap cable reads the block before that chain.
3. Every feed into a track is first delayed to the track's longest
   incoming path. An input arrives at once, a pre-tap edge as late as
   what reached its child, and a post edge that plus its child's chain
   latency, so an input that reaches a track two ways, such as through
   a bus with a limiter and through a reverb send, never meets itself
   offset.
4. The chain's output passes through a delay preloaded with the chain's
   latency, its limiters' and hosted plugins' together, so every block
   is exactly one block, late by that latency. A limiter's stream lag
   varies from block to block; the delay absorbs it.
5. `main` adds what reaches it to its own mix of the song, and its own
   chain runs on the sum. The input reaches `main` late by its longest
   path's latency.

An input has no place on the timeline, so it passes through each
window's gain and pan but not its start, duration, or fades. It reaches
each track that reads its track once, through the first window that
does, however many times the arrangement places it. The overlay chains
keep their state across a locate, and the warmup a far locate renders
into the void reads no input, because a source read there would be
consumed off the audio thread. A gain ramp on a window the input passes
through glides the input with the song, sample by sample on the same
timeline. A session swap builds the overlay afresh in the new session:
the input goes silent for its path's latency and any tail its chains
were ringing stops. Chunk 3 swaps sessions under a playing input, and
decides there whether that gap is acceptable or the overlay's state
should carry across.

**Why not evaluate the path in place.** A track's content sits on a
timeline its placement offsets, and a track placed more than once would
need to be at several positions at once. creek places `phrase` three
times, so an input under `phrase` would have three "nows", and a
streaming chain can only be in one. The overlay keeps the song's
render untouched, and with it the golden equivalence the live engine
rests on.

**What it gives up.** Linear inserts (eq, reverb, plate, hall) give the
same result whether they process the song and the input together or
apart, and `main`'s chain processes the true sum. A limiter or hosted
plugin on a track between the input and `main` hears the input apart
from that track's own content, so it does not duck the song under your
playing. That is a monitoring difference only: a take recorded on the
track renders through the real chain.

**Limits in chunk 1.** An input's path stays at one rate, because the
overlay has no converter; a path that crosses rates is refused, by the
compiler and by the engine. Each input name appears once, and an input
must sit under `main`.

## 10 Progress

- 2026-10-11 — Chunk 1 (branch `live/input-window`). Session version 4
  adds the input window, `compileSession` takes `inputs` and keeps each
  input's path out of the freeze, and the engine runs §9's overlay.
  `field-audiod --render-live --input <name>=<file.wav>` feeds an input
  from a file, which is how `src/audiod/live-input.test.ts` proves
  criterion 1: the output equals the offline render of the same signal
  through the same chains, sample for sample, 145 samples late, the
  input track's limiter latency, for as long as the signal lasts. Past
  it the two part on purpose: the stem ends with its track's content and
  cuts an eq's ring there, and an input has no end, so the overlay rings
  out. The test found the compiler's limiter latency one sample short of
  the engine's window, which `insertLatency` now mirrors operation for
  operation. The review of the chunk found paths of unequal latency
  meeting offset, which step 3 now aligns; a second golden holds an
  input reaching `main` three ways, at 0, 145, and 290 samples, to the
  offline render late by 290, with the tone loud enough that all three
  limiters, `voice`'s, `crush`'s, and `main`'s, reduce gain. Criterion 2 holds in the compiled
  session: the input's track and the bus above it keep their chains,
  and a sibling fed by a file is served from its stem. The daemon's
  `session` op refuses an input window until chunk 2 gives it a source,
  so nothing outside the tests can attach one yet.
