import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';

// Effect parameters for `inserts:` entries (effects.md §5) — on any
// track, the song's master chain included, since that is the output
// track's inserts.

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

export const eqParams = {
  bands: z.array(eqBandSchema).min(1).max(8),
  normalize: z.boolean().default(true),
};

// limit: offline lookahead peak limiter (effects.md §2).
export const limitParams = {
  ceiling_db: z.number().min(-24).max(0).default(-1),
  lookahead_ms: z.number().min(0.1).max(50).default(5),
  release_ms: z.number().min(1).max(2000).default(100),
};

// reverb: Freeverb, deterministic; decay is T60 in seconds and the output
// grows by the tail (effects.md §2).
export const reverbParams = {
  mix: z.number().min(0).max(1).default(0.3),
  decay: z.number().min(0.05).max(30).default(2), // seconds to −60 dB
  predelay_ms: z.number().min(0).max(500).default(0),
  damping: z.number().min(0).max(1).default(0.5),
};

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
