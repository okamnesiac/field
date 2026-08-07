# Plan: Project layout revision

**Status:** Done (2026-08-06); the loader/CLI migration (§2.1) and the
§4 vocabulary shipped in #31, and field migrated the same day (field
7fbdbc5, which also adds the first shared sample). This records a
design conversation
that amended three earlier DECIDED records; §4 records the vocabulary
decided mid-migration, which amends spellings in §1–§3 without changing
any decision's substance.

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
   used as is not a property of the program. *Amended by §4.6: the same
   reasoning then merged `generators/` into `instruments/` — four
   shelves became three.*
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
   **Amended 2026-08-06:** "the directory is the package" now reads *the
   directory is the package's plural* — packages went singular (§4.5's
   amendment), so the file is `sounds/kit-punch.yaml` and the label is
   `//songs/creek/sound:kit-punch`. The mapping is still mechanical, and
   a label now says what it addresses rather than which folder it came
   from.
4. **`generation/` dissolves.** A generation recipe *is* a spec handed
   to a generator, so it lives with the other specs:
   `targets/<name>.yaml`, deliberate kind, carrying `variants:` and
   `chosen:` where a say target carries nothing extra. Committed
   variants move to the song's committed-audio home:
   `audio/<target>/<variant>.wav`. Ledger rows stay in `assets.yaml`.
   *Superseded by §4.8: under the unified namespace there is no ledger
   row — choosing repoints the sound's own label, and the sound file
   pins its variants.*
   Supersedes [ace-generation.md](ace-generation.md)'s layout — the
   `generation/` workflow convention (§3.2) and its
   `//songs/<s>/generation:` labels (§4.2); those addresses migrate to
   `targets:`. (§3.1 — outputs committed, never cached — is untouched;
   decision 2 here restates it as the deliberate trigger policy.)
   Follow-on, not prerequisite: clips can then reference `target:`
   directly and `choose` repoints which committed variant the target
   resolves to — promotion stops being a copy-into-the-ledger step and
   becomes choosing what the target *means*.
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
   the scope root, labels `//shared/asset:<name>` (superseding the
   `//shared/samples:<name>` spelling sketched in discussion; the
   assets-kind spelling keeps the two scopes symmetric). Every
   committed file is pinned exactly once; promotion moves the pin with
   the file. The ledger pins
   **committed audio only**: programs are *keyed, not pinned* —
   sc-render hashes program content into the action key (drift
   re-renders, which is editing working normally), whereas a pin is a
   verification promise (drift fails `bloom check`). Code's integrity
   story is git; pinning programs would fail check on every legitimate
   edit. *Nuanced by §4.8: pin authority splits — imported/recorded
   audio pins in the ledger, generated variants pin in their sound spec
   (the per-variant sha256 check verifies). Every committed file is
   still pinned exactly once.*
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

- Cross-scope reference spelling on clips (`asset: //shared/asset:rain`
  vs a scoped field) — decided during migration chunk 1, forced by §2.3.
  Answered by §4.3: one `source:` field whose spellings are
  syntactically disjoint.
- Variant filenames once the directory carries the identity
  (`audio/still-water-keys/1.wav` vs repeating the name) — decided at
  migration: the directory carries the identity, so the filename is the
  bare number (`audio/still-water-keys/1.wav`).

## 4 Vocabulary (DECIDED, 2026-08-06)

Decided during the migration itself, before any of the §1.3 file shapes
shipped. This amends the *spellings* in §1–§3 without changing any
decision's substance: where earlier sections say `targets/`, `rule:`,
and `asset:`/`target:`/`program:`, the implementation reads `sounds/`,
`type:`, and `source:`. Recorded as a new section so §1's numbering and
every existing citation stay stable.

