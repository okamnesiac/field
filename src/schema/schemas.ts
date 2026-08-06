import { z } from 'zod';
import { SLUG_PATTERN } from '../ids.js';
import { RESERVED_TARGET_NAME } from '../labels.js';
import type { KeyOrder } from '../yaml/emit.js';

// Zod schemas are the single source of truth for the canonical project
// format (project-core.md §1); JSON Schema is generated from them to keep
// the format language-neutral (§5). Each schema ships with the KeyOrder
// used for deterministic emission (§3.6).

export const slug = z.string().regex(SLUG_PATTERN, 'must be a lowercase-slug');

// For anything addressable as //pkg:name — assets, targets, tracks — the
// grammar's reserved word is not a legal name.
export const labelName = slug.refine((n) => n !== RESERVED_TARGET_NAME, {
  message: `"${RESERVED_TARGET_NAME}" is reserved by the label grammar`,
});

const ticks = z.number().int().min(0);
const samples = z.number().int().min(0);

export const sampleRate = z.union([
  z.literal(44100),
  z.literal(48000),
  z.literal(88200),
  z.literal(96000),
  z.literal(176400),
  z.literal(192000),
]);

// bloom.yaml — the project manifest.
export const projectSchema = z.strictObject({
  bloom: z.literal(1), // format version
  name: slug,
  sample_rate: sampleRate,
});
export type Project = z.infer<typeof projectSchema>;
export const projectOrder: KeyOrder = { keys: ['bloom', 'name', 'sample_rate'] };

// songs/<song>/song.yaml
export const songSchema = z.strictObject({
  name: slug,
  title: z.string().optional(),
  // Declared song length in ticks: the mix renders exactly this long —
  // tails truncate, short content pads — so a song's extent is authored,
  // not emergent from whichever stem happens to ring longest. What makes
  // a whole song loopable.
  length: z.number().int().positive().optional(),
});
export type Song = z.infer<typeof songSchema>;
export const songOrder: KeyOrder = { keys: ['name', 'title', 'length'] };

// songs/<song>/tempo.yaml — tempo and meter maps.
export const tempoEventSchema = z.strictObject({
  at: ticks,
  bpm: z.number().positive().max(1000),
  ramp: z.literal('linear').optional(),
});

export const meterEventSchema = z.strictObject({
  at: ticks,
  numerator: z.number().int().min(1).max(64),
  denominator: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(4),
    z.literal(8),
    z.literal(16),
    z.literal(32),
  ]),
});

export const tempoFileSchema = z.strictObject({
  tempo: z.array(tempoEventSchema).min(1),
  meter: z.array(meterEventSchema).min(1),
});
export type TempoFile = z.infer<typeof tempoFileSchema>;
export const tempoFileOrder: KeyOrder = {
  keys: ['tempo', 'meter'],
  children: {
    tempo: { items: { keys: ['at', 'bpm', 'ramp'] } },
    meter: { items: { keys: ['at', 'numerator', 'denominator'] } },
  },
};

// songs/<song>/arrangement.yaml — named sections on the timeline.
export const sectionSchema = z.strictObject({
  name: slug,
  at: ticks,
});

export const arrangementSchema = z.strictObject({
  sections: z.array(sectionSchema),
});
export type Arrangement = z.infer<typeof arrangementSchema>;
export const arrangementOrder: KeyOrder = {
  keys: ['sections'],
  children: { sections: { items: { keys: ['name', 'at'] } } },
};

// songs/<song>/assets.yaml — binds a readable asset name to its file and
// content hash. Clips and takes reference assets by name (readable diffs,
// project-core.md §6); the sha256 is the content identity and equals the
// Git LFS OID (§3.5).
export const assetSchema = z.strictObject({
  name: labelName,
  file: z.string().min(1), // path relative to the song directory
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256'),
  bytes: z.number().int().min(0),
});
export type Asset = z.infer<typeof assetSchema>;

export const assetsFileSchema = z.strictObject({
  assets: z.array(assetSchema).default([]),
});
export type AssetsFile = z.infer<typeof assetsFileSchema>;
export const assetsFileOrder: KeyOrder = {
  keys: ['assets'],
  children: { assets: { items: { keys: ['name', 'file', 'sha256', 'bytes'] } } },
};

