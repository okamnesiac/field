import { z } from 'zod';
import { SLUG_PATTERN } from '../ids.js';
import { RESERVED_TARGET_NAME } from '../labels.js';

// Shared building blocks for the per-file schemas (index.ts is the
// barrel). Zod schemas are the single source of truth for the canonical
// project format (project-core.md §1); JSON Schema is generated from them
// to keep the format language-neutral (§5).

export const slug = z.string().regex(SLUG_PATTERN, 'must be a lowercase-slug');

// For anything addressable as //pkg:name — assets, targets, tracks — the
// grammar's reserved word is not a legal name.
export const labelName = slug.refine((n) => n !== RESERVED_TARGET_NAME, {
  message: `"${RESERVED_TARGET_NAME}" is reserved by the label grammar`,
});

export const ticks = z.number().int().min(0);
export const samples = z.number().int().min(0);

// Musical time arrays (musical-time.md §1): scalar numbers are ticks
// (samples on absolute clips); arrays are musical. Positions are ordinal
// and 1-indexed — [9, 2] is bar 9, beat 2 — and spans are cardinal counts
// where zero is legal — [0, 2] is two beats. The schema validates shape
// only: legal beat and tick ranges depend on the meter map (tempo.yaml),
// so resolution and range diagnostics live in the model layer
// (model/project.ts), which rewrites arrays to tick scalars at load — the
// build graph never sees an array, and either spelling of a time produces
// the same action key.
const musicalPosition = z.array(z.number().int().min(1)).min(1).max(3);
const musicalSpan = z.array(z.number().int().min(0)).min(1).max(3);
export const timePosition = z.union([ticks, musicalPosition]);
export const timeSpan = z.union([z.number().int().positive(), musicalSpan]);

export const sampleRate = z.union([
  z.literal(44100),
  z.literal(48000),
  z.literal(88200),
  z.literal(96000),
  z.literal(176400),
  z.literal(192000),
]);
