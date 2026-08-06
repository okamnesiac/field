import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName, slug } from './common.js';
import { insertOrder, insertSchema } from './effects.js';

// songs/<song>/mixes/<name>.yaml — one declared mix per file, name
// matching the filename (project-layout.md §1.3), addressed as
// //songs/<song>/mix:<name> (mix-assembly.md §3 — the label package
// predates the directory and is unchanged). A mix sums track stems with
// each track's gain_db/pan (constant-power balance) and a master gain.
// `tracks` omitted means every audio track with clips.
export const mixSchema = z.strictObject({
  name: labelName,
  type: z.literal('mix').default('mix'),
  tracks: z.array(slug).optional(),
  gain_db: z.number().default(0), // master gain, applied before the master chain
  // Applied after the sum and the master gain, so a final limiter's
  // ceiling guards the true output (effects.md §5).
  master: z.array(insertSchema).default([]),
});
export type Mix = z.infer<typeof mixSchema>;

export const mixOrder: KeyOrder = {
  keys: ['name', 'type', 'tracks', 'gain_db', 'master'],
  children: { master: { items: insertOrder } },
};