// songs/<song>/targets.yaml — declared build targets (project-core.md §3.4:
// the project model is the build file; these entries become
// //songs/<song>/targets:<name>). Rule-specific fields are flat and
// strict, discriminated by `rule`.
// Single-input rules source exactly one of `asset` (assets.yaml) or
// `target` (targets.yaml, same song) — the clip pattern. Enforced by each
// rule's validate() rather than a schema refine, because refined objects
// cannot join a discriminated union.
const singleInput = {
  asset: slug.optional(),
  target: slug.optional(),
};

export const normalizeTargetSchema = z.strictObject({
  name: labelName,
  rule: z.literal('normalize'),
  ...singleInput,
  sample_rate: sampleRate,
  bit_depth: z.union([z.literal(16), z.literal(24), z.literal(32)]),
});
export type NormalizeTarget = z.infer<typeof normalizeTargetSchema>;

// eq: RBJ biquads with Fyra's parameterization — bandwidth in octaves —
// and Fyra's response-based auto-gain on by default (effects.md §2):
// EQ moves change tone, not level.
export const eqBandSchema = z.strictObject({
  type: z.enum(['highpass', 'lowshelf', 'bell', 'highshelf', 'lowpass']),
  frequency: z.number().min(10).max(24000),
  gain_db: z.number().min(-24).max(24).default(0), // bell and shelves only
  bandwidth: z.number().min(0.1).max(16).default(2), // octaves
});
export type EqBand = z.infer<typeof eqBandSchema>;

// Effect parameters are defined once and appear in three positions:
// standalone targets, track inserts, and the mix master chain
// (effects.md §5) — same fields, same semantics, everywhere.
const eqParams = {
  bands: z.array(eqBandSchema).min(1).max(8),
  normalize: z.boolean().default(true),
};

// limit: offline lookahead peak limiter (effects.md §2).
const limitParams = {
  ceiling_db: z.number().min(-24).max(0).default(-1),
  lookahead_ms: z.number().min(0.1).max(50).default(5),
  release_ms: z.number().min(1).max(2000).default(100),
};

// reverb: Freeverb, deterministic; decay is T60 in seconds and the output
// grows by the tail (effects.md §2).
const reverbParams = {
  mix: z.number().min(0).max(1).default(0.3),
  decay: z.number().min(0.05).max(30).default(2), // seconds to −60 dB
  predelay_ms: z.number().min(0).max(500).default(0),
  damping: z.number().min(0).max(1).default(0.5),
};

export const eqTargetSchema = z.strictObject({
  name: labelName,
  rule: z.literal('eq'),
  ...singleInput,
  ...eqParams,
});
export type EqTarget = z.infer<typeof eqTargetSchema>;

export const limitTargetSchema = z.strictObject({
  name: labelName,
  rule: z.literal('limit'),
  ...singleInput,
  ...limitParams,
});
export type LimitTarget = z.infer<typeof limitTargetSchema>;

export const reverbTargetSchema = z.strictObject({
  name: labelName,
  rule: z.literal('reverb'),
  ...singleInput,
  ...reverbParams,
});
export type ReverbTarget = z.infer<typeof reverbTargetSchema>;

// Insert entries — discriminated on `effect:` so the AU-hosting era can
// add an `au:` variant additively instead of reshaping track files (the
// obligation recorded in effects.md §1).
export const insertSchema = z.discriminatedUnion('effect', [
  z.strictObject({ effect: z.literal('eq'), ...eqParams }),
  z.strictObject({ effect: z.literal('limit'), ...limitParams }),
  z.strictObject({ effect: z.literal('reverb'), ...reverbParams }),
]);
export type Insert = z.infer<typeof insertSchema>;

export const insertOrder: KeyOrder = {
  keys: [
    'effect',
    'bands',
    'normalize',
    'ceiling_db',
    'lookahead_ms',
    'release_ms',
    'mix',
    'decay',
    'predelay_ms',
    'damping',
  ],
  children: { bands: { items: { keys: ['type', 'frequency', 'gain_db', 'bandwidth'] } } },
};

// sc-render: a SuperCollider program renders an asset offline (NRT). The
// program is run via sclang with BLOOM_OUTPUT / BLOOM_SEED / BLOOM_DURATION /
// BLOOM_SAMPLE_RATE / BLOOM_CHANNELS in the environment; it must write
// BLOOM_OUTPUT and exit. Determinism given the seed is the program's job;
// the program's content hash is the cache input.
export const scRenderTargetSchema = z.strictObject({
  name: labelName,
  rule: z.literal('sc-render'),
  program: z.string().min(1), // project-relative path to the .scd
  seed: z.number().int().min(0),
  duration: z.number().positive().max(3600), // seconds
  channels: z.union([z.literal(1), z.literal(2)]).default(2),
});
export type ScRenderTarget = z.infer<typeof scRenderTargetSchema>;

