# Architecture

Field is divided into layers with a hard rule about where each language
is allowed: **TypeScript for everything with a keyboard, C++ for
everything with a deadline, Python only as a model-runner.**

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
     |            (sclang/scsynth,  (field-aced, field-voiced:
 Core Audio        driven over OSC)  ACE-Step, Chatterbox)
 Audio Units
 Apollo
```

## Control plane (TypeScript)

The control plane owns project interpretation and orchestration: it
parses and validates project files, constructs the dependency graph,
hashes inputs, makes cache decisions, invokes the daemon and the
SuperCollider and Python workers, manages assets and provenance,
integrates with Git for semantic diffs, and exposes the CLI (and later
the MCP tool surface).

**Decision — TypeScript, not Python, and no Python-first prototype.**
The schemas are the contract and the daemon speaks a well-defined IPC
protocol, so the control-plane language is technically a two-way door —
but the rewrite tax is real, so Field picks once. TypeScript wins on MCP
SDK maturity, schema validation (zod), and long-running-process
ergonomics. The canonical project format remains language-neutral
regardless.

**Diagnostics have two severities, and only one holds the gate.** A
diagnostic without a severity is an error: `field check` fails, `build`
refuses, `watch` reports and waits for the next edit. A `warning`
reports without failing any of them — `check` prints it (marked
`warning:`) and still says ok, `build` surfaces it and proceeds, `watch`
reports it and rebuilds anyway. The level exists because some true
findings describe normal intermediate states — a cable with one end
wired (nested-tracks.md §19 decision 3) — and a gate that fails on those
either stops legitimate work or trains you to expect red.

**`field --version` reports the build, not the checkout.** `pnpm build`
stamps `dist/build-info.json` with the commit, branch, and dirty count
at build time — cleared before `tsc`, written after everything
succeeds, so a failed build leaves no stamp — and the dist artifact
reads its stamp.

When the checkout has moved since the build, the report says so beside
the baked identity instead of impersonating it: a new HEAD prints
`checkout now at <sha> — pnpm build to update`, and edits without a
commit print `checkout has changed since the build — pnpm build to
update`. Running from source (tsx, vitest) keeps the live git read,
because there the checkout is the code; an unstamped dist falls back to
the live read.

## Native audio daemon (C++ / JUCE) — `field-audiod`

The daemon owns all latency-sensitive and hardware-facing work. Its
playback half is shipped: device I/O, a sample-accurate transport with
musical-position readout, and playback of built labels, behind a
versioned NDJSON protocol on a Unix domain socket. It runs daemon-lite —
`field play` spawns it on demand, a lock file guarantees one instance,
and it exits when idle — and `field transport` and `field devices` drive
the same protocol, which CI exercises against the real binary in
null-output mode. Hosting arrived with
[plugin-hosting.md](projects/all/plugin-hosting.md) chunk 1: `--scan`
probes installed AU/VST3 plugins one crash-isolated subprocess each, and
`--render` instantiates pinned plugins offline. The rest — recording,
monitoring, the live plugin chain, editor windows, delay compensation,
routing, metering, crash-safe capture — is future work whose settled
decisions live in [audio-engine.md](audio-engine.md).

The real-time audio callback never depends on TypeScript or Python: GC
pauses and JIT are disqualifying when a 64-sample buffer at 96kHz gives
you about 0.7ms.

**Decision — C++ with JUCE.** Alternatives considered and rejected:

- *Swift + AVAudioEngine/AudioToolbox.* Viable for a Mac-only product,
  and Apple's stack does host AUv2/v3 with a manual-rendering mode for
  offline builds. Rejected because JUCE has already absorbed a decade of
  workarounds Field would otherwise re-earn: out-of-process plugin
  scanning (one crashy plugin must not kill the daemon), plugin editor
  window hosting, state-serialization quirks across badly behaved
  plugins, delay-compensation bookkeeping, and glitch-free dynamic graph
  rebuilds. UAD plugins exercise exactly these edges.
- *Tracktion Engine.* A full open-source DAW engine — too much of Field
  already built, at the wrong altitude: it owns its project model, and
  Field's entire thesis is owning the model. Mapping canonical files
  onto its internal state would be permanent work, and hidden state is
  the problem Field exists to kill.
- *Rust.* Better real-time discipline than C++ in principle, but there
  is no mature AU-hosting story in Rust, and JUCE is a C++ framework you
  inherit from, not a library you call — a Rust/JUCE bridge means
  designing a C ABI over a deeply object-oriented API and debugging
  real-time threading bugs at the FFI boundary. Not worth borrow
  checking in roughly 30% of one contained process.

**Licensing.** JUCE 8 is dual-licensed AGPLv3 / commercial. Field uses
AGPL while personal/open-source; if productized closed-source, a
commercial license (about $130/month Pro tier, or perpetual) resolves
it. JUCE stays **quarantined inside the daemon** — it never leaks into
other components, so licensing exposure is one process and the hosting
layer stays swappable.

## SuperCollider

A first-class runtime, driven directly from TypeScript — no Python
intermediary. SC's control surface is spawning `sclang`/`scsynth` and
OSC over UDP, which TypeScript handles fine. Two modes:

- **Offline (NRT)** — the default: an SC program plus an explicit seed
  renders an asset via scsynth's non-realtime mode. Deterministic,
  cacheable, and the first real build rule.
- **Live** — scsynth as a node in the real-time graph, receiving
  timestamped OSC. Arrives with the real-time runtime.

SC source is tracked in Git and treated as code.

## Python model-runners — `field-aced`, `field-voiced`

Python survives only where the ML ecosystem forces it. Two workers exist
today: `field-aced` runs ACE-Step music generation and `field-voiced`
runs Chatterbox voice generation, both invoked by `field generate` and
never by the build. Each runs from its own uv-managed environment, which
`field setup <worker>` creates explicitly — environments are never built
as a side effect. A worker takes immutable inputs and a job spec and
emits assets plus structured metadata over the versioned worker protocol
(see IPC below), and never participates in the real-time callback.
Later analysis workers (separation, transcription, loudness, take
ranking) join the same protocol. No application code is written in
Python.

## IPC

Boring by design: versioned NDJSON over flock-owned Unix domain sockets
— `field-audiod` on the daemon protocol, `field-aced` and `field-voiced`
on the worker protocol with a `hello` handshake — and OSC to scsynth.
All three daemons share the daemon-lite lifecycle: spawned on demand,
one instance per project, idle exit. `field --version` reports the
worker protocol version and what each running daemon speaks, so the
widget (Swift, later) can speak the same protocol as the control plane.
