import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { sampleRate, slug } from './common.js';

// bloom.yaml — the project manifest.
export const projectSchema = z.strictObject({
  bloom: z.literal(1), // format version
  name: slug,
  sample_rate: sampleRate,
});
export type Project = z.infer<typeof projectSchema>;
export const projectOrder: KeyOrder = { keys: ['bloom', 'name', 'sample_rate'] };
