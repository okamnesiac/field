# Field

Field treats music production like software development. A song is a
repository. Production state — arrangement, tempo, takes, plugin chains,
synthesis programs, generation recipes, mixes — lives in structured,
schema-validated, diffable files. Every meaningful action is a CLI command;
agent-facing functionality is exposed through MCP; audio outputs are produced
by an explicit dependency graph with content-addressed caching. Human users and
coding agents work on the same underlying representation.

## Why

Traditional DAWs store production state inside proprietary project files and
graphical interfaces. That state is hard to inspect, impossible to review as a
text diff, unreliably scriptable, and versioned only as an opaque binary blob.
Audio generation tools live outside the production environment, and no
operation is reproducible. A coding agent cannot meaningfully operate a DAW.

Field inverts this. A Field project is buildable, inspectable, editable, and
recordable without opening a DAW — from a terminal, from an agent, or from a
small native control surface, all driving the same engine and the same files.

## Core concepts

- **Project** — a Git repository of schema-validated YAML plus content-addressed
  audio assets. A project contains one or more songs — think album — plus
  shared instruments and samples reused across them. See
  [project-model.md](project-model.md).
- **Song** — one piece within a project: its own arrangement, tempo map,
  tracks, sounds, takes, and mixes, drawing freely on the project's shared
  material.
- **Asset** — an immutable audio/MIDI file, referenced by content hash. Audio is
  never edited in place; all placement and editing is metadata.
- **Node** — a producer or processor in the dependency graph: a recorded track,
  a SuperCollider program, a generative sound, a plugin chain, a bus.
- **Label** — the address of something buildable: a stem, a sound, a cue mix,
  the song's output track. `field build //songs/opener/track:main`. See
  [build-graph.md](build-graph.md).
- **Take** — one performance of something. Recorded takes and renders of
  nondeterministic nodes use the same machinery: numbered, auditioned, one
  active, none destroyed.
- **Recipe** — a committed, seeded description of how a generated asset was
  produced (SuperCollider program + seed, ACE prompt + model + seed), with
  provenance. Recipes are reproducible; the generated bits are committed, not
  regenerated.

## V1 platform scope

macOS on Apple Silicon only. Core Audio, Audio Units (AUv2, AUv3 where
practical), Apollo interfaces as reference hardware, UAD-2 DSP and UADx native
plugins, SuperCollider, and ACE-Step generative audio.

Explicitly out of scope for V1: Logic (integration, import/export, plugins),
Windows, Linux, VST/CLAP/AAX, other DAW integrations, a full graphical DAW
interface, cloud collaboration, remote rendering, notation, video scoring,
surround/Atmos, and Apollo Console automation (no supported API exists — see
[audio-engine.md](audio-engine.md)).

## Two workflows

**CLI-first.** Create, configure, generate, play, record, process, and render a
project from the command line: `field init`, `field sc render`, `field ace
generate`, `field build //track:main`, `field record --track lead-vocal --punch
42.2.1..46.1.1`.

**A minimal recording widget** (later). A compact native macOS control surface
for the engine — transport, arming, metering, monitoring, take audition. Not a
DAW. The widget and CLI control the same engine and project state; the widget
holds no hidden state unavailable to the CLI.

## Sequencing philosophy

Field is built generation-first, because offline generation delivers unique
value (prompt → recipe → committed, diffable, buildable music) with zero
real-time code. The real-time daemon — the riskiest component — arrives only
after the project model has been battle-tested by real use. The current build
order lives in [projects/](projects/README.md).
