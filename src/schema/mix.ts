import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName, slug } from './common.js';
import { insertOrder, insertSchema } from './effects.js';

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
