# Plan: ACE generation

**Status:** Planned, not started. Follows [sc-render.md](sc-render.md); first
use of the Python model-runner layer.

**Goal:** `bloom ace generate` (then `extend`, `repaint`, `variants`, …):
committed generation recipes produce audio assets through ACE-Step running in
a Python worker, with full provenance.

## 1 Shape

- ACE lands as `src/rules/ace-generate.ts` behind the `RuleImpl` interface —
  a module, not engine code. First change of the phase, deferred from the
  #7 review as agreed there: make the registry generic
  (`RuleImpl<T extends Target>`) so the per-method `'wrong rule'` guards
  become compiler-proven instead of runtime-checked; the third rule is the
  agreed trigger.

- The worker protocol comes first: a Python subprocess (`bloom-modeld`
  pattern) taking immutable inputs and a JSON job spec on stdio, emitting
  assets + structured metadata ([architecture.md](../../architecture.md)
  "Python model-runners"). ACE is the first client of the protocol, not a
  special case.
- A recipe commits everything: model name/version/checksum, prompt, negative
  prompt, seed, duration (bars at tempo), conditioning (chords, MIDI,
  reference audio), generation parameters, output hashes, licensing and
  provenance metadata.
- Reproducibility caveat recorded in [build-graph.md](../../build-graph.md):
  fixed seed is reproducible on the same machine, not guaranteed across
  GPU/framework versions — so generated assets are committed and never
  silently regenerated.
- Multiple variants from one recipe are takes: numbered, auditioned, one
  active ([project-model.md](../../project-model.md) "Takes").
- ACE-Step runs on Apple Silicon via MPS; performance is acceptable for
  asset-generation (not interactive) use.

## 2 Definition of done

A committed recipe generates variants; picking a variant is a take selection;
rebuilding is a cache hit; the recipe, provenance, and chosen asset all read
as a reviewable diff.
