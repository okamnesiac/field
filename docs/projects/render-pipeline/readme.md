---
status: done
---

**Outcome:** Shipped.

# Plan: One rendering pipeline

**Status:** Shipped, chunks 1–6 (#50, #53, #54, #55 and chunk 5 here),
chunk 2 having carried most of chunk 6 with it. One §7 question outlives
the plan and is still open: whether `field build` wants a `--no-native`
subset. Written after
[linux-portability.md](../linux-portability/readme.md) proposed a fourth
TypeScript DSP module and the question "why is any of this in
TypeScript?" turned out to have a better answer than the one on record.
Supersedes part of [effects.md](../effects/readme.md) §1 — see §6 there.

**Goal:** One executor for rendered audio. A render is implemented
once, plugins work offline, and what the daemon monitors is what the
graph renders — without maintaining the same effect twice.

## 1 What changed

[effects.md](../effects/readme.md) §1 and [mix-assembly.md](../mix-assembly/readme.md) §1
both put DSP in TypeScript on the same reasoning: *the executor is the
replaceable part; the contract is the durable part.* That reasoning
stands and this plan does not overturn it. What is new is that the
replacement date is now knowable, and neither plan followed its own
logic to the end.

Both were also explicit that they were provisional.
[mix-assembly.md](../mix-assembly/readme.md) §1 scoped its work as "**the first**
mixer," with "No plugins (that phase comes with the daemon and AU
hosting)." [audio-engine.md](../../audio-engine.md) already lists
"offline rendering where supported" among daemon responsibilities. The
daemon was always going to render offline; what was missing was the
argument for *when*.

## 2 Decisions (DECIDED, 2026-08-07)

1. **The daemon is the single executor for rendered audio.** An insert
   chain is a serial signal path, and TypeScript cannot host an
   AudioUnit. [effects.md](../effects/readme.md) §1 anticipated `au:` as an
   additive *schema* change, which it is — but the moment a chain reads
   `eq → au:1176 → limit`, something has to render that chain. The
   options are buffers crossing the IPC boundary mid-chain with delay
   compensation split across two processes, or the daemon rendering the
   whole chain. Only the second is real, so the executor question was
   settled the moment AU hosting entered the roadmap; it just was not
   noticed.

   Rejected: **TypeScript offline, native live.** That is two
   implementations of every effect, forever — precisely the parity seam
   [effects.md](../effects/readme.md) §1 recorded as a debt rather than a design.

   Rejected: **deferring until AU hosting is built.** The schema already
   discriminates on `effect:`, so nothing breaks today; but every
   further TS DSP module and every rendered artifact raises the
   migration cost, and the resampler in
   [linux-portability.md](../linux-portability/readme.md) §2 was about to be the
   fourth. Stop growing the TS side now; port on the schedule in §6.

2. **Two tiers: built-in effects field owns, specialized effects you
   name.** *Built-in* — `eq`, `limit`, `reverb`, sample-rate conversion
   — is hand-written portable C++ with no platform library underneath:
   always present, deterministic, identical on every platform, and what
   the property tests in decision 3 are written against. *Specialized* —
   `au:`, UAD/Apollo — is opt-in, named explicitly by the user,
   macOS-bound, and carries plugin identity and version into the action
   key.

   Rejected: **Apple's stock AudioUnits for the built-in tier** (say
   `kAudioUnitSubType_NBandEQ` for `eq`). This is the Fyra defect by
   name, the one [effects.md](../effects/readme.md) §1 records: "its iOS EQ
   displays cookbook math but plays Apple's AU." Concretely it breaks
   `normalize`, which §2 of that plan makes the **default**:
   `autoGainDB` computes its compensation from field's own coefficients,
   so a renderer whose coefficients differ applies a correction for a
   filter that is not the one playing — the feature does not degrade, it
   silently becomes wrong. It also macOS-locks pure arithmetic, puts an
   unversionable OS binary inside a cache key, and deletes the reference
   the tests check against.

   The efficiency argument for stock AUs does not survive contact: a
   five-band stereo EQ at 48 kHz is roughly 4 Mflop/s, IIR filters are
   serial and do not vectorise across time, AU hosting adds per-block
   overhead that can exceed the filter cost, and
   [mix-assembly.md](../mix-assembly/readme.md) §1 defines this path as the one
   with no deadline. Hardware offload (UAD-2 on the Apollo) is a real
   efficiency win for *live monitoring*, where headroom is scarce, and a
   penalty offline, where it caps render at real time — which is what
   [audio-engine.md](../../audio-engine.md)'s "where supported" carries.

