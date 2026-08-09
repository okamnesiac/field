# Plan: Project core — format, CLI, build graph skeleton

**Status:** Scaffold, schemas, tick/tempo math, deterministic YAML, and the
first CLI commands shipped in #4; the asset store in #5; the build graph
(labels, action cache, `build`/`query`/`explain`, the normalize rule, and
§7's normalized-path enforcement) is the third and final chunk. The §4
definition-of-done flow has been run end to end. The phase finishes when
the build-graph PR merges and real use (bloom, then sc-render) stops
surfacing surprises.

**Goal:** A `field` CLI that can initialize a multi-song project, validate its
schemas, hash and store assets content-addressably, and build trivial targets
through a real dependency graph with caching — so the next phase
([sc-render.md](sc-render.md)) only has to add a build rule, not a build
system.

## 1 Scope

- `field init` — create a project: `field.yaml`, `shared/`, `songs/`,
  `.field/` (unversioned), Git + LFS setup.
- Schemas and validation for the initial file set: project manifest, song
  manifest, tempo map, arrangement, tracks, clips, takes. Zod schemas are the
  single source of truth; `field check` validates the whole tree.
- Content-addressed asset store: import an audio file, hash it, reference it
  from manifests by hash; LFS holds the bytes
  ([project-model.md](../../project-model.md) "Assets").
- Build graph core: labels (`//songs/<song>/...`, `//shared/...`), target
  resolution, dependency traversal, input hashing, a cache under `.field/`,
  and cache-hit detection.
- First (trivial) build rules to prove the machinery: import/copy, and audio
  file normalization (sample-rate/bit-depth conversion) — mechanical rules
  with real inputs and cacheable outputs.
- `field build <target>`, `field query 'deps(<target>)'`, `field explain
  <target>`, `field status`.

## 2 Non-goals

No audio rendering beyond format conversion, no SuperCollider (next phase),
no plugins, no daemon, no MCP yet, no widget. The point is that the *shape* of
the system exists and is exercised end-to-end before anything hard is bolted
on.

## 3 Design questions this phase must settle

The load-bearing schema decisions, recorded as `(DECIDED)` with alternatives:

1. **Tempo/timeline semantics (DECIDED).** Canonical musical time is integer
   ticks from song start at fixed PPQ (960/quarter); `bar.beat.tick` is a
   display projection through the meter map, never stored — storing bars would
   make meter edits silently reinterpret every position. The tempo map
   (constant segments + linear ramps, closed-form integration) maps ticks ↔
   seconds; project sample rate maps seconds ↔ samples. Each clip declares an
   `anchor`: `musical` (ticks stored, samples derived — moves with tempo
   edits) or `absolute` (samples stored, ticks derived — stays put). Default
   `musical`. Manifests may store both values but declare the anchor; the
   derived one is verified by `field check`, so they can never disagree. A
   musically-anchored clip *moves* under tempo edits but does not
   *time-stretch* — stretching is a separate explicit operation, out of scope.
   Loops (possibly with their own internal timeline, e.g. polyrhythmic loops
   against a different meter) are explicitly deferred; nothing in the tick
   scheme precludes a loop carrying a local timeline mapped at its
   instantiation point. **Taken up by
   [nested-tracks.md](nested-tracks.md) §1.5 (2026-08-08)**, which makes
   that local timeline a property of every track rather than a feature of
   loops: a polymetric loop is a track carrying its own meter, mapped into
   its parent at the reference's `at`.
2. **Clip offsets (DECIDED).** A clip is a *window* (`position`, `duration`,
   in anchor units) on *content* (`asset`, `source_offset` in samples, `slip`
   in samples, default 0; effective read offset = `source_offset − slip`, so
   positive slip moves content later against a fixed window). Folding slip
   into `source_offset` was rejected: `source_offset` is set mechanically
   (take placement, comping, latency correction) while slip is set musically
   (a human nudge) — keeping them separate keeps the mechanical value
   re-derivable and the intent a one-line diff. Fades and gain are clip
   fields; fades in samples.
3. **ID scheme (DECIDED).** No UUIDs; three tiers. Humans name it → natural
   slug is the ID (tracks, songs, targets; filenames are keys). Content is
   the identity → SHA-256 (assets, cached outputs). Machines mint it →
   timestamp for takes (`take-20260804-202355`, sortable, merge-safe),
   slug-plus-short-random for clips (`chorus-vox-x7f3q`, referenced stably
   by automation). The full argument — the case against, and why it lost —
   is recorded in §6 so it never has to be re-litigated.
4. **Label grammar (DECIDED).** The project model *is* the build file — no
   separate `BUILD` files, which would only re-declare structure the
   manifests already express. Targets derive by convention:
   `songs/opener/tracks/lead-vocal.yaml` is `//songs/opener/track:lead-vocal`;
   mixes declared in a song's mix file become `//songs/opener/mix:main`.
   Grammar: `//path:name`, wildcards `//songs/opener/...` and `:all`.
   Amended 2026-08-05 (was: absolute-only in V1): the CLI also accepts
   songs-relative shorthand — `opener/mix:main` means
   `//songs/opener/mix:main` — since nearly everything addressable lives
   under `songs/`, and a bare song name (`field play opener`) means the
   song's main mix. `main` is a convention, not a requirement: a song
   whose mixes are named otherwise gets a no-such-target error, not a
   guess. The canonical form everywhere else (files, output, docs)
   remains absolute; future roots (`//shared/...`) use the full form.
   Amended 2026-08-06: authored specs became per-file
   ([project-layout.md](project-layout.md) §1.3) — sounds and mixes
   derive like tracks (`songs/opener/sounds/pad.yaml` →
   `//songs/opener/sound:pad`), so "declared in a song's mix file"
   reads "declared in `mixes/<name>.yaml`"; project-layout §4 then
   renamed the shelf (`targets/` → `sounds/`) and retired "target" as a
   term — the addressable thing is a label. The grammar itself is
   unchanged.
   Amended 2026-08-06 (**packages are singular**): `//songs/creek/sound:pad`,
   `//songs/creek/track:keys`, `//songs/creek/asset:water`,
   `//shared/asset:rain` — joining `mix:`, which was singular all along.
   What forced the question was that inconsistency: `mix:` beside
   `tracks:` made the rule you would infer from any other label wrong
   exactly once, and wrong on the label you type most. The rejected fix
   was pluralizing `mix:` to restore "the package is its directory"
   (project-layout.md §1.3). Singular won on how it reads: a label
   addresses one thing, so `//songs/creek/track:keys` is "the keys
   track", and the directory stays plural because a folder holds many.
   The ledger's `assets:` key stays plural for the same reason — it is a
   list. Cache-neutral: the label is not in the action key (§3.5), so
   nothing re-renders; only `.field/out/` paths move. Typing the old
   plural gets a hint at the singular rather than a bare no-such-label.
   Amended 2026-08-08 (was: a bare song name means the song's main mix):
   it means the song's output **track** — `field play opener` is
   `//songs/opener/track:main`. What changed is that a track can now be a
   song's output, carrying the declared `length` and `loop` and the master
   chain as its inserts ([nested-tracks.md](nested-tracks.md) §7 chunk 2),
   and it renders bit-identically to the mix it replaces. `main` is still
   a convention rather than a requirement, and the shorthand still expands
   to exactly one label rather than trying `track:` and falling back to
   `mix:` — a song may not declare both, and two ways to resolve one name
   is the thing §3.4 has avoided since it was written. Explicit `mix:`
   labels keep working; `mixes/` retires separately.
5. **Cache key definition (DECIDED).** SHA-256 everywhere, chosen so asset
   hash = Git LFS OID — store, pointer, and cache speak one identifier
   (BLAKE3 is faster but buys a second identity scheme). Key = hash of
   canonical JSON of `{rule name, rule_version, input hashes, parameters,
   plugin id+version+state hash (later), sample rate, render-relevant
   settings}`. Rules carry an explicit `rule_version` bumped to invalidate —
   we do not hash our own source, which would invalidate the world on every
   refactor. Layout: `.field/cache/cas/<hash>` plus an action index, shared
   across songs. `deterministic: false` flows into take handling per
   [build-graph.md](../../build-graph.md).
6. **Deterministic YAML emission (DECIDED).** Schema-defined key order
   (semantic, `id`/`name` first — not alphabetical), 2-space indent, block
   style, no anchors/aliases, minimal quoting, stable numbers, trailing
   newline. `field fmt` writes it; `field check` enforces it. **Comments must
   survive programmatic edits** — the npm `yaml` package's document/CST API
   (comment-preserving) is used from day one; a format-then-lose-annotations
   tool is unacceptable for a Git-native system.

## 4 Definition of done

From an empty directory: `field init`, import an audio file into a song,
define a normalize target, `field build` it, see a cache hit on rebuild and a
rebuild on parameter change, and `field query`/`explain` answer honestly —
with the whole project state readable as diffable YAML in Git.

## 5 Stack (DECIDED)

Node 24 LTS, pnpm, ESM-only, strict TypeScript, single package at repo root
(`packages/` only when the daemon and workers exist). Zod v4 schemas as source
of truth with JSON Schema generated from them — that is what keeps the
canonical format honestly language-neutral for the future Swift widget and C++
daemon. CLI: commander. Tests: vitest. Audio conversion for the normalize
rule: macOS built-in `afconvert` (excellent SRC, zero dependencies, macOS-only
by charter); ffmpeg only if a need appears that afconvert can't meet.
**Superseded 2026-08-07** — the charter stopped being macOS-only, so
"macOS-only by charter" stopped being free. `normalize` renders in
field-audiod's own polyphase resampler as of
[render-pipeline.md](render-pipeline.md) chunk 5; ffmpeg was never
needed. Bun was
considered and rejected: boring wins for a decade-scale tool. Work lands as
squash-merged PRs (the ruleset requires it), roughly one per coherent chunk.

## 6 Decision record: names are identity — no UUIDs

Settled 2026-08-04, recorded in full so it is never re-litigated. The
industry-standard alternative — stable machine ID plus display name, as in
DAWproject and essentially every DAW format — was argued properly and
rejected.

### The case for opaque IDs

1. **Rename becomes a refactor instead of a field edit.** With UUIDs,
   renaming `lead-vocal` to `main-vox` changes one display-name line and no
   reference moves. With slugs, a rename touches every referencing file —
   clips, automation, routing, comps, take manifests. The nasty version is
   cross-branch: branch A renames the track, branch B adds clips referencing
   the old name, both merge cleanly (different files, no textual conflict),
   and the dangling references surface only when validation runs.
2. **Identity reuse across time.** Delete `verse-guitar`; months later create
   an unrelated track with the same name. Under slug-identity the new track
   inherits the old identity — historical references silently associate with
   the wrong thing. UUIDs never collide across time; names do, because humans
   reuse good names constantly.
3. **Slugs invite hand-editing, and hand-edits typo.** Nobody types a UUID;
   `chorus-vox` looks writable, and one typo creates a dangling reference
   that looks plausible in review.

### Why it lost

In the same order:

1. Rename-as-refactor is exactly how **code** works — renaming a function
   touches every call site — and we accept it because the tool does it
   atomically (`field track rename` rewrites all references in one commit)
   and the result is greppable and reviewable, which UUID indirection never
   is. The cross-branch hazard is real but **not solved by UUIDs**: branch B
   referencing a UUID that branch A deleted merges just as cleanly and
   dangles just as silently. The true defense is identical in both worlds —
   referential validation in `field check`, run in CI.
2. The layers where identity reuse would do real damage are already immune:
   takes are timestamped, assets and cached artifacts are content-hashed. At
   the track level, a human reusing a name usually *means* "the new verse
   guitar" — continuity, not corruption.
3. Typo risk is the price of readability, and `field check` catches it.

The asymmetry that decides it: **UUID cost is paid on every diff read,
forever** — diffs become join tables (`id: trk-7f3a2` where it should say
`lead-vocal`), unreviewable without tooling, which attacks Field's central
thesis. **Slug cost is paid rarely, at rename time, by a tool built for it.**

### Operational commitments this decision creates

- `field track rename` (and its siblings) exist from early on and rewrite all
  references atomically.
- `field check` validates referential integrity and runs in CI.
- Merges may need a post-merge `field check` to catch cross-branch dangles —
  accepted, because the UUID alternative has the same failure mode with less
  readable evidence.

## 7 Deferred within this phase

- **Normalized-form asset paths** (from #5 review): `check` accepts any
  relative spelling that resolves inside the project (`./audio/x.wav`);
  comparisons therefore resolve paths rather than comparing strings. The
  §3.6-flavored tightening — `validate` requiring `file` in normalized form
  so exact-string comparisons stay sound everywhere — lands with the
  build-graph chunk, where path→label normalization must be settled anyway.
