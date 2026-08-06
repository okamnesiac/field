# Plan: ACE generation

**Status:** Complete (2026-08-05, #17 + #18). Both chunks shipped; field
demonstrates the full loop — generate, audition variants in the mix,
`choose`, clip the promoted asset into creek. The goal's further verbs
(`extend`, `repaint`, …) are future phases, not this plan. §5 has the
open follow-ups. Layout superseded 2026-08-06
([project-layout.md](project-layout.md) §1.4, §4): the `generation/`
directory and `//songs/<s>/generation:` labels (§3.2, §4.2 below)
migrate to deliberate `generate` sounds in `sounds/` with variants in
`audio/`, chosen by repointing (`bloom choose`) rather than promotion
into the ledger (§4.8); the committed-not-cached decision (§3.1)
stands. The `ace` CLI prefix retired with §1.7.

**Goal:** `bloom ace generate` (then `extend`, `repaint`, `variants`, …):
committed generation recipes produce audio assets through ACE-Step running in
a Python worker, with full provenance.

## 1 Shape

- ACE lands as `src/rules/ace-generate.ts` behind the `RuleImpl` interface —
  a module, not engine code. The generic-registry polish deferred from the
  #7 review (`RuleImpl<T>`, so per-method `'wrong rule'` guards become
  compiler-proven) had "the third rule" as its agreed trigger; with the
  phase reorder, the third rule is `track-render`, so the refactor moved to
  [mix-assembly.md](mix-assembly.md) §5 and lands there, not here.

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

## 3 Decisions (DECIDED, 2026-08-05)

1. **ACE lives outside the build graph: outputs are committed, not
   cached.** The reproducibility caveat (§1) is structural — a fixed seed
   reproduces on the same machine, not across GPU/framework versions — so
   `bloom ace generate` is a *generation workflow*, not a rule: it runs
   the model, lands variants, and the chosen one is imported as an
   ordinary committed asset with the recipe recorded as provenance beside
   it. The recipe serves deliberate regeneration and audit, never a cache
   key. The graph sees a normal asset; clips and takes reference it like
   any recording.
2. **Nondeterministic-node/take-pinning machinery is deferred.** It
   exists to let nondeterministic renders live *inside* the graph
   ([build-graph.md](../../build-graph.md)); the committed-asset flow
   gives it nothing to do. Its forcing function is the recording era —
   plugin renders and realtime-bounce — which will teach the real
   requirements. Revisit then, not now. ACE's variants-as-takes UX
   (numbered, auditioned, one active) is a workflow convention in
   `generation/`, no graph support required.
3. **`bloom-aced`: a resident worker with the audiod lifecycle.** Model
   load costs tens of seconds and prompt iteration is the whole workflow,
   so the worker is a daemon: spawn-on-demand, flock-owned socket at
   `.bloom/aced.sock`, versioned NDJSON with a `hello` handshake,
   streaming `progress` events, idle-exit. One house style for Bloom
   daemons. The idle timeout is shorter-fused than audiod's (default
   10 min, tunable) because an idle model worker holds several GB of
   unified memory.
4. **`uv` manages the Python side, and the Python is strictly typed.**
   `python/aced/` carries its own pinned, lockfiled environment; setup is
   an explicit, loud `bloom ace setup` (environment + the multi-GB
   HuggingFace weights download, consented, never a surprise), with a
   `BLOOM_ACED_PYTHON` override mirroring `BLOOM_AUDIOD`. **Pyright in
   strict mode** gates the worker in CI (PyLance's engine, so the editor
   and the gate agree); every module is fully annotated, and the one
   untyped boundary — ACE-Step's own package — is quarantined behind a
   single typed adapter so strictness holds everywhere else. ACE-Step
   1.5 is pinned by commit from its MIT-licensed repo. Python is a
   model-runner here, as architecture.md always said — the protocol
   boundary is the contract.

## 4 Chunks

1. **The worker** (shipped, #17) — `python/aced/` (uv project, ACE-Step
   pinned), `bloom-aced` with the daemon-lite lifecycle and NDJSON
   protocol (`hello`, `generate`, streaming progress, `quit`),
   `bloom ace setup` and `bloom ace generate` end to end: prompt → WAV
   variants on disk + provenance YAML. First generation ran 2×12 s in
   ~15 s on the M3 Max after a one-time model load.
2. **Variants as takes** (shipped, #18) — the `generation/` recipe schema,
   numbered variants with hashes, audition via `bloom play`
   (`//songs/<song>/generation:<name>-<n>`), and `bloom ace choose`
   promoting the active variant to a committed asset wired for clips — in
   place, no bytes copied, reversibly; field demonstrates with a generated
   part in creek.

## 5 Follow-ups

- The worker enforces a 10-second duration floor, so 1–2 bar loops at
  common tempos can't generate directly. Tolerable because a clip can
  reference just the first N bars of a longer generation; revisit if it
  chafes in practice.
- `quit`/SIGTERM mid-generation kills the worker thread silently. Safe —
  the CLI writes the recipe only after all variants land — but a politer
  cancel could come with the recording era's job control.
- ACE-Step writes `.cache/acestep/progress_estimates.json` into the
  daemon's cwd, i.e. the user's project. Redirect next to the weights in
  `~/.bloom/models` if ACE-Step's env allows it.