export const targetSchema = z.discriminatedUnion('rule', [
  normalizeTargetSchema,
  scRenderTargetSchema,
  eqTargetSchema,
  limitTargetSchema,
  reverbTargetSchema,
]);
export type Target = z.infer<typeof targetSchema>;

export const targetsFileSchema = z.strictObject({
  targets: z.array(targetSchema).default([]),
});
export type TargetsFile = z.infer<typeof targetsFileSchema>;
export const targetsFileOrder: KeyOrder = {
  keys: ['targets'],
  children: {
    targets: {
      items: {
        keys: [
          'name',
          'rule',
          'asset',
          'target',
          'program',
          'seed',
          'duration',
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
        ],
        children: {
          bands: { items: { keys: ['type', 'frequency', 'gain_db', 'bandwidth'] } },
        },
      },
    },
  },
};

// songs/<song>/mix.yaml — declared mixes, addressed as
// //songs/<song>/mix:<name> (mix-assembly.md §3). A mix sums track stems
// with each track's gain_db/pan (constant-power balance) and a master
// gain. `tracks` omitted means every audio track with clips.
export const mixTargetSchema = z.strictObject({
  name: labelName,
  rule: z.literal('mix').default('mix'),
  tracks: z.array(slug).optional(),
  gain_db: z.number().default(0), // master gain, applied before the master chain
  // Applied after the sum and the master gain, so a final limiter's
  // ceiling guards the true output (effects.md §5).
  master: z.array(insertSchema).default([]),
});
export type MixTarget = z.infer<typeof mixTargetSchema>;

export const mixFileSchema = z.strictObject({
  mixes: z.array(mixTargetSchema).default([]),
});
export type MixFile = z.infer<typeof mixFileSchema>;
export const mixFileOrder: KeyOrder = {
  keys: ['mixes'],
  children: {
    mixes: {
      items: {
        keys: ['name', 'rule', 'tracks', 'gain_db', 'master'],
        children: { master: { items: insertOrder } },
      },
    },
  },
};

// A clip is a window (position, duration, in anchor units) on content
// (source, source_offset, slip, in samples). Effective read offset =
// source_offset − slip (project-core.md §3.2). The content is exactly one
// of: a committed asset (assets.yaml) or a same-song rule target
// (targets.yaml) — clipping a target means the arrangement plays a render
// that is never committed, only its recipe (mix-assembly.md §5).
// Looping (clip-looping.md §1): the window is authoritative and the source
// tiles to fill it — extending a loop is extending `duration`. `every` is
// the repetition interval in anchor units (grid-locked through tempo
// ramps); omitted, repeats tile at the source's sample length. `mode` says
// what happens when a repeat outlives its slot: cut, or ring over its
// successors (summed like any overlapping clips). `fade` guards each seam.
export const clipLoopSchema = z.strictObject({
  enabled: z.boolean().default(true), // switch a loop off without deleting it
  every: z.number().int().positive().optional(), // anchor units
  mode: z.enum(['truncate', 'overlay']).default('truncate'),
  fade: samples.default(480), // ≈10 ms at 48 k; the naive loop must not click
});
export type ClipLoop = z.infer<typeof clipLoopSchema>;

export const clipSchema = z
  .strictObject({
    id: slug,
    asset: slug.optional(), // an asset name declared in the song's assets.yaml
    target: slug.optional(), // a target name declared in the song's targets.yaml
    anchor: z.enum(['musical', 'absolute']).default('musical'),
    position: z.number().int().min(0), // ticks when musical, samples when absolute
    duration: z.number().int().positive(), // same units as position
    loop: clipLoopSchema.optional(),
    source_offset: samples.default(0),
    slip: z.number().int().default(0),
    gain_db: z.number().default(0),
    fade_in: samples.default(0),
    fade_out: samples.default(0),
  })
  .refine((c) => (c.asset === undefined) !== (c.target === undefined), {
    message: 'a clip sources exactly one of asset or target',
  });
