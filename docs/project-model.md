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

Time fields in project YAML take two spellings
([projects/all/musical-time.md](projects/all/musical-time.md)): a scalar is
ticks (samples on absolute-anchored clips), and an array is musical,
resolved through the song's meter map. Positions are ordinal and 1-indexed
— `at: [9, 2]` is bar 9, beat 2 — while spans are cardinal counts where
zero is legal — `duration: [4]` is four bars, `every: [0, 2]` is two beats,
advanced from the field's anchor so meter changes mean what a musician
means. Arrays are resolved to ticks at load: either spelling produces the
same build, and `bloom fmt` preserves whichever notation the author wrote,
keeping arrays single-line.

## Clips are metadata; audio is immutable

Audio files are never edited in place. A clip's content is exactly one of a
committed asset or a same-song build target — clipping a target means the
arrangement plays a render that is never committed, only its recipe. A clip
carries three independent, non-destructive offsets:

1. **Timeline position** — where the clip sits in the arrangement (musical
   position by default).
2. **Source offset** — where the clip's window starts within its source asset.
3. **Slip** — shifts content against the grid without moving the clip's
   boundaries (as in Nio).

Fades, gain, and edits are clip metadata too. Every edit is a diff.

Tracks carry the mix-stage controls — `gain_db` and `pan` (constant-power
balance) — while clips carry their own gain and fades as part of the
arrangement. Tracks also carry `inserts:` (EQ, limiter, reverb — entries
discriminated on `effect:` so hosted plugins can join later): inserts are
*content*, baked into the stem, so editing one re-renders the stem where a
fader move never does. The split matters to the build graph: every audio track with
clips is implicitly buildable as `//songs/<song>/tracks:<name>`, a pre-fader
stem whose cache key sees clip placement but not the track fader, so mixing
decisions never invalidate rendered stems (see
[build-graph.md](build-graph.md) "Rules so far").

## Identity: names, not UUIDs

Nothing in a Bloom project carries an opaque ID. Identity comes in three
tiers, by how a thing gets it:

- **Humans name it → the slug is the ID.** Tracks (`lead-vocal`), songs
  (directory name), targets. Filenames are keys. Renaming is a repo-wide,
  tool-assisted refactor (`bloom track rename` rewrites every reference
  atomically), exactly as renaming a function is in code.
- **Content is the identity → SHA-256.** Assets and cached outputs.
- **Machines mint it → timestamp or slug-plus-short-random.** Takes are
  timestamped (`take-20260804-202355`, sortable, merge-safe); clips — which
  automation references stably — get a readable random suffix
  (`chorus-vox-x7f3q`).

The industry-standard alternative (opaque ID + display name, as in DAWproject
and every DAW format) was deliberately rejected: it makes every diff a join
table, which attacks Bloom's central thesis, while its supposed advantages
mostly don't survive scrutiny. `bloom check` validates referential integrity
(in CI, and after merges — cross-branch dangling references merge cleanly
under *any* ID scheme). The full argument is preserved in
[projects/all/project-core.md](projects/all/project-core.md) §6 — read it
before reopening this.

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

All audio/MIDI assets are content-addressed: each song's `assets.yaml` binds a
readable asset name to its file path, SHA-256, and size, and clips/takes
reference assets **by name** — so human-edited files stay readable while the
hash carries the content identity. The SHA-256 equals the Git LFS OID for the
same file, so the manifest, the LFS pointer, and the build cache share one
identifier. Where the bytes live is a pluggable detail. **Git LFS is backend
#1**;
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

Concretely (ACE): `bloom ace generate` writes
`songs/<song>/generation/<name>.yaml` plus numbered variant WAVs under
`generation/<name>/`. Recipes are schema-validated project files — `bloom
check` verifies variant hashes, `bloom fmt` covers them — and each variant is
addressable as `//songs/<song>/generation:<name>-<n>` for audition via `bloom
play`, without being referenceable by clips. Promotion is `bloom ace choose`:
it declares the chosen variant in `assets.yaml` where it lies (no bytes move)
and records `chosen` in the recipe. Choosing again moves the reference —
promotion is cheap and reversible, and only ever replaces an entry a previous
choose created.
