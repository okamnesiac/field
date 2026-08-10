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
labels address both (`//songs/opener/track:main`, `//shared/asset:rain`).

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

Song directories are a workspace, not a library. `tracks/` holds one
file per track — every definition is a track (nested-tracks.md §18,
decision 12): an effect is an insert on one, a render or a generative
request is an entry in one — while `audio/` holds *all* of a song's
committed sound: recorded, imported, or generated, the producer is
irrelevant. Where a file lives declares who may see it
(project-layout.md §1.5): an entry references its own song's names plus
`//shared/asset:` pins, and nothing else.

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
│       ├── tempo.yaml
│       ├── markers.yaml
│       ├── tracks/       # one file per track: inserts and its inputs
│       ├── takes/        # take manifests (see below)
│       ├── comps/
│       ├── midi/
│       ├── audio/        # ALL committed song sound (LFS): recorded,
│       │                 # imported, generated — a directory per item
│       │                 # (audio/<name>/, project-layout.md §4.11)
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

`sounds/` retired when the last sound folded into a track
(nested-tracks.md §18, decision 12; `check` tells a surviving directory
the move). What its `type:` union expressed lives on where it attaches:
effects as `inserts:`, SuperCollider renders as `supercollider:`
entries (generated in-graph and cached), generative requests as
`generative:` entries — deliberate, their takes committed under
`audio/<name>/` with `field choose` repointing which one the gen node's
label means.

## Timeline and tempo

The tempo map is the single source of truth for the mapping between sample
time and musical time (`bar.beat.tick`). Everything that stores both — take
manifests store `started_at_samples` *and* `musical_position` — must define
which is authoritative and when the other is derived, so the two can never
disagree. The semantics of editing the tempo map under existing content
(do entries hold musical position or sample position?) is a per-track,
explicitly-stored property, not an ambient behavior.

Time fields in project YAML take two spellings
([projects/all/musical-time.md](projects/all/musical-time.md)): a scalar is
ticks (samples on absolute-anchored entries), and an array is musical,
resolved through the song's meter map. Positions are ordinal and 1-indexed
— `at: [9, 2]` is bar 9, beat 2 — while spans are cardinal counts where
zero is legal — `duration: [4]` is four bars, `every: [0, 2]` is two beats,
advanced from the field's anchor so meter changes mean what a musician
means (`loop.every` resolves once, at the entry's position, and repeats as
that fixed interval thereafter). Arrays are resolved to ticks at load:
either spelling produces the
same build, and `field fmt` preserves whichever notation the author wrote,
keeping arrays single-line.

## Entries are metadata; audio is immutable

Audio files are never edited in place. A track file is a name, an
optional `rate:`, an optional `time:`, optional `inserts:`, and one
list: `inputs:`
(nested-tracks.md §18). Every entry places one thing on the track's
timeline, named by the entry's field — the kind lives in the field name,
never in a value prefix:

- `track: <name>` — another track's render;
- `audio: <name>` — committed bytes, from the song's ledger or the one
  cross-scope spelling `audio: //shared/asset:<name>`;
- `supercollider:` — an inline render: `source:` (the program), `seed`,
  `duration`, `channels`, written where they play.
  The render is minted as its own node, `//songs/<song>/gen:<name>`,
  named by the owning track (or `<track>-<id>` when the entry carries an
  id — which is why a track holding two generators needs ids on them).
  Playing it means the arrangement plays a render that is never
  committed, only its definition;
- `generative:` — a deliberate request inline: `prompt:` (music) or
  `text:` (voice) plus the conditioning fields. It mints a `gen:` node
  under the same naming rule, but nothing in the build may run it — the
  node resolves to the chosen take, and its run-recorded state lives
  beside the audio (see "Deliberate generation"). The track file never
  changes when audio is generated or chosen.

`sound: <name>` was the transitional fourth kind — a defined sound,
bridging exactly as long as `sounds/` existed — and retired with the
last fold (§18 sequencing); the schema forwards the spelling to the
track its target folded into.

