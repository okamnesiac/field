# Plan: Project layout revision

**Status:** Decided (2026-08-06), not yet migrated. This records a design
conversation that amended three earlier DECIDED records; until the
migration lands, code and field follow the old layout and
[project-model.md](../project-model.md) carries a pointer here. The
migration is queued in [next](../next.md).

**Goal:** every file in a project has exactly one home, chosen by what
the file *is* — its contract, scope, and who writes it — with no shelf
encoding a decision that actually belongs to a clip, a trigger policy,
or a scope boundary.

## 1 Decisions (DECIDED, 2026-08-06)

1. **`shared/` has four shelves, split by contract:**
   `instruments/` (driven by notes — MIDI-taking `.scd`, later AU),
   `generators/` (driven by a spec — `.scd` render programs; generation
   models' definitions when they grow any), `samples/` (committed audio
   material; driven by nothing, it just *is*), `plugins/` (transforms
   audio rather than producing it). `loops/` dissolves into `samples/`:
   looping is a **clip placement property** (`loop:` on the clip,
   [clip-looping.md](clip-looping.md)), so a loops-vs-samples shelf
   split encoded a decision the clip owns — the same WAV legitimately
   tiles one track and one-shots another. This amends the 2026-08-05
   role-naming decision (#25), which filed `.scd` render programs under
   `loops/` — that conflated the artifact's role with its *output's*
   role. What a render program is, is a generator; what its render gets
   used as is not a property of the program.
2. **One generator category; two trigger policies.** A generator
   produces audio from a spec. Per generator, one question: is it safe
   for the build system to re-run it without asking? **Automatic**
   (deterministic: sc-render, say) — machine-triggered, in-graph,
   cached, never committed; an edit propagates silently because re-run
   provably reproduces. **Deliberate** (nondeterministic: ACE, voice) —
   human-triggered (`generate`), outputs committed (regeneration would
   not reproduce them), N variants with one promoted (`choose`);
   automatic re-run would replace chosen audio under your feet and burn
   model-minutes uninvited. Storage follows trigger policy; determinism
   is the *qualification* for automatic, not a filing principle —
   rejected: separate homes for the two kinds. Both kinds shelve in
   `shared/generators/` and are invoked from `targets/`. Note the
   deliberate workflow may later drive deterministic generators too
   (seed auditioning via `generate`/`choose`, nothing committed — the
   choice just writes the winning seed into the target).
3. **Authored specs get a file each; ledgers get a table.**
   `targets.yaml` becomes `targets/<name>.yaml` and `mix.yaml` becomes
   `mixes/<name>.yaml`, name-matches-filename like tracks and takes
   (project-core.md §6: filenames are keys). The list-file was a
   Bazel-ism — BUILD files hold many targets, but here the directory is
   the package and every file is already build input, so the container
   was imported, not needed. `assets.yaml` stays a single file: it is a
   machine-written *ledger* (one row per pin, written by import,
   verified by check), and ledgers are the one shape that wants to be a
   table. Labels are unchanged: `//songs/creek/targets:kit-punch` now
   reads as directory + filename, even more literally than before.
4. **`generation/` dissolves.** A generation recipe *is* a spec handed
   to a generator, so it lives with the other specs:
   `targets/<name>.yaml`, deliberate kind, carrying `variants:` and
   `chosen:` where a say target carries nothing extra. Committed
   variants move to the song's committed-audio home:
   `audio/<target>/<variant>.wav`. Ledger rows stay in `assets.yaml`.
   Supersedes [ace-generation.md](ace-generation.md) §3.1's layout
   (`generation/` directory, `//songs/<s>/generation:` labels — those
   addresses migrate to `targets:`). Follow-on, not prerequisite: clips
   can then reference `target:` directly and `choose` repoints which
   committed variant the target resolves to — promotion stops being a
   copy-into-the-ledger step and becomes choosing what the target
   *means*.
5. **`audio/` is all of a song's committed sound** — recorded, imported,
   or generated; the producer is irrelevant. `shared/samples/` vs
   `songs/<song>/audio/` is **enforced visibility, not content**: a clip
   can only reference its own song's ledger plus `shared/` — the system
   checks this — so where a file lives declares who may see it.
   Everything starts in the song; promotion to `shared/` happens on
   actual reuse, never speculatively, and is cheap by construction:
   content addressing means the hash survives the move (proven when the
   `.scd` relocation was a full cache hit).
6. **One ledger per scope.** `shared/assets.yaml` mirrors
   `songs/<song>/assets.yaml` — same schema, `file:` paths relative to
   the scope root, labels `//shared/assets:<name>` (superseding older
   `//shared/samples:<name>` sketches; the assets-kind spelling keeps
   the two scopes symmetric). Every committed file is pinned exactly
   once; promotion moves the pin with the file. The ledger pins
   **committed audio only**: programs are *keyed, not pinned* —
   sc-render hashes program content into the action key (drift
   re-renders, which is editing working normally), whereas a pin is a
   verification promise (drift fails `bloom check`). Code's integrity
   story is git; pinning programs would fail check on every legitimate
   edit.
7. **The `ace` prefix retires.** `bloom generate` and `bloom choose`
   are verbs over the generator category — the recipe's `model:` field
   says which generator ran. Answers
   [voice-generation.md](voice-generation.md) §4's CLI-seam question
   (schema reuse already made `ace choose` promote non-ACE recipes, a
   misnomer-in-waiting). The rename lands with the migration.

## 2 Migration (queued, not started)

One loader/CLI PR, then a field PR — flag-day is fine while field is the
only project:

1. Loader reads `targets/` and `mixes/` directories (the `tracks/`
   pattern), name-matches-filename diagnostics; generation recipes load
   as deliberate targets; `shared/assets.yaml` + the cross-scope clip
   reference (spelling decided here — see §3); `bloom generate`/`choose`
   rename with back-compat aliases removed in the same breath.
2. field migrates: split `targets.yaml`/`mix.yaml`, `.scd` programs →
   `shared/generators/`, still-water-keys recipe → `targets/`, variants
   → `audio/still-water-keys/`, `loops/` dir retires. Expected to be
   cache-neutral except the relabeled generation nodes.
3. field gains **one shared sample** exercising the whole shared story
   end-to-end: a file in `shared/samples/`, pinned in
   `shared/assets.yaml`, clipped into a song across the scope boundary —
   the demo that forces the reference spelling to exist and proves the
   visibility rule.
4. Docs-root updates (project-model.md layout + prose, build-graph.md
   labels) land with the migration, replacing the pointer note.

## 3 Open questions

- Cross-scope reference spelling on clips (`asset: //shared/assets:rain`
  vs a scoped field) — decided during migration chunk 1, forced by §2.3.
- Variant filenames once the directory carries the identity
  (`audio/still-water-keys/1.wav` vs repeating the name) — decided at
  migration.
