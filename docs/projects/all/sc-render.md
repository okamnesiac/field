# Plan: SuperCollider offline rendering

**Status:** Planned, not started. Follows
[project-core.md](project-core.md); the first real build rule.

**Goal:** `bloom sc render` and a `supercollider-render` build rule: a
committed SC program plus an explicit seed renders an audio asset through
scsynth's non-realtime (NRT) mode, deterministically and cacheably.

## 1 Shape

- The control plane drives `sclang`/`scsynth` directly from TypeScript —
  process spawning plus OSC score files for NRT; no Python involved
  ([architecture.md](../../architecture.md) "SuperCollider").
- A recipe is a node in the graph: program path + seed + duration + output
  spec. Program source, and anything it imports, hashes into the cache key.
- SC programs live in `shared/sc/` (reusable across songs) or a song's `sc/`
  ([project-model.md](../../project-model.md)).
- Rendered assets land in the content-addressed store with provenance;
  committed, not regenerated ([build-graph.md](../../build-graph.md)
  "Determinism policy").

## 2 Definition of done

A seeded generative texture (e.g. a granular pad) defined as a target,
rendered by `bloom build`, cache-hit on rebuild, re-rendered when the program
or seed changes — and audibly identical when re-rendered with the same seed.
This is the first point where Bloom does something a DAW can't: prompt-shaped,
diffable, reproducible sound design in Git.
