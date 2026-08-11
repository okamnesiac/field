import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { samples, slug, ticks } from './common.js';

// songs/<song>/takes/<track>/<take-id>.yaml — one performance, referencing
// an immutable asset. Takes store both time representations but declare the
// anchor; the derived one is verified by `field check` (project-core.md §3.1).
//
// This path is the retired layout (project-model.md "Takes", decided
// 2026-08-10): a recorded take's record will live beside its bytes under
// audio/, like variants, so committing the audio commits its record in one
// decision. Nothing writes takes/ today; this schema and its loader stand
// until the recording work replaces them with that shape.
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
