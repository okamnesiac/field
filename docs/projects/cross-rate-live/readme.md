---
status: completed
---

**Outcome:** Shipped whole in #143: a foreign-rate dirty track
evaluates live with the edge converting (byte-identical to the offline
render, proven), a device that cannot switch gets converted delivery,
and all three rate refusals are gone. Two §4 clauses stand short. The
watch arc on a cross-rate edit has no end-to-end test; the dirty list
it turns on is tested. And converted delivery has run on the null
device only, because the hardware #143 played on switched to 44.1 kHz
rather than converting.

# Cross-rate live wiring

**Goal:** deliver [realtime.md](../realtime/readme.md) decision 7's promise — "a
foreign-rate dirty track therefore runs live like every other track" —
and retire the three rate refusals it left behind: the compile-time
refusal of cross-rate sessions (chunk 2 amendment), the engine's own
constructor guard against a session track at a foreign rate
(live.cpp — whose message still says this wiring lands "later in
chunk 2"), and the daemon's refusal of a device that cannot switch to
the session's rate (chunk 4 amendment). After this plan, a 44.1 kHz
project plays live on a 48 kHz-locked interface, and editing a
foreign-rate child lands next block like any other edit. Streaming
rings stay deferred (realtime.md chunk 2 amendment records them); this
plan is written against the materialized engine and says where rings
would change it.

## 1 What already exists — and what only looks like it does

Multi-rate ([multi-rate.md](../multi-rate/readme.md) decision 4) minted the edge:
a parent placing a cross-rate child depends on
`//songs/<s>/convert:track-<child>-<rate>`, a `resample` rule node —
not on the child directly. Verified on a fixture: `main` (48 k) →
`convert:track-low-48000` → `track:low` (44.1 k), zero diagnostics.
That routing is genuinely most of the hard part, and to
`compileSession` a convert dep is an ordinary file dependency the
freeze (realtime.md decision 4) knows how to serve. But no cross-rate
session has ever compiled, clean or dirty: the all-tracks rate check
reads every track in the song — not the tracks the live walk reaches —
so the same compile that builds the conversion into `toBuild` then
refuses the song on sight (minjudd measured it on the fixture: cold
and warm both refused, no cache state helps). So the gaps are three,
cheapest first: unblock the clean case (delete that check; the freeze
then serves the cached conversion as a file window), evaluate the
dirty conversion live, and convert at the device. The chunk-1 DSP
library already contains the streaming `dsp::Resampler` (causal,
taps/2 group delay) and its whole-buffer wrapper `resample()` — one
kernel, per decision 7 there is never a second.

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
   with the offline render is by construction. This is also the change
   that replaces the engine's constructor guard: `LiveSession` today
   throws on any track whose rate differs from the session's, which is
   exactly the session this decision produces, so the guard retires
   with the edge conversion that makes it unnecessary. No group delay
   appears: the wrapper's emission is timeline-aligned (its internal
   `delay` accounting), and what remains is availability, not shift —
   the same reasoning that keeps comp_delay zero. realtime.md
   decision 7 said the taps/2 delay is "reported into delay
   compensation"; that described a causal streaming edge this engine
   never runs, and the amendment recorded there with this plan
   reconciles it: under rings the producer runs ahead of the playhead,
   so the aligned form survives, and the one place the streaming delay
   is physically real is delivery (decision 3), outside the golden. A
   dirty conversion whose source is a committed file (a cross-rate
   asset placed directly) still builds in the compile: converting a
   file is a build, and it is dirty only when the file changed.
2. **The compile refusal narrows to nothing.** The all-tracks rate
   check deletes; rate correctness is an edge property now, the way
   multi-rate made it one offline. The compiler mirrors the wrapper's
   output-length rule — `n > 0 ? max(1, round(n·to/from)) : 0` in
   reduced-ratio integer arithmetic, resample.cpp's flush exactly:
   zero in, zero out, and the floor at one applies only to a non-empty
   source ("never round a non-empty source away", the #57 lesson) —
   for window durations and child lengths, the way it already mirrors
   chain latency and growth.
3. **Device delivery converts when the device cannot switch.**
   `maybeMatchDeviceRate` still moves the device to the session's rate
   when it can — bit-perfect delivery, as today. When it cannot, the
   output stream runs through a streaming `dsp::Resampler` into the
   device instead of refusing — what the artifact path's transport
   always did, now with the project's own kernel. Delivery conversion
   is outside the golden (it always was) and adds taps/2 ≈ 1.4 ms,
   reported nowhere because the transport clock stays in session
   samples. Its state has a defined lifecycle across every transport
   discontinuity (Codex's finding on the draft): locate, stop, and a
   session swap reset the converter to its primed-with-zeros starting
   state and drop any queued output — pre-seek audio never leaks, and
   the onset after a reset is exactly a stream start's; a natural end
   flushes the converter and delivers the remainder before the
   transport reports finished, so the last taps/2 of tail are heard;
   and the heard position may lead the device by at most one
   conversion block plus the kernel delay (bounded ~15 ms), because
   `delivered` counts what entered the converter — recorded here so
   nobody reads the skew as a bug. The daemon's refusal message and
   the CLI's artifact-spelling rescue both retire.
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
the status to `in-progress` when it opens — `completed` when it lands,
since the chunk is the plan.

## 4 Definition of done

The fixture song (48 k main placing a 44.1 k child) compiles cold with
the child live, and `--render-live` of that session is byte-identical
to the offline artifact; built warm, the conversion freezes to a file
window and the golden holds — a path that has never run, so this is
its first proof, not a re-confirmation; the watch arc on a cross-rate
edit runs dirty-live → background build → frozen swap. A 44.1 kHz
project plays on the 48 kHz null device (and on real hardware) instead
of refusing; locate, stop, swap-with-carry, and natural end all behave
through the delivery converter as decision 3 specifies; and
`field play <song>` needs no interim artifact spelling. All three
refusal messages are gone from the tree.
