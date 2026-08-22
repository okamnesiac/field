---
status: done
---

**Outcome:** Shipped.

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
  realtime-evaluable ([automation.md](../automation/readme.md)) and will ride
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
   several block sizes and diffs the output (decision 6 sets the
   tolerance: bit-identity).
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
6. **The golden test demands bit-identity, engineered rather than
   hoped for.** Both paths run the same compiled functions;
   recurrences carry state exactly, so block boundaries cannot
   reorder them; the summing order is fixed by the graph. The two
   landmines are named so they get defused up front: the stem op
   must match the callback's floating-point environment (flush-to-
   zero on both sides, or neither — denormal handling alone breaks
   identity in reverb tails), and the limiter's causal twin must run
   the same backward recurrence over a two-ramp buffer rather than
   computing ramps by multiplication, because chained addition
   rounds differently. The test is then a hash comparison — the
   live engine's output for a clean subgraph *is* the cached
   artifact in the content-addressed sense the repo already runs
   on. A per-processor epsilon is the documented fallback if
   evidence forces one; it is not adopted in advance. Rejected: a
   blanket epsilon (custom comparison machinery, admits drift, and
   surrenders the hash-equality property for free).

   *Resolved 2026-08-10 (chunk 1): neither path flushes.* Review
   showed flush-to-zero is not output-invariant after all — DAZ
   zeroes subnormal float32 *input* samples, which are representable
   data, and FZ moves decaying filter tails around 1e−38 (a cold A/B
   on creek showed three stems differing, ~760 dB down) — and keeping
   it would have forked the cache, since no action key moves when the
   arithmetic environment does. The double filter state makes
   denormal stalls unreachable (every feedback path decays and
   truncates near −60 dB), so both paths simply run the default
   floating-point environment, and the callback inherits this as a
   requirement, not a choice.