Placement fields are uniform across kinds — none of them means something
different depending on what produced the audio. An entry carries three
independent, non-destructive offsets:

1. **`at`** — where the entry sits on this track's timeline (musical
   position by default). Omitted means the track's start, for every
   kind — which is what lets a leaf read as bare content, and makes
   `at: 0` never worth writing.
2. **`source_offset`** — where the entry's window starts within its
   source.
3. **`slip`** — shifts content against the grid without moving the
   window's boundaries (as in Nio).

Fades, gain, pan, loops, and an optional `id` — the handle automation
attaches to — are entry metadata too. Every edit is a diff.

An entry's `duration` may be omitted, and then it plays the whole
source. The length is resolved when the source has rendered rather than
while planning, so it never enters the action key: "the whole of it"
re-keys through the source's own content hash. A looping entry is the
exception and must declare one, because a loop tiles a window and the
source fills it — and a loop on a source whose length is unknowable
before it builds (anything that renders, or committed audio at another
rate) must declare `every` too.

A track carries no level at all — `gain_db` and `pan` live on the entry
that consumes it (see below) — but it does carry `inserts:` (EQ,
limiter, reverb — discriminated on `effect:` so hosted plugins can join
later): inserts are *content*, baked into the stem, so editing one
re-renders the stem where a fader move never does. The split matters to
the build graph: every track is implicitly buildable as
`//songs/<song>/track:<name>`, a pre-fader stem whose cache key sees the
resolved placement plan but not the level applied above it, so mixing
decisions never invalidate rendered stems (see
[build-graph.md](build-graph.md) "Rules so far").

A `track:` entry carries a time and an optional window, so one track can
be placed in more than one parent and more than once in the same one,
from a single render
([projects/all/nested-tracks.md](projects/all/nested-tracks.md)); it is
checked like any entry (it must resolve to a track that is not an
ancestor), its `gain_db` and `pan` count toward `explain`'s level
answer, and the window powers — `source_offset`, `slip`, loops — apply
to it exactly as to committed audio.

A track may also carry its own time, in a `time:` key holding a `tempo`,
a `meter`, or both — a 7/8 figure inside a 4/4 song is a track that says
so, rather than a feature. Whichever half it omits comes from the song,
and so does everything for the great majority of tracks that declare no
`time:` at all. **From the song, never from the parent that places it:** a
track can have two parents and renders exactly once, so "bar 2" inside it
has to mean one thing no matter who consumes it. Everything in one track
file — every entry's `at` — is in that one
track's time.

The two timelines are never reconciled as maps. A track renders to
samples in its own time from its own sample 0; its parent's `at` resolves
to samples under the parent's map; the daemon sums by sample offset. So
placing a 7/8 child in a 4/4 parent is an addition, not a conversion.

A track may also carry its own `rate:` (multi-rate.md decision 3), the
project's `sample_rate` otherwise — the same inheritance shape as
`time:`, from the song and never from the placing parent, because a
track renders once. Rates convert only at edges: where a source's rate
differs from its track's — a 24 kHz generated take, a 44.1 kHz import,
a child tracked at 96 kHz — the graph mints a conversion node at the
placement (decision 4), content-addressed and shared by every placement
of that source at that rate, visible in `explain` and `deps()`. The
song's output track is the song, so it renders at the project rate and
refuses a `rate:` of its own; delivery at another rate is `field export
--rate` (decision 1), not a node in the song.

A placement also carries the level — `gain_db` and `pan` — and that is
where a level lives, rather than on the track. The two are one gain stage
seen from two directions: what a console calls a channel's fader is the
same thing its bus calls an input level, and a track with two parents
cannot hold one value for both. So the placement carries it, applied by
the parent while summing and therefore outside the child's own render,
which is how nesting keeps the pre-fader property rather than diluting
it. A track's own `gain_db`/`pan` are gone from the schema rather than
merely unread: a file that still sets one is told where the level went
rather than having it quietly ignored.

