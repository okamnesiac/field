# Project model

The canonical project representation is language-neutral, schema-validated
YAML in a normalized directory structure, optimized for: semantic Git diffs,
stable ordering, deterministic formatting, mergeability, human and agent
readability, explicit IDs, and explicit dependencies.

**Decision — a native format, not DAWproject.** DAWproject is
interchange-oriented XML: poor for diffs and merges, and it models a DAW's
concepts rather than Field's (no takes-as-manifests, no build targets, no
generation recipes). A DAWproject *exporter* is a possible later feature.

## Projects contain songs

A project is an album-shaped workspace: one or more songs plus shared material
reused across them. Songs are packages; shared material is a library; build
labels address both (`//songs/opener/mix:main`, `//shared/asset:rain`).

The shared library has three shelves, split by **contract** — make, is,
change ([projects/all/project-layout.md](projects/all/project-layout.md)
§1.1, §4.6): `instruments/` holds definitions that *make* sound (`.scd`
programs, later model definitions and AU references — however a sound or
a track ends up invoking them), `samples/` holds committed sound that
just *is*, and `plugins/` holds things that *change* sound. Whether a
definition renders from a spec or responds to MIDI is a property of how
it is invoked, not of the definition — the same `.scd` legitimately does
both — so there is no shelf split along that line, exactly as there is
no loops shelf (looping is a clip property). `shared/assets.yaml` is the
shared scope's ledger: one pin per committed file under `shared/`,
labeled `//shared/asset:<name>`.

Song directories are a workspace, not a library. `sounds/` holds one
file per **defined sound** — audio is committed bytes, a sound is a
definition, and a sound wrapped in an effect is a different sound —
while `audio/` holds *all* of a song's committed sound: recorded,
imported, or generated, the producer is irrelevant. Where a file lives
declares who may see it (project-layout.md §1.5): a clip references its
own song's names plus `//shared/asset:` pins, and nothing else.

```text
project/
├── field.yaml            # project manifest: name, engine versions
├── field.lock            # locked environment: plugin versions, model versions
├── shared/               # material reused across songs, by contract
│   ├── instruments/      # definitions that make sound (.scd, model defs, AU)
│   ├── samples/          # committed sound that just is
│   ├── plugins/          # things that change sound: chains and presets
│   └── assets.yaml       # the shared ledger: //shared/asset:<name>
├── songs/
│   └── <song>/
│       ├── song.yaml
│       ├── arrangement.yaml
│       ├── tempo.yaml
│       ├── markers.yaml
│       ├── tracks/       # one file per track: routing, inserts, clips
│       ├── sounds/       # one file per defined sound (type: + source:)
│       ├── mixes/        # one file per mix
│       ├── takes/        # take manifests (see below)
│       ├── comps/
│       ├── midi/
│       ├── audio/        # ALL committed song sound (LFS): recorded,
│       │                 # imported, generated (variants in audio/<sound>/)
│       ├── automation/
│       ├── assets.yaml   # the song's ledger
│       └── monitoring/
├── plugins/
│   ├── manifests/        # scanned plugin inventory
│   └── states/           # serialized AU state blobs
├── hardware/
│   └── apollo.yaml
└── .field/               # unversioned: cache, recording transactions, sockets
```

Exact schemas are designed in [projects/all/project-core.md](projects/all/project-core.md);
the layout and its vocabulary are decided in
[projects/all/project-layout.md](projects/all/project-layout.md).

A sound file is discriminated by `type:` (`supercollider`, `eq`,
`generative`, …) and fed by `source:` — a bare name resolving in the
song's one namespace (assets and sounds together), a
`//shared/asset:<name>` label crossing into the shared scope, or, for
`supercollider`, a program file (a bare filename resolves in
`shared/instruments/`). Automatic types are generated in-graph and
cached; the `generative` type is deliberate — its variants are committed
under `audio/<sound>/` and `field choose` repoints which one the
sound's label means.

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
means (`loop.every` resolves once, at the clip's position, and repeats as
that fixed interval thereafter). Arrays are resolved to ticks at load:
either spelling produces the
same build, and `field fmt` preserves whichever notation the author wrote,
keeping arrays single-line.

