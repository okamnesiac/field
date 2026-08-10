# Field

Field treats music production like software development. A song is a
repository. Production state — arrangement, tempo, takes, plugin chains,
synthesis programs, generation recipes, mixes — lives in structured,
schema-validated, diffable files. Every meaningful action is a CLI
command, and audio outputs are produced by an explicit dependency graph
with content-addressed caching. Human users and coding agents work on
the same underlying representation; an MCP surface exposing the CLI's
verbs as tools is planned ([projects/later.md](projects/later.md)).

For a concrete project you can read and build, see
[`examples/bloom`](../examples/bloom/README.md) — two songs exercising
most of what this page describes, checked by CI on every change.

## Why

A traditional DAW stores production state inside proprietary project
files and graphical interfaces. You cannot inspect that state, review it
as a text diff, or script it reliably, and it versions only as an opaque
binary blob. Audio generation tools live outside the production
environment, and no operation is reproducible. A coding agent cannot
meaningfully operate a DAW.

Field inverts this. You can build, inspect, edit, and record a Field
project without opening a DAW — from a terminal, from an agent, or from
a small native control surface — and all three drive the same engine and
the same files.

## Core concepts

- **Project** — a Git repository of schema-validated YAML plus
  content-addressed audio assets. A project contains one or more songs —
  think album — plus shared instruments and samples reused across them.
  See [project-model.md](project-model.md).
- **Song** — one piece within a project: its own arrangement, tempo map,
  tracks, takes, and committed audio, drawing freely on the project's
  shared material.
- **Asset** — an immutable audio or MIDI file, referenced by content
  hash. Field never edits audio in place; all placement and editing is
  metadata.
- **Node** — a producer or processor in the dependency graph: a recorded
  track, a SuperCollider program, a generative sound, a plugin chain, a
  bus.
- **Label** — the address of something buildable: a stem, a sound, a cue
  mix, the song's output track. For example,
  `field build //songs/opener/track:main`. See
  [build-graph.md](build-graph.md).
- **Take** — one performance of something. Recorded takes and renders of
  nondeterministic nodes use the same machinery: numbered, auditioned,
  one active, none destroyed.
- **Recipe** — a committed, seeded description of how a generated asset
  was produced (a SuperCollider program plus a seed, an ACE prompt plus
  model plus seed), with provenance. Recipes are reproducible; the
  generated bits are committed, not regenerated.

## V1 platform scope

macOS on Apple Silicon only. Core Audio, Audio Units (AUv2, and AUv3
where practical), Apollo interfaces as reference hardware, UAD-2 DSP and
UADx native plugins, SuperCollider, and ACE-Step generative audio.

Explicitly out of scope for V1: Logic (integration, import/export,
plugins), Windows, Linux, VST/CLAP/AAX, other DAW integrations, a full
graphical DAW interface, cloud collaboration, remote rendering, notation,
video scoring, surround/Atmos, and Apollo Console automation (no
supported API exists — see [audio-engine.md](audio-engine.md)).

## Two workflows

**CLI-first.** You create, configure, generate, build, and play a
project from the command line, and recording joins the same surface when
the engine grows it. `field init` starts an empty project; on a fresh
clone of [`examples/bloom`](../examples/bloom/README.md), this sequence
takes creek from request to delivered file:

```bash
field generate creek/still-water-keys --seed 90210 --variants 2
field generate creek/lead-take --seed 4823 --variants 3
field build creek/track:main
field play creek
field export creek --rate 44100 --bit-depth 16
```

**A minimal recording widget** (later). A compact native macOS control
surface for the engine: transport, arming, metering, monitoring, take
audition. Not a DAW. The widget and the CLI control the same engine and
project state; the widget holds no hidden state unavailable to the CLI.

## Sequencing philosophy

Field is built generation-first, because offline generation delivers
unique value — prompt → recipe → committed, diffable, buildable music —
with zero real-time code. The playback daemon arrived only after real
use had battle-tested the project model, and the rest of the real-time
engine (recording, monitoring, plugin hosting) follows the same rule.
The current build order lives in [projects/](projects/README.md).
