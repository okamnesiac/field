---
status: completed
---

**Outcome:** Shipped.

# Playback

**Status:** Shipped (#12–#13, merged 2026-08-05): the daemon, the socket,
and blocking `field play` with `--from` and the `field transport` family —
the definition of done below is met, verified on real hardware. afplay
survives as a fallback for machines without the built binary; retire it
once the daemon path has soaked. Followed
[mix-assembly.md](../mix-assembly/readme.md) (shipped #9–#11); the first native code.
An interim `field play <pattern>` shipped early (after #7): it builds
targets and auditions the files through `afplay` — useful today, but it
plays *artifacts*, not the graph. This phase is still about the real
engine: transport, the timeline, devices, and the control socket. The
afplay path gets retired when the daemon can play.

**Goal:** `field play` — audition built artifacts and timeline positions from
the CLI through Core Audio, on the device Field selected (Apollo or
otherwise).

## 1 Shape

- The first real-time code, and deliberately minimal: play rendered assets
  with sample-accurate transport (play/pause/stop/locate). This is the seed of
  `field-audiod` ([architecture.md](../../architecture.md)), started at the
  smallest useful scope — device selection and enumeration, an output
  callback, a transport clock, and the versioned control socket the CLI (and
  later the widget) speaks.
- It may begin as a thin C++/JUCE tool before growing daemon lifetime
  management; what matters is that the IPC protocol and process boundary are
  the real ones from day one.
- Playing the *graph* (instruments, live SC, inserts) is explicitly later —
  this phase plays built artifacts only.

## 2 Definition of done

`field build && field play` auditions the mix through the Apollo without
leaving the terminal; transport commands work over the same socket the widget
will eventually use.

## 3 Decisions (DECIDED, 2026-08-05)

1. **Daemon-lite lifecycle.** The CLI spawns `field-audiod` on demand when
   the socket is dead; the daemon exits after an idle timeout (no clients,
   transport stopped). Real daemon semantics without launchd machinery;
   launchd can arrive later without protocol changes. Rejected: a managed
   daemon now (lifecycle work this phase doesn't need), a throwaway player
   process per play (throwaway process boundary — the one thing the plan
   says must be real).
2. **One daemon per project.** The socket lives at `.field/audiod.sock`;
   the daemon's world has a single project and sample rate. A per-user
   daemon would need multi-project state for no current benefit. Two
   projects playing at once means two daemons — acceptable, arguably
   correct. (macOS `sun_path` is 104 bytes, so both sides bind/connect via
   a path relative to the project root.)
3. **Versioned NDJSON protocol.** Newline-delimited JSON over the socket:
   `hello` handshake carrying a protocol number, request/response with
   client-chosen ids, plus broadcast events (state, position). Zod schemas
   on the TS side are the source of truth; the C++ side uses JUCE's JSON.
   Legibility beats compactness — this is the socket the widget will speak.
4. **Device choice is local state, not project truth.** Machines differ;
   a committed device name breaks on clone. Selection lives under
   `.field/` (uncommitted), settable per play; default is the system
   output. The committed `hardware/apollo.yaml` story belongs to the
   recording phase.
5. **Sample rate: set the device, else resample with a notice.** "Never
   resample implicitly" protects build artifacts; auditioning through
   whatever DAC is present is monitoring, not rendering. If the device
   can't run at the file's rate, the daemon resamples and says so in
   status output. The artifact stays pure.
6. **`field play` stays blocking.** Ctrl-c stops, matching the afplay-era
   muscle memory and agent ergonomics — but playback runs through the
   daemon, streams position, and `field transport status|pause|play|stop|locate`
   reaches the same daemon from anywhere. `--from <bar.beat.tick>` projects
   musical time through the tempo map CLI-side and sends `locate(samples)`
   — the daemon never learns what a bar is (artifacts-only stays clean).
7. **CMake + JUCE via FetchContent, treated as an artifact.** ~35 lines,
   pinned JUCE tag, wrapped in `pnpm build:native` (explicit — never
   postinstall); CI compiles it. Rejected: Projucer and checked-in Xcode
   projects (unreadable diffs), Meson/Bazel (no first-class JUCE support),
   a hand-rolled Makefile over JUCE modules (viable today, painful the day
   `juce_audio_processors` arrives for AU hosting).

## 4 Chunks

1. **The daemon** (shipped, #12) — `native/audiod/`: CMake + JUCE skeleton,
   the unix socket NDJSON server, device enumeration/selection, file
   playback with sample-accurate transport, a null-output mode so CI
   exercises the whole protocol without an audio device, idle exit, and
   the TS client (`field devices` as the first consumer).
2. **The handoff** (shipped, #13) — `field play` goes through the daemon
   (blocking, position-streaming, ctrl-c), `--from <position>`, the
   `field transport` command family, and afplay demoted to a fallback for
   machines without the built binary — then retired.

## 5 Follow-ups

- **Live device tracking** — daemon-lite exposed a staleness family in
  real use (a session hit both in ten minutes): the device *list* went
  stale after a hot-plug, and the device *choice* went stale after the
  system default changed, because the daemon snapshotted Core Audio at
  spawn. The daemon now subscribes to Core Audio's device-list and
  default-output notifications and **follows the system default live
  unless a device was explicitly selected**; a selection whose device
  vanishes resets to the default. A `device` event on the socket says so,
  and a blocking `field play` prints it. The mental model this buys: the
  `*` in `field devices` and the actual output can never disagree, and
  `pkill field-audiod` stops being a tool users need to know about.
- **Reload at the loop wrap** (daemon 0.4, [watch.md](../watch/readme.md) §1.1) —
  the protocol gains `reload(path)`: the daemon opens and prepares the
  new file at request time, a fine position poll detects the looping
  reader's wrap, and the takeover lands there — whole passes only, the
  transport never stops, and a broadcast `reloaded` event fires when
  the swap actually sounds. Latest reload wins; a fresh `load`
  supersedes any queued takeover. This is what `--watch` on a looping
  `field play` rides; the recorded successor (a sample-exact,
  bar-synced double-buffered swap) waits until wrap latency chafes.
