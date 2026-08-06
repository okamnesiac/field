# Later

Wanted, nobody has committed to it. One line each, linking a plan in
[all](all/) where there is one. When something graduates, move the line to
[next](next.md) — or straight to [now](now.md) if it starts immediately. A
line that never graduates can just be deleted; it cost nothing and losing it
costs nothing. See [README](README.md) for how these lists work.

- **Automation** — breakpoint lanes + control-rate generators (LFO first),
  one compile target, realtime-evaluable by design; audio-rate stays SC's
  job ([automation.md](all/automation.md) records the decided shape).
- **AU hosting** — scanning, instantiation, parameter/state management, delay
  compensation in the daemon; UAD-2/UADx execution modes
  ([architecture.md](../architecture.md), [build-graph.md](../build-graph.md)).
- **Recording and takes** — crash-safe transactional capture, punch/loop/
  count-in, monitoring paths ([audio-engine.md](../audio-engine.md)).
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
- **Loops with their own timeline** — polyrhythmic/polymetric loops against a
  different meter, carrying a local timeline mapped at the instantiation point
  ([project-core.md](all/project-core.md) §3.1 defers this deliberately).
