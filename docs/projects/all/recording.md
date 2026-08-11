---
status: Draft
---

# Plan: Recording

**Goal:** `field record` — capture a live performance into a track as
takes, through the same daemon that plays: armed, crash-safe,
latency-placed, and committed beside its bytes the way every take
already is.

## 1 Shape

- The second real-time phase. [playback.md](playback.md) built the
  daemon, the socket, and the transport; this opens the input side of
  the same process. [audio-engine.md](../../audio-engine.md) holds the
  decisions already settled — the three simultaneous paths, host vs.
  Apollo-direct monitoring, explicit latency, transactional capture —
  and this plan builds the first slice of them rather than re-deciding
  any.
- A recorded take follows the variants shape (decided 2026-08-10,
  [project-model.md](../../project-model.md) "Takes"): the record —
  placement, device, latency, session context — lives beside the bytes
  under `audio/<name>/`, because the decision to commit the audio must
  be the decision to commit its record. §3 makes that concrete.
- A recording track is the generative pattern with a human where the
  model was. `tracks/lead-take.yaml` carries a `generative:` entry and
  its performances land beside it; a `record:` entry asks for yours.
  Everything downstream — the chosen take, the resolver, placement by
  parent tracks — is machinery that already exists and does not change.

## 2 Where the code stands

The seams this phase opens, verified against main (01d4fe6):

- The daemon opens the device output-only —
  `initialiseWithDefaultDevices (0, 2)` (player.cpp:146). Capture needs
  a duplex open, input-channel enumeration over the socket, and an
  input-capable null mode: the null clock is output-only today
  (512-frame blocks at 48 kHz, player.cpp:41), and CI exercises the
  whole protocol through it.
- Idle exit checks connection count and transport state and nothing
  else (main.cpp:108). An armed or recording daemon must refuse to
  idle-exit, or a take dies to a timeout.
- Feature detection is semver arithmetic in the client (play.ts:147
  splits `daemonVersion`; `--watch` gates the same way). Two gates was
  tolerable; recording adds several more, so §6 replaces the pattern
  before it spreads.
