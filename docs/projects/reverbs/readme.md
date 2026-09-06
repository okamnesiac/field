---
status: in-progress
priority: now
---

**Outcome:** Shipped whole: a Dattorro `plate`, an FDN `hall` with
per-band decay, and the old `reverb` kept deliberately as the live
comparison. Stays open until the creek listening pass has flipped
`space` between the three rooms and picked the example's room.

# Plan: Two reverbs that beat Freeverb

**Goal:** two new insert effects — `plate`, a Dattorro figure-8 tank,
and `hall`, a feedback delay network with per-band decay — that make
the current `reverb` sound like what it is: the fastest correct port
chunk 1 of [realtime.md](../realtime/readme.md) could carry. Freeverb's tail is
static (no modulation, so sustained material rings its combs
metallically), its echo density never grows, and its stereo is one
network offset 23 samples. The replacements are the two standard
architectures that fix those by construction.

## 1 What any candidate inherits

The constraints are realtime.md's, and they prune the field:

- **Causal, deterministic, block-size invariant** (decision 3): same
  bytes offline and in the callback, enforced by the golden and the
  field-dsp-check harness. No platform FFTs, no unseeded randomness.
- **Analytic tail** — the compiler computes chain growth as
  arithmetic (predelay + T60 today); a reverb whose ring-out cannot
  be computed cannot be compiled.
- **Denormal-safe without flushing** (decision 6): feedback paths
  must decay and truncate near −60 dB, because neither render path
  flushes subnormals.
- **The cache is law:** existing songs' bytes and action keys must
  not move. New effects are new inserts; nothing about `reverb`
  changes.

Convolution reverb (impulse responses as committed assets — a real
place, hash-pinned like any asset) and the exotic architectures
(velvet-noise, scattering delay networks) were ranked and deferred to
their own projects ([convolution-reverb](../convolution-reverb/readme.md),
[exotic-reverbs](../exotic-reverbs/readme.md)): the first needs a
cross-platform-deterministic FFT story
before it can join the golden, the second has no track record worth a
mix. This plan is the parametric pair.

## 2 Decisions (DECIDED, 2026-08-11)

1. **Freeverb stays, deliberately, as the comparison.** No users and
   only the example project would make replacement cheap today, but a
   kept `reverb` is a permanent A/B: the same send, two effect names,
   and the difference is audible in one edit under the live watch.
   The docs stop presenting it as the reverb and start presenting it
   as the classic. Nothing invalidates: action keys never move for
   untouched songs.
2. **`plate` is Dattorro's 1997 design, whole.** Predelay, input
   diffusion (four series allpasses), then the figure-8 tank: two
   cross-fed branches of modulated allpass → delay → damping →
   decay → allpass → delay, with the published output tap table for
   stereo. The published tunings are sample counts at 29 761 Hz and
   scale to the session rate by rounding, the way Freeverb's tunings
   already scale. Stereo input mono-sums into the tank (a plate is
   one sheet of metal); the taps are what make it wide.
3. **`hall` is a Jot FDN: eight delay lines, Householder feedback,
   per-band T60.** Line lengths are mutually prime, scaled by
   `size`; the feedback matrix is the Householder reflection
   I − (2/N)·11ᵀ, applied in O(N) as y = x − 2·mean(x) — the factor
   of two is what makes it a reflection and therefore orthogonal
   (Codex caught the draft describing mean(x) − x, which annihilates
   the common mode and is not lossless) — so stability is algebraic,
   not tuned. Each line
   carries an absorptive filter deriving per-band decay from three
   numbers: `decay` (mid T60), `decay_low` and `decay_high`
   (multipliers) — rooms keep their lows and lose their highs, and
   this is that, exposed directly instead of through a damping
   euphemism. Input diffusion in front; an orthogonal ± tap pattern
   out, `width` blending mid/side. Early reflections are
   deliberately out of this chunk: placements and sends already put
   position into a mix, and a bare-FDN distance complaint should be
   heard before machinery is built against it.
