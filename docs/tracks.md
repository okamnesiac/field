# Tracks

The track is Field's one structural primitive. Every definition is a
track: an instrument is a leaf track carrying its program, an effect is
an insert on a track, a submix is a track placing other tracks, and the
song itself is the track named `main`. Structure, local time, and the
mixer are all the same tree.

This page describes the track file and the tree it builds. For how
tracks become buildable stems — action keys, caching, conversion nodes —
see [build-graph.md](build-graph.md).

## A track file

A track is one file, `songs/<song>/tracks/<name>.yaml`, with at most
five keys besides its name: `rate:`, `time:`, `inserts:`, `sends:`, and
the one list every track has — `inputs:`. From
[`examples/bloom`](../examples/bloom/README.md):

```yaml
# songs/creek/tracks/keys.yaml
name: keys
sends:
  keys-verb:
    gain_db: -14
inputs:
  - id: keys-loop-p4t2n
    track: still-water-keys
    at: [1]
    duration: [4]
```

There is no `type:` — every track is audio — and no track-level
`gain_db` or `pan`; levels live on the placement that consumes the track
(see [Levels live on placements](#levels-live-on-placements)).

## What an entry places

Every entry in `inputs:` places one thing on the track's timeline, and
the kind lives in the field name, never in a value prefix:

- **`track: <name>`** — another track's render. This is the nesting
  edge: the whole tree below the named track joins this one.
- **`audio: <name>`** — committed bytes, from the song's ledger, or the
  one cross-scope spelling `audio: //shared/asset:<name>`.
- **`supercollider:`** — an inline render: `source:` (the program),
  `seed`, `duration`, `channels`. The render is minted as its own
  `gen:` node, cached and addressable like any rule.
- **`generative:`** — a deliberate request: `prompt:` (music) or
  `text:` (voice) plus conditioning. Nothing in the build may run it;
  the node resolves to the chosen committed take. See
  [project-model.md](project-model.md) "Deliberate generation".
- **`receive: <label>`** — the receiving end of a cable. A receive
  admits signal rather than placing it, so it carries nothing but its
  label; `check` rejects any other key on it. See
  [Sends are cables](#sends-are-cables).

A `gen:` node is named by its owning track, or `<track>-<id>` when the
entry carries an `id` — which is why a track holding two generators
needs ids on them.

## Placement fields

Placement fields are uniform across the kinds that place content — none
of them means something different depending on what produced the audio.

An entry carries three independent, non-destructive offsets:

1. **`at`** — where the entry sits on this track's timeline. Omitted
   means the track's start, for every kind — which is what lets a leaf
   read as bare content, and makes `at: 0` never worth writing.
2. **`source_offset`** — where the entry's window starts within its
   source.
3. **`slip`** — shifts content against the grid without moving the
   window's boundaries.

Beyond the offsets, an entry can carry `duration`, `fade_in` and
`fade_out`, `gain_db` and `pan`, a `loop:` map, and an optional `id` —
the handle automation attaches to. Every edit is a diff.

Time fields take two spellings — a scalar is ticks, an array is musical
(`at: [9, 2]` is bar 9, beat 2) — described in
[project-model.md](project-model.md) "Timeline and tempo".

Two rules about `duration`:

- **Omitted `duration` plays the whole source.** The length resolves
  when the source has rendered, so it never enters the action key: "the
  whole of it" re-keys through the source's own content hash.
- **A looping entry must declare one**, because a loop tiles a window
  and the source fills it. A loop on a source whose length is unknowable
  before it builds (anything that renders, or committed audio at another
  rate) must declare `every` too.

## Nesting: one render, many placements

A `track:` entry places another track the way an `audio:` entry places a
file: with a time, an optional window, and all the window powers —
`source_offset`, `slip`, loops. One track can be placed in more than one
parent, and more than once in the same one, from a single render.

creek is the working example: the song is three passes of a four-bar
phrase, and the structure says so directly —

```yaml
# songs/creek/tracks/main.yaml (abridged)
name: main
inputs:
  - track: phrase
    at: [1]
  - track: phrase
    at: [5]
  - track: phrase
    at: [9]
```

Placing a track pulls its whole definition into the parent's subgraph:
the arrangement can play audio nothing ever committed, and editing the
definition rebuilds straight through every parent. `check` requires that
a placed track resolve to a track that is not an ancestor.

## Levels live on placements

A track carries no level. `gain_db` and `pan` live on the entry that
consumes it, because a fader and a bus input level are one gain stage
seen from two directions — and a track with two parents cannot hold one
value for both. The parent applies the level while summing, outside the
child's own render, which is how nesting keeps stems pre-fader: mixing
decisions never invalidate rendered stems.

A file that still sets a track-level `gain_db` is told where the level
went rather than having it quietly ignored.

`pan` is a balance, not a constant-power pan: it attenuates the opposite
channel and never boosts, so a hard-panned placement silences one
channel — 3 dB of total power for a centred source — and two pans on one
path compose per channel instead of adding up to a third pan. That is
why `field explain <track>` answers the level question by summing the
gains along each path to a root and *listing* the pans it passes: a
track carries no level, so the answer only exists spread across the
placements above it.

## Inserts are content

`inserts:` is the other half of the split: an insert chain (EQ, limiter,
and the reverbs — `reverb`, the Freeverb classic, and `plate`, the
Dattorro tank with a modulated tail; discriminated on `effect:` so
hosted plugins can join later) is
*content*, baked into the stem. Editing an insert re-renders the stem;
moving a fader never does. Chains compose by nesting — a track wrapped
in an effect is a different track, cached per link.

## Local time and rate

A track may carry its own time, in a `time:` key holding a `tempo`
list, a `meter` list, or both — a 7/8 figure inside a 4/4 song is a
track that says so, rather than a feature:

```yaml
time:
  meter:
    - at: 0
      numerator: 7
      denominator: 8
```

Whichever half it omits comes from the song, and so does everything for
the great majority of tracks that declare no `time:` at all.
Inheritance is **from the song, never from the parent that places it**:
a track can have two parents and renders exactly once, so "bar 2" inside
it has to mean one thing no matter who consumes it. Every `at` in one
track file is in that one track's time.

The two timelines are never reconciled as maps. A track renders to
samples in its own time from its own sample 0; its parent's `at`
resolves to samples under the parent's map; the daemon sums by sample
offset. Placing a 7/8 child in a 4/4 parent is an addition, not a
conversion.

`rate:` follows the same inheritance shape (multi-rate.md decision 3,
amended): a track renders at its declared rate, otherwise the song's
`rate:`, otherwise the project's `sample_rate` — from the song and
never from the placing parent. Rates
convert only at edges — where a source's rate differs from its track's,
the graph mints a conversion node at the placement, shared by every
placement of that source at that rate and visible in `explain` and
`deps()` (see [build-graph.md](build-graph.md) "Node types and their
generators").

## The output track

The track named `main` is the song's output. It carries the song's
declared `length` and `loop` and renders exactly that long, with `loop:`
folding the overhang back onto the start. A bare song reference resolves
to it: `field play creek` evaluates the song live in the engine rooted
at `main` (realtime.md decision 8), and `field play creek/track:main`
plays the built artifact of the same tree. Either spelling plays on
any device: when the output cannot switch to the song's rate, live
delivery converts through the project's own resampler
(cross-rate-live.md decision 3), as the artifact path's transport
always did. Because the
output track is the song, it renders at the song's rate — its `rate:`,
or the project's `sample_rate` — and refuses a `rate:` of its own;
delivery at another rate is `field export --rate`, not a node in the
song.

The song's structure *is* the output track's placements:
`field arrangement <song>` prints them as a timeline, one line per
authored entry —

```console
$ field arrangement tall-grass
tall-grass
  1.1.1 0:00.0  bass
  1.1.1 0:00.0  drums
  1.1.1 0:00.0  room  (-6 dB)
```

## Sends are cables

A send is the one edge that is not containment
([projects/all/nested-tracks.md](projects/all/nested-tracks.md) §19).
The sending track declares it under `sends:`, a map keyed by label; the
receiving track carries `- receive: <label>` among its `inputs:`. One
label links exactly one send to exactly one receive, like a patch cable.

```yaml
# songs/tall-grass/tracks/drums.yaml (abridged)
name: drums
sends:
  drum-verb:
    gain_db: -10
inputs:
  - track: seven-eight-loop
    at: [1]
    duration: [2]
```

```yaml
# songs/tall-grass/tracks/room.yaml (abridged)
name: room
inserts:
  - effect: reverb
    mix: 1.0
    decay: 1.2
inputs:
  - receive: drum-verb
```

The edge carries a level (`gain_db`) and a tap point (`tap: pre | post`,
default post — after the sender's inserts) and never an offset. The
level lives on the send because that is the one place there is to write
it; a bare label is a unity post-insert send.

### What check enforces

`field check` owns the wiring:

- A label on two sends, or on two receives, is an **error** — a cable
  has two ends, not three.
- A label with one end is a **warning**: wiring incrementally is normal,
  so a dangling end reports without failing the gate.
- Cycles are checked on the combined graph, containment plus cables. The
  locally decidable case keeps its own message: a send cannot reach into
  itself.
- A receive is legal only where the path from its track up to the
  cable's common ancestor is a single unshifted pass: `at`, `slip` and
  `source_offset` at their defaults and no `loop:`. `duration` and fades
  stay legal — they window and shape without moving anything.

### Arrivals are derived

The unshifted-pass rule is what lets arrival times be *derived* instead
of invented. The walk climbs from the receiver and, at every track on
the way up, collects the sender placements in that track's subtree:

- A sender placed twice arrives twice; loop repetitions each arrive.
- A return carrying its own dry copy of the sender hears it at zero
  *and* through the mix above.
- The walk never collects the subtree it just climbed out of: those are
  other instances of the containment the receiver sits in, and an
  instance hears itself, not its siblings.
- Where the receiver resolves through several parents, their views must
  agree — arrivals bake into a render that exists once however often it
  is placed, so disagreement is an error naming both paths.
- Identical landings collapse to a count: a doubled sender is one
  arrival at twice the amplitude.

creek's shared reverb shows the shape: `keys` sends from inside the
thrice-placed phrase, so the room hears it once per pass —

```console
$ field explain creek/track:space
...
cable: receive "keys-verb" ← track:keys, -14.0 dB (tap post), 3 arrivals at samples 0, 480000, 960000
cable: receive "vocal-verb" ← track:lead-vocal, -10.0 dB (tap post), arrives at sample 0
```

### How a receive renders

A receive renders as ordinary clips: the sender's whole render — its
stem for a post tap, a shared pre-insert tap node for `pre` — placed at
each derived arrival at the cable's gain, converted at the edge if the
sender runs at another rate, and summed through the receiver's inserts
with everything else it plays.

The receive's action key re-keys on exactly what §19 names — sender
content, gain, tap and arrivals — and on nothing else. A send-level
tweak re-renders the receiver and whatever consumes it, never the
sender: in creek, a reverb-send tweak rebuilds `space` and `main` while
every other stem stays a cache hit. `field explain` shows a cable from
either end, because the edge's gain is part of a level answer neither
track file holds in full.