3. **Tests are properties measured from rendered output, not
   comparisons against a reference implementation.** What is worth
   asserting is field's own semantics, not that a biquad is a biquad:

   - **EQ** — a bell at `f0` with bandwidth `B` octaves has half-gain
     points whose ratio is `2^B`; a `normalize: true` curve returns the
     level it was handed, *measured the way `autoGainDB` defines level*.
     That qualifier is load-bearing. The compensation averages power at
     48 log-spaced points, which is equal-energy-per-octave weighting,
     and `biquad.ts:103` says as much. So the assertion renders tones at
     those same 48 frequencies and checks the mean output power is
     0 dB — tight, and it fails the moment rendered audio stops matching
     the coefficients the compensation was computed from. Seeded pink
     noise is the loose end-to-end version and wants a tolerance near
     ±1 dB (measured against the current renderer: −0.59 dB through a
     +6 dB/500 Hz high shelf, +0.91 dB through a +6 dB/200 Hz low
     shelf). **Not white noise** — its energy sits in the top octaves,
     so that same high shelf comes out **+1.91 dB** and the property is
     not merely loose but false.
   - **Reverb** — an impulse decays to −60 dB in `decay` seconds; no wet
     output appears *before* `predelay_ms`, and the first tap lands at
     predelay plus the shortest comb. (Not "the first wet sample lands
     at `predelay_ms`": predelay gates the input to a network that adds
     its own latency, so at 48 kHz with 100 ms predelay the onset is
     sample 6015, not 4800. `reverb.test.ts:33` already records this.)
     Asserted to the sample, that onset is also the cheapest guard on
     the delay-line sizing in decision 4 — JUCE's integer scaling puts
     it at 6014.
   - **Limiter** — no sample ever exceeds `ceiling_db` on adversarial
     transients; untouched audio passes at exactly unity.

   The normalization assertion is the parity test in disguise:
   `autoGainDB` is computed from the coefficients and validated against
   rendered audio, so a renderer that stops matching the coefficient
   math fails it without anyone thinking to look. It would have caught
   the substitution rejected in decision 2 automatically.

   Rejected: **[effects.md](../effects/readme.md) §1's "bit-exact reference the
   native code is tested against."** Keeping the TS implementations
   alive as an oracle is permanent dual maintenance — the cost this plan
   exists to remove. Properties and golden hashes survive deleting
   `reverb.ts`; a cross-implementation diff does not.

   **Amended on implementation (chunk 1).** The list above was the spec,
   and it was short by two. Both gaps were found by mutating the renderer
   and re-running — a property that survives its own mutation is not a
   property — and neither is a bug in the shipped effects: they are
   assertions this decision should have asked for and did not.

   - **The diffusion chain is allpass.** Swapping field's Schroeder
     allpass for JUCE's `read − x` left *every* assertion above green,
     which is exactly the silent swap §2.4 says nothing would notice once
     `reverb.ts` is deleted. It turns out to be measurable, and exactly:
     a true allpass has unit magnitude at every frequency, so the wet
     tail carries precisely the comb bank's energy, `Σ 1/(1−g_k²) / 64`.
     That is derived rather than transcribed — nothing in `reverb.ts`
     computes it — and it matches the render to 0.0000 dB, while Jezar's
     variant misses by 14.7 dB. It locks the per-comb T60 feedback, the
     scaled delay lengths and the ⅛ average in passing.
   - **The attack ramp reaches back by `lookahead_ms`.** Deleting the
     backward pass outright also left everything green, so the harness
     could not defend the half of §2.4's limiter claim that is about
     lookahead — and `limiter.test.ts`, which does cover it, is deleted
     by chunk 4. Driving a spike 60 dB over the ceiling makes the window
     itself measurable, since the slope is scaled so the deepest
     reduction spans exactly it.

   Three of the stated properties also needed sharpening once measured.
   The ceiling holds to within **one float32 ulp**, not exactly: the
   arithmetic pins each peak in double precision and the store to float32
   rounds, by up to half an ulp. "Untouched audio passes at unity" is
   genuinely bit-exact, and detects a leak from 1e-6 dB up — which is
   where float32 begins to see one at all. And T60 has to be read as an
   envelope *slope*: measured as a ratio against the first samples it
   reads about 18 dB shallow, because the start of an impulse response is
   the sparse tap burst rather than the steady envelope.

   **A second round, from review.** The first ten properties were still
   not deletion-safe, because every fixture was mono and every read kept
   only channel 0. Five more contracts — all of them live in
   [effects.md](../effects/readme.md) §2, and all of them covered today only by the
   direct tests chunk 4 deletes — survived their own mutation:

   - **The band types are discriminated.** Making `highpass`, `lowpass`
     and `lowshelf` identity filters passed everything, because only
     `bell` and `highshelf` were ever rendered.
   - **The right channel is spread.** Removing the 23-sample offset left
     the channels identical, which a mono harness cannot see. It is
     exact: the right tap lands at `round((1116+23)·rate/44100)` = 1240
     where the left lands at 1215.
   - **Limiting is stereo-linked.** Giving each channel its own gain
     curve — the thing the shared curve exists to prevent, since limiting
     must not wander the image — passed.
   - **`mix` blends.** Every reverb property ran at `mix: 1`, so a
     renderer that ignored the parameter passed. Both coefficients need
     asserting, and a first attempt that pinned only the dry one was
     caught in review: the first wet tap is a whole comb away, so sample
     0 is exactly `1 − mix` — which leaves `wet · (mix === 0 ? 0 : 1)`
     passing, blending dry correctly while running fully wet at every
     nonzero mix. Since the probe is a lone impulse, everything after
     sample 0 is wet only, so the `mix: 1` render is the reference: the
     first tap scales as `mix` and the wet signal carries `mix²` of the
     energy. Both hold exactly, and together they also reject an
     equal-*power* blend, which is the plausible wrong reading of a
     dry/wet control.
   - **`release_ms` is honoured.** Hard-coding 100 ms passed; only the
     attack side had been measured.

   With those, the harness catches **21 of 22** deliberate mutations,
   run as one matrix against the head it describes rather than tallied
   across rounds. The one survivor perturbs untouched gain by 1e-9 dB,
   which no float32 can represent — the same mutation at 1e-6 dB is
   caught.

   The method is worth keeping for chunks 2 and 3, where the renderer
   actually changes hands: mutating the implementation and re-running is
   what found every gap above, and none of them were visible from reading
   the assertions.

