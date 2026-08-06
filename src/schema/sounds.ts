import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName, sampleRate, sourceRef } from './common.js';
import { eqParams, limitParams, reverbParams } from './effects.js';

// songs/<song>/sounds/<name>.yaml — one defined sound per file, name
// matching the filename like tracks and takes (project-core.md §3.4 as
// amended by project-layout.md §1.3 and §4: the directory is the
// package, so the label //songs/<song>/sounds:<name> reads as directory
// + filename). Audio is committed bytes; a sound is a definition — and a
// sound wrapped in an effect is a different sound, so the algebra
// closes. Fields are flat and strict, discriminated by `type:` (§4.2,
// the format's discriminator convention). `source:` (§4.3) names what a
// sound is made from: a bare slug resolves in the song's one namespace
// (assets and sounds together), a //shared/assets:<name> label crosses
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
// rendered offline (NRT). The program runs via sclang with BLOOM_OUTPUT /
// BLOOM_SEED / BLOOM_DURATION / BLOOM_SAMPLE_RATE / BLOOM_CHANNELS in
// the environment; it must write BLOOM_OUTPUT and exit. Determinism
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

// say: macOS text-to-speech — the deterministic, keyless side of the
// voice boundary (voice *generation* is a deliberate `generate` sound
// with committed outputs; this is a recipe like supercollider). text/
// voice/rate are the whole action key; output is cached, never
// committed. `voice` is required because the system default voice is a
// per-user setting — a recipe that renders differently on two Macs under
// the same key would lie. The one recorded exception: `voice: Siri`
// selects the machine's Spoken Content voice — the system-selected Siri
// voices are not nameable via say -v (only a few Siri-branded regional
// voices ever list), so the system default is the only way to reach
// them; the caveat that the bytes follow a Settings toggle is accepted
// deliberately (generators/say.ts).
export const saySoundSchema = z.strictObject({
  name: labelName,
  type: z.literal('say'),
  text: z.string().min(1),
  voice: z.string().min(1),
  rate: z.number().int().min(60).max(720).optional(), // words per minute
});
export type SaySound = z.infer<typeof saySoundSchema>;

// generate: deliberate generation (project-layout.md §1.2, §1.4) — a
// sound with no in-graph Generator behind it: nothing may generate it
// mechanically; you run it, with bloom generate. Model inference does not reproduce across GPU/framework
// versions, so the outputs are committed (variants under audio/<name>/,
// content-addressed like assets) and the file is provenance plus
// promotion state: `bloom generate` writes it, `bloom choose` records
// `chosen`, and the sound's own label resolves to the chosen variant —
// clips reference the sound by name, no ledger copy involved. Each
// variant is additionally auditionable as
// //songs/<song>/sounds:<name>-<n>. The `model` field says which
// generator ran.
export const generateVariantSchema = z.strictObject({
  file: z.string().min(1), // song-relative, under audio/<name>/
  seed: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256'),
});
export type GenerateVariant = z.infer<typeof generateVariantSchema>;

export const generateSoundSchema = z.strictObject({
  name: labelName,
  type: z.literal('generate'),
  model: z.string().min(1),
  prompt: z.string().min(1),
  lyrics: z.string().optional(),
  bpm: z.number().int().min(30).max(300).optional(),
  duration_seconds: z.number().positive(),
  bars: z.number().int().positive().optional(),
  seed: z.number().int().min(0),
  chosen: z.number().int().min(1).optional(), // 1-based variant number
  variants: z.array(generateVariantSchema).min(1),
  generated_at: z.iso.datetime(),
});
export type GenerateSound = z.infer<typeof generateSoundSchema>;

export const soundSchema = z.discriminatedUnion('type', [
  normalizeSoundSchema,
  supercolliderSoundSchema,
  saySoundSchema,
  generateSoundSchema,
  eqSoundSchema,
  limitSoundSchema,
  reverbSoundSchema,
]);
export type Sound = z.infer<typeof soundSchema>;

// The types the graph may generate automatically — the ones with a
// Generator (src/generators/). `generate` is deliberately excluded: its
// generation is human-triggered, which is the §1.2 trigger policy
// expressed in the type system, so dispatching code narrows to this
// first.
export type BuildableSound = Exclude<Sound, GenerateSound>;

export const soundOrder: KeyOrder = {
  keys: [
    'name',
    'type',
    'source',
    'model',
    'prompt',
    'lyrics',
    'bpm',
    'seed',
    'duration',
    'duration_seconds',
    'bars',
    'channels',
    'text',
    'voice',
    'rate',
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
    'generated_at',
  ],
  children: {
    bands: { items: { keys: ['type', 'frequency', 'gain_db', 'bandwidth'] } },
    variants: { items: { keys: ['file', 'seed', 'sha256'] } },
  },
};
