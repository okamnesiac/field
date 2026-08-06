# Plan: Voice generation

**Status:** In progress (started 2026-08-06). The other side of the
determinism boundary from the `say` rule (#27), kept separate by design —
"got to keep them separated."

**Goal:** `bloom voice generate`: text (and a voice) produce committed,
provenance-carrying vocal audio through a local model, auditioned and
promoted with the same variant machinery ACE established. field's creek
trades its spoken `say` line for a generated voice worth listening to.

## 1 Decisions (DECIDED, 2026-08-06)

1. **A generation workflow, not a build rule.** Model inference is not
   reproducible across GPU/framework versions, so outputs are committed
   with a recipe — the ACE pattern ([ace-generation.md](ace-generation.md)
   §1) — never cached-and-regenerated. `say` stays the hermetic in-graph
   recipe; this is the keyed-quality tier. The boundary is the determinism
   contract, and both sides are recorded in
   [build-graph.md](../build-graph.md).
2. **Local-first.** 2026 open models (Chatterbox, Qwen3-TTS, CosyVoice 3)
   sit within ~80 ELO of ElevenLabs on public arenas; no API keys, no
   per-render cost, no vendor voice IDs. ElevenLabs becomes an optional
   keyed backend later only if a specific voice demands it — a backend,
   not the design.
3. **A voice is a committed reference asset.** Zero-shot cloning means
   "the voice" is a ~3–10 s reference recording committed like any asset
   (content-hashed, in the recipe by name+sha) — strictly better
   provenance than a vendor's opaque voice ID, and it makes "sing it in
   my voice" a recording, not an integration.
4. **A second worker on the established protocol, not a second model in
   bloom-aced.** ace-generation.md built the worker protocol so ACE would
   be "the first client, not a special case" — voice is the second
   client: `bloom-voiced`, same pyright-strict daemon-lite shape (spawn
   on demand, flock-owned, idle-exit, NDJSON), its own process so model
   memory and lifecycle stay independent.
5. **Chatterbox first.** MIT-licensed, English, zero-shot cloning from a
   short reference, expressiveness control, runs on Apple Silicon via
   MPS. Qwen3-TTS / CosyVoice 3 are candidate backends behind the same
   worker job spec; the recipe's `model` field already discriminates.
6. **Recipes reuse the generation shape.** `generation/<name>.yaml` with
   the existing schema growing optional voice fields (`text`,
   `voice_ref` naming a committed asset) — variants, `chosen`, hashes,
   and `bloom ace choose`-style promotion work unchanged. Rejected: a
   parallel recipe kind — two files that differ only in which model
   family wrote them would split the variant tooling for no reason.

## 2 Definition of done

creek's lead vocal is a generated voice: a committed reference asset, a
recipe with ≥2 variants, one chosen, clipped where the `say` line sits
today (the `say` target stays as the scratch tier). Worker start-to-audio
on the M3 Max in seconds-not-minutes; recipe hashes verified by
`bloom check`.

## 3 Chunks

1. `bloom-voiced` worker (Chatterbox behind the job-spec protocol) +
   `bloom voice generate` CLI + recipe/schema growth + tests.
2. field: record/pick a reference voice, generate creek's line, choose,
   clip; vault the milestone.

## 4 Open questions

- Reference voice for creek: whose? (A 3–10 s clean recording is all it
  takes — deferred to chunk 2, does not block the worker.)
- CLI naming: `bloom voice generate` vs folding into a general
  `bloom generate` once two generators exist — decide at the CLI seam.