4. **The three shipped effects keep their algorithms and are ported by
   hand.** The claim "ours is better" holds unevenly, and the honest
   ranking is worth recording because it decides what to defend later:

   - **`limit` — genuinely better, but for a narrower reason than
     "guarantees a ceiling."** `juce::dsp::Limiter` is, in its own
     words, "two compressors and a hard clipper at 0 dB"
     (`juce_Limiter.h:40`), and it does clip every output sample to
     `[-1, 1]` (`:94`), so it *does* guarantee 0 dBFS — by clipping.
     What it does not offer is an arbitrary ceiling, lookahead, or a
     route to the ceiling that isn't hard-clipping the transients that
     reach it; it exposes only `setThreshold` and `setRelease`. field's
     computes the exact per-sample gain pinning every peak to
     `ceiling_db`, then slews it backward (attack) and forward
     (release), so the ceiling is reached by gain reduction rather than
     by clipping, and the slew is click-free by construction. That is
     only available offline, which is the right thing to exploit here.
   - **`reverb` — better parameterised, and not quite the same
     algorithm.** `juce::Reverb` is Freeverb off the same base comb and
     allpass *tables* as `reverb.ts`, but applies one
     `roomSize`-derived feedback to all eight combs, so each decays at a
     different real rate and the knob means nothing measurable. field
     derives feedback per comb from its own length, which is what makes
     `decay` mean T60 and makes the test in decision 3 possible. field
     also has predelay; JUCE has none.

     The allpass sections differ too, which matters more than a
     parameterisation gap because it survives into the port. field
     stores `x + 0.5·read` and returns `read − 0.5·(x + 0.5·read)` — the
     canonical Schroeder allpass. JUCE stores the same value but returns
     `read − x` (`juce_Reverb.h`, `AllPassFilter::process`), reproducing
     Jezar's Freeverb variant, which is not a true allpass. field's is
     the more defensible of the two, but it is a real divergence: the
     port must carry field's form deliberately, and a golden or
     property has to lock it before `reverb.ts` is deleted, because
     after that there is nothing left to notice a silent swap to JUCE's
     equation.

     The delay *sizing* diverges too, everywhere except 44.1 kHz. field
     rounds — `Math.round((tuning + spread) · rate / 44100)`, floored at
     1 (`reverb.ts:23`); JUCE casts the rate to `int` and divides in
     integers, which truncates (`juce_Reverb.h:111`). At 48 kHz that is
     one sample short on seven of the twelve delay lines per channel:
     the 1116 comb is 1215 in field and 1214 in JUCE, which is exactly
     why the onset above is 6015 and not 6014. Taking JUCE's sizing
     because the tables match would shift every tap, so this is the
     second thing the port must carry deliberately, and the
     sample-accurate onset property is what locks it.

     Be clear-eyed all the same: Freeverb is the canonical *teaching*
     reverb, and when reverb quality actually matters the answer is
     neither — it is convolution/IR or a plugin, from the specialized
     tier.
   - **`eq` — not better; the same filter.** The RBJ cookbook gives both
     the `sin(w0)/(2Q)` and `sinh` bandwidth forms of one alpha, exactly
     interconvertible. The reasons to keep field's are real but are not
     "better math": Fyra parity ([effects.md](../effects/readme.md) §2 pins the
     octaves/sinh form as the parity-proven one) and `autoGainDB`, which
     JUCE has no equivalent of at all. If Fyra parity ever stops
     mattering, this is the weakest of the three.

5. **JUCE supplies plumbing, not algorithms.** `dsp::IIR::Filter` for
   biquad state and processing, fed field's coefficients as a raw
   six-element array; `dsp::DelayLine`, `dsp::ProcessorChain`,
   `dsp::Gain`, `dsp::DryWetMixer`, `dsp::Oversampling` if true-peak
   limiting arrives. All portable C++ — where JUCE does reach for a
   platform library it is device I/O, plugin hosting and GUI, plus two
   DSP exceptions noted in §3. Adding `juce_dsp` to the daemon's
   `target_link_libraries` is a one-line change; only
   `juce_audio_devices` and `juce_audio_formats` are linked today.

