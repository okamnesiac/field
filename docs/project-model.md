# Project model

The canonical project representation is language-neutral,
schema-validated YAML in a normalized directory structure, optimized
for: semantic Git diffs, stable ordering, deterministic formatting,
mergeability, human and agent readability, explicit IDs, and explicit
dependencies.

**Decision — a native format, not DAWproject.** DAWproject is
interchange-oriented XML: poor for diffs and merges, and it models a
DAW's concepts rather than Field's (no takes-as-manifests, no build
targets, no generation recipes). A DAWproject *exporter* is a possible
later feature.

## Projects contain songs

A project is an album-shaped workspace: one or more songs plus shared
material reused across them. Songs are packages; shared material is a
library; build labels address both (`//songs/opener/track:main`,
`//shared/asset:rain`).

```text
project/
├── field.yaml            # project manifest: name, engine versions
├── shared/               # material reused across songs, by contract
│   ├── instruments/      # definitions that make sound (.scd, model defs, AU)
│   ├── samples/          # committed sound that just is
│   ├── plugins/          # things that change sound: chains and presets
│   └── assets.yaml       # the shared ledger: //shared/asset:<name>
├── songs/
│   └── <song>/
│       ├── song.yaml     # name, time (tempo + meter), rate, length, loop
│       ├── tracks/       # one file per track: inserts and its inputs
│       ├── audio/        # ALL committed song sound (LFS): recorded,
│       │                 # imported, generated — a directory per item
│       │                 # (audio/<name>/), takes and their pins
│       │                 # beside the bytes (project-layout.md §4.11)
│       └── assets.yaml   # the song's ledger
└── .field/               # unversioned: cache, recording transactions, sockets
```

Designed but not yet built, arriving with the features that write them:
`field.lock` (the locked plugin and model environment), `markers.yaml`,
`automation/`, `monitoring/`, the scanned plugin inventory and AU state
blobs, and `hardware/apollo.yaml`. Recorded takes are deliberately not
on that list — they add no directory (see "Takes" below).

Exact schemas are designed in
[projects/all/project-core.md](projects/all/project-core.md); the layout
and its vocabulary are decided in
[projects/all/project-layout.md](projects/all/project-layout.md).

### The shared library

The shared library has three shelves, split by **contract** — make, is,
change (project-layout.md §1.1, §4.6):

- **`instruments/`** holds definitions that *make* sound: `.scd`
  programs, later model definitions and AU references.
- **`samples/`** holds committed sound that just *is*.
- **`plugins/`** holds things that *change* sound: chains and presets.

Whether a definition renders from a spec or responds to MIDI is a
property of how it is invoked, not of the definition — the same `.scd`
legitimately does both — so there is no shelf split along that line,
exactly as there is no loops shelf (looping is a clip property).
`shared/assets.yaml` is the shared scope's ledger: one pin per committed
file under `shared/`, labeled `//shared/asset:<name>`.

### Song directories

Song directories are a workspace, not a library. `tracks/` holds one
file per track — every definition is a track: an effect is an insert on
one, a render or a generative request is an entry in one (see
[tracks.md](tracks.md)) — while `audio/` holds *all* of a song's
committed sound: recorded, imported, or generated, the producer is
irrelevant.

Where a file lives declares who may see it (project-layout.md §1.5): an
entry references its own song's names plus `//shared/asset:` pins, and
nothing else.

## Tracks

The track is the structural primitive: structure, local time, and the
mixer are one tree of track files, and the song itself is the track
named `main`. The track file, its entry kinds, placement, nesting,
levels, local time and rate, and sends are described in
[tracks.md](tracks.md).

## Timeline and tempo

The tempo map is the single source of truth for the mapping between
sample time and musical time (`bar.beat.tick`). Everything that stores
both — take manifests store `started_at_samples` *and*
`musical_position` — must define which is authoritative and when the
other is derived, so the two can never disagree. The semantics of
editing the tempo map under existing content (do entries hold musical
position or sample position?) is a per-track, explicitly stored
property, not an ambient behavior.

