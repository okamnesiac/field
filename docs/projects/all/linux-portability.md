# Plan: Linux portability — the daemon, and normalize without afconvert

**Status:** Planned (2026-08-07), not started. Written after measuring
what actually binds to macOS: the whole suite was run on Linux in a
container at `3e03322`, and **9 tests of 301 failed**, all of them
shelling out to a macOS binary — `say` (6, in `say.test.ts`) and
`afconvert` (3, one each in `stem.test.ts`, `effects.test.ts`,
`build.test.ts`). `pnpm typecheck` and `pnpm build` pass unchanged.
Two things that looked platform-bound are not: the SuperCollider tests
are `describe.skipIf(!sclangPresent)` and have been skipping on macOS CI
all along (sclang runs on Linux), and the daemon tests are
`describe.skipIf(!binary)`, so they run only where the binary was built.

**Goal:** Bloom builds, tests, and plays on Linux, so that the parts of
the system with no business being platform-bound stop being so — and so
CI can run most of the suite on a runner that does not bill at 10×. The
charter does not change: macOS is the product platform (overview.md
"V1 platform scope"), and this buys reproducibility and cheap CI, not a
second supported product.

## 1 Decisions (DECIDED, 2026-08-07)

1. **`normalize` stops shelling out; the conversion moves into
   TypeScript.** `afconvert` is asked for exactly one thing —
   `-f WAVE -d LEI<bits>@<rate>` — which is a sample-rate conversion
   plus a float→int format change. Both belong in the same place the
   mixer, the biquads, the limiter and the reverb already live: offline
   work has no deadline (mix-assembly.md §1), and `wav.ts` already reads
   and writes the formats involved.

   Rejected: **`ffmpeg` or `sox` behind the same `execFile`.** It ports
   in an afternoon and keeps the defect. Rejected: **keep `afconvert` on
   macOS with a Linux fallback binary** — two resamplers means two
   answers to the same action key, which is worse than either alone.

   The reason this is an upgrade rather than a port: **`afconvert` is an
   OS-versioned binary sitting inside the meaning of a cache key.**
   Bloom's premise is that the same key implies the same bytes, and
   today a macOS update could change a resampler under a stable key —
   the same hazard accepted deliberately and narrowly for `voice: Siri`
   (#43), except here it is load-bearing for every rate conversion in
   the graph. An in-house resampler is IEEE-754 double arithmetic with
   no platform library underneath, so `normalize` becomes bit-identical
   across machines *and* platforms — a stronger claim than Bloom can
   make today, and one worth a test that asserts it.

   Priced: `normalize`'s `rule_version` bumps, so every normalized
   output re-renders once. That is the honest cost of changing what the
   rule *is*, and it is the same trade §4.4 of project-layout.md took
   for the `sc-render` → `supercollider` rename.

2. **The daemon ports behind `#if JUCE_MAC`, not behind an
   abstraction.** Exactly two things in `player.cpp` are macOS-only:
   the `AudioObjectAddPropertyListener` registrations for
   "default output device changed" and "device list changed" (#16).
   Everything else already runs through JUCE's `AudioDeviceManager`,
   which speaks ALSA/JACK on Linux, and `registerBasicFormats`, which
   covers WAV everywhere. The listeners get a `#if JUCE_MAC` and other
   platforms fall back to a periodic device rescan on the timer the
   daemon already runs.

   Rejected: **a `HardwareWatcher` interface with per-platform
   implementations.** Fourteen lines do not earn an abstraction, and the
   fallback is the honest description of what other platforms can do
   today — the seam can appear later if a real Linux hot-plug path
   (udev) is ever wanted.

3. **`say` does not port, and is not made to.** It is macOS
   text-to-speech by definition. It is already isolated in one
   generator, so a project that uses it is macOS-bound and everything
   else is not. When a better voice library arrives
   ([voice-generation.md](voice-generation.md)), `say` retires rather
   than growing a Linux branch — and a `say` recipe on Linux should fail
   with "this rule needs macOS", which it already does.

4. **CI splits by what a test needs, not by platform loyalty** — and it
   splits *before* any of this work, because it can. 268 of 301 tests
   already pass on Linux at `3e03322`. A `ubuntu-latest` job runs
   typecheck, build, the Python `pyright` gate, and everything except
   the four platform-bound files; a `macos-latest` job runs `say`, the
   three `afconvert` tests, and the daemon. Both jobs together keep
   today's coverage exactly, and most of the wall clock moves off the
   10× meter.

   This is decision 4 and not an afterthought because it is what makes
   the rest affordable: the 3,000 included minutes are 300 macOS
   minutes, and a two-minute run means ~150 runs a month for the whole
   organization.

5. **Linux is a build-and-test target, not a support promise.** No
   Linux packaging, no audio-backend matrix, no "which of ALSA, JACK or
   PipeWire is blessed". The daemon must build and pass its protocol
   tests in null-output mode; whether it drives a particular Linux audio
   stack pleasantly is out of scope until somebody actually wants to
   make music on one.

## 2 Shape

- **The resampler.** Band-limited, windowed-sinc (Kaiser) polyphase, in
  `src/audio/`. Inputs are the source and target rates as integers, so
  the conversion is a rational L/M with a precomputed filter bank rather
  than per-sample interpolation. Deterministic by construction: no
  lookup into platform math beyond `Math.sin`/`Math.exp`, which are
  IEEE-754 and identical across the platforms in scope.
- **Format conversion.** Float32 → LEI16/24/32, and back where a source
  is already integer. `wav.ts` gains an integer writer; `readWav`
  already normalizes to float.
- **`normalize` becomes a pure TypeScript generator**, keeping its
  schema (`sample_rate`, `bit_depth`) and its `source:` semantics
  exactly. Only `rule_version` and the implementation change.
- **`say` keeps `afconvert`** for its AIFF→WAV step, which is fine: it
  is macOS-only anyway, and pretending otherwise would be the two-answer
  problem decision 1 rejects.
- **The daemon.** `#if JUCE_MAC` around the listeners, a rescan fallback
  elsewhere, and Linux build dependencies in CI (`libasound2-dev` at
  minimum; JUCE 8 console apps typically want a small X11/freetype set
  even headless — to be discovered on the first red build, not guessed
  at here).
- **CI.** Two jobs, `concurrency: cancel-in-progress` so a superseded
  push stops paying, and the native build cache keyed as it is today.

## 3 Definition of done

`pnpm typecheck`, `pnpm build` and `pnpm test` pass on Linux with only
the `say` tests skipped by platform guard rather than failing; the
daemon builds on Linux and its protocol tests pass in null-output mode;
a normalized output renders **byte-identical on macOS and Linux** from
the same input, asserted by a test that pins the hash; and CI's macOS
job runs only what needs macOS. field still builds and plays on macOS
with the same audible result — the mix's hash moves once, at the
`rule_version` bump, and then stays put.

## 4 Chunks

1. **CI split + concurrency.** No source changes; available today,
   pays for the rest. Guard the four platform-bound files so the Linux
   job skips rather than fails.
2. **The resampler and format conversion**, with tests: known-signal
   THD/aliasing bounds, rate round-trips, and a cross-platform hash
   assertion run in a container.
3. **`normalize` swaps implementation**, `rule_version` bumps, field
   re-renders once and is re-verified by ear.
4. **The daemon on Linux**: `#if JUCE_MAC`, rescan fallback, Linux CI
   build, protocol tests green in null-output mode.

Chunks 1 and 2 are independent; 3 depends on 2; 4 depends only on 1.

## 5 Open questions

- **Filter quality target.** Taps, transition width, stopband
  attenuation — and what a test asserts about them. "Sounds fine" is not
  a bound, and neither is matching `afconvert` bit-for-bit, which is
  explicitly not the goal. A candidate: ≥100 dB stopband, measured as
  aliasing energy from a swept sine, which is comfortably past 24-bit.
- **Dither on bit-depth reduction.** Float→16-bit arguably wants TPDF
  dither, and dither is random, which collides with the determinism this
  plan is partly for. Options: no dither (deterministic, defensible at
  24-bit, questionable at 16), or seeded dither with the seed in the
  action key (deterministic *and* correct, at the cost of one more
  parameter). Unresolved, and worth resolving before chunk 2 rather than
  after.
- **Does "Bloom never resamples implicitly" survive?** Today the
  refusal (`stem.ts`) is a guard against surprise; with cheap in-house
  resampling the argument for it is unchanged, but the wording in the
  error should stop implying the conversion is expensive or external.
- **SuperCollider in CI.** Installing `sclang` on the Linux job would
  un-skip the sc-render integration tests, which have never run on CI.
  Cheap coverage win, but it is a separate decision with its own minute
  cost.