6. **Render is a subprocess, not a verb on the running daemon**
   (2026-08-07). `field-audiod --render` spawned by the build action,
   exiting when the file is written. That is the shape
   [architecture.md](../../architecture.md)'s IPC section already gives
   the other executors — "JSON over stdio to worker subprocesses" — and
   the shape the daemon's own flags already take (`--socket`,
   `--null-output`, `--idle`).

   Rejected: **a `render` command on the NDJSON control socket.** A build
   action would contend with whatever the developer is listening to, one
   process owning both the transport and the render queue, and two
   `field build` runs could not proceed independently. Builds are
   hermetic and parallel by construction; borrowing a long-lived
   stateful process to do them gives that up for nothing, because an
   offline render needs no device, no transport and no shared state.

   Rejected: **rendering in-process in the CLI through a native addon.**
   A second binding surface to maintain beside the protocol, for a path
   [mix-assembly.md](../mix-assembly/readme.md) §1 defines as having no deadline.

   **Amended on implementation (chunk 2, from review).** A subprocess
   boundary is a protocol, and this decision described the plan's *shape*
   without saying what happens when the two sides disagree about it.
   `daemonBinary()` reuses whatever build already exists, so "control
   plane newer than binary" is the ordinary case, not an exotic one.

   The plan therefore carries a **version** the binary must match exactly
   (`RENDER_PLAN_VERSION`, mirrored in `render.cpp`), separate from the
   socket's `PROTOCOL_VERSION` because they version different
   conversations. And the binary **rejects every value it does not
   understand** rather than rendering something plausible: unknown
   effect, unknown eq band type, missing field.

   **Amended again (chunk 3, from an exhaustive audit).** Rejecting
   unknown *values* was not enough, because the parser still failed open
   on everything it had not been patched for: `juce::var` coerces freely,
   so an object answered a number cast and `ceiling_db: {}` became a 0 dB
   limiter; `version: 2.9` passed an exact gate by truncation; unknown
   keys were ignored, which is the additive-field hazard this decision
   names; an EQ with no bands rendered as a byte-identical no-op. An
   audit of 263 mutations accepted 126 of them.

   Worse, one was not a cache-integrity bug but a memory-safety one:
   `start: -1` allocated for the clip's end and then indexed *before* the
   output buffer, which AddressSanitizer confirms as a heap-buffer
   overflow.

   So the shape is now validated once, before dispatch
   (`native/audiod/src/plan.cpp`), and the renderer downstream sees only a
   plan already proven to match: types that reject coercion, allowed keys,
   required and optional fields per `op` and per `effect`, collection
   sizes, the domains where a bad value is unsafe rather than merely odd,
   and the one cross-field rule (`loop` needs a length to fold onto).

   One line drawn here was wrong, and review corrected it. The first
   version enforced structure but delegated the numeric ranges back to
   zod, on the grounds that a second copy would drift. The rebuttal is
   decisive: the file already mirrored names, types, cardinalities and
   *some* bounds, so a partial copy carried the same drift risk with none
   of the coverage — and the omitted ranges were not merely odd values.
   `bandwidth: 0` makes a bell an identity filter and `ceiling_db: 1`
   leaves audio untouched; both rendered byte-identical to their input
   under keys naming an EQ and a limiter, which is the exact failure the
   validator exists to close.

   So the bounds are **generated** rather than copied.
   `scripts/gen-plan-limits.ts` emits `native/audiod/src/plan-limits.h`
   from the zod schemas, and a test regenerates and compares, so a widened
   range cannot land without the daemon following it. zod stays the single
   source of truth project-core.md §5 already says it is. The drift
   objection was real; generating was the answer to it, and omission was
   not.

   `read_offset` does stay unbounded, and that one is principled: reads
   outside a source are declared silence — it is what slip *is*, and
   bounding it would break a documented feature while looking like
   rigour.

   The lesson underneath five findings: a boundary is not made safe by
   checking values where they are used. Four fixes at four use sites left
   the fifth hole open, and the sixth was memory corruption. Validate the
   shape once, at the edge, and let everything downstream assume it.

   The band type shipped broken and review caught it. `design()` returned
   an identity filter for a type it had never heard of, so a plan with a
   +12 dB band of a future type exited 0 and produced output byte-identical
   to its input — cached under an action key describing a chain that never
   ran. The unknown-*effect* check was already there with a comment
   explaining exactly this hazard; it simply was not applied one level
   down. Worth remembering as a shape: a discriminated union guards the
   discriminant it names, and nothing else.

7. **Musical time stays in TypeScript; the daemon is handed
   sample-accurate edit lists** (2026-08-07). The daemon is "artifacts
   only: it plays files the build produced and has no idea what a clip
   or a bar is" (`native/audiod/src/main.cpp`), and that sentence stays
   true when it renders. Bars, beats, tempo maps and clip placement
   resolve in the control plane exactly as they do now (`src/time/`);
   what crosses the boundary is sample offsets and file paths.

   Rejected: **giving the daemon the tempo map.** It duplicates
   `TempoMap` in C++, puts musical semantics on both sides of a
   versioned protocol, and retires the one-sentence description of the
   daemon that has held since #12 — for no gain, since offline render
   has already resolved every position before it starts.

8. **Standalone effect targets move first, then `track-render` and
   `mix`** (2026-08-07). The `eq`/`limit`/`reverb` rules take one input
   and one set of parameters, so they exercise the whole new path —
   spawn, plan, render, compare — with nothing else changing. Stems and
   mixes add clip placement and summing on top of a boundary that is by
   then already proven.