Time fields in project YAML take two spellings
([projects/all/musical-time.md](projects/all/musical-time.md)): a scalar
is ticks (samples on absolute-anchored entries), and an array is
musical, resolved through the song's meter map.

- Positions are ordinal and 1-indexed: `at: [9, 2]` is bar 9, beat 2.
- Spans are cardinal counts where zero is legal: `duration: [4]` is four
  bars, `every: [0, 2]` is two beats, advanced from the field's anchor
  so meter changes mean what a musician means. `loop.every` resolves
  once, at the entry's position, and repeats as that fixed interval
  thereafter.

Arrays are resolved to ticks at load: either spelling produces the same
build, and `field fmt` preserves whichever notation the author wrote,
keeping arrays single-line.

The arrangement is derived, not authored (nested-tracks.md §11): a
song's structure *is* its output track's placements, and
`field arrangement <song>` prints them as a timeline (see
[tracks.md](tracks.md) "The output track"). There is no
`arrangement.yaml`.

## Identity: names, not UUIDs

Nothing in a Field project carries an opaque ID. Identity comes in three
tiers, by how a thing gets it:

- **Humans name it → the slug is the ID.** Tracks (`lead-vocal`), songs
  (directory name), assets. Filenames are keys, and a song's names are
  one namespace — `audio: pad` must mean exactly one thing
  (project-layout.md §4.3), enforced by `field check`. Renaming is a
  repo-wide, tool-assisted refactor, exactly as renaming a function is
  in code.
- **Content is the identity → SHA-256.** Assets and cached outputs.
- **Machines mint it → a number or a timestamp.** Generated takes are
  numbered within their request (`audio/<name>/2.wav`); recorded takes
  get timestamps (`take-20260804-202355`, sortable, merge-safe). Entry
  `id:`s — which automation will reference stably — are author-written
  slugs; the slug-plus-short-random convention (`chorus-vox-x7f3q`)
  keeps one unique without pretending to mean something.

The industry-standard alternative (opaque ID + display name, as in
DAWproject and every DAW format) was deliberately rejected: it makes
every diff a join table, which attacks Field's central thesis, while its
supposed advantages mostly don't survive scrutiny. `field check`
validates referential integrity (in CI, and after merges — cross-branch
dangling references merge cleanly under *any* ID scheme). The full
argument is preserved in
[projects/all/project-core.md](projects/all/project-core.md) §6 — read
it before reopening this.

## Takes

A take is one performance of something. Takes are numbered,
auditionable, never destroyed; each thing that has takes plays exactly
one — the active take — and switching is a one-line edit to its record.

Takes cover more than recording: **a render of a nondeterministic node
is a take.** A hardware-synth bounce, a free-running-LFO chorus render —
multiple valid performances of the same recipe. They reuse the same
machinery: list, audition, select active, pin. See
[build-graph.md](build-graph.md) for the determinism policy.

The takes that exist today are generated ones: numbered WAVs with their
record beside them under `audio/<name>/` (see "Deliberate generation").
Recording follows the same shape when it arrives (decided 2026-08-10): a
recorded take's record — placement, device, latency, session context —
lives beside its bytes under `audio/`, because the decision to commit
the audio must be the decision to commit its record
([projects/all/bloom-in-tree.md](projects/all/bloom-in-tree.md) §7). A
separate manifest directory whose gitignore rule could quietly disagree
with the audio's — the earlier `takes/<track>/` design — is exactly what
that fold retired for variants. Comping (one active take assembled from
several) is part of the recording work.

## Assets

Audio files are never edited in place; all placement and editing is
metadata. All audio/MIDI assets are content-addressed: each scope's
ledger — a song's `assets.yaml`, or `shared/assets.yaml` with the
identical shape — binds a readable asset name to its file path, SHA-256,
and size, plus, for WAVs, the header's facts (`sample_rate`,
`bit_depth`, `channels`, `frames`), recorded at import and verified by
`check` against the file it already hashes (multi-rate.md decision 5).

`field import <file>` is what writes a ledger entry. Importing a rate
the project does not run at asks first, because a mismatch is a
conversion cost someone should pay knowingly.