`pan` is a balance rather than a constant-power pan: it attenuates the
opposite channel and never boosts, so a hard-panned placement silences
one channel — 3 dB of total power for a centred source — and two pans on
one path compose per channel instead of adding up to a third pan. That is why `field explain <track>` answers
the level question by summing the gains along each path to a root and
*listing* the pans it passes rather than folding them together — a track
carries no level, so the only place the answer exists is spread across
the placements above it.

## Sends are cables

A send is the one edge that is not containment
([projects/all/nested-tracks.md](projects/all/nested-tracks.md) §19). The
sending track declares it under `sends:`, a map keyed by label; the
receiving track carries `- receive: <label>` among its `inputs:`; one
label links exactly one send to exactly one receive, like a patch cable.
The edge carries a level (`gain_db`) and a tap point (`tap: pre | post`,
default post — after the sender's inserts) and never an offset. A
receive admits signal, not a placement: it carries nothing but its
label — no position, no level, no id — because the level lives on the
send, the one place there is to write it. A bare label is a unity
post-insert send.

`field check` owns the wiring: a label on two sends or two receives is
an error, a label with one end is a *warning* — wiring incrementally is
normal — and cycles are checked on the combined graph, containment plus
cables, with the locally decidable case kept as its own message (a send
cannot reach into itself). A receive is legal only where the path from
its track up to the cable's common ancestor is a single unshifted pass:
`at`, `slip` and `source_offset` at their defaults and no `loop:`
(`duration` and fades stay legal — they window and shape without moving
anything). That rule is what lets arrival times be *derived* instead of
invented: the walk climbs from the receiver and, at every track on the
way up, collects the sender placements in that track's subtree — a
sender placed twice arrives twice, and a return carrying its own dry
copy of the sender hears it at zero *and* through the mix above. What
the walk never collects is the subtree it just climbed out of: those
are other instances of the containment the receiver sits in, and an
instance hears itself, not its siblings — which is also why a placement
*above* everything that joins may be displaced freely (the circuit
shifts as one) while one below may not. Where the receiving track
resolves through several parents, their views must agree, because
arrivals bake into a render that exists once however often it is placed
(disagreement is an error naming both paths), and identical landings
collapse to a count rather than repeating — a doubled sender is one
arrival at twice the amplitude.

A receive renders as ordinary clips: the sender's whole render — its
stem for a post tap, a shared pre-insert tap node for `pre` — placed at
each derived arrival at the cable's gain, converted at the edge if the
sender runs at another rate, and summed through the receiver's inserts
with everything else it plays. So the receive's action key re-keys on
exactly what §19 names — sender content, gain, tap and arrivals — and
on nothing else: a send-level tweak re-renders the receiver and
whatever consumes it, never the sender.
`field explain` shows a cable from either end, because the edge's gain
is part of a level answer neither track file holds in full.

## Identity: names, not UUIDs

Nothing in a Field project carries an opaque ID. Identity comes in three
tiers, by how a thing gets it:

- **Humans name it → the slug is the ID.** Tracks (`lead-vocal`), songs
  (directory name), assets. Filenames are keys, and a song's names are
  one namespace — `audio: pad` must mean exactly one thing
  (project-layout.md §4.3), enforced by `field check`.
  Renaming is a repo-wide, tool-assisted refactor (`field track rename`
  rewrites every reference atomically), exactly as renaming a function
  is in code.
- **Content is the identity → SHA-256.** Assets and cached outputs.
- **Machines mint it → timestamp or slug-plus-short-random.** Takes are
  timestamped (`take-20260804-202355`, sortable, merge-safe); input entries — which
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
binds a readable asset name to its file path, SHA-256, and size — plus,
for WAVs, the header's facts (`sample_rate`, `bit_depth`, `channels`,
`frames`), recorded at import and verified by `check` against the file
it already hashes (multi-rate.md decision 5); importing a rate the
project does not run at asks first, because a mismatch is a conversion
cost someone should pay knowingly — and
entries/takes reference assets **by name** — so human-edited files stay
readable while the hash carries the content identity. The SHA-256 equals the Git LFS OID for the
same file, so the manifest, the LFS pointer, and the build cache share one
identifier. Where the bytes live is a pluggable detail. **Git LFS is backend
#1**;
a remote store (S3-backed) is a manifest-preserving migration later, when LFS
storage/bandwidth costs hurt. Generated variants are committed with their request and provenance,
never silently regenerated — and pinned by their own takes file's
per-variant hashes rather than the ledger (project-layout.md §4.8), so
every committed file is still pinned exactly once.