## Clips are metadata; audio is immutable

Audio files are never edited in place. A clip's content is its `source:`
— an asset, a sound, or a shared pin, resolved exactly like a sound's
own source. Clipping an automatic sound means the arrangement plays a
render that is never committed, only its definition; clipping a
`generative` sound plays its chosen committed variant. A clip carries
three independent, non-destructive offsets:

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
clips is implicitly buildable as `//songs/<song>/track:<name>`, a pre-fader
stem whose cache key sees clip placement but not the track fader, so mixing
decisions never invalidate rendered stems (see
[build-graph.md](build-graph.md) "Rules so far").

## Identity: names, not UUIDs

Nothing in a Field project carries an opaque ID. Identity comes in three
tiers, by how a thing gets it:

- **Humans name it → the slug is the ID.** Tracks (`lead-vocal`), songs
  (directory name), sounds, assets. Filenames are keys, and a song's
  asset and sound names share one namespace — `source: pad` must mean
  exactly one thing (project-layout.md §4.3), enforced by `field check`.
  Renaming is a repo-wide, tool-assisted refactor (`field track rename`
  rewrites every reference atomically), exactly as renaming a function
  is in code.
- **Content is the identity → SHA-256.** Assets and cached outputs.
- **Machines mint it → timestamp or slug-plus-short-random.** Takes are
  timestamped (`take-20260804-202355`, sortable, merge-safe); clips — which
  automation references stably — get a readable random suffix
  (`chorus-vox-x7f3q`).

The industry-standard alternative (opaque ID + display name, as in DAWproject
and every DAW format) was deliberately rejected: it makes every diff a join
table, which attacks Field's central thesis, while its supposed advantages
mostly don't survive scrutiny. `field check` validates referential integrity
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

All audio/MIDI assets are content-addressed: each scope's ledger — a
song's `assets.yaml`, or `shared/assets.yaml` with the identical shape —
binds a readable asset name to its file path, SHA-256, and size, and
clips/takes reference assets **by name** — so human-edited files stay
readable while the hash carries the content identity. The SHA-256 equals the Git LFS OID for the
same file, so the manifest, the LFS pointer, and the build cache share one
identifier. Where the bytes live is a pluggable detail. **Git LFS is backend
#1**;
a remote store (S3-backed) is a manifest-preserving migration later, when LFS
storage/bandwidth costs hurt. Generated variants are committed with their recipe and provenance,
never silently regenerated — and pinned by their own sound file's
per-variant hashes rather than the ledger (project-layout.md §4.8), so
every committed file is still pinned exactly once.

## Deliberate generation

A `generative` sound is provenance and promotion state in one file: model
name + version, prompt, seed, duration, conditioning, per-variant output
hashes — everything needed to audit or deliberately regenerate.
Reproducibility of the recipe is the contract; the committed bits are
the artifact. (For SuperCollider the "recipe" is the program plus an
explicit seed, and it *is* reproducible, which is why `supercollider` is
an automatic type instead.)

Concretely: `field generate <name> --song <song> --prompt …` runs the
model through its worker and writes `songs/<song>/sounds/<name>.yaml`
plus numbered variant WAVs under `audio/<name>/`. The sound is a
schema-validated project file — `field check` verifies variant hashes,
`field fmt` covers it — and each variant auditions as
`//songs/<song>/sound:<name>-<n>` via `field play`. `field choose
<name> --variant <n>` records `chosen:`, and from then on the sound's
own label resolves to that variant — clips say
`source: <name>` and follow every re-choose, a one-line diff. Nothing
is copied into a ledger, and nothing ever regenerates mechanically.