9. **Sample-rate conversion is a hand-written fixed-ratio polyphase
   FIR** (2026-08-07, chunk 5). The six project rates are pairwise
   rational with small denominators — 44100→48000 is exactly 160/147 —
   so every conversion field supports is a fixed ratio, and a fixed ratio
   admits precomputed per-phase coefficient rows. The prototype is a
   Kaiser-windowed sinc; the stopband edge sits at the *lower* of the two
   Nyquist frequencies, which is what makes the same code correct in both
   directions.

   Rejected: **`juce::Interpolators::WindowedSinc`**, and not on the
   grounds §3's table first guessed. Reading
   `juce_GenericInterpolator.h`, `interpolateImpl` advances `pos +=
   speedRatio` against a kernel whose width never depends on
   `speedRatio`; the sinc is not rescaled when the ratio is greater than
   one. So downsampling — 96 kHz material into a 44.1 kHz project, which
   the schema permits and `normalize` exists to perform — filters at the
   *input* Nyquist and folds everything above the output Nyquist back
   into the band. That is not a quality difference, it is aliasing, and
   it disqualifies the option for half the conversions rather than making
   it a cheaper alternative for all of them.

   The cost of owning it is small and was measured before choosing:
   scalar double with `-ffp-contract=off` runs 3 minutes of stereo
   44.1→48 in 0.41 s at 64 taps per phase and 1.06 s at 128, against
   `afconvert`'s 0.13 s including its I/O. `afconvert` wins by
   vectorising with FMA, which is precisely what §4's byte-identity rule
   forbids. It does not matter regardless: `normalize` is cached by
   action key, so this is paid once per source at import, not once per
   build. Fixed-order SIMD without FMA remains available later and would
   not cost the guarantee.
