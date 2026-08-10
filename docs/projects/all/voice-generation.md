---
status: Shipped
---

# Plan: Voice generation

**Status:** In flight (2026-08-07). Designed and recorded ahead of the
build (2026-08-06), then queued behind other work until `say`'s removal
made it the thing bloom needs. Chunk 1 is complete — schema (#58),
worker lifecycle (#59), `field-voiced` (#60), CLI seam (#61) — and
nothing here has yet loaded the model: chunk 2 is the first real
generation. Written before
[project-layout.md](project-layout.md) §4: where this plan says
`generation/<name>.yaml` and recipe fields, read a `generate` sound in
`sounds/<name>.yaml` (`type:`/`source:` spellings, §4.3), with choosing
as repointing (§4.8). The other side of the determinism boundary from
the `say` rule (#27), kept separate by design — "got to keep them
separated."

**Goal:** `field generate` over a voice recipe: text (and optionally a
voice) produce committed,
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

creek's lead vocal is a generated voice: a recipe with ≥2 variants, one
chosen, clipped where the `say` line used to sit. Worker start-to-audio
on the M3 Max in seconds-not-minutes; recipe hashes verified by
`field check`.

**Amended 2026-08-07**, twice over, and both amendments are in §5 and §6
rather than being quietly absorbed here. This said "a committed reference
asset" as a requirement — §6 makes the reference optional, so the default
voice satisfies this and a recording only improves it. And it said "the
`say` target stays as the scratch tier", which is no longer available to
say: §5 records that the rule was deleted, so there is no scratch tier
to fall back to and creek's clips have no source at all until this
ships. That is why this moved from a nice-to-have to the thing bloom is
waiting on.

## 3 Chunks

1. `field-voiced` worker (Chatterbox behind the job-spec protocol) +
   `field generate` support + recipe/schema growth + tests. The CLI name
   is §4's settled one, not the `field voice generate` this said before
   that question was answered. **Shipped** across four pull requests: the
   schema (#58), the worker lifecycle it builds on (#59), the worker
   itself (#60), and the CLI seam (#61, §7).
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

**What it costs, honestly.** This plan was *deferred and not started*
when `say` went, and is only now in flight, so
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

## 7 The CLI seam as built (2026-08-07)

§4 answered "which verb" and left the rest of the seam to whoever built
it. Three things the building settled.

**The kind split is checked before anything spawns.** The recipe schema
already rejects a voice recipe carrying `duration_seconds` (§6), but it
does so on the way to disk — after the model has run. `field generate`
states the same rules in flag vocabulary (`--bars is a music option`)
and states them first, alongside the namespace pre-flight that was
already there for the same reason: a refusal that costs model minutes is
a worse refusal.

**`voice_ref` resolves through the project model's own lookup, not a
copy of it.** Both #58 review findings were two readings of "which asset
is this" disagreeing — a name resolved in the wrong namespace, and a
hash that pinned nothing — so there is one reading now (`lookupAsset`),
used by validate to diagnose a ref, by `verifyAssetHashes` to compare
its hash, and by `generate` to turn it into the path the worker reads.
The per-song scoping that #58 fixed on the verify side is the same
function on the write side, rather than the same rule written twice.

**A written hash is the hash of the bytes that were read.** This is the
first code in field that writes a content hash into a committed file
rather than checking one somebody else wrote, so the discipline is worth
naming: `generate` hashes the recording it is about to hand the model,
and refuses outright if that disagrees with the ledger. Recording the
*ledger's* value instead would have been one line shorter and would have
left a check-green recipe describing bytes the model never heard — the
refusal `field choose` already makes about a drifted variant, for the
same reason.

**A hash pins bytes, not a filename.** The first version hashed the
recording and handed the worker its path, which is a promise about one
instant: the worker reads minutes later, after daemon start and a
weights download, and a recording edited inside that window is generated
from while the recipe records what it used to be. Re-hashing afterwards
does not close it — an edit that is undone before the run ends compares
equal at both ends and passes, which is exactly how the #61 review
reproduced it, ending check-green with audio from other bytes. So the
window is removed rather than watched: the reference is copied first,
and the copy is what gets hashed and what the worker reads. Hashed and
heard are the same bytes by construction.

**An ambiguous name is not a name.** An asset ledger is schema-valid
with two rows called `ref-voice`; validate diagnoses that, but
generation does not read diagnostics, so it spent model minutes on
whichever row came first and wrote that arbitrary choice down as
provenance (#61 review). `lookupAsset` reports how many rows answer to
the name — a lookup can only say a name is ambiguous, not resolve it —
and generation refuses. Which is the shape of every fix in this section:
the resolver's job is to be honest about what it found, and the caller's
job is to decide that "arbitrary" is not good enough for something about
to be committed.

**Tested through a stub worker** (`src/testing/stub-worker.mjs`), which
the `FIELD_*_PYTHON` override lets stand in for a daemon: the real
client, real socket, real framing, no model. It observes what `generate`
*sends* and what it *writes*, while the live-daemon tests observe the
protocol itself — so neither test is asserting against its own fixture.
Every property above was checked by mutation, including against the fix
that looks right and is not: replacing the snapshot with a
post-generation re-hash still fails, because the test observes the bytes
the worker read rather than the file's state afterwards. The one
surviving mutant was equivalent (an explicit `undefined` that
`JSON.stringify` drops).

**Still unproven, and deliberately so:** none of this has loaded
Chatterbox. Everything that can be verified without weights is, and what
remains — that the model produces audio, at 24 kHz, needing a
`normalize` wrapper at the project rate — is chunk 2's first act rather
than something this section can claim.

*Note (2026-08-09):* the wrapper this paragraph expects is no longer
written. Under [multi-rate.md](multi-rate.md) decision 6 the 24 kHz
output needs nothing authored at all — the edge converts it to the
consuming track's rate automatically, which is how creek plays
`lead-take` today: a generative leaf track whose own edge converts,
placed twice by `lead-vocal`. Chunk 2's first act became writing
nothing.

## 8 The delivery knobs, and one rename (2026-08-08)

creek's first take reads its line at a fixed pace, and §1 left no way to
change that: the job spec was text, seed, variants and `voice_ref`, so
the only lever was the words themselves. Chatterbox has six sampling
parameters; two of them are exposed here and four are not, because every
field added to the recipe is a permanent part of the committed format.

**What was measured, before anything was named.** Same seed, same text,
the committed line:

| `cfg_weight` | `exaggeration` | speech | tokens |
| --- | --- | --- | --- |
| 0.5 (default) | 0.5 | 2.58 s | 72 |
| 0.4 | 0.5 | 2.58 s | 72 |
| 0.3 | 0.5 | 2.58 s | 72 |
| 0.2 | 0.5 | 2.90 s | 82 |
| 0.3 | 0.3 | 3.10 s | 85 |

Duration is quantised by token count at about 40 ms each, and the extra
length is speech rather than silence — leading and trailing silence stay
within 0.12–0.20 s throughout. So the pacing effect is real, up to about
20%, and `exaggeration` is the stronger lever: it is a conditioning
input the model receives, where `cfg_weight` only reweights sampling.
The three runs at 0.5, 0.4 and 0.3 produced *different audio* on the
same token count, so the knob changes delivery continuously and pace
only in steps.

**A determinism result worth recording.** The 0.5/0.5 run reproduced the
committed take byte for byte — the same sha256 the recipe pins. §1.1
commits outputs because inference does not reproduce across GPU and
framework versions, and that stands; within one fixed environment, the
seed does exactly what the recipe implies it does.

**`cfg_weight` is `conviction` here** (Justin's call). The wire, the
schema and the CLI all say `conviction`; `adapter.py` translates to
`cfg_weight` at the boundary where Chatterbox's vocabulary starts, which
is what that module is for. The name is not decoration: `cfg_weight`
leaks a technique into a musician's file, and the technique is
classifier-free guidance, which each step computes as
`logits = cond + w * (cond - uncond)` — the model predicts once knowing
the text and voice and once deliberately ignorant of them, and `w` says
how far past the informed prediction to push. So it is a conviction
control, and pace is a side effect of it. Rejected: `speed` and `pace`,
which promise what the measurement shows it does not deliver;
`looseness`, which would invert the scale so a value copied from
Chatterbox's own docs would mean its opposite. The direction is kept
identical to Chatterbox's for exactly that reason.

**Absent means the model's default, not a default we chose.** Neither
field is written to a recipe unless it was asked for, and the adapter
passes only what was given. Recording 0.5 explicitly would look
identical today and silently pin it if Chatterbox's defaults ever moved.

**The bounds are narrower than the model's**, `exaggeration` in
[0.25, 2] and `conviction` in [0.1, 1], and enforced three times: the
CLI parser before the model runs, the worker's own job spec, and the
schema on the way to disk. Narrower on purpose — widening a range later
leaves every committed recipe valid, and narrowing one does not.
