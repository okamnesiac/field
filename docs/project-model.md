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
`automation/`, `monitoring/`, and `hardware/apollo.yaml`. Recorded takes
are deliberately not on that list — they add no directory (see "Takes"
below) — and neither is hosted plugins' state, whose blobs live under
`shared/plugins/` as described below.

Exact schemas are designed in
[projects/project-core/readme.md](projects/project-core/readme.md); the layout
and its vocabulary are decided in
[projects/project-layout/readme.md](projects/project-layout/readme.md).

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
file under `shared/`, labeled `//shared/asset:<name>` — with one
deliberate exception: plugin state blobs under `shared/plugins/`
(`<slug>/<sha256>.state`,
[projects/plugin-hosting/readme.md](projects/plugin-hosting/readme.md)
decision 4) carry no ledger row, because a blob's filename *is* its
content hash — the drift guard a pin exists to add is intrinsic there,
and reads resolve by hash so the directory is a convention rather than
an address.

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
([projects/musical-time/readme.md](projects/musical-time/readme.md)): a scalar
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
[projects/project-core/readme.md](projects/project-core/readme.md) §6 — read
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

Two kinds exist: generated takes, numbered WAVs with their record beside
them under `audio/<name>/` (see "Deliberate generation"), and recorded
takes, timestamp-named WAVs with theirs (see "Recorded takes"). Both
keep the record beside the bytes under `audio/`, because the decision to
commit the audio must be the decision to commit its record
([projects/bloom-in-tree/readme.md](projects/bloom-in-tree/readme.md) §7). A
separate manifest directory whose gitignore rule could quietly disagree
with the audio's — the earlier `takes/<track>/` design — is exactly what
that fold retired for variants. Comping (one active take assembled from
several) is part of the recording work still to come.

## Assets

Audio files are never edited in place; all placement and editing is
metadata. All audio/MIDI assets are content-addressed: each scope's
ledger — a song's `assets.yaml`, or `shared/assets.yaml` with the
identical shape — binds a readable asset name to its file path, SHA-256,
and size, plus, for WAVs, the header's facts (`sample_rate`,
`bit_depth`, `channels`, `frames`), recorded at import and verified by
`check` against the file it already hashes (multi-rate.md decision 5).

`field import <file>` is what writes a ledger entry. Importing a rate
the song does not run at asks first, because a mismatch is a
conversion cost someone should pay knowingly.

Entries and takes reference assets **by name**, so human-edited files
stay readable while the hash carries the content identity. The SHA-256
equals the Git LFS OID for the same file, so the manifest, the LFS
pointer, and the build cache share one identifier. Where the bytes live
is a pluggable detail: **Git LFS is backend #1**, and a remote store
(S3-backed) is a manifest-preserving migration later, when LFS
storage/bandwidth costs hurt.

field hashes files as they sit on disk, not as Git stores them: a
`.scd` program's content hash is an input to its render, and `check`
compares each manifest byte for byte with its canonical form. A
checkout that rewrites line endings changes those answers while
`git status` stays clean, and Git for Windows does that by default
(`core.autocrlf=true`). So the `.gitattributes` that `field init`
writes opens with `* text=auto eol=lf`, which checks text out with LF
on every platform. The LFS rules for audio and `*.state binary` for
plugin state blobs follow it and override it, because Git applies the
last matching rule. `init` keeps a `.gitattributes` that already
exists, so in a project created before `init` wrote the LF rule, add
`* text=auto eol=lf` by hand above the LFS lines.

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

## Recorded takes

A recorded take is the generative pattern with a person where the model
was ([projects/recording/readme.md](projects/recording/readme.md) §1):
a `record:` entry in a track file asks for a performance, and the takes
beside the audio say which performances exist and which one plays.

### The entry