10. **Bit-depth reduction dithers, deterministically** (2026-08-07,
    chunk 5). Every depth is written as **integer PCM** — `bit_depth: 32`
    included, because that is what `afconvert -d LEI32` produced and what
    [linux-portability.md](../linux-portability/readme.md) decision 1 says still
    stands; writing IEEE float there would change the meaning of an
    existing schema value under a version bump that only claims to change
    the bytes (#57 review). 24- and 16-bit targets get 1-LSB TPDF dither
    before rounding, because plain truncation leaves the quantization error
    correlated with the signal — audible as distortion rather than noise
    on exactly the quiet material a `normalize` target tends to carry.

    The determinism is not a caveat but a requirement: same action key,
    same bytes. So the generator is a specified integer PRNG with a fixed
    seed, written out here rather than taken from `<random>`.
    `std::uniform_real_distribution` and `std::mt19937`'s pairing are not
    specified to produce identical sequences across libstdc++ and
    libc++, so using them would make the dither — and therefore every
    rendered artifact — platform-dependent, which is the one thing §4
    exists to prevent.

    32-bit is undithered: its step sits about 186 dB below full scale,
    finer than the float32 samples feeding it can resolve except at the
    very bottom of the range, so dither there would add noise without
    masking anything measurable.

    Rejected: **no dither**, which is simpler and equally deterministic
    but wrong for the reason above. Rejected: **noise shaping**, which is
    a real improvement on TPDF and a much larger decision (which curve,
    and it makes the artifact depend on a psychoacoustic choice we have
    not made). Flat TPDF is the conservative, well-understood floor.

## 3 What JUCE does and does not supply

Checked against the pinned JUCE 8.0.4 tree, not from memory.

| Piece | JUCE has it | Usable as-is |
| --- | --- | --- |
| Biquad coefficients | `dsp::IIR::ArrayCoefficients` — plain C++ RBJ, no Apple | No: Q-parameterised, fails the bandwidth test |
| Biquad processing | `dsp::IIR::Filter`, transposed direct form II | Yes, fed field's coefficients |
| EQ auto-gain | — | No equivalent exists |
| Reverb | `juce::Reverb`, Freeverb, same base tables | No: `roomSize` not T60, no predelay, Jezar allpass, truncated rate scaling |
| Limiter | `dsp::Limiter`, threshold + release only | No: no lookahead, and 0 dBFS by hard clip — no arbitrary ceiling by gain reduction |
| Resampling | `Interpolators::WindowedSinc`, 100 crossings/side | No: kernel width ignores `speedRatio`, so downsampling aliases (decision 9) |
| Delay lines, chains, gain, oversampling | `juce_dsp` | Yes |

**The two places JUCE reaches for a platform library**, both outside
the current path and both worth knowing before they enter it:
`juce::dsp::FFT` selects a backend at compile time (`AppleFFT` via vDSP
on macOS, else FFTW/MKL/IPP, else its own), so anything FFT-based —
convolution reverb, spectrum analysis — is *not* bit-identical across
platforms; and `FloatVectorOperations` uses vDSP on Apple and SSE/NEON
elsewhere, where elementwise ops stay IEEE-exact but order-dependent
reductions need not.

## 4 Determinism, honestly

Moving to C++ relocates the cross-platform bit-identity problem rather
than solving it, and the goal has to be scoped before it is claimed.

- **Any project with an `au:` insert can never render byte-identically
  off macOS.** Byte-identity is a claim about the built-in tier only.
- **Transcendentals were expected to be the exposure. Measured, they
  are not** (2026-08-07, chunk 2). The reasoning here was that libm's
  `sin`/`cos`/`sinh`/`pow` differ in the last ulp between Apple's and
  glibc's, so chunk 6 scheduled replacing them with polynomials field
  controls. With `-O3`, no `-ffast-math` and **`-ffp-contract=off`**, the
  built-in tier renders **byte-identically** on macOS arm64 (Apple
  libm), Linux arm64 (glibc) and Linux x86-64 (glibc) — 40 randomised
  chains across three sample rates and both channel counts on the first
  pair, and the golden fixture on all three. No polynomial substitution
  was needed.

  Two things that claim does *not* say. It is four platform/architecture
  combinations and one libm pair, not a proof; a different glibc, a
  different compiler, or a new libm release could still move, which is
  exactly why the golden hash is a CI test rather than a paragraph. And
  it says nothing about `-ffast-math` builds or about the specialized
  tier. What retires is the *scheduled work*, not the vigilance.
- **OS-versioned binaries inside cache keys are the permanent
  condition, not an anomaly.** `afconvert` is the first instance, not a
  special case: a UAD plugin version bump changes output bytes under a
  stable key exactly as a macOS resampler update would. The general
  answer — binary identity and version as action-key inputs — is worth
  building once, and it retires
  [linux-portability.md](../linux-portability/readme.md) §1.1's framing of
  `afconvert` as a defect to eliminate.

## 5 Port notes

Two things worth designing rather than transliterating, both of which
improve determinism and speed at once:

- **`reverb.ts` uses `%` for its circular buffers**, twelve times per
  sample per channel. Integer division where JUCE uses compare-and-reset
  (`if (++i >= size) i = 0`); likely the largest single gap against
  JUCE's reverb, and mechanical to fix. **Done in chunk 2** — and it is
  an identity, not an approximation, since the index is only ever
  incremented by one.
- **`limiter.ts` calls `Math.pow` per sample per channel,
  unconditionally** — ~17M calls on a three-minute stereo mix. The gain
  curve is *exactly* 0 dB wherever audio was untouched, and
  `pow(10, 0/20)` is 1, so guarding the call skips the transcendental
  for most samples in typical material — exactly, not approximately.
  That is the speedup, and it removes §4's libm exposure on every sample
  the limiter left alone. **Done in chunk 2.** It does not remove the
  exposure on the samples it touched — a chain that actually limits still
  calls `pow` per reduced sample — but §4's measurement says those calls
  agree across platforms today, so what guards them is the golden
  fixture, which limits on purpose, rather than an evaluator we write.

One inherited choice to make deliberately: `reverb.ts` uses `Float64Array`
delay buffers where JUCE uses `float`, doubling memory traffic on the
most memory-bound of the three effects.

## 6 Chunks

1. **Property tests against the current TypeScript renderer.** Every
   assertion in decision 3, passing today. Cheap, valuable immediately,
   and any that fails is a real bug found before the port. These are the
   migration harness and they never change hands. Shipped (#50):
   fifteen properties in `src/generators/effect-properties.test.ts`, all
   built and measured through the build rules so nothing imports
   `src/audio/` except `wav.ts`. None of decision 3's stated assertions
   failed; seven were *missing*, and decision 3 above records them and
   how each was found.
2. **The insert chain ported to C++, behind the existing schemas** — in
   review. The three effects in `native/audiod/src/dsp/`, a
   `field-audiod --render <plan.json>` subprocess (decision 6), and the
   standalone `eq`/`limit`/`reverb` rules calling it (decision 8). Track
   inserts and the mix master chain still run the TypeScript until chunk
   3, which is why `src/audio/insert-chain.ts` is still here.

   **`juce_dsp` was not linked after all**, which is a departure from
   decision 5 worth stating rather than burying. The three effects need
   biquad state (a five-line loop), circular delay lines, and nothing
   else; `dsp::IIR::Filter` would have replaced the five lines with a
   template whose internals we would then be pinning by hope, against a
   byte-identity requirement (§4) that decision 5 predates. Hand-written
   is both smaller here and the only version we can hold still. If
   oversampling arrives for true-peak limiting, that is the moment to
   revisit.

   Chunk 1's fifteen properties pass unchanged against the C++, and
   mutating the C++ — Q-form alpha, auto-gain off, truncated delay
   sizing, JUCE's allpass, no stereo spread, no lookahead — fails exactly
   the properties it failed in TypeScript. The harness did what it was
   built for: it did not change hands.
3. **Rendering moves to the daemon** — in review. `track-render` and
   `mix` call it, so the plan grows an `op` discriminant (`effects`,
   `stem`, `mix`) and `RENDER_PLAN_VERSION` goes to 2. Summing lives in
   `native/audiod/src/dsp/mixdown.cpp`: placed clips into a stem, stems
   through faders into a mix, then master gain, master chain and the
   declared length in that order.

   **No `rule_version` bump, and no re-render.** Byte-identical again,
   including the awkward paths — clip fades, negative read offsets, reads
   past a source's end, mono content on a stereo stem, constant-power
   pan, and loop folding past the declared length. That was written
   expecting the opposite, and the cost it priced — bloom re-rendering
   and being re-verified by ear — is not incurred. Stem and mix goldens
   join the effects one, so a future DSP change fails there first and the
   bump goes with it.

   **What did not move: the rate and channel-count checks.** They stay in
   the control plane, reading WAV headers rather than decoding, because
   the messages they produce are user-facing diagnostics and belong with
   every other diagnostic rather than duplicated into C++ where they
   would drift. The daemon does arithmetic; the control plane does
   explaining.

   After this, `src/audio/insert-chain.ts` and the DSP beneath it are
   executors of nothing — dead code with passing tests, which is exactly
   the state chunk 4 exists to clear.
4. **The TypeScript DSP is deleted.** Shipped (#55): `biquad.ts`,
   `limiter.ts`, `reverb.ts`, `insert-chain.ts` and the three unit-test
   files, 492 lines. Not "`src/audio/` minus `wav.ts`" as this said —
   chunk 3 put `render-daemon.ts` in that directory, so what is left is
   the WAV codec and the client that spawns the renderer, neither of
   which is DSP.

   **Three properties had to be written before the delete was safe**, and
   finding them is the argument for checking rather than assuming. The
   claim "the tests stay" was true of twelve of the fifteen deleted
   assertions — the ceiling, the ramps, the channel link, T60, predelay,
   the stereo spread, the mix blend all have property equivalents, and
   reverb's tail-length assertion is covered by the golden, whose digest
   spans a file whose length would change. The three that did not were
   all `autoGainDB`'s: **make-up for cuts**, the **±12 dB clamp**, and
   **narrow-vs-wide proportionality**. Every normalize assertion in the
   harness used a boost at bandwidth 1 or wider, and so does the golden's
   +6.6 dB bell, so nothing looked at a cut, at the bound, or at a narrow
   band.

   Each gap was confirmed by mutation against the C++ before writing
   anything. `min(0, compensation)` — pad boosts, ignore cuts — passed
   353 of 353. Deleting the clamp outright passed 353 of 353. Widening
   bands under 0.5 octaves to 2 octaves *while computing compensation
   only*, so the rendered filter stays narrow, passed the 38 relevant
   tests (#55 review). The three new properties kill all three, and the
   fifteen pre-existing ones stay green under each, which is what says
   the new tests carry weight rather than duplicate.

   The third gap is the one worth remembering, because it was found by a
   reviewer after the first two had been fixed and the accounting written
   up as complete. "Twelve of fifteen are covered" is a claim about
   absence, and the only way to hold one is to mutate for it — reading
   the surviving tests and judging them sufficient is exactly what had
   already produced the wrong answer twice.

   The deeper point is that the deleted assertions had *already* stopped
   testing anything at chunk 2, when the executor changed: they exercised
   TypeScript functions that no longer ran. They were green, and they
   were measuring dead code. Deleting them did not remove coverage so
   much as stop the file from claiming coverage it had lost two chunks
   earlier — which is the failure mode worth naming, because nothing goes
   red when it happens.
5. **Sample-rate conversion in the built-in tier**, replacing
   `afconvert` in `normalize` — the work
   [linux-portability.md](../linux-portability/readme.md) §4.2–4.3 described,
   relocated and no longer blocking Linux. Decisions 9 and 10 above
   record the design: fixed-ratio polyphase, TPDF dither, and why JUCE's
   interpolator was rejected on aliasing rather than on taste.

   **`afconvert` had two callers, not one, and the second decided the
   scope.** `say.ts` converted the AIFF that macOS `say` emits into a WAV
   at the project rate. Keeping it meant teaching the daemon AIFF for one
   macOS-only rule, or keeping `afconvert` for that rule alone — either
   way the macOS dependency survives. So `say` is deleted instead
   ([voice-generation.md](../voice-generation/readme.md) §5), which is why this
   chunk retires **all nine** platform-guarded tests rather than the
   three a resampler alone would have freed. It also leaves bloom's
   `lead-vocal` without a source until the generated-voice tier ships;
   that gap is recorded rather than glossed.

   **Shipped.** `normalize` renders through `op: "normalize"`; the probe
   file `src/testing/platform.ts` is gone along with both capability
   checks, and nothing in the build shells out to a macOS binary any
   more. `RENDER_PLAN_VERSION` is 3.

   Since raised to 4 (2026-08-08): a placed clip may carry an optional
   `pan`, so a placement can balance its child the way a mix fader
   balances a track. Optional and omitted when centred, so no stem that
   never panned anything re-keys; the version still moves, because
   `validatePlan` refuses unknown keys and an older daemon must reject a
   plan describing work it will not do rather than render it centred.

   And to 6 (2026-08-08): a placed clip's `duration` may be zero. A
   placement's window is resolved from the rendered child, and an empty
   track renders to nothing — so zero is a length the control plane
   produces rather than one anybody authored, which is why an authored
   zero-length clip stays refused upstream where `timeSpan` is positive.

   And to 5 (2026-08-08): a `stem` plan may carry `length_samples` and
   `loop`, the two fields `mix` already had, so a track can be a song's
   output. The cross-field rule — looping needs a positive length to fold
   onto — moved into a shared `validateDeclaredLength` rather than being
   copied, since two ops disagreeing about what a loop without a length
   means is exactly the drift this validator exists to prevent.

   **This is the one rule whose output is not byte-identical to what it
   replaced**, and the difference is structural rather than incidental:
   every other chunk transliterated a TypeScript reference and could
   prove equality against it, while this one displaced a macOS binary
   there was never any way to diff against. So `normalize`'s
   `rule_version` goes to 2 and its artifacts re-render once — the cost
   chunks 2 and 3 priced and did not incur, arriving here instead.

   **Six findings in review say how far that goes** (#57). Four were
   coverage: routing 16-bit through the float writer, cutting
   `tapsPerPhase` from 128 to 32, replacing the input with the dither,
   and flooring the output length all left every property green. The
   properties now pin the format tag and width, the passband at 10/15/19
   kHz, the tone's magnitude against neighbouring bins, and a short
   source's survival — each mutation now fails exactly one of them. Two
   were the code itself: `bit_depth: 32` had regressed to IEEE float, and
   an odd `data` chunk went unpadded while our own reader already
   advanced past a pad byte.

   The lesson is the same one chunk 4 recorded and is worth the
   repetition: "with no oracle the properties are the specification" is a
   claim about what the properties *catch*, and only mutation answers it.
   Writing that sentence is not the same as earning it.

   With no oracle, the properties are the whole specification, so they
   were mutation-tested before being believed. Filtering at the input
   Nyquist instead of the lower of the two — the JUCE failure mode from
   decision 9 — folds a 30 kHz tone into a 44.1 kHz file at 14.1 kHz and
   **0 dB**, which the aliasing property catches and nothing else does.
   Removing the dither leaves a sub-LSB signal quantizing to digital
   black, which one other property catches and nothing else does. Both
   times the remaining five stayed green.
6. **Byte-identity established rather than asserted** — mostly done in
   chunk 2, and not the way this described. `-ffp-contract=off` is in the
   daemon's compile options, and a golden fixture in
   `src/audio/render-daemon.test.ts` renders a three-effect chain over
   material that actually limits and asserts its SHA-256. Both CI jobs
   check the same constant, so the platforms are compared through the
   golden rather than against each other, and a divergence fails on
   whichever one moved.

   The transcendental substitution this chunk was mostly about **was not
   needed**: measured, Apple's libm and glibc agree bit-for-bit on the
   values the built-in tier feeds them (§4). That was the expensive half
   of the chunk and it is retired, not deferred. What remains here is
   narrow: the limiter's per-sample `pow` is still a libm call on any
   chain that actually limits, and while it agrees today, it is the one
   place a future libm release could move a rendered artifact. The
   golden covers it — deliberately, on limiting material — so the
   question is now "does CI still pass" rather than "is this safe".

Ordering, as it actually went: 1, then
[linux-portability.md](../linux-portability/readme.md) chunks 1 and 4, then 2 with
6 folded in. Adding properties to a renderer while CI ran no tests was
the wrong order, and once the effect rules call `field-audiod --render`
the binary is a *build* dependency, so the Linux daemon build had to
land before this chunk rather than after it.

How it went: 3 depended on 2, 4 on 3, and 4 no longer waited on 6 once
the byte-identity lock existed. Chunk 5 depends on 2 and is the only one
left.

## 7 Open questions

**One still open as of chunk 5 (2026-08-07)**: whether a `--no-native`
subset is worth having for contributors who only touch the control plane.
That is contributor tooling rather than rendering, so shipping this plan
does not dispose of it. Everything else below is answered, and the
entries are kept because the reasoning behind an answer outlasts the
answer.

- ~~**When to start chunk 2.**~~ **Answered by doing it** — chunk 2
  shipped in #53, after chunk 1 and before AU hosting, on exactly the
  reasoning recorded here. Recommended: after chunk 1, and before AU
  hosting rather than during it — the port is cheap while there are
  three effects and no plugin variants, and the shipped algorithms
  transliterate nearly mechanically. The alternative, converging only
  when AU hosting forces it, keeps the phase order in
  [docs/projects](../README.md) undisturbed but pays a larger migration.
  Justin's call; nothing else in this plan depends on it.
- ~~**Does offline render run in-process or as an NRT mode of the
  daemon?**~~ **Answered** — decisions 6–8 above. It is a subprocess,
  musical time stays in the control plane, and standalone effect targets
  move first. SuperCollider's precedent held: one engine, two modes.
- **`field build` requires the native toolchain as of chunk 2** — not
  chunk 3, which is what this said while it was still a prediction. The
  standalone `eq`/`limit`/`reverb` rules already spawn the daemon, so an
  uncached build of one fails without `pnpm build:native`.
  [linux-portability.md](../linux-portability/readme.md) chunk 4 was therefore a
  hard prerequisite for *this* chunk, which is why it went first.
  README's build section says so now too. What is still open is whether a
  `--no-native` subset is worth having for contributors who only touch
  the control plane — a question chunk 3 sharpens, since it takes stems
  and mixes across the same boundary.
- ~~**Resampler quality target**~~, inherited unresolved from
  [linux-portability.md](../linux-portability/readme.md) §5: taps, transition
  width, stopband attenuation, and whether JUCE's variable-rate
  `WindowedSinc` clears the bar or a fixed-ratio polyphase design is
  wanted. Dither on bit-depth reduction was open there too.
  **Answered by decisions 9 and 10**: fixed-ratio polyphase at 128 taps
  per phase, 100 dB stopband, the transition placed against the lower
  Nyquist, and 1-LSB TPDF dither at 16 and 24 bits. `WindowedSinc` does
  not clear the bar and the reason is not quality but correctness — its
  kernel width ignores the ratio, so it aliases when downsampling.
