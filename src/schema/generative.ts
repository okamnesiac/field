import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName, sourceRef } from './common.js';

// The generative request and its takes: the request fields, their
// refinement, and the takes machinery that pins committed variants.

// generative: deliberate generation (project-layout.md §1.2, §1.4) — a
// request with no in-graph Generator behind it: nothing may generate it
// mechanically; you run it, with field generate. Model inference does
// not reproduce across GPU/framework versions, so the outputs are
// content-addressed under audio/<name>/ and the takes file is
// provenance plus promotion state: `field generate` writes the takes
// and chooses the first, `field choose` switches which one, and the gen
// node's label resolves to the chosen variant — placements reference
// the track that carries the request, no ledger copy involved. Each
// variant is additionally auditionable as //songs/<song>/gen:<name>-<n>.
//
// Provenance lives on the variant rather than on the request, because
// it describes a *run* and a request accumulates several
// (bloom-in-tree.md §3). Two takes made a month apart can come from
// different model versions and certainly have different generation
// times; a single `model`/`generated_at` pair on the request could
// record only one answer for the whole list. It is also what lets a
// request exist before any run has happened, which is the shape an
// example project ships in.
const TAKES_FILE = 'variants.yaml';

export const generativeVariantSchema = z.strictObject({
  file: z.string().min(1), // song-relative, under audio/<name>/
  model: z.string().min(1), // which generator produced this take
  seed: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256'),
  generated_at: z.iso.datetime(),
});
export type GenerativeVariant = z.infer<typeof generativeVariantSchema>;

// What a run produced, and which take you kept — `audio/<name>/variants.yaml`,
// beside the WAVs it pins (bloom-in-tree.md §7).
//
// It sits there rather than in the track file because generating and
// choosing are things *your* machine did, and a recipe is what you share.
// With them in the recipe, following the documented workflow modified a
// committed file: clone the example, run `field generate`, and the working
// tree is dirty before you have heard anything.
//
// And it sits *inside the audio directory* rather than beside the recipe so
// that one gitignore rule governs both. This file pins those WAVs and is
// meaningless without them, so the decision to commit the audio and the
// decision to commit its pins have to be the same decision — two rules in
// two places can drift, and each way they drift is quiet: pins without
// bytes fail `check` for everyone else, bytes without pins cannot be
// verified at all.
export const generativeTakesSchema = z
  .strictObject({
    // What these takes attach to: a gen node (`gen:` — the owning
    // track's name, or <track>-<id> when the entry carries an id).
    // Redundant with the directory name, and checked against it for the
    // same reason a track's `name` is checked against its filename: a
    // file that has been moved should say so rather than quietly
    // describe something else.
    gen: labelName,
    chosen: z.number().int().min(1).optional(), // 1-based, as played and numbered
    // Defaulted rather than merely allowed to be empty: omitting the key and
    // writing `variants: []` would otherwise be different failures, and a
    // hand-written file does the former.
    variants: z.array(generativeVariantSchema).default([]),
  });
export type GenerativeTakes = z.infer<typeof generativeTakesSchema>;
export const generativeTakesOrder: KeyOrder = {
  keys: ['gen', 'chosen', 'variants'],
  children: {
    variants: { items: { keys: ['file', 'model', 'seed', 'sha256', 'generated_at'] } },
  },
};
export const TAKES_FILENAME = TAKES_FILE;