1. **The authored-spec shelf is `sounds/`.** The per-file targets of
   §1.3 become `songs/<song>/sounds/<name>.yaml`, labeled
   `//songs/<song>/sound:<name>`. What such a file defines *is* a
   sound — a say line, a SuperCollider render, a generated part, a
   sound wrapped in an effect (still a sound; the algebra closes,
   exactly as the graph composes nodes). This finishes the
   contract-naming §1.1 started — `tracks/`, `mixes/`, `sounds/`,
   `audio/` — and the audio/sounds pair teaches the system's central
   distinction: audio is committed bytes, a sound is a definition.
   Rejected: keeping `targets/` (mechanism-named Bazel inheritance —
   the project's own informal register always said "recipe"); `nodes/`
   (the engine's word, and wrong twice over: everything in the graph is
   a node, while the shelf holds only authored specs).
2. **The discriminator is `type:`.** `rule:` was engine jargon in
   musician-facing YAML, and false since §1.2 — a deliberate `generate`
   entry is precisely *not* a rule, whereas `type: generative` is simply
   a type that is not machine-runnable. `type:` is already the format's
   discriminator convention (tracks' `type: audio|midi`, eq bands'
   `type: lowshelf`). Rejected: `kind`, `class` — a third spelling
   where the format has a house style. (Inserts' `effect:` becomes the
   one remaining odd discriminator; renaming it is a separable
   cleanup, not part of this decision.)
3. **Inputs unify as `source:`.** `asset:`, `target:`, and `program:`
   collapse into one field: the thing this sound is made from. Its
   spellings are syntactically disjoint, so the loader never guesses —
   a bare slug is a name in the song, a `//` label crosses scope
   (`source: //shared/asset:rain`, answering §3's open question), and
   a path (slashes, extension) is a program file, still wiring, still
   keyed by content. A bare filename (`source: creek-kit.scd`, no
   slash) resolves on the type's home shelf — `shared/instruments/` for
   `supercollider` (§4.6) — the same principle as a bare slug resolving
   in the song's namespace: every bare spelling resolves in its natural
   home, explicit spellings escape. Never a search path: each spelling names
   exactly one location (the one-spelling rule, project-core.md §7),
   so a
   song-local program, if one ever exists, writes the slashed path.
   Clips adopt the same field: a clip's `source:` is an asset name, a
   sound name, or a shared label. Forced consequence,
   accepted deliberately: a song's asset and sound names now share one
   namespace — `source: pad` must mean exactly one thing — enforced by
   check, in the spirit of project-core.md §6 (names are identity).
4. **`sc-render` becomes `supercollider`.** The type names the
   instrument, not the engine verb (`say` was already right). The type
   value participates in the action key, so this is a one-time
   re-render of SuperCollider nodes — free inside the flag-day that
   relabels them anyway.
5. **"Target" retires as a term.** The addressable thing is a *label*;
   `bloom build` builds labels, and things that never had spec files
   (track stems, mixes) were never comfortably "targets" anyway. Mix
   labels keep their `mix:` package; a mix file's `rule: mix` becomes
   `type: mix`.
   **Amended 2026-08-06:** keeping `mix:` while the file moved to
   `mixes/<name>.yaml` left it the only package that did not equal its
   directory, contradicting §1.3's "the directory is the package" —
   a tension this record created and did not notice. Resolved the other
   way: **every package is now the singular of its directory**
   (`sound:`, `track:`, `asset:`, `mix:`), because a label addresses one
   thing and reads as such. §1.3's principle is amended to match: the
   directory is the package's *plural*. Directories and the `assets:`
   ledger key keep their plurals — both hold many.
6. **`shared/` lands on three shelves: `instruments/`, `samples/`,
   `plugins/` — make, is, change.** `generators/` merges into
   `instruments/` by §1.1's own argument: whether a definition
   auto-triggers from a spec or responds to notes is a property of *how
   it is invoked* — a sound handing it a spec, a track handing it MIDI
   — not of the definition, exactly as looping was a clip property, not
   content. The same `.scd` legitimately renders in a sound today and
   plays from a MIDI clip later; under a split it has no honest home. A
   drum kit, a pad, a voice, an AI model you play with prompts — all
   instruments, in the way musicians already talk. Rejected:
   `synths/` as a separate shelf (strong SC/TTS/AI resonance, but it
   recreated the invoker-encoding split with an adjacency trap beside
   `instruments/`); `programs/`, `defs/`, `models/`, `specs/` (each
   honest for part of the shelf, false or colliding for the rest).
   Bare program filenames (§4.3) resolve in `shared/instruments/`.
7. **The engine's executor is a `Generator`.** §1.2 already named the
   category — "a generator produces audio from a spec" — so the code
   speaks the record's language: `Generator<T>` implementations in
   `src/generators/`, one per automatic type; a deliberate type has no
   in-graph Generator — *you* generate it, with `bloom generate`. The
   poles were never generate-vs-something-else; they were always
   automatic-vs-deliberate generation. Rejected: keeping `RuleImpl`
   ("rule" was only ever true engine-side, and §1.2's own noun is
   better); `Renderer` (a third word for a category the record had
   already named — and "render is a word for visual stuff"). One deliberate fossil: the action-key JSON keeps its
   serialized field spelled `rule` — renaming a hash key would
   invalidate every cache for zero semantic gain, so only the
   `sc-render` → `supercollider` *value* change re-keys (§4.4).
8. **Choosing repoints; the ledger copy dissolves.** Forced by §4.3's
   one-namespace rule: `choose` minting an asset named after its own
   sound would self-collide, so §1.4's recorded follow-on lands inside
   the migration rather than after it. A generative sound's own label
   resolves to its chosen variant; clips reference the sound by name
   (`source: still-water-keys`), `bloom choose` rewrites only `chosen:`
   — a one-line diff every reference follows — and the sound spec pins
   its variants (per-variant sha256, verified by check). `--as` retires
   with the ledger step; the reference is scope-stable, since it names
   the sound, not a file.
9. **The deliberate type spells `generative`.** The `type:` slot answers
   "what kind of sound is this," and the kind has a musicians' name —
   generative music — so the adjective wins over the verb: a *generative
   sound*, produced by `bloom generate` (the verb stays the act, §1.7).
   Rejected: `type: generate` (the verb in the type slot — initially
   ratified for verb symmetry, but "a generate sound" never parsed, and
   the symmetry survives through the shared root). Decided after §4.8
   and moved below it in the list — §4.8 already had incoming citations,
   this decision had none, and the §4 preamble's own promise is that
   numbering stays stable for citers.
10. **The implicit track type spells `stem`.** `track-render` was the
    last `-render` fossil (§4.7 struck the word from the executor) and
    the odd one out beside `mix`: a mix file defines a `mix`, a track
    file implies a `stem` — the artifact's real name everywhere the
    docs speak ("track stems", "the mix sums stems"). Rejected:
    `track-generate` (the verb in the type slot, per §4.9); `track`
    (the track is the declaration, not the artifact, and its file
    already discriminates on `type: audio|midi`). The type value is in
    the action key, so stems re-key once — deterministic summing means
    they re-render byte-identically and mixes stay cached, same class
    as §4.4's supercollider re-key, free inside the same flag-day.
