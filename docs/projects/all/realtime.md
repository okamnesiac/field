---
status: Draft
---

# Plan: Realtime

**Goal:** the graph runs live — edit YAML while the song plays and hear
it next block — while `field build` stays exactly what it is: stems,
caching, and the generation pipeline. Two render paths, one DSP
library, and the build cache doubling as automatic track freezing.

## 1 Shape

- The engine becomes a live evaluator of the project graph:
  `field-audiod` streams committed sources from disk at their
  placements (loops, fades, offsets), runs insert chains as causal
  processors in the callback, wires sends as live cables, and sums
  through nested tracks to `main`. The CLI compiles YAML into a
  session graph over the socket — the daemon still never learns what
  a bar is (playback.md §3.6); positions arrive as samples.
- Today the closest thing is `--loop --watch`: a whole-mix re-render
  taking over at the loop wrap, with the audible hiccup later.md
  tracks. That mechanism — and the wait — is what this deletes: a
  level change lands as a ramp next block, a structural edit as a
  subgraph swap mid-play.
- Generation is untouched. SuperCollider, ACE and chatterbox produce
  the *sources* the engine plays; live SC as a graph node stays
  future work (later.md). Automation lanes were already designed
  realtime-evaluable ([automation.md](automation.md)) and will ride
  this engine when they arrive.

## 2 Decisions (DECIDED, 2026-08-10)

1. **Offline render keeps the build graph and stems.** The build
   graph's advantage is not that stems render fast but that they
   mostly don't render at all: an edit re-renders one stem and the
   sums above it, everything else is a content-addressed cache hit,
   and stems parallelize across cores. A realtime-bounce engine has
   no memory — every bounce runs the whole session, full length,
   serially — and loses to "only the dirty stem" on every edit after
   the first. Rejected: one-engine bounce (the Logic model; forfeits
   caching, incrementality and parallelism), and live-preview that
   diverges from the committed render (two implementations of every
   effect maintained forever, and what you hear is not what you
   commit).
2. **Two render paths, one DSP library.** What forces live and
   offline to agree is shared DSP, not a shared render path. The stem
   op and the live engine link the same causal processors — same
   limiter, same reverb, same EQ — which is structurally cheap
   because the seam already exists: the offline chain runs inside
   `field-audiod --render` (render.cpp), so both paths live in one
   binary and share `native/audiod/src/dsp/` today.
3. **Processors are causal, deterministic, and block-size-invariant.**
   Nothing that cannot run in the callback may be in the shared
   library, and a stem op processing offline-sized chunks must emit
   the same samples as a callback processing 128 frames. One processor
   is genuinely non-causal and retires: the limiter's backward pass
   (limiter.h:10 states the construction in as many words). The eq
   (RBJ biquads) and reverb (Freeverb combs and allpasses) are causal
   structures already — what is offline-shaped about them is the
   interface, whole buffers in and a computed output length out
   (reverb.h:38), and what they need is a streaming form that carries
   state across blocks. The loop *fold* is a different mechanism
   entirely — mixdown's `applyDeclaredLength`, part of the offline
   mix path decision 1 keeps — and is not touched here.
   The property is enforced, not hoped for: a golden equivalence test
   renders the same subgraph offline and through the engine at
   several block sizes and diffs the output (§8 decides the
   tolerance).
4. **The cache is the freeze.** Because live and offline are
   sample-identical, the engine plays the cached stem for any clean
   subgraph and evaluates live only what is dirty — automatic track
   freezing, with invalidation already implemented as the build
   graph's dirtiness tracking, and the swap between cached and live
   inaudible by decision 3. Ableton and Logic spend user attention on
   freeze/unfreeze; field gets it from the architecture. CPU scales
   with what you are editing, not with the session.
5. **Parameter edits are ramps; structural edits are swaps.** A
   changed `gain_db`, `pan` or send level reaches the callback as a
   short ramp landing next block. A moved clip, an edited chain, a
   new track is a prepared subgraph the engine swaps in at a block
   boundary without stopping the transport. The CLI decides which is
   which by diffing the compiled session graph — the daemon never
   sees YAML.

## 3 The session graph

What the CLI compiles and the daemon loads — everything in samples
and file paths, one node per track, arrivals precomputed:

