import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { sampleRate, slug } from './common.js';

// The license the project's own work is offered under (remote.md §3.5):
// an SPDX identifier, checked for shape and nothing else. A project may
// leave it out; whether a public project must carry one is the site's
// rule, which a project on disk cannot know.
export const SPDX_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
export const spdxIdentifier = z
  .string()
  .regex(SPDX_IDENTIFIER, 'must be an SPDX license identifier, such as CC-BY-4.0, CC0-1.0, or MIT');

// field.yaml — the project manifest.
export const projectSchema = z.strictObject({
  field: z.literal(1), // format version
  name: slug,
  license: spdxIdentifier.optional(),
  sample_rate: sampleRate,
});
export type Project = z.infer<typeof projectSchema>;
export const projectOrder: KeyOrder = { keys: ['field', 'name', 'license', 'sample_rate'] };
