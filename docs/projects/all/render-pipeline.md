# Plan: One rendering pipeline

**Status:** Planned (2026-08-07), not started. Written after
[linux-portability.md](linux-portability.md) proposed a fourth
TypeScript DSP module and the question "why is any of this in
TypeScript?" turned out to have a better answer than the one on record.
Supersedes part of [effects.md](effects.md) §1 — see §7 there.

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
     points whose ratio is `2^B`; broadband noise through a
     `normalize: true` curve comes out at the RMS it went in at.
   - **Reverb** — an impulse decays to −60 dB in `decay` seconds; the
     first wet sample lands at `predelay_ms`.
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

4. **The three shipped effects keep their algorithms and are ported by
   hand.** The claim "ours is better" holds unevenly, and the honest
   ranking is worth recording because it decides what to defend later:

   - **`limit` — genuinely better, and not close.** `juce::dsp::Limiter`
     exposes only `setThreshold` and `setRelease` — no lookahead — and
     is internally a two-stage compressor with ballistics, so it
     overshoots transients. field's computes the exact per-sample gain
     pinning every peak to the ceiling, then slews it backward (attack)
     and forward (release), making the ceiling a hard guarantee. That
     construction is only available offline, which is the right thing to
     exploit here.
   - **`reverb` — better parameterised, same algorithm.**
     `juce::Reverb` is Freeverb with byte-identical tunings to
     `reverb.ts`, but applies one `roomSize`-derived feedback to all
     eight combs, so each decays at a different real rate and the knob
     means nothing measurable. field derives feedback per comb from its
     own length, which is what makes `decay` mean T60 and makes the test
     in decision 3 possible. field also has predelay; JUCE has none. Be
     clear-eyed all the same: Freeverb is the canonical *teaching*
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
| Reverb | `juce::Reverb`, Freeverb, identical tunings | No: `roomSize` not T60, no predelay, float |
| Limiter | `dsp::Limiter`, threshold + release only | No: no lookahead, cannot guarantee a ceiling |
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
  compiler.
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
  That is both the speedup and most of the libm exposure from §4.

One inherited choice to make deliberately: `reverb.ts` uses `Float64Array`
delay buffers where JUCE uses `float`, doubling memory traffic on the
most memory-bound of the three effects.

## 6 Chunks

1. **Property tests against the current TypeScript renderer.** Every
   assertion in decision 3, passing today. Cheap, valuable immediately,
   and any that fails is a real bug found before the port. These are the
   migration harness and they never change hands.
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

Chunk 1 is independent and available today. 2 depends on 1; 3 on 2; 4
on 3; 5 on 2 and is otherwise unordered.

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
