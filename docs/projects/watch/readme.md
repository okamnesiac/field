---
status: completed
---

**Outcome:** Superseded. Both chunks shipped (#34, #35) and were used
for real on 2026-08-06; [realtime](../realtime/readme.md)'s chunk 3
(#139) then retired the play half — the daemon `reload` op and the
loop-wrap takeover — and `field play <song> --watch` runs on the live
engine instead.
`field build --watch` stands as built. §5's status-visibility question
went moot with the looped file hash it asked about.

# Plan: Watch mode — the loop follows the project

**Status:** Implemented (2026-08-06). Chunk 1 — the daemon `reload` op
(takeover at the wrap, daemon 0.4) and `field build --watch` — landed
in #34; chunk 2 — `play --loop --watch`, the §3 walk run against bloom
(scripted, null output; every step behaved), and the docs paragraphs —
landed in #35, since amended by #37, #38 and the #44 rename. One thing
is open: §5's `status`-visibility question remains a design question.
§6 recorded an audible hiccup at every reload takeover, deliberately
deferred because the real-time engine would delete the mechanism —
realtime chunk 3 did (2026-08-10), and the hiccup went with it. Written
against the layout-migration vocabulary (project-layout.md §4, landed
in #31).

**Goal:** `field play <song> --loop --watch` keeps the loop playing
while the project changes underneath it: edit a clip, nudge a fader,
rewrite an `.scd`, `field choose` a different variant — and the running
loop picks it up without anyone stopping the transport. The dev-tool
move (`tsc --watch`, hot reload) applied to music, and the core of the
agent story: an agent edits YAML while a human just keeps listening.

## 1 Decisions (DECIDED, 2026-08-06)

1. **Swap at the loop wrap.** When a rebuild produces a new mix, the
   daemon finishes the current pass and the next wrap starts the new
   file — you always hear whole passes, and the daemon change is small:
   a `reload(path)` request that queues a takeover at the wrap point,
   alongside the native-loop reader that already wraps at end-of-file
   (#23, recorded in [clip-looping.md](../clip-looping/readme.md)'s status line;
   [playback.md](../playback/readme.md) §5 records the reload op, added with
   chunk 2 as promised here). Worst-case latency is one loop length. The recorded
   successor, deliberately not now: a bar-synced in-place swap —
   stems and mixes share a sample-0-aligned timeline, so a same-length
   rebuild could take over at the next bar line (computed CLI-side in
   samples; musical time never crosses the socket) with the daemon
   double-buffering two readers. That lands when wrap-latency actually
   chafes, not before.
2. **A red project never stops the music.** On every change burst:
   `check` first. Diagnostics print, the last good build keeps looping,
   and the next change retries. A half-saved file mid-edit is the
   *common* case, not an error case.
3. **"Did anything audible change" is an output-hash question.** The
   watcher never diffs files or reasons about what an edit meant — it
   rebuilds the playing label and compares the output hash. The graph
   makes this cheap by construction (a fader move re-runs one sum; a
   comment edit or `fmt` pass is all cache hits) and correct by
   construction: hash moved ⇒ swap, hash same ⇒ silence. No debounce
   heuristics beyond a few hundred ms of write-burst coalescing.
4. **`field build --watch <label>` is the underlying verb;
   `play --watch` composes it.** The headless form is useful alone (an
   agent keeping a project green; a CI-like local loop), and the play
   form is exactly: watch-build, then reload-at-wrap on hash movement.
   `--watch` on `play` requires `--loop` and exactly one label — a
   multi-item `--loop` queue is requeue-path playback with no wrap to
   swap at, so watching it is out of scope until a need appears (the
   headless `build --watch` is the multi-label form).
5. **Trigger policy holds under watch — for free.** Watch runs `build`,
   and build never generates a generative sound (project-layout.md
   §1.2), so no watcher event can burn model-minutes or replace chosen
   audio. But a `chosen:` repoint is just a YAML edit, so
   `field choose` against a running watch is live A/B-ing of variants
   inside the loop — likely the single best demo of the system.
6. **Slow rebuilds don't glitch.** Builds land atomically in the CAS;
   until the new artifact exists, the old mix keeps looping. An `.scd`
   edit that takes ten seconds to render swaps ten seconds later, at
   the wrap after it lands.

## 2 Shape

- **Watcher:** FSEvents via `fs.watch(root, { recursive: true })`
  (macOS-only by charter), filtered to the files the loader reads plus
  program files and assets — in practice: everything except `.field/`
  (watching build output would self-trigger forever) and `.git/`.
  Debounce ~300 ms to coalesce editor write-bursts and `fmt` rewrites.
- **Loop body:** on a settled burst — `loadProject`; if diagnostics,
  print them and wait. Else `build` the playing label through the
  normal engine; if the outcome hash differs from what the daemon is
  looping, send `reload`. On a tty the session renders a live block —
  `playing <label>─<shortHash> → (<device>)` over a position line
  carrying the loop iteration (`[10] 8.4`); while a takeover is
  pending the separator becomes `┬` and the successor's hash hangs
  `└<shortHash>` beneath the one it replaces. The wrap closes the
  block as `played …` history and opens the successor's — except a
  byte-identical swap (an edit changed back before the wrap), which
  renders as nothing pending and just another pass. Device moves
  repeat the header with the new route. A `--from` region loop still
  announces `↻ … next pass` at queue time — its swap moment is the
  pass boundary, not a wrap. Quitting with a takeover still pending
  says so on teardown (`<shortHash> built, never sounded (stopped
  before the wrap)`) — otherwise the frozen `└` reads as about to
  happen when ctrl-c means it never will. Non-tty output stays plain
  sequential lines (`↻ … at the next wrap`, `↻ swapped at the wrap`).
- **Coalescing:** a change arriving mid-build marks the build stale;
  its artifact still lands in the CAS (warm for later), but its swap is
  skipped and the loop body re-runs. Only ever one build in flight.
- **Daemon:** protocol gains `reload(path)` (queue takeover at wrap) —
  a daemon version bump; `--watch` requires the new daemon, no
  fallback shims.
- **`--from` + `--watch`:** region loops take the requeue path already
  (#23); after a swap the region re-applies to the new file. Same
  rule as ever: the CLI owns musical time.

## 3 Definition of done

`field play creek --loop --watch`, then, without touching the
transport: edit a clip position (loop updates at the wrap), change a
track fader (sum-only rebuild, updates), edit an `.scd` (render
completes, updates one wrap later), break a YAML file (diagnostics
print, loop keeps playing, fixing it recovers), `field fmt` (nothing
rebuilds, nothing swaps), and `field choose <song>/<sound> --variant 2` from
another shell (the loop is A/B-ing variants live). Ctrl-C still ends
the session cleanly.

## 4 Chunks

1. Daemon `reload` + protocol bump; CLI `build --watch` (watcher,
   debounce, coalescing, check-gate) with tests against a fake runner.
2. `play --loop --watch` composing the two; bloom demo of the
   definition-of-done walk; docs (build-graph.md gains the watch
   paragraph; playback.md note on reload).

## 5 Open questions

- ~~Multi-target watch (`build --watch //songs/creek/...`)~~ —
  *resolved by chunk 1:* it fell out of the engine loop as predicted
  (any pattern watches; every matched label baselines), and the format
  decided itself in review: one `↻ <label> <shortHash>` line per moved
  label, one silence line per quiet rebuild — which is what decision 4
  already meant by "the multi-label form".
- Whether `status` should show watch state (playing hash vs freshest
  hash) for agents polling the session.

## 6 The takeover is audible, and deliberately not fixed (2026-08-08)

§1.1 promised you always hear whole passes. You very nearly do, and the
part that is missing is audible: every reload takeover has a hiccup at
the seam. Plain loops never do — the wrap inside the reader is
sample-exact — so this is the takeover alone.

**Two causes, established by ear because reading gave the wrong
emphasis.** The takeover is a 20 ms message-thread poll watching for the
position to move backwards (`player.cpp`, `startTimer (20)`), which is
the wrap having *already happened*; it then does `transport.stop()`,
`setSource (nullptr)`, `setSource (new, 1 << 15, &readThread, rate)`,
`setPosition (0)`, `start()`.

Reading that, the poll lag looks like the whole story. It is not:

- At **1 ms** the hiccup was still clearly there — so something under
  the poll is contributing. That is the teardown: a fresh `setSource`
  rebuilds the transport's buffering source, which starts empty and has
  to be refilled by the read thread before audio flows.
- At **200 ms** it was dramatically worse — so the poll lag is a real
  contributor too, not a rounding error.

Both, then. Neither experiment was predictable from the source, and the
1 ms run may have been *worse* than 20 ms rather than better (reported,
not measured — a 1 ms message-thread timer is aggressive enough to
disturb things on its own), which is a second reason not to ship it as a
mitigation.

**Why it stays.** One change would remove both: swap the reader inside
the audio callback at the exact wrap, underneath a transport source that
is never torn down — no poll lag because the boundary *is* the swap
point, no refill gap because `setSource` is never called again. That is
lock-free handoff, lifetime management off the audio thread, a
non-looping mode so `field play` can still detect end-of-stream, a
daemon version bump, and four existing reload tests to keep green.

It is also work with an expiry date. Reload-at-the-wrap exists because a
mix is a rendered *file*; [audio-engine.md](../../audio-engine.md)
describes the real-time engine this daemon is a placeholder for, where a
fader move is heard live and nothing is rebuilt or swapped at all. The
file-playback path survives that — auditioning assets, stems and chosen
variants is core — but this mechanism does not. Justin's call
(2026-08-08): bearable, and not worth building something to throw away.

**If someone does fix it**, the design above is the one to build, and the
two measurements are the acceptance test: 200 ms must not sound worse
than 20 ms, because with the swap at the boundary the poll would be gone
entirely.

**Resolved by deletion (2026-08-10).** Realtime chunk 3 retired the
takeover whole — `play --watch` rides the live engine now, where a gain
edit ramps at the next block and a structural edit swaps the session
with the transport carried, so no file is reloaded at a wrap and the
mechanism this section diagnoses no longer exists. The expiry date
above arrived exactly as written. The measurements stay as the record
of why nobody built the lock-free handoff.