export type Clip = z.infer<typeof clipSchema>;
export const clipOrder: KeyOrder = {
  keys: [
    'id',
    'asset',
    'target',
    'anchor',
    'position',
    'duration',
    'loop',
    'source_offset',
    'slip',
    'gain_db',
    'fade_in',
    'fade_out',
  ],
  children: { loop: { keys: ['enabled', 'every', 'mode', 'fade'] } },
};

// songs/<song>/tracks/<name>.yaml — name must match the filename; the slug
// is the identity (project-core.md §6). gain_db and pan are mix-stage
// parameters: stems render pre-fader, the mix rule applies them while
// summing (mix-assembly.md §3), so a fader nudge never rebuilds a stem.
export const trackSchema = z.strictObject({
  name: labelName,
  type: z.enum(['audio', 'midi']),
  gain_db: z.number().default(0),
  pan: z.number().min(-1).max(1).default(0), // constant-power balance, -1 left … 1 right
  // Inserts are content, not mix parameters: they bake into the stem, so
  // an insert edit re-renders it — the accepted cost model (effects.md §5).
  inserts: z.array(insertSchema).default([]),
  clips: z.array(clipSchema).default([]),
});
export type Track = z.infer<typeof trackSchema>;
export const trackOrder: KeyOrder = {
  keys: ['name', 'type', 'gain_db', 'pan', 'inserts', 'clips'],
  children: { inserts: { items: insertOrder }, clips: { items: clipOrder } },
};

// songs/<song>/takes/<track>/<take-id>.yaml — one performance, referencing
// an immutable asset. Takes store both time representations but declare the
// anchor; the derived one is verified by `bloom check` (project-core.md §3.1).
export const takeSchema = z.strictObject({
  id: z.string().regex(/^take-\d{8}-\d{6}$/, 'take ids are take-YYYYMMDD-HHMMSS'),
  track: slug,
  asset: slug, // references an asset name declared in the song's assets.yaml
  anchor: z.enum(['musical', 'absolute']).default('musical'),
  position: ticks, // ticks (authoritative when anchor is musical)
  position_samples: samples, // derived when anchor is musical, authoritative when absolute
  duration_samples: z.number().int().positive(),
  recording: z
    .strictObject({
      device: z.string().optional(),
      input: z.string().optional(),
      sample_rate: z.number().int().positive().optional(),
      buffer_size: z.number().int().positive().optional(),
      round_trip_latency_ms: z.number().min(0).optional(),
    })
    .optional(),
});
export type Take = z.infer<typeof takeSchema>;
export const takeOrder: KeyOrder = {
  keys: [
    'id',
    'track',
    'asset',
    'anchor',
    'position',
    'position_samples',
    'duration_samples',
    'recording',
  ],
  children: {
    recording: {
      keys: ['device', 'input', 'sample_rate', 'buffer_size', 'round_trip_latency_ms'],
    },
  },
};

// songs/<song>/generation/<name>.yaml — provenance for one generation run
// (ace-generation.md §3.1, project-model.md "Generation recipes"): outputs
// are committed, not cached, so the recipe is what makes them auditable
// and deliberately regenerable. Variant files live in generation/<name>/
// and are content-addressed like assets; `chosen` is written by
// `bloom ace choose` when a variant is promoted.
export const generationVariantSchema = z.strictObject({
  file: z.string().min(1), // path relative to the generation directory
  seed: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256'),
});
export type GenerationVariant = z.infer<typeof generationVariantSchema>;

export const generationRecipeSchema = z.strictObject({
  name: labelName,
  model: z.string().min(1),
  prompt: z.string().min(1),
  lyrics: z.string().optional(),
  bpm: z.number().int().min(30).max(300).optional(),
  duration_seconds: z.number().positive(),
  bars: z.number().int().positive().optional(),
  seed: z.number().int().min(0),
  chosen: z.number().int().min(1).optional(), // 1-based variant number
  variants: z.array(generationVariantSchema).min(1),
  generated_at: z.iso.datetime(),
});
export type GenerationRecipe = z.infer<typeof generationRecipeSchema>;
export const generationRecipeOrder: KeyOrder = {
  keys: [
    'name',
    'model',
    'prompt',
    'lyrics',
    'bpm',
    'duration_seconds',
    'bars',
    'seed',
    'chosen',
    'variants',
    'generated_at',
  ],
  children: { variants: { items: { keys: ['file', 'seed', 'sha256'] } } },
};
