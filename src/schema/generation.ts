import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName } from './common.js';

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