4. **Modulation is deterministic by construction.** Both effects
   modulate delay interpolation points with fixed-rate sinusoidal
   LFOs (per-branch rates detuned, published in the header), linear
   interpolation, depth from `modulation`. The LFO phase is a pure
   function of the engine's *unwrapped* input-timeline index — the
   `clock` renderBlock already maintains and `locate` already sets,
   the same axis the limiter's ramps ride. The streaming class
   carries it as a counter initialized to wherever the chain starts
   rendering: zero offline and at load, the *warmup start* at a
   locate (minjudd caught the draft seeding the landing position,
   which would have left a permanent phase error the size of the
   warmup). From there counter and clock advance together, so by the
   time the audible position arrives the phase equals a from-the-top
   render's — block-invariant and golden-clean. Two bounds said
   plainly: the *state* after a far seek matches a from-the-top
   render within the warmup's −60 dB threshold, the bound every
   chain already has at locate (realtime.md chunk 3's amendment,
   recorded from chainWarmup's own comment) — exact
   equality holds from the top, where the golden compares; and under
   `loop` the unwrapped clock keeps counting across the wrap, so
   pass two deliberately does not repeat pass one's phase — a tail
   identical every pass is the static-ring disease this plan exists
   to cure. `modulation: 0` is bit-frozen and is the dsp-check
   fixture's default case.
5. **Tails stay compiler arithmetic.** `plate`: growth = predelay +
   decay·rate. `hall`: growth = predelay + decay·max(1, decay_low,
   decay_high)·rate — the longest band governs, whichever it is; the
   schema constrains neither multiplier, so the formula must not
   assume the low band wins (minjudd and Codex both caught the draft
   truncating a bright room). Both formulas live beside
   chainGrowth's reverb arm in the compiler and in the engine's
   warmup, the pair that must always agree.
6. **Each chunk bumps RENDER_PLAN_VERSION and rides the session
   schema.** A new effect is the listed reason that version exists;
   the session insert union gains an arm and the old daemon's
   fail-closed parse rejects sessions it cannot evaluate, as
   designed. `field build` output for existing songs is unchanged —
   all cache hits — and the golden proves it, the same claim
   chunk 1 of realtime made.

## 3 The YAML, concretely

```yaml
# a vocal send into a plate
inserts:
  - effect: plate
    mix: 0.3
    decay: 2.5        # T60 seconds
    predelay_ms: 12
    damping: 0.4      # highs die faster, like air
    diffusion: 0.7    # input smearing: low = discrete, high = wash
    modulation: 0.3   # tail motion; 0 = frozen

# the shared room, sized
  - effect: hall
    mix: 0.25
    decay: 3.5        # mid-band T60 seconds
    decay_low: 1.3    # lows ring ~4.6 s
    decay_high: 0.4   # highs die in ~1.4 s
    size: 0.8         # delay-line scale: small room → hall
    predelay_ms: 20
    diffusion: 0.8
    modulation: 0.2
    width: 1.0
```

## 4 Chunks

1. **`plate`** — the streaming class in `dsp/` with its whole-buffer
   wrapper and analytic tail, schema + session + plan arms on both
   sides, dsp-check block-invariance and subnormal cases, golden
   byte-identity offline-vs-live, and creek's `space` swapped to
   `plate` on a branch for the listening A/B (not merged as part of
   the chunk — the example changes when the ear decides).
2. **`hall`** — the FDN with per-band decay, same harness, same
   golden; the listening pass compares all three on the same send.

## 5 Definition of done

Both effects render byte-identically offline and live at every
harness block size, with `modulation: 0` and non-zero; existing
projects rebuild as pure cache hits; `field play creek --watch` with
`space` flipped between `reverb`, `plate`, and `hall` A/Bs the three
rooms live, which is the demo — and the decision about what creek
ships with — this plan exists to enable.