The entry carries no device or input — bare `- record:` — because the
device and input you record through are facts about your machine, not
the song (recording.md §4). The one thing it may name is an instrument,
which makes it record MIDI instead of audio (see "MIDI takes" below).
It places like every other entry: `at`, `duration`, `gain_db`, and the
rest apply to the window the takes fill. It never loops.

```yaml
# songs/creek/tracks/lead-vocal.yaml
name: lead-vocal
inputs:
  - record:
```

An entry with no takes yet builds as silence, and `field check` says so
as a warning rather than an error, so you can place the track and loop
the mix before the first take exists. `field record creek/track:lead-vocal`
is what fills it.

### The record

The record is `audio/<name>/takes.yaml`, where `<name>` is the record
node's name — the track's, or `<track>-<id>` when the entry carries an
`id`. One row per take. The bytes pin in the song's ledger under the
take's name, where imported audio pins, so the row carries the record
and never a hash:

```yaml
# songs/creek/audio/lead-vocal/takes.yaml
record: lead-vocal
chosen: take-20260907-143012
takes:
  - asset: take-20260907-143012
    started_at_samples: 806400
    musical_position: [17]
    latency: 270
    device: Apollo Twin X
    input: 1
    monitoring: apollo-direct
    console_preset: vocal-tracking
    recorded_at: 2026-09-07T14:30:12.000-04:00
```

`started_at_samples` is where the take's first sample sits on the
recording track's timeline, counted from the record entry's own `at`
(zero for a bare entry) at the track's rate, and `latency` is how far
the capture ran behind it — the device's declared round trip, input
plus output. The take sounds at the entry's window start plus their
difference and nothing else; `musical_position` records what the song's
map said at capture and is never arithmetic. Moving the entry's `at`
moves its takes with it, as every other entry's content moves. `field
record` writes the row when a take lands,
choosing it, and `field choose creek/lead-vocal --take <name>` moves
`chosen` the way `--variant` moves a gen node's.

Request and record are separate files because they answer to different
owners: the request is shared, while the takes and the pick are what
your machine did. The takes sit *inside* the audio directory so one
decision governs both — ignore the audio and its pins go too, commit the
audio and the provenance comes with it (bloom-in-tree.md §7). The split
is on disk only; the loader merges them.

### MIDI takes

A record entry that names an instrument records what you play on
`field keys` or a controller, and you hear it through that instrument
([projects/keyboard-instrument/readme.md](projects/keyboard-instrument/readme.md)
§12). The instrument resolves as `field keys` resolves one: a name
without `.scd` gets it, and a name without a `/` is under
`shared/instruments/`. Its program must answer `FIELD_MODE=voice`.

```yaml
# songs/creek/tracks/keys.yaml
name: keys
inputs:
  - record:
      instrument: still-water-pad
```

A MIDI take is a notes file, `audio/<name>/<take>.notes.yaml`, pinned
in the ledger like any take, with one flow row per note, controller
change, and pitch bend, in samples at the capture's rate:

```yaml
# songs/creek/audio/keys/take-20261010-143012.notes.yaml
sample_rate: 48000
length: 96000
notes:
  - { at: 0, length: 24000, note: 60, velocity: 100 }
  - { at: 12000, length: 84000, note: 64, velocity: 90 }
controls:
  - { at: 6000, cc: 64, value: 127 }
bends: []
```

A note still held when the take stopped lasts to its end, and
`channel` appears only when it is not 1. Its row carries `sources`, the
MIDI inputs the take listened to, where an audio row carries `device`
and `input`, and its `latency` is the output latency alone: you play
in time with what you hear, which runs behind the playhead by that
much.

The build renders the chosen take through the instrument as a `gen:`
node named like the record node, and the entry places that render. A
take of the other kind than its entry records is an error in `field
check`, as is an instrument whose program is missing or outside the
project: it resolves by the rule a `supercollider:` entry's `source:`
does. The notes file has one
writer, `field record`. Editing it by hand changes its hash, and the
build then refuses it, as it refuses any pinned file whose bytes
changed.

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
