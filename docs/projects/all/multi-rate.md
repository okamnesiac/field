# Plan: Sample rate is a property of the track, converted at the edge

**Status:** In progress (2026-08-09). Step 1 (import reads headers,
decision 5) is implemented: the ledger records `sample_rate` /
`bit_depth` / `channels` / `frames`, check verifies them against the
file it already hashes, and a rate mismatch asks — `--allow-mismatch`
in scripts, y/N interactively. Steps 2 and 3 unstarted. Written because
chunk 6 of [nested-tracks.md](nested-tracks.md) hit `normalize` and
found two features sharing its schema (§1), and the inbound half's
shape depends on whether a project can hold more than one rate — so
that decision had to be made first, and made on record. Blocks the
remaining slices of nested-tracks chunk 6.

**Goal:** a track may run at its own sample rate, and rates convert only
at edges — a placement, an import, an export. "Convert before connecting"
becomes the rule, the way [nested-tracks.md](nested-tracks.md) §1.13 made
level an edge property: a child meets its parent at the placement, and
that is where the two timelines' rates meet too. A project tracked at
96 kHz delivers at 44.1 kHz without ever holding a file that lies about
its rate.

## 1 Why now: normalize is two features (2026-08-09)

`type: normalize` carries `source`, `sample_rate`, and `bit_depth`, and
bloom uses it twice in ways that share nothing but the executor:

- **`vocal-48k`** (creek) is *inbound conditioning*: Chatterbox emits
  24 kHz mono float, "which is no project's rate", and the wrapper is
  where the take enters the song's grid. Its `sample_rate: 48000` can
  only correctly hold one value — the project's — and its
  `bit_depth: 24` is unobservable, because stems are float internally
  and nothing downstream can see the 24.
- **`loop-cd`** (tall-grass) is *outbound formatting*: 44100/16 is CD.
  Nothing references it because nothing should — it is a deliverable you
  build, not an input. Both fields are real choices here.

A schema whose fields are load-bearing in one use and vestigial in the
other is two features. Chunk 6 cannot fold `normalize` into tracks as one
thing, and the insert formula ("a track with one input and one insert",
nested-tracks.md §1.12) fits neither: there is no `normalize` insert, and
an insert that can only restate `project.yaml` should not exist.

## 2 Decisions (DECIDED, 2026-08-09)

1. **Outbound formatting leaves tracks entirely.** Delivery rate and bit
   depth are export parameters: `field export --rate 44100 --bit-depth
   16`. The daemon's `op: 'normalize'` already does the work; export
   grows two flags and the conversion happens on the way out, never as a
   node in the song. `loop-cd` retires into an export invocation.

   *Rejected: a `normalize` insert carrying both fields.* A stem must be
   at its track's rate to be summed, so the insert's `sample_rate` could
   only restate the track's — a field with one correct value — and
   `bit_depth` on an internal float stem changes nothing a listener or a
   test could observe.

2. **Bit depth needs no track-level anything.** Stems are float
   internally; a 16-bit and a 24-bit source sum without conversion, so
   bit depth appears exactly twice in the system: on a committed file
   (a fact, recorded in the ledger) and at export (a choice, on the
   flag). The multi-*rate* problem is half the size the word "format"
   suggests.

3. **A track may declare `rate:`, defaulting to the project's.** Same
   inheritance shape as `time:` (nested-tracks.md §13): the song's rate
   unless the track says otherwise, never the placing parent's, because a
   track renders once. `project.yaml`'s `sample_rate` stays, demoted from
   "the rate" to the default rate and the rate of every song output.

