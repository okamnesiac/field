# Plan: One rendering pipeline

**Status:** Chunk 1 in review (#50); chunks 2–6 not started. Written
after [linux-portability.md](linux-portability.md) proposed a fourth
TypeScript DSP module and the question "why is any of this in
TypeScript?" turned out to have a better answer than the one on record.
Supersedes part of [effects.md](effects.md) §1 — see §6 there.

**Goal:** One executor for rendered audio. A render is implemented
once, plugins work offline, and what the daemon monitors is what the
graph renders — without maintaining the same effect twice.

## 1 What changed

[effects.md](effects.md) §1 and [mix-assembly.md](mix-assembly.md) §1
both put DSP in TypeScript on the same reasoning: *the executor is the
replaceable part; the contract is the durable part.* That reasoning
stands and this plan does not overturn it. What is new is that the
replacement date is now knowable, and neither plan followed its own
logic to the end.

Both were also explicit that they were provisional.
[mix-assembly.md](mix-assembly.md) §1 scoped its work as "**the first**
mixer," with "No plugins (that phase comes with the daemon and AU
hosting)." [audio-engine.md](../../audio-engine.md) already lists
"offline rendering where supported" among daemon responsibilities. The
daemon was always going to render offline; what was missing was the
argument for *when*.

## 2 Decisions (DECIDED, 2026-08-07)

1. **The daemon is the single executor for rendered audio.** An insert
   chain is a serial signal path, and TypeScript cannot host an
   AudioUnit. [effects.md](effects.md) §1 anticipated `au:` as an
   additive *schema* change, which it is — but the moment a chain reads
   `eq → au:1176 → limit`, something has to render that chain. The
   options are buffers crossing the IPC boundary mid-chain with delay
   compensation split across two processes, or the daemon rendering the
   whole chain. Only the second is real, so the executor question was
   settled the moment AU hosting entered the roadmap; it just was not
   noticed.

   Rejected: **TypeScript offline, native live.** That is two
   implementations of every effect, forever — precisely the parity seam
   [effects.md](effects.md) §1 recorded as a debt rather than a design.

   Rejected: **deferring until AU hosting is built.** The schema already
   discriminates on `effect:`, so nothing breaks today; but every
   further TS DSP module and every rendered artifact raises the
   migration cost, and the resampler in
   [linux-portability.md](linux-portability.md) §2 was about to be the
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
   name, the one [effects.md](effects.md) §1 records: "its iOS EQ
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
   [mix-assembly.md](mix-assembly.md) §1 defines this path as the one
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

   Rejected: **[effects.md](effects.md) §1's "bit-exact reference the
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
   [effects.md](effects.md) §2, and all of them covered today only by the
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
     renderer that ignored the parameter passed. The blend law is exactly
     assertable: the first wet tap is a whole comb away, so sample 0 is
     exactly `1 − mix`.
   - **`release_ms` is honoured.** Hard-coding 100 ms passed; only the
     attack side had been measured.

   With those, the harness catches **18 of 19** deliberate mutations. The
   one survivor perturbs untouched gain by 1e-9 dB, which no float32 can
   represent — the same mutation at 1e-6 dB is caught.

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
     "better math": Fyra parity ([effects.md](effects.md) §2 pins the
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

## 3 What JUCE does and does not supply

Checked against the pinned JUCE 8.0.4 tree, not from memory.

| Piece | JUCE has it | Usable as-is |
| --- | --- | --- |
| Biquad coefficients | `dsp::IIR::ArrayCoefficients` — plain C++ RBJ, no Apple | No: Q-parameterised, fails the bandwidth test |
| Biquad processing | `dsp::IIR::Filter`, transposed direct form II | Yes, fed field's coefficients |
| EQ auto-gain | — | No equivalent exists |
| Reverb | `juce::Reverb`, Freeverb, same base tables | No: `roomSize` not T60, no predelay, Jezar allpass, truncated rate scaling |
| Limiter | `dsp::Limiter`, threshold + release only | No: no lookahead, and 0 dBFS by hard clip — no arbitrary ceiling by gain reduction |
| Resampling | `Interpolators::WindowedSinc`, 100 crossings/side | Probably: variable-rate, not fixed-ratio polyphase |
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
- **Transcendentals are the exposure, in either language.** libm's
  `sin`/`cos`/`sinh`/`pow` differ in the last ulp between Apple's and
  glibc's. The advantage of C++ is that a polynomial you control can be
  substituted; in JavaScript there is no remedy at all. JUCE builds
  with `-O3` and no `-ffast-math`, so basic arithmetic is safe, but
  `-ffp-contract=off` is needed to stop FMA contraction from varying by
  compiler. **This is chunk 6, not an assumption** — everything in this
  section is work to be done, and the property tests in §2.3 assert
  tolerances that a last-ulp divergence passes straight through.
- **OS-versioned binaries inside cache keys are the permanent
  condition, not an anomaly.** `afconvert` is the first instance, not a
  special case: a UAD plugin version bump changes output bytes under a
  stable key exactly as a macOS resampler update would. The general
  answer — binary identity and version as action-key inputs — is worth
  building once, and it retires
  [linux-portability.md](linux-portability.md) §1.1's framing of
  `afconvert` as a defect to eliminate.

## 5 Port notes

Two things worth designing rather than transliterating, both of which
improve determinism and speed at once:

- **`reverb.ts` uses `%` for its circular buffers**, twelve times per
  sample per channel. Integer division where JUCE uses compare-and-reset
  (`if (++i >= size) i = 0`); likely the largest single gap against
  JUCE's reverb, and mechanical to fix.
- **`limiter.ts` calls `Math.pow` per sample per channel,
  unconditionally** — ~17M calls on a three-minute stereo mix. The gain
  curve is *exactly* 0 dB wherever audio was untouched, and
  `pow(10, 0/20)` is 1, so guarding the call skips the transcendental
  for most samples in typical material — exactly, not approximately.
  That is the speedup, and it removes §4's libm exposure on every sample
  the limiter left alone. It does not remove it on the ones it touched:
  a chain that actually limits still calls `pow` per reduced sample, and
  byte identity there needs an evaluator field controls. That is chunk
  6's problem, named there rather than left implied here.

One inherited choice to make deliberately: `reverb.ts` uses `Float64Array`
delay buffers where JUCE uses `float`, doubling memory traffic on the
most memory-bound of the three effects.

## 6 Chunks

1. **Property tests against the current TypeScript renderer.** Every
   assertion in decision 3, passing today. Cheap, valuable immediately,
   and any that fails is a real bug found before the port. These are the
   migration harness and they never change hands. In review (#50):
   fifteen properties in `src/generators/effect-properties.test.ts`, all
   built and measured through the build rules so nothing imports
   `src/audio/` except `wav.ts`. None of decision 3's stated assertions
   failed; seven were *missing*, and decision 3 above records them and
   how each was found.
2. **`juce_dsp` linked, insert chain ported**: the three effects
   hand-written in C++ behind the existing schemas, the same tests green
   against the daemon.
3. **Rendering moves to the daemon** — `track-render` and `mix` call it;
   `rule_version` bumps once, bloom re-renders and is re-verified by ear.
4. **The TypeScript DSP is deleted.** `src/audio/` minus `wav.ts`. The
   tests stay.
5. **Sample-rate conversion in the built-in tier**, replacing
   `afconvert` in `normalize` — the work
   [linux-portability.md](linux-portability.md) §4.2–4.3 described,
   relocated and no longer blocking Linux.
6. **Byte-identity established rather than asserted.**
   `-ffp-contract=off` in the daemon's compile options; transcendentals
   replaced by polynomials field controls — in coefficient and table
   setup, and also **on the per-sample path**, where the limiter's
   dB→linear conversion is the one live case (§5). The zero-gain guard
   there skips untouched samples exactly, so what is left to schedule is
   a controlled evaluator for the reduced ones; and the cross-platform
   fixture has to render material that actually limits, or it passes
   without exercising the most likely divergence in the built-in tier.
   Then a test that renders the same input on macOS and Linux and
   compares bytes, running in CI rather than by hand. Without all of
   this, §4's claim is a hope: the property tests in chunk 1 assert
   tolerances and will not catch a last-ulp divergence.

Chunk 1 is independent of everything else here, but
[next.md](../next.md) puts [linux-portability.md](linux-portability.md)
chunk 1 ahead of it: adding properties to a renderer while CI runs no
tests is the wrong order. 2 depends on 1; 3 on 2; 4 on 3 **and 6**; 5
on 2. Chunk 6 runs alongside 2 — the compile flags
and the polynomial substitutions are part of writing the C++, not a
later pass over it — but its cross-platform comparison needs the Linux
daemon build from [linux-portability.md](linux-portability.md) chunk 4,
and it gates chunk 4 here: deleting `reverb.ts` before byte-identity is
locked removes the only thing that would notice a regression.

## 7 Open questions

- **When to start chunk 2.** Recommended: after chunk 1, and before AU
  hosting rather than during it — the port is cheap while there are
  three effects and no plugin variants, and the shipped algorithms
  transliterate nearly mechanically. The alternative, converging only
  when AU hosting forces it, keeps the phase order in
  [docs/projects](../now.md) undisturbed but pays a larger migration.
  Justin's call; nothing else in this plan depends on it.
- **Does offline render run in-process or as an NRT mode of the
  daemon?** SuperCollider already resolves this shape the same way —
  [architecture.md](../../architecture.md) records scsynth as offline
  NRT by default and live as a graph node, one engine and two modes.
  The daemon plausibly wants the same, but the IPC surface for "render
  this graph node to a file" is not designed yet.
- **Does `field build` now require the native toolchain?** Today 268 of
  301 tests pass on Linux with no native build at all. If render lives
  in the daemon, the Linux job needs a full JUCE build, which cuts
  against [linux-portability.md](linux-portability.md) rather than with
  it. A `--no-native` subset, or accepting the dependency, is
  undecided.
- **Resampler quality target**, inherited unresolved from
  [linux-portability.md](linux-portability.md) §5: taps, transition
  width, stopband attenuation, and whether JUCE's variable-rate
  `WindowedSinc` clears the bar or a fixed-ratio polyphase design is
  wanted. Dither on bit-depth reduction is still open there too.