7. **The resampler is the fourth repackaging — there is never a
   second SRC.** The offline converter is a fixed-ratio polyphase
   windowed sinc whose inner loop is already per-output-sample
   (resample.cpp), so a streaming form is the same kernel fed by a
   ring of input history, primed with the zeros the offline edge
   implies, with the group delay the code already computes
   (`taps / 2` = 64 input samples, ~1.4 ms) reported into delay
   compensation. A foreign-rate dirty track therefore runs live
   like every other track. Rejected: a cheap realtime interpolator
   (a second SRC implementation with a different sound — the
   two-implementations disease decision 2 exists to kill), and a
   re-render-and-swap fallback for foreign-rate dirty tracks (a
   permanent behavioral cliff, built to avoid a fourth instance of
   a pattern this plan already commits to three times).

   *Amended 2026-08-11 ([cross-rate-live.md](../cross-rate-live/readme.md)):*
   the "reported into delay compensation" clause described a causal
   streaming edge the engine never runs. The engine materializes
   (chunk 2's amendment), so an edge converts the child's whole
   buffer through the wrapper, whose emission is timeline-aligned —
   the taps/2 group delay is internal accounting, and what remains
   is availability, not shift, the same resolution that keeps
   comp_delay zero. Under streaming rings the producer runs ahead
   of the playhead by at least the kernel window, so the aligned
   form survives there too. The one place the streaming delay is
   physically real is device delivery, which is outside the golden.
8. **Live evaluation arrives behind `--live` and becomes the
   meaning of song playback when the freeze lands.** While chunks
   2–3 are landing, `field play <song> --live` is the explicitly
   experimental path and artifact playback stays the known-good
   reference. When chunk 4 makes cost scale with dirt rather than
   session size, live evaluation becomes what playing a song *is*,
   and the artifact path for song playback retires — two permanent
   surfaces would be a standing divergence risk. Playing an explicit
   artifact stays file playback. This is the arc playback.md already
   walked with afplay: fallback until the new path soaked, then
   retired.

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
([recording.md](../recording/readme.md) §6 proposes the same mechanism; whichever
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

[recording.md](../recording/readme.md) waits behind this plan and gets simpler
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
   computes the identical gain curve left-to-right. The resampler
   joins as the fourth repackaging (decision 7): the same polyphase
   kernel fed streaming, its `taps / 2` delay reported. Latency
   reporting per processor (the PDC groundwork; the stem op trims
   the fixed offsets), matched floating-point environment across
   both paths (decision 6), and the golden equivalence harness at
   multiple block sizes — four processors, all repackagings.
   `field build` output should not change at all; the golden test is
   what proves it did not.
2. **The live graph** — the session message set and schema, clip
   streaming with loops and fades, per-track chains, live rate
   conversion at the edges that declare it, sends with delay
   compensation, nested summing, level/pan/send ramps over the
   socket; `features` gating in hello; all behind `field play
   <song> --live` (decision 8).

   *Amended 2026-08-10 (review of the first implementation):* the
   engine materialises rather than streams — sources preload whole
   at session load and every non-output track renders into a
   full-length buffer, so memory scales with session length times
   track count (creek: ~143 MB resident; a five-minute thirty-track
   session extrapolates to ~3.5 GB). Correctness first, deliberately
   — the buffers are what made the golden equivalence provable — and
   note the freeze (decision 4) does not bound this, because a frozen
   track becomes a file window and file windows preload whole too.
   Streaming rings and buffered readers are follow-up work owed
   before large sessions, not an optimisation to forget. Two more
   bounds the same review round pinned: the bit-identity claim holds
   within the live limiter's 60 dB horizon — beyond it the ramp
   starts late by design, ceiling still held, offline still exact —
   and cross-rate sessions are refused at compile time until the
   resampler wiring lands, with the artifact path as the interim
   answer (since delivered —
   [cross-rate-live.md](../cross-rate-live/readme.md): a foreign-rate track
   evaluates live and the edge converts).
3. **Edits land mid-play** — the CLI compiles and diffs on file
   change, ramps vs. subgraph swaps, watch integration; the loop-wrap
   takeover machinery retires.

   *Amended 2026-08-11 (recording shipped behaviour two later plans
   lean on):* this chunk's review round (#139) gave `locate` its
   warm-up: a far seek rebuilds the output chain and then renders one
   warm-up span — each reverb's tail, each limiter's window, a second
   per eq stage — into the void before the position sounds, so the
   state at an audible position matches a from-the-start render
   within the design's own audibility threshold, 60 dB. That bound
   had lived only as `chainWarmup`'s comment in live.cpp;
   [reverbs.md](../reverbs/readme.md) and
   [cross-rate-live.md](../cross-rate-live/readme.md) both reason from it, so
   it is recorded here where they can cite it.
4. **The cache is the freeze** — the compiler sends cached stems for
   clean subgraphs, the engine swaps a track between cached and live
   as dirtiness changes, and CPU stops scaling with session size.
   Live evaluation becomes the default for song playback and the
   `--live` flag and the artifact path for songs retire (decision 8).

   *Amended 2026-08-11 (the implementation):* the cached form needed
   no new session vocabulary — a frozen track is an ordinary track
   whose inputs are one file window over the stem at unity, chain
   empty — so the engine did not change at all and the freeze swap is
   a plain session swap, inaudible because the golden proves the stem
   and the live evaluation are the same bytes. Two kinds of track
   never freeze: the output — its windows are the ramp surface, and
   under loop the artifact is a fold where the live wrap is a
   performance, so swapping it would be audible — and any pre-tap
   sender, conservatively (a stem is post-chain; the cable reads the
   pre ring), which is also what §5's "one live chain plus file
   streaming" already said. Tracks nothing reaches once their
   consumers freeze drop from the session instead of pre-rendering
   for nobody. The compile reports its dirty list — reachable freeze
   candidates that missed the cache — and the watch loop rebuilds
   exactly that list behind the play, freezing it on the next
   compile; the list never names a track that cannot freeze, which is
   what makes the loop converge. An unwatched play simply plays its
   dirt live. Two costs recorded: every compile re-materializes
   frozen stems out of the CAS (a copy per stem, cheap next to a
   build but not free), and `field play <song>` now needs the device
   to serve the session's rate — the artifact path resampled in the
   transport, live playback does not until the cross-rate wiring
   lands, and the explicit artifact spelling remains the answer on a
   device that cannot switch (since delivered —
   [cross-rate-live.md](../cross-rate-live/readme.md) decision 3: delivery
   converts when the device cannot).

   *Amended 2026-08-11 (review of the first implementation):* the
   authored `loop:` never reaches the transport — it is the fold,
   clip-looping.md's one seamless pass — so a bare play of a
   loop-shaped song plays one pass and stops, and repetition stays
   `field play --loop`, wrapping at the declared extent or, on a song
   that declares none, at the output's natural length; sessions are
   always bounded now, because an unbounded one played silence forever
   past its content. `--from --loop` — the region loop — is refused on
   the live path and pointed at the artifact spelling until the engine
   grows a loop-start; that wiring is owed alongside the streaming
   rings. The background freeze rides the watch's abort signal down
   into the render subprocess, so ctrl-c ends a mid-freeze build at
   once instead of when the stem finishes, and build temporary paths
   are process-unique because the freeze legitimately put two builds
   in one process.

## 8 Open questions

None right now. The three the first draft carried — the golden test's
tolerance, live rate conversion, the CLI surface — were discussed and
decided 2026-08-10, and live as decisions 6–8 in §2.