```json
{
  "op": "session",
  "tracks": [
    {
      "name": "keys",
      "clips": [
        { "file": ".field/out/songs/creek/still-water-keys.wav",
          "at": 0, "offset": 0, "length": 768000,
          "loop": { "every": 384000, "fade": 480 } }
      ],
      "chain": [
        { "effect": "eq", "params": { "low_shelf_db": -2.0 } }
      ],
      "gain_db": -6.0, "pan": -0.2,
      "sends": [ { "to": "space", "gain_db": -14.0, "tap": "post" } ]
    },
    { "name": "space", "chain": [ { "effect": "reverb", "params": {} } ] },
    { "name": "main", "sum": ["keys", "space"], "chain": [] }
  ]
}
```

The shape is illustrative — the real message set and its schema are
chunk 2's first deliverable, versioned like every other protocol this
daemon speaks, with `features` gating in `hello`
([recording.md](recording.md) §6 proposes the same mechanism; whichever
plan lands first builds it). A `"cached"` variant of a track node
carries a stem path instead of clips-and-chain, which is decision 4's
freeze: the compiler consults the build cache and sends the cheap form
for every clean subgraph.

## 4 What retires

- The loop-wrap takeover: `reload(path)`, the fine wrap poll, and the
  whole-file swap (playback.md §5, watch.md §1.1). Later.md's "audible
  loop takeover" line is resolved by deletion, as it predicted.
- `--watch`'s re-render-and-reload cycle becomes compile-diff-send;
  the build still runs (it feeds the cache and the freeze), but
  playback no longer waits on it.
- The limiter's backward-pass implementation, once the golden test
  says its causal twin matches it sample-for-sample — the
  implementation retires, not the offline render path (decision 1
  keeps that, loop fold and all).

## 5 Definition of done

While the mix plays looping, editing a `gain_db` in a track file is
audible at the next block — no wrap wait; moving a clip swaps its
subgraph without the transport stopping; `field build` still renders
stems through the build graph, and the golden test proves a stem and
the live engine produce identical samples for the same subgraph. A
session of thirty clean tracks and one being edited costs the engine
one live chain plus file streaming.

## 6 Where recording fits

[recording.md](recording.md) waits behind this plan and gets simpler
because of it: capture becomes an input node in a graph that already
runs live, and monitoring falls out of the same callback. Its plan
stands as drafted; its list line waits in later.md.

## 7 Chunks

1. **The causal DSP library** — streaming interfaces for `eq` and
   `reverb` (state across blocks; same algorithms), and the limiter
   restructured around its own bounded window: the backward pass only
   ever reaches one attack ramp back (limiter.h:13 — "the 'lookahead'
   is the attack ramp length"), so a causal twin that delays by one
   ramp sees exactly the window the backward pass consulted and
   computes the identical gain curve left-to-right. Latency reporting
   per processor (the PDC groundwork; the stem op trims the limiter's
   fixed offset), and the golden equivalence harness at multiple
   block sizes — which therefore covers all three processors as
   repackagings. `field build` output should not change at all; the
   golden test is what proves it did not.
2. **The live graph** — the session message set and schema, clip
   streaming with loops and fades, per-track chains, sends with
   delay compensation, nested summing, level/pan/send ramps over the
   socket; `features` gating in hello.
3. **Edits land mid-play** — the CLI compiles and diffs on file
   change, ramps vs. subgraph swaps, watch integration; the loop-wrap
   takeover machinery retires.
4. **The cache is the freeze** — the compiler sends cached stems for
   clean subgraphs, the engine swaps a track between cached and live
   as dirtiness changes, and CPU stops scaling with session size.

## 8 Open questions

- The golden test's tolerance: strict bit-identity, or an epsilon that
  admits float summation-order differences? Bit-identity is the
  stronger claim and worth attempting first; the reverb's feedback
  state is where it will be hardest.
- Live rate conversion: a dirty track at its own rate
  (multi-rate.md decision 3) needs sample-rate conversion in the
  callback that the offline resample op does with a windowed-sinc
  pass today. Clean tracks dodge this via the cache (the convert
  node's artifact is cacheable), so V1 may accept "a track being
  edited plays at the session rate" — decide when chunk 2 meets it.
- The CLI surface: does live evaluation hide behind `field play`
  once it exists, or arrive as an explicit flag until the freeze
  chunk makes it always-cheap?
