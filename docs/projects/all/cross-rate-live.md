---
status: Draft
---

# Plan: Cross-rate live wiring

**Goal:** deliver [realtime.md](realtime.md) decision 7's promise — "a
foreign-rate dirty track therefore runs live like every other track" —
and retire both rate refusals it left behind: the compile-time refusal
of cross-rate sessions (chunk 2 amendment) and the daemon's refusal of
a device that cannot switch to the session's rate (chunk 4 amendment).
After this plan, a 44.1 kHz project plays live on a 48 kHz-locked
interface, and editing a foreign-rate child lands next block like any
other edit. Streaming rings stay deferred (realtime.md chunk 2
amendment records them); this plan is written against the materialized
engine and says where rings would change it.

## 1 What already exists

Multi-rate ([multi-rate.md](multi-rate.md) decision 4) minted the edge:
a parent placing a cross-rate child depends on
`//songs/<s>/convert:track-<child>-<rate>`, a `resample` rule node —
not on the child directly. To `compileSession` that is an ordinary file
dependency, so the freeze (realtime.md decision 4) already covers the
clean case: a cached conversion arrives as a file window and the
session never sees the child's rate. Verified on a fixture: `main`
(48 k) → `convert:track-low-48000` → `track:low` (44.1 k), zero
diagnostics. The chunk-1 DSP library already contains the streaming
`dsp::Resampler` (causal, taps/2 group delay) and its whole-buffer
wrapper `resample()` — one kernel, per decision 7 there is never a
second.

## 2 Decisions (DECIDED, 2026-08-11)

1. **A dirty conversion whose source is live evaluates live; the edge
   converts the materialized buffer through the offline wrapper.**
   Today a dirty convert dep is built synchronously inside the compile
   — the re-render-and-swap cliff decision 7 rejected, hidden behind
   the refusal. Instead: when a `convert:` dep is uncached and its
   source is this song's `track:` or `tap:`, the child compiles live
   at its own rate and the parent's window carries the edge; the
   engine renders the child in full (the materialized posture) and
   converts that buffer wholesale with `resample()` — the same kernel
   on the same samples the offline node would see, so bit-identity
   with the offline render is by construction. No group delay appears:
   the future exists, lag is availability, not shift — the same
   reasoning that keeps comp_delay zero. A dirty conversion whose
   source is a committed file (a cross-rate asset placed directly)
   still builds in the compile: converting a file is a build, and it
   is dirty only when the file changed. Under streaming rings the edge
   feeds the same kernel blockwise ahead of the playhead;
   block-invariance says the samples cannot move.
2. **The compile refusal narrows to nothing.** The all-tracks rate
   check deletes; rate correctness is an edge property now, the way
   multi-rate made it one offline. The compiler mirrors the wrapper's
   output-length rule (`max(1, round(n·to/from))` in reduced-ratio
   integer arithmetic, resample.cpp's flush) for window durations and
   child lengths, the way it already mirrors chain latency and growth.
3. **Device delivery converts when the device cannot switch.**
   `maybeMatchDeviceRate` still moves the device to the session's rate
   when it can — bit-perfect delivery, as today. When it cannot, the
   output stream runs through a streaming `dsp::Resampler` into the
   device instead of refusing — what the artifact path's transport
   always did, now with the project's own kernel. Delivery conversion
   is outside the golden (it always was) and adds taps/2 ≈ 1.4 ms,
   reported nowhere because the transport clock stays in session
   samples. The daemon's refusal message and the CLI's
   artifact-spelling rescue both retire.
4. **SESSION_VERSION bumps to 2.** Track rates become load-bearing at
   edges — an old daemon summing a cross-rate session raw would be
   quietly wrong, which is exactly what the version exists to prevent
   (session.ts: "an engine evaluating a session whose meaning it
   misreads is a quietly wrong monitor"). The old daemon's rejection
   message already says what to do.
5. **The dirty list speaks convert labels for cross-rate children.**
   The watch's background freeze builds the conversion (which builds
   the child's stem beneath it), and the next compile serves the file
   window — the same converge-by-construction loop as chunk 4, one
   node deeper.

## 3 Chunks

One chunk: a single implementation PR carrying the compiler, the
engine, the device fallback, and the docs sweep, because none of the
halves is testable without the others. It follows this plan and flips
the status to Active when it opens — Shipped when it lands, since the
chunk is the plan.

## 4 Definition of done

The fixture song (48 k main placing a 44.1 k child) compiles cold with
the child live, and `--render-live` of that session is byte-identical
to the offline artifact; built warm, the conversion freezes to a file
window and the golden holds again; the watch arc on a cross-rate edit
runs dirty-live → background build → frozen swap. A 44.1 kHz project
plays on the 48 kHz null device (and on real hardware) instead of
refusing, and `field play <song>` needs no interim artifact spelling.
Both refusal messages are gone from the tree.
