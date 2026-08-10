# Architecture

Field is divided into layers with a hard rule about where each language is
allowed: **TypeScript for everything with a keyboard, C++ for everything with a
deadline, Python only as a model-runner.**

```text
CLI / MCP / Recording Widget
            |
            v
    Field Control Plane          TypeScript
            |
     +------+----------+
     v                 v
Native Audio Daemon   Worker subprocesses
(field-audiod)         |         |
 C++ / JUCE       SuperCollider  Python model-runners
     |            (sclang/scsynth,  (field-modeld:
 Core Audio        driven over OSC)  ACE, analysis, ML)
 Audio Units
 Apollo
```

## Control plane (TypeScript)

Owns project interpretation and orchestration: parsing and validating project
files, constructing the dependency graph, hashing, cache decisions, invoking
the daemon / SuperCollider / Python workers, managing assets and provenance,
Git integration and semantic diffs, and exposing both the CLI and the MCP tool
surface.

**Decision — TypeScript, not Python, and no Python-first prototype.** The
schemas are the contract and the daemon speaks a well-defined IPC protocol, so
the control plane language is technically a two-way door — but the rewrite tax
is real, so we pick once. TypeScript wins on MCP SDK maturity, schema
validation (zod), and long-running-process ergonomics. The canonical project
format remains language-neutral regardless.

**`field --version` reports the build, not the checkout.** `pnpm build`
stamps `dist/build-info.json` with the commit, branch, and dirty count
at build time (cleared before `tsc`, written after everything succeeds,
so a failed build leaves no stamp), and the dist artifact reads its
stamp. When the checkout has moved since the build — a new HEAD, or
edits without a commit — the report says so beside the baked identity
(`checkout now at <sha> — pnpm build to update`) instead of
impersonating it. Running from source (tsx, vitest) keeps the live git
read, because there the checkout is the code; an unstamped dist falls
back to the live read.

## Native audio daemon (C++ / JUCE) — `field-audiod`

All latency-sensitive and hardware-facing work: device I/O, transport,
playback, recording, monitoring, AU hosting, plugin state, delay compensation,
routing, metering, crash-safe capture. The real-time audio callback never
depends on TypeScript or Python — GC pauses and JIT are disqualifying when a
64-sample buffer at 96kHz gives you ~0.7ms.

**Decision — C++ with JUCE.** Alternatives considered and rejected:

- *Swift + AVAudioEngine/AudioToolbox.* Viable for a Mac-only product, and
  Apple's stack does host AUv2/v3 with a manual-rendering mode for offline
  builds. Rejected because JUCE has already absorbed a decade of workarounds we
  would otherwise re-earn: out-of-process plugin scanning (one crashy plugin
  must not kill the daemon), plugin editor window hosting, state-serialization
  quirks across badly-behaved plugins, delay-compensation bookkeeping, and
  glitch-free dynamic graph rebuilds. UAD plugins exercise exactly these edges.
- *Tracktion Engine.* A full open-source DAW engine — too much of Field
  already built, at the wrong altitude: it owns its project model, and Field's
  entire thesis is owning the model. We would spend our lives mapping canonical
  files onto its internal state, which is the hidden-state problem Field exists
  to kill.
- *Rust.* Better real-time discipline than C++ in principle, but there is no
  mature AU-hosting story in Rust, and JUCE is a C++ framework you inherit
  from, not a library you call — a Rust/JUCE bridge means designing a C ABI
  over a deeply object-oriented API and debugging real-time threading bugs at
  the FFI boundary. Not worth borrow checking in ~30% of one contained process.

**Licensing.** JUCE 8 is dual-licensed AGPLv3 / commercial. Field uses AGPL
while personal/open-source; if productized closed-source, a commercial license
(~$130/month Pro tier, or perpetual) resolves it. JUCE stays **quarantined
inside the daemon** — it never leaks into other components, so licensing
exposure is one process and the hosting layer stays swappable.

The daemon is deferred until the playback phase; the generation-first
milestones need no real-time code at all.

## SuperCollider

A first-class runtime, driven directly from TypeScript — no Python
intermediary. SC's control surface is spawning `sclang`/`scsynth` and OSC over
UDP, which TS handles fine. Two modes:

- **Offline (NRT)** — the default: an SC program plus an explicit seed renders
  an asset via scsynth's non-realtime mode. Deterministic, cacheable, the first
  real build rule.
- **Live** — scsynth as a node in the real-time graph, receiving timestamped
  OSC. Arrives with the real-time runtime.

SC source is tracked in Git and treated as code.

## Python model-runners — `field-modeld`

Python survives only where the ML ecosystem forces it: ACE-Step generation,
source separation, transcription, analysis, embeddings, take ranking. Workers
are subprocess-shaped — immutable inputs in, assets or structured metadata out,
JSON over stdio — and never participate in the real-time callback. No
application code is written in Python.

## IPC

Boring by design: JSON over a Unix domain socket between the control plane and
the daemon, JSON over stdio to worker subprocesses, OSC to scsynth. The daemon
protocol is versioned and documented so the widget (Swift, later) speaks the
same one as the control plane.