- No identifier or schema field carries the word "latency" — it left
  with the retired take schema (#132), surviving only in prose: two
  test comments about reverb tails (effect-properties.test.ts) and the
  reload doc comment on wrap latency (player.h:67), in the same header
  chunk 1 opens for the duplex device.
  [audio-engine.md](../../audio-engine.md) defines the vocabulary; this
  phase is where it becomes observable numbers instead of prose.
- `field click` is CLI-side TypeScript DSP (click.ts, 90 lines) and the
  sole production caller of the whole-file WAV codec. The count-in and
  metronome a tracking session needs belong in the engine's callback,
  which is what retires it (§7).

## 3 The take on disk

Generated takes today are numbered WAVs with `variants.yaml` beside
them binding bytes to recipe. Recorded takes mirror the shape
file-for-file — `audio/<name>/takes.yaml`:

```yaml
record: lead-vocal
chosen: 2
takes:
  - file: audio/lead-vocal/1.wav
    recorded_at: 2026-08-12T21:04:11.402Z
    at: [17]
    device: Apollo Twin X
    input: 1
    sample_rate: 48000
    latency: 142
    sha256: 9c1f0b537b698fcad138b45c34caf3d78af4f55ee1c808c81fe2365bc9ffdd41
  - file: audio/lead-vocal/2.wav
    recorded_at: 2026-08-12T21:06:38.114Z
    at: [17]
    device: Apollo Twin X
    input: 1
    sample_rate: 48000
    latency: 142
    sha256: 4694165412616825f04f89574e775687e3e887a11d2e5b05f625b3b3a8d7fed8
```

- `at` is the timeline position capture started against; `latency` is
  the samples the captured audio ran behind that position, as the
  device reported it. Together they are the whole placement story:
  playback compensates by exactly what capture recorded, and both
  numbers are inspectable forever. The exact compensation arithmetic
  (input vs. round-trip, and a loopback measurement to check the
  device's claim) is settled in the first chunk against real hardware,
  not in this plan.
- Bytes stay pure: the file is what the converter produced, at the
  device's rate. If the track renders at another rate, the edge
  converts ([multi-rate.md](multi-rate.md) decision 4) exactly as for
  any other source — no resample at finalize, ever.
- `chosen` means what it means for variants, and `field choose` moves
  it the same way.

## 4 Arming: the record entry

The committed half is one entry, mirroring `generative:`:

```yaml
# tracks/lead-vocal.yaml
name: lead-vocal
inputs:
  - record:
```

The entry is the anchor: it marks the track as one that records, gives
the takes a place to attach (`takes.yaml` names it back, as
`variants.yaml` names its gen), and lets parent tracks place the track
now so the performance lands somewhere the moment it exists. The
payload is empty on purpose — device and input are local state
(playback.md §3.4: a committed device name breaks on clone), and no
other field has earned its place yet. Candidates that may earn one
later, shown only to record what was considered: a named input a
committed `hardware/` file binds per machine (the story playback.md
§3.4 deferred to this phase), `count_in`, a punch region. Each starts
as a CLI flag and moves into the entry only if committing it proves
out.

## 5 Capture in the daemon

- The duplex open happens when arming asks for it, not at spawn:
  playback-only sessions keep today's output-only open, so the macOS
  microphone-permission prompt appears the first time someone actually
  records, not the first time they play.
- Recording is transactional, as audio-engine.md decided:
  `.field/recording/<transaction-id>/` holds a manifest, a journal, and
  audio in recoverable chunks. A normal stop finalizes into
  `audio/<name>/<n>.wav` plus a `takes.yaml` row; a crash leaves the
  transaction behind, and the next daemon spawn reports it so the audio
  can be recovered into a take.
- Armed or recording pins the daemon open — the idle check learns two
  new states.
- The null mode grows an input side (silence, or a marker tone tests
  can assert on), so the whole path — arm, record, journal, finalize —
  runs deviceless in CI.

## 6 Transport and protocol surface

- New verbs: `arm(track, input)` / `disarm`, `record(at)`, `stop`
  finalizing the take; `status` gains the recording state and the
  armed input; a meter event stream arrives at a modest rate for the
  CLI to draw.
- `hello` grows `features: ["reload", "record", …]`, and the client
  gates on names instead of parsing `daemonVersion`. The two existing
  semver gates migrate; the version string stays for humans in
  `transport status`.
- `field record` blocks like `field play` blocks: ctrl-c stops and
  finalizes, matching the muscle memory, and `field transport` reaches
  the same state from anywhere.

## 7 Count-in and click, engine-side

The daemon still never learns what a bar is (playback.md §3.6). The
CLI projects the tempo map into a click *schedule* — sample positions
with accent flags — and hands it over the socket; the engine
synthesizes the ticks in the callback, sample-accurate against the
same clock the capture uses. Count-in is the schedule starting before
`at`. This retires click.ts's offline DSP and its whole-file WAV
codec use; `field click` stays as a command, now asking the engine.

## 8 Monitoring

V1 monitoring is Apollo-direct, configured manually in Console, and
capture is dry — both already decided in audio-engine.md. This plan
builds no monitor path. Host monitoring (input through Field's engine
and effects, with the latency policy beside it) is real future work
and stays out of scope here.

## 9 Definition of done

While the built mix loops, `field record creek/lead-vocal --at 17`
captures a take against it; a mid-take kill loses nothing recoverable;
stop lands numbered bytes and their record beside them; and the next
`field build && field play` plays the chosen take in place —
compensated, so what comes back sits where it was sung.

## 10 Chunks

1. **The input side** — duplex and null-input open, input enumeration,
   arm/record/stop verbs, transactional capture with journal and crash
   recovery, idle-exit pinning, `features` in hello with the two semver
   gates migrated.
2. **The take lands** — finalize into `audio/<name>/` + `takes.yaml`,
   the `record:` entry and its schema, resolver arm for recorded takes,
   latency-compensated placement verified by loopback on real hardware,
   blocking `field record`.
3. **Count-in and click** — the click schedule over the socket, engine
   ticks, click.ts retired.
4. **Punch and loop takes** — punch in/out against a region, loop
   cycles landing one take each. Comping — one active take assembled
   from several — is part of the recording work
   (project-model.md "Takes") but big enough to plan when we reach it,
   informed by how takes actually accumulate.

## 11 Open questions

- The record entry's spelling: bare `- record:` (null payload) as
  above, or `- record: {}`? Both are honest about carrying nothing;
  pick the one that reads better in a real track file.
- The record file: `takes.yaml` with a `takes:` list as above, or reuse
  the `variants.yaml` name and `variants:` key so both kinds of take
  share one filename? Separate names say what happened; one name says
  they are the same machinery.
- Does stop auto-choose the new take, the way generation chooses its
  first variant? Tracking says yes — you want to hear what you just
  sang; a later take overwriting your chosen comp says no.
- Are meters needed for the V1 CLI, or is the widget their first real
  consumer?
