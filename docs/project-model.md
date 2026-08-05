# Project model

The canonical project representation is language-neutral, schema-validated
YAML in a normalized directory structure, optimized for: semantic Git diffs,
stable ordering, deterministic formatting, mergeability, human and agent
readability, explicit IDs, and explicit dependencies.

**Decision — a native format, not DAWproject.** DAWproject is
interchange-oriented XML: poor for diffs and merges, and it models a DAW's
concepts rather than Bloom's (no takes-as-manifests, no build targets, no
generation recipes). A DAWproject *exporter* is a possible later feature.

## Projects contain songs

A project is an album-shaped workspace: one or more songs plus shared material
— instruments, loops, samples, SuperCollider programs, plugin chains — reused
across them. Songs are packages; shared material is a library; build labels
address both (`//songs/opener/mix:main`, `//shared/instruments:dark-pad`).

```text
project/
├── bloom.yaml            # project manifest: name, engine versions
├── bloom.lock            # locked environment: plugin versions, model versions
├── shared/               # material reused across songs
│   ├── instruments/
│   ├── loops/
│   ├── samples/
│   ├── sc/               # SuperCollider programs (synths, effects, textures)
│   └── plugins/          # shared chains and presets
├── songs/
│   └── <song>/
│       ├── song.yaml
│       ├── arrangement.yaml
│       ├── tempo.yaml
│       ├── markers.yaml
│       ├── tracks/       # one file per track: routing, inserts, sources
│       ├── clips/
│       ├── takes/        # take manifests (see below)
│       ├── comps/
│       ├── midi/
│       ├── audio/        # recorded/imported assets (LFS)
│       ├── automation/
│       ├── generation/   # ACE recipes and provenance
│       ├── sc/           # song-specific SC programs
│       └── monitoring/
├── plugins/
│   ├── manifests/        # scanned plugin inventory
│   └── states/           # serialized AU state blobs
├── hardware/
│   └── apollo.yaml
└── .bloom/               # unversioned: cache, recording transactions, sockets
```

Exact schemas are designed in [projects/all/project-core.md](projects/all/project-core.md).

## Timeline and tempo

The tempo map is the single source of truth for the mapping between sample
time and musical time (`bar.beat.tick`). Everything that stores both — take
manifests store `started_at_samples` *and* `musical_position` — must define
which is authoritative and when the other is derived, so the two can never
disagree. The semantics of editing the tempo map under existing content
(do clips hold musical position or sample position?) is a per-track,
explicitly-stored property, not an ambient behavior.

## Clips are metadata; audio is immutable

Audio files are never edited in place. A clip carries three independent,
non-destructive offsets:

1. **Timeline position** — where the clip sits in the arrangement (musical
   position by default).
2. **Source offset** — where the clip's window starts within its source asset.
3. **Slip** — shifts content against the grid without moving the clip's
   boundaries (as in Nio).

Fades, gain, and edits are clip metadata too. Every edit is a diff.

## Takes

A take is one performance of something, stored as a manifest referencing an
immutable asset, with timeline placement, device/latency metadata, and session
context. Takes are numbered, auditionable, never destroyed; each track has one
active take (or a comp built from several).

Takes cover more than recording: **a render of a nondeterministic node is a
take.** A hardware-synth bounce, a free-running-LFO chorus render — multiple
valid performances of the same recipe. They reuse the same machinery: list,
audition, select active, pin. See [build-graph.md](build-graph.md) for the
determinism policy.

## Assets

All audio/MIDI assets are content-addressed: manifests reference bytes by
hash, so where the bytes live is a pluggable detail. **Git LFS is backend #1**;
a remote store (S3-backed) is a manifest-preserving migration later, when LFS
storage/bandwidth costs hurt. Generated assets are committed with their recipe
and provenance, never silently regenerated.

## Generation recipes

A generated asset's recipe is committed alongside it: engine, model name +
version + checksum where possible, prompt, seed, duration, conditioning
(chords, MIDI, reference audio), generation parameters, output hashes, and
licensing/provenance metadata. For SuperCollider, the recipe is the program
plus an explicit seed. Reproducibility of the recipe is the contract; the
committed bits are the artifact.