// Two kinds of generation share this one shape, discriminated by which
// of `prompt`/`text` is present rather than by a second `type:`
// (voice-generation.md §1.6). Music recipes carry `prompt` and may carry
// `lyrics`/`bpm`/`bars`/`duration_seconds`; voice recipes carry `text`
// and a `voice_ref` naming the committed reference recording that
// defines the voice (§1.3 — a recording, not a vendor's opaque ID). The
// variant machinery, `chosen`, the hashes and `field choose` are
// identical for both, which is the whole reason not to fork the schema.
//
// A voice line has no `duration_seconds`: its length follows from the
// text, and the committed variant WAV is its own record of what came out.
//
const generativeRecipeFields = {
  prompt: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  voice_ref: sourceRef.optional(),
  voice_ref_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256')
    .optional(),
  // Chatterbox's two expressive knobs, ours by name (voice-generation.md
  // §8). `conviction` is its `cfg_weight`: classifier-free guidance,
  // which each step blends as `cond + w * (cond - uncond)` — how far
  // past the on-text reading to push. Higher commits harder and hurries;
  // lower lingers. Named for what it does rather than for the technique,
  // and left in Chatterbox's direction so a value copied from its docs
  // means the same thing here.
  //
  // Bounds are deliberately narrower than the model's: widening a range
  // later keeps every existing recipe valid, narrowing one does not.
  exaggeration: z.number().min(0.25).max(2).optional(),
  conviction: z.number().min(0.1).max(1).optional(),
  lyrics: z.string().optional(),
  bpm: z.number().int().min(30).max(300).optional(),
  duration_seconds: z.number().positive().optional(),
  bars: z.number().int().positive().optional(),
};
type RecipeFields = {
  [K in keyof typeof generativeRecipeFields]?: z.infer<(typeof generativeRecipeFields)[K]>;
};
// The kind split, enforced rather than documented. Without it a recipe
// can be a chimera of both kinds or neither, and the generator would
// have to guess which one it was looking at — the same failure the
// clip asset-vs-target precedent rules out.
const refineRecipe = (recipe: RecipeFields, ctx: z.RefinementCtx): void => {
  const isMusic = recipe.prompt !== undefined;
  const isVoice = recipe.text !== undefined;
  if (isMusic === isVoice) {
    ctx.addIssue({
      code: 'custom',
      path: [isMusic ? 'text' : 'prompt'],
      message: isMusic
        ? 'a recipe carries either `prompt` (music) or `text` (voice), not both'
        : 'a generative request needs `prompt` (music) or `text` (voice)',
    });
    return;
  }
  const musicOnly = ['lyrics', 'bpm', 'bars', 'duration_seconds'] as const;
  const voiceOnly = ['voice_ref', 'voice_ref_sha256', 'exaggeration', 'conviction'] as const;
  for (const key of isVoice ? musicOnly : voiceOnly) {
    if (recipe[key] !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: isVoice
          ? `\`${key}\` is music-only; a voice recipe carries \`text\` and \`voice_ref\``
          : `\`${key}\` is voice-only; a music recipe carries \`prompt\``,
      });
    }
  }
  // Music has to say how long. `field generate` asks for exactly one of
  // --bars or --duration and a written recipe records the seconds it
  // ran at, so a recipe with neither describes nothing runnable — and
  // once a recipe can exist before its takes, that is reachable by
  // writing one. Caught here so `check` says it, rather than at fill
  // time where the advice would name flags that filling refuses.
  if (isMusic && recipe.bars === undefined && recipe.duration_seconds === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['duration_seconds'],
      message: 'a music recipe needs a length — `bars` or `duration_seconds`',
    });
  }
  // The reference recording is the voice, so its identity is part of
  // the recipe's provenance (§1.3): name alone would let the bytes
  // change under a recipe that still claims to describe them.
  if (isVoice && (recipe.voice_ref === undefined) !== (recipe.voice_ref_sha256 === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['voice_ref'],
      message: '`voice_ref` and `voice_ref_sha256` go together — the recording and its hash',
    });
  }
};

// The request inline in a track's `inputs:` — `name` and `type` are
// supplied by where the entry sits and what field it is. Its takes live
// beside the audio under the gen node's name.
export const generativeEntrySchema = z.strictObject(generativeRecipeFields).superRefine(refineRecipe);
export type GenerativeEntry = z.infer<typeof generativeEntrySchema>;
