import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName, sampleRate, sourceRef } from './common.js';
import { eqParams, limitParams, reverbParams } from './effects.js';

// songs/<song>/sounds/<name>.yaml — one defined sound per file, name
// matching the filename like tracks and takes (project-core.md §3.4 as
// amended by project-layout.md §1.3 and §4: the directory is the
// package's *plural*, so sounds/<name>.yaml is
// //songs/<song>/sound:<name> — the folder holds many, the label
// addresses one). Audio is committed bytes; a sound is a definition — and a
// sound wrapped in an effect is a different sound, so the algebra
// closes. Fields are flat and strict, discriminated by `type:` (§4.2,
// the format's discriminator convention). `source:` (§4.3) names what a
// sound is made from: a bare slug resolves in the song's one namespace
// (assets and sounds together), a //shared/asset:<name> label crosses
// scope, and for supercollider a path names the program file.

export const normalizeSoundSchema = z.strictObject({
  name: labelName,
  type: z.literal('normalize'),
  source: sourceRef,
  sample_rate: sampleRate,
  bit_depth: z.union([z.literal(16), z.literal(24), z.literal(32)]),
});
export type NormalizeSound = z.infer<typeof normalizeSoundSchema>;

export const eqSoundSchema = z.strictObject({
  name: labelName,
  type: z.literal('eq'),
  source: sourceRef,
  ...eqParams,
});
export type EqSound = z.infer<typeof eqSoundSchema>;

export const limitSoundSchema = z.strictObject({
  name: labelName,
  type: z.literal('limit'),
  source: sourceRef,
  ...limitParams,
});
export type LimitSound = z.infer<typeof limitSoundSchema>;

export const reverbSoundSchema = z.strictObject({
  name: labelName,
  type: z.literal('reverb'),
  source: sourceRef,
  ...reverbParams,
});
export type ReverbSound = z.infer<typeof reverbSoundSchema>;

// supercollider: the sound is defined by a SuperCollider program,
// rendered offline (NRT). The program runs via sclang with FIELD_OUTPUT /
// FIELD_SEED / FIELD_DURATION / FIELD_SAMPLE_RATE / FIELD_CHANNELS in
// the environment; it must write FIELD_OUTPUT and exit. Determinism
// given the seed is the program's job; the program's content hash is the
// cache input. `source:` is the program file — a bare filename resolves
// on the type's home shelf, shared/instruments/ (§4); a slashed path is
// project-relative.
export const supercolliderSoundSchema = z.strictObject({
  name: labelName,
  type: z.literal('supercollider'),
  source: z.string().min(1),
  seed: z.number().int().min(0),
  duration: z.number().positive().max(3600), // seconds
  channels: z.union([z.literal(1), z.literal(2)]).default(2),
});
export type SupercolliderSound = z.infer<typeof supercolliderSoundSchema>;

// `say` was here — macOS text-to-speech as an in-graph recipe. Removed
// in render-pipeline.md chunk 5; voice-generation.md §5 records why.
// Short version: it was the last thing tying the build to `afconvert`
// and to macOS, and the generated-voice tier replaces what it was for.

// generative: deliberate generation (project-layout.md §1.2, §1.4) — a
// sound with no in-graph Generator behind it: nothing may generate it
// mechanically; you run it, with field generate. Model inference does not reproduce across GPU/framework
// versions, so the outputs are content-addressed under audio/<name>/ and
// the file is provenance plus promotion state: `field generate` writes
// the takes and chooses the first, `field choose` switches which one, and
// the sound's own label resolves to the chosen variant — clips reference
// the sound by name, no ledger copy involved. Each variant is
// additionally auditionable as //songs/<song>/sound:<name>-<n>.
//
// Provenance lives on the variant rather than on the sound, because it
// describes a *run* and a sound accumulates several (bloom-in-tree.md
// §3). Two takes made a month apart can come from different model
// versions and certainly have different generation times; a single
// `model`/`generated_at` pair on the sound could record only one answer
// for the whole list. It is also what lets a recipe exist before any run
// has happened, which is the shape an example project ships in.
const RETIRED_TO_VARIANT =
  'provenance describes a run and lives on each take now — copy this value ' +
  'onto every entry under `variants:` and delete it here ' +
  '(bloom-in-tree.md §3)';
const RETIRED_SEED =
  'each entry under `variants:` already records the seed it ran with, so ' +
  'this one has no home — delete it (bloom-in-tree.md §3)';

