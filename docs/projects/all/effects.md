---
status: Shipped
---

# Plan: Offline effects

**Status:** In progress (started 2026-08-05). Follows
[playback.md](playback.md); inserted ahead of ACE deliberately — ACE stems
want tone-shaping on arrival, and mixes have needed a real limiter since
creek's sum first clipped (a master `gain_db` was hand-tuned as a stopgap
in bloom).

**Goal:** three offline effects — `eq`, `limit`, `reverb` — as build
rules, chainable with everything the graph already does, then usable as
track inserts and a mix master chain.

## 1 The disposability decision (DECIDED)

Effects land now, before live DSP exists, on the same reasoning recorded
for the mixer (mix-assembly.md §1): **the executor is the replaceable
part; the contract is the durable part.** Schemas, parameter semantics,
tests, and rendered artifacts survive the live-DSP era untouched — the
daemon changes who executes, not what is declared. Offline rendering is
permanent Field architecture (freezing is caching), so the TS
implementations either remain the offline executors or become the
bit-exact reference the native code is tested against. The alternative —
deferring effects until the recording era — was rejected: it leaves every
intervening phase mixing with faders only.

Two obligations recorded up front:

- **The parity seam.** When the daemon hosts these effects live, what is
  monitored must match what renders — Fyra's exact problem (its iOS EQ
  displays cookbook math but plays Apple's AU). Our advantage: the TS
  implementation is executable reference, not a measurement rig.
- **Insert entries are discriminated on `effect:`** so the AU-hosting era
  adds an `au:` variant additively instead of reshaping track files.

**Where these contracts end up (2026-08-08).**
[nested-tracks.md](nested-tracks.md) §1.12 folds effect *sounds* into
tracks — an `eq` sound becomes a track with one input and one insert.
That does not reverse anything here: §1's argument is that the executor
is replaceable and the contract durable, and the contracts survive
untouched. What changes is where they attach.

## 2 The effects (DECIDED)

- **`eq`** — RBJ audio-EQ-cookbook biquads ported from Fyra's `eq.cpp`
  (the parity-proven form: bandwidth in **octaves** via the sinh alpha,
  shelves driven from that same alpha, frequency clamped to 45% of
  Nyquist). Band types: `highpass`, `lowshelf`, `bell`, `highshelf`,
  `lowpass`. **`normalize: true` by default**, Fyra's response-based
  auto-gain verbatim: composite response sampled at 48 log-spaced points
  20 Hz–20 kHz (per-band dB summed, as Fyra does), mean power,
  `−10·log₁₀(meanEnergy)`, clamped ±12 dB, applied as one scalar — EQ
  moves change tone, not level. One divergence: Fyra pins the integral to
  48 kHz so saved songs never shift; Field computes at the project rate,
  because a rate change re-renders everything anyway and the action key
  sees it.
- **`limit`** — offline lookahead peak limiter: `ceiling_db` (default −1),
  `lookahead_ms` (attack ramp length, default 5), `release_ms` (default
  100). Offline affords the artifact-free form: per-sample naive gain,
  then a backward pass slewing attacks and a forward pass slewing
  releases, both dB-linear — no overshoot ever, no envelope ripple.
  Sample-peak in v1; true-peak is a later refinement.
- **`reverb`** — Freeverb (Schroeder–Moorer): 8 combs + 4 allpasses per
  channel, right channel delay-spread, comb feedback derived from
  `decay` (T60), `damping` in the comb loops, `predelay_ms`, `mix`
  (equal-sum dry/wet). The canonical "basic reverb," fully deterministic.
  Output grows by the tail (until −60 dB); downstream nodes just see a
  longer input.

## 3 Wiring (DECIDED)

- Every single-input rule sources **exactly one of `asset:` or
  `target:`** — the clip pattern. `normalize` migrates from its old
  `input:` field to the same shape (breaking; bloom is the only project
  and updates in the same breath). This also closes the loop our
  rate-mismatch error promises: normalize *of a target* is now
  declarable.
- Chains are just targets referencing targets: `sc-render → eq → reverb`,
  cached per link with early cutoff. Rule impls declare `targetDeps`
  alongside `assetDeps`; the graph wires both.
- Target→target references make **cycles declarable** for the first time,
  so `field check` grows a cycle detector with the cycle spelled out in
  the diagnostic — the engine's ordering guard must never be the first
  thing to notice.

## 4 Definition of done

creek's kit EQ'd, its pad reverb'd (as recipe-chained targets), and
`mix:main` through a master limiter replacing the hand-tuned gain — each
a one-line-diff-sized edit that rebuilds exactly its own chain.

## 5 Chunks

1. **The rules** (shipped, #14) — DSP core (`src/audio/`: biquads +
   auto-gain, limiter, freeverb), the three rules plus the normalize
   migration, target-dep wiring, cycle validation, tests (including
   Fyra-derived auto-gain properties: narrow bells cost almost nothing,
   wide shelves proportionally more, boost/cut symmetry).
2. **Inserts** — `inserts:` chains on tracks (applied post-clip-sum in
   the stem: inserts are content, so insert edits re-render the stem —
   the accepted cost model) and a `master:` chain on mixes, applied
   **after** the sum and the master gain so a final limiter's ceiling
   guards the true output (gain drives *into* the limiter; anything else
   would defeat it). Same effect schemas in all three positions. bloom
   demonstrates everything (§4).

## 6 §1 revisited (2026-08-07)

§1 called the TypeScript implementations disposable and said they would
"either remain the offline executors or become the bit-exact reference
the native code is tested against."
[render-pipeline.md](render-pipeline.md) takes neither branch, and §1's
two recorded obligations are the reason.

The **parity seam** is discharged by removing it rather than bridging
it: the daemon becomes the single executor for rendered audio, so there
is no second implementation to keep in parity. The forcing argument is
§1's other obligation — **`au:` as an additive variant**. That remains
exactly right as a schema decision, and the schema already ships it
(`src/schema/effects.ts`). But an insert chain is a serial signal path,
and TypeScript cannot host an AudioUnit, so a chain reading
`eq → au:1176 → limit` settles who executes. That consequence was not
followed through here.

The **bit-exact reference** branch is dropped too. Keeping `src/audio/`
alive as a test oracle is permanent dual maintenance — the cost the
disposability decision was meant to avoid. The tests become properties
measured from rendered output (bandwidth ratios, T60, ceiling
guarantees, auto-gain level), which survive deleting the TypeScript and
would have caught a substituted renderer on their own.

Nothing in §2, §3 or §5 changes: same effects, same parameter
semantics, same three homes, same shipped artifacts. Only the executor
moves.

**Done as of [render-pipeline.md](render-pipeline.md) chunk 4.** §5's
chunk 1 above describes `src/audio/` as the DSP core, and it was, until
the daemon took over in chunks 2–3 and the TypeScript was deleted. The
directory now holds the WAV codec and the render client only.

The auto-gain properties §5 lists — narrow bells cost almost nothing,
wide shelves proportionally more, boost/cut symmetry — are now in
`src/generators/effect-properties.test.ts`, but none of the three made
the trip on its own. All three had to be written there, along with the
±12 dB clamp, because the properties that replaced the unit tests all
happened to use boosts at bandwidth 1 or wider. The move was sound; it
was neither free nor automatic, and the narrow-vs-wide one was missed on
the first pass and caught in review.