4. **Rates convert at the placement, automatically, as a graph node.**
   When a child's rate differs from its parent's, the edge implies a
   conversion node: content-addressed, cached once, shared by every
   placement of that child at that parent rate. It appears in `field
   explain` and `query deps(...)` like any node — automatic to apply,
   visible on inspection, one render however many placements consume it.

   *Rejected: silent inline resampling in the daemon.* Invisible cost,
   and it would put a second resampler implementation in the render path
   ([render-pipeline.md](render-pipeline.md) §2.9 has exactly one).
   *Rejected: refusing mismatched placements and demanding a hand-written
   node* — the current behaviour, generalized. The error message already
   names the one correct fix ("add a normalize sound at 48000"); a
   diagnostic that knows the only right answer should apply it. Same
   smell as `field --version` printing the bare number: working as
   written, wrong as designed.

5. **Import reads the header, records the facts, and warns on a
   mismatch — acknowledged, not fatal.** `field import` gains the first
   content validation it has ever had: it reads the WAV header, records
   `sample_rate` (and `bit_depth`, `channels`, `frames`) in the ledger
   entry, and when the rate differs from the song's it says so and asks —
   `--allow-mismatch` in scripts, a y/N prompt interactively. Refusing
   outright was rejected: with decision 4, a mismatched asset is a
   *conversion cost*, not an error, and the warning exists so nobody pays
   it unknowingly. The acknowledgement is the answer to "you don't
   accidentally use a file that's the wrong sample rate without knowing
   it" — it fires at the moment the mistake is cheap to fix (re-export
   the source), not at first build weeks later.

   The ledger fields follow project-core.md §3.1's pattern for stored
   derived values: recorded at import, verifiable against the file
   `check` already hashes.

6. **The conditioning step stops being authored.** `vocal-48k`-style
   wrappers retire: a clip sources the sound directly, and the edge
   supplies the conversion. What §1 called the wrapper's deliberate
   property — re-choosing a take moves every consumer — survives, because
   the consumers reference the sound, not a variant.
   [voice-generation.md](voice-generation.md) §7 expects the 24 kHz model
   output to need "a `normalize` wrapper at the project rate" as its
   chunk 2's first act; under this decision that act becomes writing
   nothing — the edge supplies the conversion — and §7 gains a note
   saying so when this lands, not before.

## 3 What this costs

- **Chunk 2's "only offsets add" weakens to "offsets add within a
  rate".** nested-tracks.md §13 could say sample offsets compose by pure
  addition because every stem shared one rate. Across a rate boundary the
  parent computes its offset in its own rate from ticks, and the child's
  stem passes through the edge conversion first. The tick layer is
  untouched — ticks were never rate-dependent — but §13 gains an
  amendment when this lands.
- **Every action key re-keys once.** `project_sample_rate` in the key
  becomes the *effective track rate*. One-time full re-render — the same
  deliberate price the `sc-render` → `supercollider` value change paid
  ([project-layout.md](project-layout.md) §4.4, and the comment on
  `actionKey` in `graph/build.ts` that cites it).
- **The daemon plans stay single-rate.** Every plan the daemon sees is at
  one rate, with conversions as separate upstream actions — `plan.cpp`
  needs nothing.

## 4 Sequencing

Before the real-time engine, by nested-tracks.md §9's own argument: this
changes the model the engine renders (a channel's rate), and doing it
after means changing the schema and the engine both.

1. **Import reads headers** (decision 5). Free-standing; no format
   change; ships alone.
2. **Export grows `--rate` / `--bit-depth`** (decision 1). Frees
   `loop-cd` to retire; nested-tracks chunk 6 can resume after this.
3. **`rate:` on tracks + edge conversion** (decisions 3, 4, 6). The
   re-keying change, so it lands alone and last.

Chunk 6 of nested-tracks resumes after step 2 — the effect sounds it
still has to fold are eq (an insert, decided) and the two normalizes
(retired by steps 2 and 3 respectively).

## 5 Definition of done

bloom keeps a 44.1 kHz asset somewhere with its ledger entry recording
it; `field import` of a mismatched file warns and records; `field export
--rate 44100 --bit-depth 16` of tall-grass produces the file `loop-cd`
used to describe, bit-identical to that sound's render; a track declared
at a non-project rate renders, places, and explains, with the conversion
node visible in `deps()`; and `rg 'type: normalize'` over `examples/`
finds nothing.
