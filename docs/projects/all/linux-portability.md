# Plan: Linux portability — the daemon, and CI that runs anywhere

**Status:** Chunk 1 in review (#49); chunk 4 not started. Chunks 2–3
**withdrawn** to [render-pipeline.md](render-pipeline.md), which puts
sample-rate conversion in the daemon's built-in tier rather than in
TypeScript; §1.1 below records what that replaced and why.

Chunk 1 became the urgent one after #46 moved the single CI job to
`ubuntu-latest` by **removing** `pnpm test` and `pnpm build:native`, so
green CI stopped meaning the tests ran. #46 said that would be restored
when this plan converted `normalize` to TypeScript — which is exactly
what has been withdrawn, leaving chunk 1's platform guards as the only
route back.

Written after measuring what actually binds to macOS: the whole suite
was run on Linux in a container at `3e03322`, and **9 tests of 301
failed**, all of them shelling out to a macOS binary — `say` (6, in
`say.test.ts`) and `afconvert` (3, one each in `stem.test.ts`,
`effects.test.ts`, `build.test.ts`). `pnpm typecheck` and `pnpm build`
pass unchanged.
Two things that looked platform-bound are not: the SuperCollider tests
are `describe.skipIf(!sclangPresent)` and have been skipping on macOS CI
all along (sclang runs on Linux), and the daemon tests are
`describe.skipIf(!binary)`, so they run only where the binary was built.

**Goal:** field builds, tests, and plays on Linux, so that the parts of
the system with no business being platform-bound stop being so — and so
CI can run most of the suite on a runner that does not bill at 10×. The
charter does not change: macOS is the product platform (overview.md
"V1 platform scope"), and this buys reproducibility and cheap CI, not a
second supported product.

## 1 Decisions (DECIDED, 2026-08-07)

1. **`normalize` stops shelling out; the conversion moves to the
   built-in tier** — **superseded 2026-08-07**, see
   [render-pipeline.md](render-pipeline.md) §2. `afconvert` is asked for
   exactly one thing — `-f WAVE -d LEI<bits>@<rate>` — which is a
   sample-rate conversion plus a float→int format change, and it should
   be field's own code rather than an OS binary. That much stands.

   What this replaced: the original decision put the conversion **in
   TypeScript**, on the grounds that the mixer, biquads, limiter and
   reverb already live there and offline work has no deadline
   (mix-assembly.md §1). That reasoning was sound and its premise did
   not survive — [render-pipeline.md](render-pipeline.md) §2.1 shows the
   TS DSP itself is on its way to the daemon, because an insert chain
   containing `au:` cannot be rendered by TypeScript at all. Writing a
   fourth TS DSP module immediately before moving the other three is the
   expensive way to be right. The conversion still happens, in C++, as
   chunk 5 there.

   Still rejected, for the original reasons: **`ffmpeg` or `sox` behind
   the same `execFile`** — ports in an afternoon and keeps the defect;
   and **`afconvert` on macOS with a Linux fallback binary** — two
   resamplers means two answers to the same action key, worse than
   either alone.

   One framing here did not survive either. This plan treated
   **`afconvert` as an anomaly**: an OS-versioned binary that had snuck
   inside the meaning of a cache key, where field's premise is that the
   same key implies the same bytes. With AU and UAD hosting coming to
   offline render, versioned native binaries inside cache keys are the
   *permanent condition* rather than an anomaly, and the general answer
   — binary identity and version as action-key inputs — is
   [render-pipeline.md](render-pipeline.md) §4. `afconvert` is the first
   instance of that problem, not a special case to eliminate.

   Priced, whenever it lands: `normalize`'s `rule_version` bumps, so
   every normalized output re-renders once. That is the honest cost of
   changing what the rule *is*, and it is the same trade §4.4 of
   project-layout.md took for the `sc-render` → `supercollider` rename.

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
   already pass on Linux at `3e03322`. (#46 has since moved the single
   job to `ubuntu-latest` by dropping `pnpm test` and
   `pnpm build:native` outright; that is a stopgap this decision
   replaces, not an instance of it.) A `ubuntu-latest` job runs
   typecheck, build, the Python `pyright` gate, and every test that does
   not shell out to a macOS binary; a `macos-latest` job runs `say`, the
   three `afconvert` tests, and the daemon.

   **The guard is per test, not per file.** "By what a test needs" is
   the whole decision, and excluding files breaks it. The nine
   platform-bound cases live in four files holding 72 tests between them
   — `say.test.ts` 6, `stem.test.ts` 30, `effects.test.ts` 5,
   `build.test.ts` 31 — so dropping the files would take 63
   platform-independent graph, stem and DSP tests off Linux, which is
   the code the Linux job exists to exercise. Only `say.test.ts` is
   wholly platform-bound. The other three contribute one test each,
   named rather than numbered because line numbers rot:
   `graph/build.test.ts` "normalizes real audio through afconvert",
   `generators/stem.test.ts` "builds the whole recipe chain: asset →
   target → stem, with real rules", and `generators/effects.test.ts`
   "normalize accepts a target, closing the rate-fix loop". Each gets
   its own guard rather than a move to a Darwin-only sibling file, so
   the reason stays next to the test.

   Both jobs together keep today's coverage exactly, and most of the
   wall clock moves off the 10× meter.

   This is decision 4 and not an afterthought because it is what makes
   the rest affordable: the 3,000 included minutes are 300 macOS
   minutes, and a two-minute run means ~150 runs a month for the whole
   organization.

   **Amended on implementation:** the macOS job runs the *whole* suite,
   not the nine tests and the daemon. This decision assumed narrowing
   macOS was where the minutes were, which was never measured; the suite
   is **12.4s** wall clock, against a macOS job dominated by
   `pnpm install` and `pnpm build:native`. Narrowing it would save
   seconds and cost a hand-maintained file list that drifts silently as
   tests move. The minutes argument above is untouched and still the
   reason for the split — it is the *native build* that costs, which is
   why the Linux job carries typecheck, `pyright` and the fast gate.
   Running everything on macOS is also the right default for the
   platform the product ships on (overview.md "V1 platform scope"):
   giving the product platform partial coverage is the wrong way round.

5. **Linux is a build-and-test target, not a support promise.** No
   Linux packaging, no audio-backend matrix, no "which of ALSA, JACK or
   PipeWire is blessed". The daemon must build and pass its protocol
   tests in null-output mode; whether it drives a particular Linux audio
   stack pleasantly is out of scope until somebody actually wants to
   make music on one.

## 2 Shape

- **The resampler and format conversion** moved to
  [render-pipeline.md](render-pipeline.md) §6, chunk 5. `normalize`
  keeps calling `afconvert` until then — a known wart with a dated
  replacement, which beats a wart with a fresh reimplementation in front
  of it. Its schema (`sample_rate`, `bit_depth`) and `source:` semantics
  do not change when the implementation does.
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

`pnpm typecheck`, `pnpm build` and `pnpm test` pass on Linux with the
`say` and `afconvert` tests skipped by platform guard rather than
failing; the daemon builds on Linux and its protocol tests pass in
null-output mode; and CI runs both jobs, with Linux carrying typecheck,
`pyright` and everything that does not need a macOS binary. bloom still
builds and plays on macOS with the same audible result.

Not "the macOS job runs only what needs macOS", which is what this
section asked for before the job was built: decision 4's amendment runs
the whole suite there, because the suite is 12.4s against a job
dominated by the native build and macOS is the platform the product
ships on.

Byte-identical cross-platform rendering was part of this plan's
definition of done and is now [render-pipeline.md](render-pipeline.md)
§4's, where it is also scoped honestly: it is a claim about the
built-in tier, and no project using an `au:` insert can make it.

## 4 Chunks

1. **CI split + concurrency** — in review (#49). Two jobs, per-test
   guards on the nine platform-bound cases (decision 4) so the Linux job
   skips those and runs the other 63 tests in the same files, and
   `cancel-in-progress`. Verified both ways before opening: 320 passed
   with the binaries present, 311 passed and 9 skipped with `afconvert`
   and `say` off PATH. **#46 is not this chunk**: it moved the one
   job to `ubuntu-latest` by deleting `pnpm test` and
   `pnpm build:native`, and says so in a workflow comment — a temporary
   runner move that reduced coverage, not the split. Restoring
   `pnpm test` on CI is this chunk's guards, since #46's stated route
   (converting `normalize` to TypeScript) was withdrawn.
2. ~~**The resampler and format conversion**~~ — withdrawn to
   [render-pipeline.md](render-pipeline.md) §6, chunk 5.
3. ~~**`normalize` swaps implementation**~~ — withdrawn with chunk 2.
4. **The daemon on Linux**: `#if JUCE_MAC`, rescan fallback, Linux CI
   build, protocol tests green in null-output mode. Restores
   `pnpm build:native`, which #46 also dropped.

Chunks 1 and 4 are what remain, 4 depends on 1, and 1 is available now.
Note that [render-pipeline.md](render-pipeline.md) §7 raises a question
this plan cannot answer alone: if rendering moves into the daemon,
`field build` gains a native-toolchain dependency on Linux, which cuts
against this plan rather than with it. Chunk 4 is also a prerequisite
for [render-pipeline.md](render-pipeline.md) chunk 6, whose
cross-platform byte comparison needs a Linux daemon build to run
against.

## 5 Open questions

- **Filter quality target** and **dither on bit-depth reduction** moved
  with the resampler to [render-pipeline.md](render-pipeline.md) §7,
  where the work now lives. Both are still open.
- **Does "field never resamples implicitly" survive?** Today the
  refusal (`stem.ts`) is a guard against surprise; with cheap in-house
  resampling the argument for it is unchanged, but the wording in the
  error should stop implying the conversion is expensive or external.
- **SuperCollider in CI.** Installing `sclang` on the Linux job would
  un-skip the sc-render integration tests, which have never run on CI.
  Cheap coverage win, but it is a separate decision with its own minute
  cost.
