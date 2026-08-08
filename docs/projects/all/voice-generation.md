# Plan: Voice generation

**Status:** Planned, deferred (2026-08-06). The design was settled and
recorded ahead of the build, then deliberately queued behind other work —
nothing here is started. Written before
[project-layout.md](project-layout.md) §4: where this plan says
`generation/<name>.yaml` and recipe fields, read a `generate` sound in
`sounds/<name>.yaml` (`type:`/`source:` spellings, §4.3), with choosing
as repointing (§4.8). The other side of the determinism boundary from
the `say` rule (#27), kept separate by design — "got to keep them
separated."

**Goal:** `field voice generate`: text (and a voice) produce committed,
provenance-carrying vocal audio through a local model, auditioned and
promoted with the same variant machinery ACE established. bloom's creek
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
   field-aced.** ace-generation.md built the worker protocol so ACE would
   be "the first client, not a special case" — voice is the second
   client: `field-voiced`, same pyright-strict daemon-lite shape (spawn
   on demand, flock-owned, idle-exit, NDJSON), its own process so model
   memory and lifecycle stay independent.
5. **Chatterbox first.** MIT-licensed, English, zero-shot cloning from a
   short reference, expressiveness control, runs on Apple Silicon via
   MPS. Qwen3-TTS / CosyVoice 3 are candidate backends behind the same
   worker job spec; the recipe's `model` field already discriminates.
6. **Recipes reuse the generation shape.** `generation/<name>.yaml` with
   the existing schema growing optional voice fields (`text`,
   `voice_ref` naming a committed asset) — variants, `chosen`, hashes,
   and `field ace choose`-style promotion work unchanged. Rejected: a
   parallel recipe kind — two files that differ only in which model
   family wrote them would split the variant tooling for no reason.
   The subtractions are the real schema change (#29 review): `prompt`
   loosens to optional with a refine requiring **exactly one of
   `prompt` or `text`** — the clip asset-vs-target precedent, so no
   recipe is a chimera of both kinds or neither (a refine is fine here:
   the recipe schema is a single object, not a discriminated union);
   `duration_seconds` loosens to optional and is omitted for voice — a
   line's length follows from its text, and the committed variant WAV is
   its own record; `bpm`/`bars`/`lyrics` stay music-only, `voice_ref`
   voice-only, both enforced by the same refine's kind split.

## 2 Definition of done

creek's lead vocal is a generated voice: a committed reference asset, a
recipe with ≥2 variants, one chosen, clipped where the `say` line sits
today (the `say` target stays as the scratch tier). Worker start-to-audio
on the M3 Max in seconds-not-minutes; recipe hashes verified by
`field check`.

## 3 Chunks

1. `field-voiced` worker (Chatterbox behind the job-spec protocol) +
   `field voice generate` CLI + recipe/schema growth + tests.
2. bloom: record/pick a reference voice, generate creek's line, choose,
   clip; vault the milestone.

## 4 Open questions

- Reference voice for creek: whose? (A 3–10 s clean recording is all it
  takes — deferred to chunk 2, does not block the worker.)
- CLI naming: `field voice generate` vs folding into a general
  `field generate` once two generators exist — decide at the CLI seam.
  Schema reuse sharpens this (#29 review): `field ace choose` promotes
  voice recipes on day one, making the `ace` prefix a misnomer-in-waiting
  — the same seam decision should cover `choose`, not just `generate`.
  Answered 2026-08-06 ([project-layout.md](project-layout.md) §1.7):
  `field generate` and `field choose` are verbs over the generator
  category; the `ace` prefix retires with the layout migration.

## 5 `say` removed before this shipped (2026-08-07)

§1's first decision drew the determinism boundary with `say` on one side
of it — "`say` stays the hermetic in-graph recipe; this is the
keyed-quality tier." The rule is now gone, deleted in
[render-pipeline.md](render-pipeline.md) chunk 5, and this section is
what changed rather than a quiet divergence.

**What forced it.** Chunk 5 replaces `afconvert` with a resampler in the
daemon's built-in tier. `normalize` was the call everyone counted;
`say.ts` had a second one, converting the AIFF that `say` emits into a
WAV at the project rate. Our WAV reader does not read AIFF, so keeping
`say` meant either teaching the daemon a second container format for one
macOS-only rule, or keeping `afconvert` for that rule alone and with it
the macOS dependency the whole exercise exists to remove. Neither is
worth a scratch-vocal placeholder.

**What it costs, honestly.** This plan is *deferred and not started*, so
there is now a gap rather than a handover: bloom's creek has a
`lead-vocal` track with two clips sourcing `scratch-vocal`, plus a
`vocal-96k` normalize derived from it, and all three stop resolving until
something replaces the source. The gap is the point of recording this —
"the generated-voice tier replaces it" is true eventually and false
today, and a plan that claimed otherwise would be the stale-status
problem [README](../README.md) warns about. The stopgap available to a
project in the meantime is an imported recording, which is what a scratch
vocal is anyway.

**What §1's boundary loses.** Nothing structural. The hermetic side still
has `supercollider`, the effect rules, `normalize` and `stem`; the
generative side is still committed outputs with provenance. `say` was
only ever the *illustration* of the boundary, and a slightly false one:
`voice: Siri` followed a Settings toggle the action key could not see, so
the cleanest example of a hermetic recipe was the rule whose bytes were
not reliably reproducible. Its removal makes the boundary easier to state
rather than harder.

## 6 Schema growth as built (2026-08-07)

§1.6 justified enforcing the kind split with a `refine` on the grounds
that "the recipe schema is a single object, not a discriminated union."
That parenthetical is now false — [project-layout.md](project-layout.md)
§4 made the recipe a `generative` sound in `sounds/<name>.yaml`, and
`soundSchema` is a discriminated union on `type:`. The conclusion
survives anyway, which is why this is a note rather than a reopened
decision: zod v4 accepts a refined member and still narrows on the
discriminant, verified before the schema was written rather than assumed.

Two things the writing settled that §1.6 left implicit.

**The kind split is enforced in both directions, not just on
`prompt`/`text`.** A voice recipe carrying `duration_seconds` is a recipe
whose generator would ignore a field it declares, and a music recipe
carrying `voice_ref` is the same defect mirrored. Both are rejected, with
the offending key named in the issue path.

**`voice_ref` is a name *and* a hash.** §1.3's argument for a committed
recording over a vendor's opaque voice ID is provenance, and provenance
needs the bytes pinned: a name alone lets the recording change under a
recipe that still claims to describe it. So `voice_ref_sha256` sits
beside it and the two are required together — the same treatment a
variant gets, for the same reason.

**The reference recording is optional, and bloom starts without one**
(2026-08-07, Justin's call). `voice_ref` is paired with its hash but not
required, so a recipe carrying `text` alone means the model's own default
voice. That unblocks §2's definition of done — creek's line can be
generated before anyone records a reference — and it changes what §4's
open question is: not "whose voice blocks this" but "whose voice improves
it", answerable whenever a recording exists. With no reference the voice
is defined by `model:` and nothing else, which is honest rather than
lossy: §1.1 already commits the output precisely because inference does
not reproduce.

**Backend feasibility, checked rather than assumed**: `chatterbox-tts`
0.1.7 resolves from PyPI in about a second, 126 packages, pulling
torch/torchaudio/transformers. §1.5's "Chatterbox first" stands on
something better than a reading of its README now.
