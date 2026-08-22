---
status: done
---

**Outcome:** Shipped.

# Plan: SuperCollider offline rendering

**Status:** Shipped (#7, merged 2026-08-04); demonstrated publicly by
bloom's committed pad recipe. The `sc-render` rule and `field sc render` are
implemented, with a real-sclang integration test proving bit-for-bit
reproducibility from the same seed (skipped where sclang is absent — CI
doesn't have SuperCollider), and reproducibility was verified across two
machines. Followed [project-core.md](../project-core/readme.md); the first real build
rule, and it only had to add a rule.

**Goal:** `field sc render` and an `sc-render` build rule: a committed SC
program plus an explicit seed renders an audio asset through scsynth's
non-realtime (NRT) mode, deterministically and cacheably.

## 1 Shape

- The control plane drives `sclang` directly from TypeScript — process
  spawning, no Python involved
  ([architecture.md](../../architecture.md) "SuperCollider").
- A recipe is a node in the graph: program path + seed + duration + channels.
  Program source hashes into the cache key.
- SC programs live in `shared/sc/` (reusable across songs) or a song's `sc/`
  ([project-model.md](../../project-model.md)).
- Rendered assets land in the content-addressed store; committed renders are
  imported like any asset ([build-graph.md](../../build-graph.md)
  "Determinism policy").

## 2 The program contract (DECIDED)

An SC program is a plain `.scd` run via `sclang <program>` with the render
parameters in the environment:

| variable | meaning |
| --- | --- |
| `FIELD_OUTPUT` | absolute path the program must write (WAV) |
| `FIELD_SEED` | integer seed (`thisThread.randSeed = seed`) |
| `FIELD_DURATION` | seconds |
| `FIELD_SAMPLE_RATE` | project sample rate |
| `FIELD_CHANNELS` | channel count |

The program renders (typically `Score.recordNRT`) and exits (`0.exit`).
Determinism given the seed is the program's responsibility; Field's
contribution is keying the cache on the program's **content hash** plus the
parameters, so editing the code invalidates exactly its own renders.

Alternatives rejected: Field generating OSC score files itself (requires
Field to understand synthdefs — wrong altitude, the program is code and code
is the recipe); passing parameters as argv (env survives sclang's own
argument handling untouched). `sclang` is found on PATH, via the
`FIELD_SCLANG` override, or at the SuperCollider.app bundle path.

### Known limitations, accepted for now

- Only the main program file is hashed; a program that `loadRelative`s
  helpers won't invalidate when the helper changes. Fine until real use
  needs multi-file programs; the fix is a declared `includes:` list.
- `sclang` runs the user's startup file. If that ever breaks determinism,
  `FIELD_SCLANG` can point at a wrapper; a sandboxed config is the real fix.
- No graph edge for the program file (it's an input by hash, not a node), so
  `deps()` doesn't list it; `explain` shows it as an input by path.

## 3 Definition of done

A seeded generative texture defined as a target, rendered by `field build`,
cache-hit on rebuild, re-rendered when the program or seed changes — and
identical when re-rendered with the same seed. **Verified stronger than
specced: the integration test wipes the cache and asserts the re-render is
bit-for-bit identical (same sha256), not merely audibly identical.** This is
the first point where Field does something a DAW can't: prompt-shaped,
diffable, reproducible sound design in Git.