export const generativeVariantSchema = z.strictObject({
  file: z.string().min(1), // song-relative, under audio/<name>/
  model: z.string().min(1), // which generator produced this take
  seed: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256'),
  generated_at: z.iso.datetime(),
});
export type GenerativeVariant = z.infer<typeof generativeVariantSchema>;

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
export const generativeSoundSchema = z
  .strictObject({
    name: labelName,
    type: z.literal('generative'),
    // Retired from the sound, declared only so a recipe written before the
    // move is told where the value went — `strictObject` would otherwise
    // answer "Unrecognized keys", which is true and tells nobody anything.
    // The precedent is `RETIRED_FADER` (schema/track.ts), and the reason
    // is the same: a removal that does not forward makes the reader guess.
    //
    // The migration is mechanical and loses nothing. A recipe's `model`
    // and `generated_at` describe the one run that produced every variant
    // it lists, which is exactly what `field generate` still writes — one
    // model and one timestamp shared by that run's takes. Copying each
    // down onto every variant preserves what was recorded rather than
    // inventing per-take values. `seed` needs no home: each variant has
    // carried its own since before this change.
    // Written for the suffix — the loader appends " at <field>".
    model: z.never({ error: RETIRED_TO_VARIANT }).optional(),
    seed: z.never({ error: RETIRED_SEED }).optional(),
    generated_at: z.never({ error: RETIRED_TO_VARIANT }).optional(),
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
    chosen: z.number().int().min(1).optional(), // 1-based variant number
    // Defaulted rather than merely allowed to be empty: omitting the key
    // and writing `variants: []` are otherwise different failures, and a
    // hand-written recipe does the former. A takeless recipe is a request
    // for audio rather than a record of it (bloom-in-tree.md §3).
    variants: z.array(generativeVariantSchema).default([]),
  })
  // The kind split, enforced rather than documented. Without it a recipe
  // can be a chimera of both kinds or neither, and the generator would
  // have to guess which one it was looking at — the same failure the
  // clip asset-vs-target precedent rules out.
  .superRefine((sound, ctx) => {
    const isMusic = sound.prompt !== undefined;
    const isVoice = sound.text !== undefined;
    if (isMusic === isVoice) {
      ctx.addIssue({
        code: 'custom',
        path: [isMusic ? 'text' : 'prompt'],
        message: isMusic
          ? 'a recipe carries either `prompt` (music) or `text` (voice), not both'
          : 'a generative sound needs `prompt` (music) or `text` (voice)',
      });
      return;
    }
    const musicOnly = ['lyrics', 'bpm', 'bars', 'duration_seconds'] as const;
    const voiceOnly = ['voice_ref', 'voice_ref_sha256', 'exaggeration', 'conviction'] as const;
    for (const key of isVoice ? musicOnly : voiceOnly) {
      if (sound[key] !== undefined) {
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
    if (isMusic && sound.bars === undefined && sound.duration_seconds === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['duration_seconds'],
        message: 'a music recipe needs a length — `bars` or `duration_seconds`',
      });
    }
    // The reference recording is the voice, so its identity is part of
    // the recipe's provenance (§1.3): name alone would let the bytes
    // change under a recipe that still claims to describe them.
    if (isVoice && (sound.voice_ref === undefined) !== (sound.voice_ref_sha256 === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['voice_ref'],
        message: '`voice_ref` and `voice_ref_sha256` go together — the recording and its hash',
      });
    }
  });
export type GenerativeSound = z.infer<typeof generativeSoundSchema>;

export const soundSchema = z.discriminatedUnion('type', [
  normalizeSoundSchema,
  supercolliderSoundSchema,
  generativeSoundSchema,
  eqSoundSchema,
  limitSoundSchema,
  reverbSoundSchema,
]);
export type Sound = z.infer<typeof soundSchema>;

// The types the graph may generate automatically — the ones with a
// Generator (src/generators/). `generative` is deliberately excluded: its
// generation is human-triggered, which is the §1.2 trigger policy
// expressed in the type system, so dispatching code narrows to this
// first.
export type BuildableSound = Exclude<Sound, GenerativeSound>;

export const soundOrder: KeyOrder = {
  keys: [
    'name',
    'type',
    'source',
    'prompt',
    'text',
    'voice_ref',
    'voice_ref_sha256',
    'exaggeration',
    'conviction',
    'lyrics',
    'bpm',
    'seed',
    'duration',
    'duration_seconds',
    'bars',
    'channels',
    'sample_rate',
    'bit_depth',
    'bands',
    'normalize',
    'ceiling_db',
    'lookahead_ms',
    'release_ms',
    'mix',
    'decay',
    'predelay_ms',
    'damping',
    'chosen',
    'variants',
  ],
  children: {
    bands: { items: { keys: ['type', 'frequency', 'gain_db', 'bandwidth'] } },
    variants: { items: { keys: ['file', 'model', 'seed', 'sha256', 'generated_at'] } },
  },
};
