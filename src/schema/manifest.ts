import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { sampleRate, slug } from './common.js';

// field.yaml — the project manifest.
export const projectSchema = z.strictObject({
  field: z.literal(1), // format version
  name: slug,
  sample_rate: sampleRate,
});
export type Project = z.infer<typeof projectSchema>;
export const projectOrder: KeyOrder = { keys: ['field', 'name', 'sample_rate'] };