## Deliberate generation

A deliberate generation is a request and a record, in two places. The
request is a `generative:` entry in a track file, carrying prompt or
text, duration, conditioning. The record is `audio/<name>/variants.yaml`,
where `<name>` is the gen node's name (the owning track's, or
`<track>-<id>`), and the file's first key attaches it (`gen:` — the
loader forwards a pre-fold `sound:` key to the rename). One entry per
take, each
carrying the model name + version that produced it, its seed, its output
hash, and when it ran — provenance sits on the take because that is what
it describes, and a request accumulates takes from runs months and model
versions apart.

They are separate files because they answer to different owners. The
request is shared; the takes and the pick are what your machine did, so
keeping them together would mean `field generate` and `field choose`
modified a committed file — which is also why generating never touches
the track file that carries the entry, byte for byte. The takes sit
*inside* the audio directory so that one decision governs both: ignore
the audio and its pins go too, commit the audio and the provenance comes
with it (bloom-in-tree.md §7). The split is on disk only — the loader
merges them, so everything downstream still reads the request's variants
and chosen take.
Reproducibility of the recipe is the contract; the committed bits are
the artifact. (For SuperCollider the "recipe" is the program plus an
explicit seed, and it *is* reproducible, which is why `supercollider` is
an automatic type instead.)

A request with no takes is legal, and is how a project ships when its
audio is not committed: there is no `variants.yaml` at all, `field
check` passes — the project is coherent, the audio is simply absent —
and `field build` or `field play` is what refuses, naming the request
and the `field generate` that fills it. Running that on an existing
takeless request fills it in place, reading the request from the entry
instead of the command line, so the flags that describe content are
refused there as a second answer.

Concretely: `field generate <song>/<name>` fills the request that
gen node name means, writing numbered variant WAVs and `variants.yaml`
under `audio/<name>/`; with content flags and a brand-new name, it
scaffolds a leaf track carrying the entry — the shape every request
lives in. `--seed` is optional: an omitted seed is drawn at random and
named in the output, and each take records the seed it ran with either
way — a seed is provenance, not reproducibility, since inference does
not reproduce across GPU/framework versions. One verb covers both
generators: `--prompt` is music, through field-aced, and `--text` is a
voice line, through field-voiced — the takes' `model:` records which
one ran, and its flags are the ones its kind takes (a voice line has no
`--bars`, because its length follows from the text). A voice line may
name the committed recording that defines its voice with `voice_ref`,
recorded as a name *and* the hash of the bytes read, or omit
it for the model's own voice — an entry authors both up front, and the
run verifies the hash rather than writing it back. Every file involved
is schema-validated — `field check` verifies variant hashes,
`field fmt` covers them — and each variant auditions as
`//songs/<song>/gen:<name>-<n>` via `field play`. Generating records
`chosen: 1`, so the request resolves as soon as it has takes; `field choose
<song>/<name> --variant <n>` moves `chosen:` to a different one, and from then
on the node's own label resolves to that variant — every placement
follows a re-choose as a one-line diff. `field explain` on the gen node
answers which take that is: `chosen: variant 2 of 2
(audio/<name>/2.wav)` — the choice, the take count, and the committed
file — while an audition label reports its own `file:` alone, being one
take rather than the choosing. Nothing
is copied into a ledger, and nothing ever regenerates mechanically:
generating over takes that already exist is refused, not merged.
