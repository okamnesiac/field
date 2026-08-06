import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName, sampleRate, slug } from './common.js';
import { eqParams, limitParams, reverbParams } from './effects.js';

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

// say: macOS text-to-speech as a build rule — the deterministic, keyless
// side of the voice boundary (voice *generation* is an ACE-style workflow
// with committed outputs; this is a recipe like sc-render). text/voice/
// rate are the whole action key; output is cached, never committed.
// `voice` is required because the system default voice is a per-user
// setting — a recipe that renders differently on two Macs under the same
// key would lie. The one recorded exception: `voice: Siri` selects the
// machine's Spoken Content voice — the system-selected Siri voices are
// not nameable via say -v (only a few Siri-branded regional voices ever
// list), so the system default is the only way to reach them; the caveat
// that the bytes follow a Settings toggle is accepted deliberately
// (rules/say.ts).
export const sayTargetSchema = z.strictObject({
  name: labelName,
  rule: z.literal('say'),
  text: z.string().min(1),
  voice: z.string().min(1),
  rate: z.number().int().min(60).max(720).optional(), // words per minute
});
export type SayTarget = z.infer<typeof sayTargetSchema>;

export const targetSchema = z.discriminatedUnion('rule', [
  normalizeTargetSchema,
  scRenderTargetSchema,
  sayTargetSchema,
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
        ],
        children: {
          bands: { items: { keys: ['type', 'frequency', 'gain_db', 'bandwidth'] } },
        },
      },
    },
  },
};
