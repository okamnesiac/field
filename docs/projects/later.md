# Later

Wanted, nobody has committed to it. One line each, linking a plan in
[all](all/) where there is one. When something graduates, move the line to
[next](next.md) — or straight to [now](now.md) if it starts immediately. A
line that never graduates can just be deleted; it cost nothing and losing it
costs nothing. See [README](README.md) for how these lists work.

- **Audible loop takeover** — every `--loop --watch` reload hiccups at
  the seam, from poll lag and transport teardown together; deferred
  because the real-time engine deletes the mechanism
  ([watch.md](all/watch.md) §6 has the diagnosis;
  [realtime.md](all/realtime.md) §4 is the deletion).
- [Recording](all/recording.md) — capture into a track as takes: the
  generative pattern with a human where the model was. Plan drafted;
  waits behind [realtime](all/realtime.md), which makes capture an
  input node in a graph that already runs live.
- **Automation** — breakpoint lanes + control-rate generators (LFO first),
  one compile target, realtime-evaluable by design; audio-rate stays SC's
  job ([automation.md](all/automation.md) records the decided shape).
- **AU hosting** — scanning, instantiation, parameter/state management, delay
  compensation in the daemon; UAD-2/UADx execution modes
  ([architecture.md](../architecture.md), [build-graph.md](../build-graph.md)).
- **Recording widget** — the native macOS control surface, last on purpose: a
  client of an engine that must exist first.
- **Live SuperCollider** — scsynth as a node in the real-time graph via
  timestamped OSC.
- **External instruments** — MIDI out with a declared audio return graduates
  live-only → realtime-bounce, nondeterministic
  ([build-graph.md](../build-graph.md) "Render strategies").
- **Remote asset store** — S3-backed backend behind the content-hash
  abstraction, when LFS costs hurt.
- **Analysis workers** — separation, transcription, loudness, take ranking on
  the worker protocol [ace-generation.md](all/ace-generation.md) establishes.
- **src/engine umbrella** — `graph/` + `generators/` (+ `audio/`?) under
  one engine module; discussed 2026-08-06, no flag-day pressure, land as
  a quiet cleanup whenever.
- **prettier and ESLint** — neither is installed and no config exists, so a
  tool reaching for a formatter applies its own defaults (#83, 312 lines);
  ESLint is free, prettier costs a ~1,900-line reformat.
- **Splice support** — shaped like ace, not import: search in, TUI to
  audition, choosing commits the sample with the recipe of how it was
  found — which pays for per-song listing and kept licenses
  ([splice.md](all/splice.md)).
- **MCP surface** — expose the CLI's verbs as MCP tools; agents are a
  first-class user, but not until everything else actually works (moved
  down from next 2026-08-10).
- **Generation progress** — real per-step progress from the workers
  (ACE step counts, Chatterbox chunking) over the existing progress
  events; today a minutes-long generate is one silent "generating".
