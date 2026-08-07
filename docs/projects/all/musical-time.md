# Plan: Musical time arrays

**Status:** In progress (started 2026-08-05). Motivated by bloom's creek:
`length: 46080` and `every: 15360` are tick math a human authors by
calculator — the project files should accept the numbers musicians think
in.

**Goal:** time fields in project YAML accept musical notation — bars,
beats, ticks — resolved through the song's meter map, without changing
what the build graph sees.

## 1 Decisions (DECIDED, 2026-08-05)

1. **Arrays, not dotted strings.** `position: [9, 2]`, not
   `position: 1.3.2`-style strings. Rejected: the dotted syntax the CLI
   uses for `--from` — in YAML, `1.3` parses as a float, so every musical
   position would need quotes and a forgotten quote silently means a
   different number. A shell argument is not YAML; `--from 9.2.1` keeps
   its dotted string form. Also rejected: parallel `*_musical` fields
   (two fields per position that can disagree — the exact failure the
   take dual-representation needs `field check` to police).
2. **Scalar means ticks, array means musical.** The distinction is
   structural — no unit suffix, no tag field, no heuristic. Every
   existing file keeps its exact meaning.
3. **Positions are ordinal and 1-indexed: `[bar, beat?, tick?]`.**
   `[9]` is bar 9, `[9, 2]` is bar 9 beat 2 — where a musician points,
   matching `--from` and the play readout. Zeros are an error; there is
   no bar 0.
4. **Spans are cardinal, and zero is legal: `[bars, beats?, ticks?]`.**
   `[4]` is four bars, `[0, 2]` is two beats, `[1, 2]` is a bar and two
   beats. A span advances through the meter map from the field's anchor
   — `duration` and `loop.every` from the clip's position, song `length`
   from bar 1 — stepping bars and beats at whatever meter is in force at
   the moving position, so a span crossing a meter change means what a
   musician means by it. Rejected: one shared shape for positions and
   spans — "bar 0" is nonsense while "0 bars, 2 beats" is essential, so
   the two kinds genuinely differ and pretending otherwise makes zeros
   ambiguous.
   **Caveat (#24 review):** a span resolves once, at its anchor. That is
   exact for `duration` and `length` — the single walk crosses any meter
   change — but `loop.every` then acts as a fixed tick interval from the
   clip's position, so repetitions beyond a mid-window meter change keep
   the anchor-time bar length instead of re-resolving per repetition.
   Documented rather than engineered: per-repetition resolution would
   change plan output for a case no song has yet, and deserves its own
   decision record if one ever does.
5. **The schema validates shape only; the model resolves.** Legal beat
   and tick ranges depend on the meter map, which lives in another file
   (tempo.yaml) — so zod checks "1–3 positive/non-negative integers" and
   the model layer resolves arrays against the song's `MeterMap`,
   diagnosing range errors (`beat 5 in 4/4`) with the rest of the
   cross-file checks.
6. **Resolution normalizes to ticks at load; the graph never sees
   arrays.** `length: [12]` and `length: 46080` produce byte-identical
   specs and action keys — notation is authoring surface, not build
   input, so a notation rewrite is always a cache hit (the clip-looping
   §1.6 precedent).
7. **Arrays emit single-line.** Canonical form is block style everywhere
   (project-core.md §3.6); a three-line block for `[9, 2]` would bury
   the notation it exists for, so time arrays are the recorded
   exception: `KeyOrder` gains a per-key `flow` flag and canonical
   emission keeps flagged sequences inline. `fmt` preserves the author's
   notation — scalar stays scalar, array stays array; it normalizes
   formatting, never units.
8. **Fields in v1:** clip `position` and `duration`, clip `loop.every`,
   arrangement section `at`, song `length`. Musical arrays require
   `anchor: musical` where an anchor exists — on an absolute clip they
   are an error, not a conversion. Deferred to a later pass: tempo and
   meter event `at` (a meter event's position helps define the map that
   would resolve it — resolvable against preceding events, but subtle
   enough not to rush), and take `position` (recorder-written, already
   dual-representation with `position_samples`).

## 2 Definition of done

bloom's creek is authored in musical notation — `length: [12]`, the keys
loop in bars — with every rebuild a cache hit against the tick spelling;
`field fmt` is stable over arrays and keeps them single-line; range and
anchor misuse produce named diagnostics; tests cover resolution through
meter changes and odd meters.

## 3 Chunks

1. Meter-map position/span resolution, schema unions + `flow` emission,
   model-layer resolution and diagnostics, tests, docs; bloom converts
   to musical notation after merge.
