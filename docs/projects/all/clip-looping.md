# Plan: Clip looping

**Status:** Complete. Clip looping shipped in #21; #23 extended looping
to the song layer (`length` + `loop: true` in song.yaml — the mix folds
the overhang onto the start, one seamless pass of the infinite
performance) and the player (`field play --loop`, gapless in the daemon,
with the `--click` metronome and phase-locked beat readout built to
verify it). bloom's creek is the proof: one looped keys clip replaced
the four hand-tiled ones with a byte-identical placement plan, and the
song loops at exactly 12 bars. Motivated by bloom's keys track — one
4-bar generation hand-tiled four times on the grid with click-guard
micro-fades ([ace-generation.md](ace-generation.md) shipped the
generation; the tiling hack shipped with it).

**Goal:** a clip plays its source repeatedly to fill its window, so a short
phrase tiles a section without hand-chained copies.

## 1 Decisions (DECIDED, 2026-08-05)

1. **The window is authoritative; loop fills it.** No repeat count — a
   clip is already a window (`position`, `duration`) on content, so
   looping means the content tiles until the window ends and extending
   the loop is extending `duration`. `repeat: N` (rejected) would be
   duration arithmetic the window already expresses, and reads worse in
   a diff.
2. **One nested map, `loop:`, not flat fields.**
   ```yaml
   loop:
     enabled: true    # default true when the map is present
     every: 15360     # repetition interval, anchor units; default: the
                      # source's length in samples
     mode: truncate   # truncate | overlay
     fade: 480        # samples of click-guard at each seam; 0 disables
   ```
   `enabled` exists so a loop can be switched off while auditioning
   without deleting its configuration.
3. **`every` is in anchor units, like `position`/`duration`** — ticks on
   musical clips (repeats stay on the grid straight through tempo ramps,
   which is what "on rhythm" means; bloom's keys are the proof), samples
   on absolute clips. Omitted, the repetition interval is the source's
   sample length — back-to-back tiling, the common constant-tempo case.
   Omitted `every` requires an asset source: a target's length is not
   known at plan time (reverb output grows by its tail), so looping a
   target demands an explicit `every`.
4. **`mode` answers "what happens when a repeat outlives its slot"** —
   under a ramp, or whenever `every` is shorter than the source.
   `truncate` (default) cuts each repetition at its slot: deterministic,
   monophonic, what the hand-tiled hack did. `overlay` lets every
   repetition ring to its natural end over its successors — polyphony by
   summing, which track-render already does for overlapping clips.
5. **`fade` guards seams by default (480 samples ≈ 10 ms at 48 k).** The
   naive `loop: {enabled: true}` must not click — safe-by-default, the
   auto-normalize-EQ precedent. In `truncate` mode it is a symmetric
   out/in dip at each cut; in `overlay` mode each repetition's head fade
   (tails ring out naturally). Whole-clip `fade_in`/`fade_out` keep their
   meaning: the first repetition's head, the window's tail.
6. **Looping is placement expansion, not a new render path.** `planTrack`
   expands a looped clip into the same resolved per-repetition entries
   equivalent hand-written clips would produce, so the render code and the
   action-key format do not change: clips without `loop` hash identically
   to before (no cache invalidation), and a loop that reproduces bloom's
   hand tiling produces the same placement plan.

## 2 Definition of done

Bloom's four hand-tiled keys clips become one looped clip; `field check`
passes; the placement plan matches what the hand tiling produced (same
seams, same fades expressible); truncate and overlay both render and are
covered by tests.

## 3 Chunks

1. Schema (`loop` map + KeyOrder), `planTrack` expansion, validation
   (anchor units, target-source needs `every`, fades fit slots), tests,
   docs; bloom swaps the hack for the feature after merge.
