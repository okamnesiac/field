# Plan: Project core — format, CLI, build graph skeleton

**Status:** Planned; design discussion complete, nothing built. The first
phase of Bloom — pure TypeScript, no audio code.

**Goal:** A `bloom` CLI that can initialize a multi-song project, validate its
schemas, hash and store assets content-addressably, and build trivial targets
through a real dependency graph with caching — so the next phase
([sc-render.md](sc-render.md)) only has to add a build rule, not a build
system.

## 1 Scope

- `bloom init` — create a project: `bloom.yaml`, `shared/`, `songs/`,
  `.bloom/` (unversioned), Git + LFS setup.
- Schemas and validation for the initial file set: project manifest, song
  manifest, tempo map, arrangement, tracks, clips, takes. Zod schemas are the
  single source of truth; `bloom check` validates the whole tree.
- Content-addressed asset store: import an audio file, hash it, reference it
  from manifests by hash; LFS holds the bytes
  ([project-model.md](../../project-model.md) "Assets").
- Build graph core: labels (`//songs/<song>/...`, `//shared/...`), target
  resolution, dependency traversal, input hashing, a cache under `.bloom/`,
  and cache-hit detection.
- First (trivial) build rules to prove the machinery: import/copy, and audio
  file normalization (sample-rate/bit-depth conversion) — mechanical rules
  with real inputs and cacheable outputs.
- `bloom build <target>`, `bloom query 'deps(<target>)'`, `bloom explain
  <target>`, `bloom status`.

## 2 Non-goals

No audio rendering beyond format conversion, no SuperCollider (next phase),
no plugins, no daemon, no MCP yet, no widget. The point is that the *shape* of
the system exists and is exercised end-to-end before anything hard is bolted
on.

## 3 Design questions this phase must settle

These are the load-bearing schema decisions; each gets recorded here as
`(DECIDED)` with alternatives as the work proceeds:

1. **Tempo/timeline semantics** — bar.beat.tick ↔ samples mapping, which
   representation is authoritative where, and the per-track policy for content
   under tempo-map edits ([project-model.md](../../project-model.md)
   "Timeline and tempo").
2. **Clip offsets** — timeline position, source offset, slip as three
   independent non-destructive fields.
3. **ID scheme** — stable, explicit IDs for tracks/clips/takes that survive
   merges.
4. **Label grammar** — exact target syntax across songs and shared material.
5. **Cache key definition** — what exactly hashes into a node's key, and how
   nondeterministic nodes are marked
   ([build-graph.md](../../build-graph.md)).
6. **Deterministic YAML emission** — stable key order and formatting so
   programmatic edits produce minimal diffs.

## 4 Definition of done

From an empty directory: `bloom init`, import an audio file into a song,
define a normalize target, `bloom build` it, see a cache hit on rebuild and a
rebuild on parameter change, and `bloom query`/`explain` answer honestly —
with the whole project state readable as diffable YAML in Git.