Entries and takes reference assets **by name**, so human-edited files
stay readable while the hash carries the content identity. The SHA-256
equals the Git LFS OID for the same file, so the manifest, the LFS
pointer, and the build cache share one identifier. Where the bytes live
is a pluggable detail: **Git LFS is backend #1**, and a remote store
(S3-backed) is a manifest-preserving migration later, when LFS
storage/bandwidth costs hurt.

Generated variants are committed with their request and provenance,
never silently regenerated — and pinned by their own takes file's
per-variant hashes rather than the ledger (project-layout.md §4.8), so
every committed file is still pinned exactly once.

## Deliberate generation

A deliberate generation is a request and a record, in two places.

### The request

The request is a `generative:` entry in a track file, carrying `prompt:`
(music) or `text:` (voice) plus duration and conditioning. It is shared,
committed, and never modified by generation: `field generate` and
`field choose` leave the track file untouched, byte for byte.

```yaml
# songs/creek/tracks/still-water-keys.yaml (abridged)
name: still-water-keys
inputs:
  - generative:
      prompt: dreamy electric piano chords, sparse and warm, minor key, ambient, gentle
      bpm: 96
      duration_seconds: 10
      bars: 4
```

A request with no takes is legal, and is how a project ships when its
audio is not committed: there is no `variants.yaml` at all, and
`field check` passes — the project is coherent, the audio is simply
absent. `field build` or `field play` is what refuses, naming the
request and the `field generate` that fills it.

### The record

The record is `audio/<name>/variants.yaml`, where `<name>` is the gen
node's name. One entry per take, each carrying the model name and
version that produced it, its seed, its output hash, and when it ran:

```yaml
# songs/creek/audio/still-water-keys/variants.yaml
gen: still-water-keys
chosen: 1
variants:
  - file: audio/still-water-keys/1.wav
    model: acestep-v15-turbo
    seed: 90210
    sha256: 128bab7fbe7692f53a9e2f0358c3d0c3d401ddc61a60e3bf4f8a547ba3b66a91
    generated_at: 2026-08-05T23:45:04.746Z
  - file: audio/still-water-keys/2.wav
    ...
```

Provenance sits on the take because that is what it describes: a request
accumulates takes from runs months and model versions apart, and a seed
is provenance, not reproducibility, since inference does not reproduce
across GPU and framework versions.

Request and record are separate files because they answer to different
owners: the request is shared, while the takes and the pick are what
your machine did. The takes sit *inside* the audio directory so one
decision governs both — ignore the audio and its pins go too, commit the
audio and the provenance comes with it (bloom-in-tree.md §7). The split
is on disk only; the loader merges them.

### Generating and choosing

`field generate <song>/<name>` fills the request that gen node name
means, writing numbered variant WAVs and `variants.yaml` under
`audio/<name>/`. With content flags and a brand-new name, it scaffolds a
leaf track carrying the entry — the shape every request lives in.
Running it against a request that already has takes is refused, not
merged: nothing ever regenerates mechanically.

One verb covers both generators: `--prompt` is music, through
`field-aced`, and `--text` is a voice line, through `field-voiced`. Each
kind takes its own flags — a voice line has no `--bars`, because its
length follows from the text — and `--seed` is optional: an omitted seed
is drawn at random and named in the output, and each take records the
seed it ran with either way. A voice line may name the committed
recording that defines its voice with `voice_ref`, recorded as a name
*and* the hash of the bytes read, or omit it for the model's own voice;
the run verifies the hash rather than writing it back.

Generating records `chosen: 1`, so the request resolves as soon as it
has takes. `field choose <song>/<name> --variant <n>` moves `chosen:`,
and from then on the node's label resolves to that variant — every
placement follows a re-choose as a one-line diff. Each variant auditions
as `//songs/<song>/gen:<name>-<n>` via `field play`, and `field explain`
on the gen node answers which take is chosen:
`chosen: variant 2 of 2 (audio/<name>/2.wav)`.

Every file involved is schema-validated: `field check` verifies variant
hashes, and `field fmt` covers them.
