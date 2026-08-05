# Plan: Playback

**Status:** In progress (started 2026-08-05). Follows
[mix-assembly.md](mix-assembly.md) (shipped #9–#11); the first native code.
An interim `bloom play <pattern>` shipped early (after #7): it builds
targets and auditions the files through `afplay` — useful today, but it
plays *artifacts*, not the graph. This phase is still about the real
engine: transport, the timeline, devices, and the control socket. The
afplay path gets retired when the daemon can play.

**Goal:** `bloom play` — audition built artifacts and timeline positions from
the CLI through Core Audio, on the device Bloom selected (Apollo or
otherwise).

## 1 Shape

- The first real-time code, and deliberately minimal: play rendered assets
  with sample-accurate transport (play/pause/stop/locate). This is the seed of
  `bloom-audiod` ([architecture.md](../../architecture.md)), started at the
  smallest useful scope — device selection and enumeration, an output
  callback, a transport clock, and the versioned control socket the CLI (and
  later the widget) speaks.
- It may begin as a thin C++/JUCE tool before growing daemon lifetime
  management; what matters is that the IPC protocol and process boundary are
  the real ones from day one.
- Playing the *graph* (instruments, live SC, inserts) is explicitly later —
  this phase plays built artifacts only.

## 2 Definition of done

`bloom build && bloom play` auditions the mix through the Apollo without
leaving the terminal; transport commands work over the same socket the widget
will eventually use.

## 3 Decisions (DECIDED, 2026-08-05)

1. **Daemon-lite lifecycle.** The CLI spawns `bloom-audiod` on demand when
   the socket is dead; the daemon exits after an idle timeout (no clients,
   transport stopped). Real daemon semantics without launchd machinery;
   launchd can arrive later without protocol changes. Rejected: a managed
   daemon now (lifecycle work this phase doesn't need), a throwaway player
   process per play (throwaway process boundary — the one thing the plan
   says must be real).
2. **One daemon per project.** The socket lives at `.bloom/audiod.sock`;
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
   `.bloom/` (uncommitted), settable per play; default is the system
   output. The committed `hardware/apollo.yaml` story belongs to the
   recording phase.
5. **Sample rate: set the device, else resample with a notice.** "Never
   resample implicitly" protects build artifacts; auditioning through
   whatever DAC is present is monitoring, not rendering. If the device
   can't run at the file's rate, the daemon resamples and says so in
   status output. The artifact stays pure.
6. **`bloom play` stays blocking.** Ctrl-c stops, matching the afplay-era
   muscle memory and agent ergonomics — but playback runs through the
   daemon, streams position, and `bloom transport status|pause|play|stop|locate`
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
   the TS client (`bloom devices` as the first consumer).
2. **The handoff** — `bloom play` goes through the daemon (blocking,
   position-streaming, ctrl-c), `--from <position>`, the `bloom transport`
   command family, and afplay demoted to a fallback for machines without
   the built binary — then retired.
