---
status: in-progress
priority: now
---

**Outcome:** Chunk 1 shipped (2026-09-06): the daemon's input side —
arm, record, stop, the crash-safe transaction and its recovery — and a
`field record` that ends with a take under `.field/recording/`. Chunks
2–4 remain. Closes when a take recorded against creek on the Apollo
plays back in place, compensated, from `field build && field play`.

# Plan: Recording

Waited behind [realtime.md](../realtime/readme.md), whose live graph makes
capture an input node rather than a second transport (realtime.md §6);
realtime shipped its four chunks (#137–#143) and this proceeded.

**Goal:** `field record` — capture a live performance into a track as
takes, through the same daemon that plays: armed, crash-safe,
latency-placed, and committed beside its bytes the way every take
already is.

## 1 Shape

- The second real-time phase. [playback.md](../playback/readme.md) built the
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

  *Superseded 2026-09-06:* realtime chunk 2 built `features` in `hello`
  (#138 — the "whichever plan lands first builds it" clause of
  realtime.md §3) and every gate moved to `client.supports()`. Chunk 1
  adds the name `record` to the list and migrates nothing.
- No identifier or schema field carries the word "latency" — it left
  with the retired take schema (#132), surviving only in prose: two
  test comments about reverb tails (effect-properties.test.ts) and the
  reload doc comment on wrap latency (player.h:67), in the same header
  chunk 1 opens for the duplex device.
  [audio-engine.md](../../audio-engine.md) defines the vocabulary; this
  phase is where it becomes observable numbers instead of prose.
- The metronome is `field play --click` (cli.ts:434), CLI-side
  TypeScript DSP (click.ts, 90 lines) baking ticks into a temp file —
  the sole production caller of the whole-file WAV codec, and the
  reason `--click` refuses to compose with `--watch` (cli.ts:456). The
  count-in and metronome a tracking session needs belong in the
  engine's callback, which is what retires the DSP and dissolves the
  refusal (§7).

## 3 The take on disk

Generated takes today are numbered WAVs with `variants.yaml` beside
them binding bytes to recipe. Recorded takes keep the shape — record
beside bytes, a `chosen`, one row per take — and differ exactly where
settled decisions say they differ: timestamp names instead of numbers,
and the pin in the ledger instead of the row. `audio/<name>/takes.yaml`:

```yaml
record: lead-vocal
chosen: take-20260812-210638
takes:
  - asset: take-20260812-210411
    started_at_samples: 806400
    musical_position: [17]
    device: Apollo Twin X
    input: 1
    latency: 142
    monitoring: apollo-direct
    console_preset: vocal-tracking
  - asset: take-20260812-210638
    started_at_samples: 806400
    musical_position: [17]
    device: Apollo Twin X
    input: 1
    latency: 142
    monitoring: apollo-direct
    console_preset: vocal-tracking
```

and finalize pins the bytes where recorded audio pins — the song's
ledger ([project-layout.md](../project-layout/readme.md) §1.6's split: imported
and recorded audio pin in the ledger; only generated variants pin in
their spec):

```yaml
# songs/creek/assets.yaml — the row finalize adds
assets:
  - name: take-20260812-210411
    file: audio/lead-vocal/take-20260812-210411.wav
    sha256: 9c1f0b537b698fcad138b45c34caf3d78af4f55ee1c808c81fe2365bc9ffdd41
    bytes: 8294444
    sample_rate: 48000
    bit_depth: 24
    channels: 1
    frames: 2764800
```

Finalize knows all four WAV facts, so the row carries all four — which
the schema requires anyway (they travel together or not at all,
multi-rate.md decision 5), and committing to capture them here is the
point of showing a row that validates.

- Take files carry timestamp names, not numbers —
  [project-model.md](../../project-model.md)'s identity tiers give
  recorded takes sortable, merge-safe timestamps
  (`take-20260812-210411`) where generated takes count within their
  request, so two clones recording independently can never mint the
  same path.
- `started_at_samples` is authoritative; `musical_position` records
  what the tempo map said at capture and is never used for placement
  arithmetic — the authority rule project-model.md "Timeline and
  tempo" demands of anything storing both. `latency` is the samples
  the captured audio ran behind the start, as the device reported it.
  Samples plus latency are the whole placement story; the exact
  compensation arithmetic (input vs. round-trip, and a loopback
  measurement to check the device's claim) is settled in the first
  chunk against real hardware, not in this plan.
- Bytes stay pure: the file is what the converter produced, at the
  device's rate the ledger row records. If the track renders at
  another rate, the edge converts ([multi-rate.md](../multi-rate/readme.md)
  decision 4) exactly as for any other source — no resample at
  finalize, ever.
- `monitoring` and `console_preset` are the monitoring context
  audio-engine.md's take manifest requires: a clone can tell how a dry
  take was heard when it was sung.
- `chosen` names a take, and `field choose` moves it the same way it
  moves a variant.

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

A record entry with no takes yet builds as **silence**, with `field
check` saying so (`lead-vocal: no takes yet`) — not the refusal an
ungenerated generative entry gets (`assertGenerated`, graph.ts:581).
The difference is the point of the entry: §9's flow places the track
and loops the mix *before* the first take exists, which a refusal
makes impossible. A generative entry without variants is a build
that forgot a step; a record entry without takes is a session that
has not happened yet.

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
the record position. This retires click.ts's offline DSP and its
whole-file WAV codec use; the surface stays `field play --click`
(cli.ts:434), now routed to the engine — and `--click` with `--watch`
stops being refused (cli.ts:456), because there is no baked temp file
for a swap to drop.

## 8 Monitoring

V1 monitoring is Apollo-direct, configured manually in Console, and
capture is dry — both already decided in audio-engine.md. This plan
builds no monitor path. That choice also disposes of the
engine-latency-while-tracking problem class (settled 2026-08-10,
realtime discussion): the performer's cue is Console's near-zero DSP
path, which is where a pro studio runs tracking effects anyway, so
Field's own chains — including the realtime limiter's buffered
lookahead ([realtime.md](../realtime/readme.md) chunk 1) — run only at
playback, where delay compensation absorbs them. audio-engine.md's
bypass-and-report latency policy becomes relevant only if host
monitoring arrives. What it does commit is the context a take was
monitored under: each take row records `monitoring:` and
`console_preset:` (§3), the expected-preset contract audio-engine.md
already states, so a clone can tell how a dry take was heard. The
committed `hardware/` file that would bind inputs and presets per
machine — the story playback.md §3.4 deferred to this phase — is an
open question (§11): its schema wants deciding from a real Apollo
session, not invented here. Host monitoring (input through Field's
engine and effects, with the latency policy beside it) is real future
work and stays out of scope.

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
2. **The take lands** — finalize into `audio/<name>/` (timestamp
   names) plus the ledger row plus `takes.yaml`, the `record:` entry
   and its schema with takeless-builds-as-silence, resolver arm for
   recorded takes, latency-compensated placement verified by loopback
   on real hardware, blocking `field record`.
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

  *Resolved 2026-09-06 (§12.6):* bare `- record:`, preprocessed to `{}`
  the way a bare send label already is (`sendSchema` in
  schema/track.ts). Chunk 2 implements it.
- The record file: `takes.yaml` with a `takes:` list as above, or reuse
  the `variants.yaml` name and `variants:` key so both kinds of take
  share one filename? Separate names say what happened; one name says
  they are the same machinery — though less of it is shared than it
  was, now that recorded rows pin in the ledger while variant rows
  pin in-file.

  *Resolved 2026-09-06 (§12.6):* `takes.yaml` with `takes:`. The two
  files pin in different places, so one filename would claim a shared
  shape the loader would then have to disambiguate by content.
- Does stop auto-choose the new take, the way generation chooses its
  first variant? Tracking says yes — you want to hear what you just
  sang; a later take overwriting your chosen comp says no.

  *Resolved 2026-09-06 (§12.6):* yes, the new take is chosen — the
  generation precedent, and what tracking wants. The comp case that
  argues otherwise arrives with comping (chunk 4), which is where to
  revisit it with real takes on disk.
- Are meters needed for the V1 CLI, or is the widget their first real
  consumer?

  *Resolved 2026-09-06 (§12.4):* one meter, in `status`, no event
  stream. The blocking `field record` draws it; a stream waits for a
  consumer that polling cannot serve.
- The committed `hardware/` file's schema — what binds a named input
  and an expected Console preset per machine class (§8) — decided
  from a real Apollo session rather than invented in this plan.

  *Deferred 2026-09-06, deliberately:* nothing in chunks 1–3 reads it.
  Device and input are `field record` flags, the record entry carries
  no payload (§4), and the manifest records what was used (§12.2), so
  the schema can be written from the first real Apollo session's
  manifests rather than ahead of them.

## 12 Chunk 1 as built (2026-09-06)

Re-verified against main at 7185f90 before starting; §2's seams held
except the feature-detection bullet, superseded above. What landed, and
the decisions it made:

1. **The transaction is one append-only WAV plus a journal, not chunk
   files.** `.field/recording/<id>/take.wav` is written block by block
   with its header sizes at zero; finalize patches them, and an
   unpatched header is what marks a transaction incomplete on disk.
   `journal.json` records the frames `fsync` has reached the disk with,
   once a second. A process crash keeps everything `fwrite` handed the
   kernel, so recovery patches from the file size and records the
   journal's count beside it as the power-loss floor. Rejected: a file
   per flush — it buys nothing a single file with a patched header
   does not, and lands a reassembly step in front of every recovery.
2. **Bytes are float32 mono at the device's rate.** The callback
   delivers float; writing it unchanged is the same "bytes stay pure"
   rule §3 states for rate, applied to depth — a 24-bit writer would be
   a quantization the pipeline avoids everywhere else. §3's ledger row
   showed `bit_depth: 24` as an illustration; the row finalize writes
   will say 32. The manifest carries both `sample_rate` (the take's)
   and `timeline_rate` (the bed's), because `started_at_samples` counts
   in the bed's samples while the bytes are at the device's.
3. **Latencies are recorded, not yet applied.** The arm response and
   the manifest carry `input_latency` and `output_latency` as the
   device reports them, separately. Which of them placement subtracts
   — input alone, or the round trip a performer hearing Console's
   direct path actually experiences — is §3's loopback measurement,
   and it stays in chunk 2 with the hardware.
4. **The meter is a peak in `status`.** `record.input_peak` is the
   largest |sample| on the armed input since the last status read, and
   the read resets it; `field record` draws it as a 60 dB bar. One
   reader sees the whole picture, two readers each see half — the
   widget's problem when it becomes a reader, and the point at which an
   event stream earns its place.
5. **Placement is latched in the callback.** `record` sets a request
   flag; the block that honours it reads the transport position and
   pushes that block's input, so the first captured sample and the
   position it is placed at describe the same instant. A block whose
   live lock was missed defers the start rather than latching a
   position it does not have. A take with no bed is placed on a free
   clock counted from arm; `timeline_rate` is absent to say so.
6. **The three product questions above are settled here** because this
   is the pull request that makes the readiness claim; chunk 2 builds
   them as written.
7. **`field record` lands in `.field/recording/` for now.** The command
   arms, loads the target's song as the bed when nothing is loaded,
   blocks with a position and meter line, and ends — on ctrl-c or on a
   stop from elsewhere — by printing the take's path and frames.
   `--list` shows every transaction and `--recover <id>` finalizes one
   a dead daemon left behind. Landing into `audio/<name>/` with the
   ledger row and `takes.yaml` is chunk 2, unchanged.
8. **What a running take refuses:** `locate`, `load`, `device.select`,
   a second `arm`, `disarm`. `pause` ends the take like `stop` does —
   a capture against a still transport has no honest placement. A
   session swap is allowed because it carries the transport.
   Default-output following and the sample-rate switch a load prefers
   are deferred until the take ends, because each restarts the device
   and gaps the capture; delivery converts meanwhile
   (cross-rate-live.md decision 3).
9. **The null input.** Armed, the null clock presents one channel as a
   real duplex open would: channel 1 a sawtooth over one second of the
   input clock, channel 2 a constant. The tests read a take back and
   prove every consecutive pair differs by exactly one step — no block
   lost or repeated between callback and file, including across a
   SIGKILL and recovery — and that arming channel 2 captured the
   constant. The null clock now paces against an absolute deadline; the
   relative sleep it had ran a tenth slow, which a frame count measures
   where a position readout never noticed.
10. **Not verified here, owed to the first hardware session:** the
    macOS microphone prompt for a detached daemon (TCC attributes it to
    the terminal that spawned `field`; a denied prompt looks like an
    input that reads `silent` in the meter, which is why the meter
    names silence instead of drawing an empty bar); the duplex open on
    an Apollo whose input and output are one device, and on a pair of
    devices JUCE combines; and the latency arithmetic of item 3.
    Known limits: a take past 4 GB (six hours of mono float at 48 kHz)
    would need RF64; frames the FIFO refuses are counted in `dropped`
    and reported, not recovered.
