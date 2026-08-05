import { z } from 'zod';
import { SLUG_PATTERN } from '../ids.js';
import type { KeyOrder } from '../yaml/emit.js';

// Zod schemas are the single source of truth for the canonical project
// format (project-core.md §1); JSON Schema is generated from them to keep
// the format language-neutral (§5). Each schema ships with the KeyOrder
// used for deterministic emission (§3.6).

export const slug = z.string().regex(SLUG_PATTERN, 'must be a lowercase-slug');

const ticks = z.number().int().min(0);
const samples = z.number().int().min(0);

// bloom.yaml — the project manifest.
export const projectSchema = z.strictObject({
  bloom: z.literal(1), // format version
  name: slug,
  sample_rate: z.union([
    z.literal(44100),
    z.literal(48000),
    z.literal(88200),
    z.literal(96000),
    z.literal(176400),
    z.literal(192000),
  ]),
});
export type Project = z.infer<typeof projectSchema>;
export const projectOrder: KeyOrder = { keys: ['bloom', 'name', 'sample_rate'] };

// songs/<song>/song.yaml
export const songSchema = z.strictObject({
  name: slug,
  title: z.string().optional(),
});
export type Song = z.infer<typeof songSchema>;
export const songOrder: KeyOrder = { keys: ['name', 'title'] };

// songs/<song>/tempo.yaml — tempo and meter maps.
export const tempoEventSchema = z.strictObject({
  at: ticks,
  bpm: z.number().positive().max(1000),
  ramp: z.literal('linear').optional(),
});

export const meterEventSchema = z.strictObject({
  at: ticks,
  numerator: z.number().int().min(1).max(64),
  denominator: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(4),
    z.literal(8),
    z.literal(16),
    z.literal(32),
  ]),
});

export const tempoFileSchema = z.strictObject({
  tempo: z.array(tempoEventSchema).min(1),
  meter: z.array(meterEventSchema).min(1),
});
export type TempoFile = z.infer<typeof tempoFileSchema>;
export const tempoFileOrder: KeyOrder = {
  keys: ['tempo', 'meter'],
  children: {
    tempo: { items: { keys: ['at', 'bpm', 'ramp'] } },
    meter: { items: { keys: ['at', 'numerator', 'denominator'] } },
  },
};

// songs/<song>/arrangement.yaml — named sections on the timeline.
export const sectionSchema = z.strictObject({
  name: slug,
  at: ticks,
});

export const arrangementSchema = z.strictObject({
  sections: z.array(sectionSchema),
});
export type Arrangement = z.infer<typeof arrangementSchema>;
export const arrangementOrder: KeyOrder = {
  keys: ['sections'],
  children: { sections: { items: { keys: ['name', 'at'] } } },
};

// A clip is a window (position, duration, in anchor units) on content
// (asset, source_offset, slip, in samples). Effective read offset =
// source_offset − slip (project-core.md §3.2).
export const clipSchema = z.strictObject({
  id: slug,
  asset: z.string().min(1), // path relative to the song directory (content hashes arrive with the asset store)
  anchor: z.enum(['musical', 'absolute']).default('musical'),
  position: z.number().int().min(0), // ticks when musical, samples when absolute
  duration: z.number().int().positive(), // same units as position
  source_offset: samples.default(0),
  slip: z.number().int().default(0),
  gain_db: z.number().default(0),
  fade_in: samples.default(0),
  fade_out: samples.default(0),
});
export type Clip = z.infer<typeof clipSchema>;
export const clipOrder: KeyOrder = {
  keys: [
    'id',
    'asset',
    'anchor',
    'position',
    'duration',
    'source_offset',
    'slip',
    'gain_db',
    'fade_in',
    'fade_out',
  ],
};

// songs/<song>/tracks/<name>.yaml — name must match the filename; the slug
// is the identity (project-core.md §6).
export const trackSchema = z.strictObject({
  name: slug,
  type: z.enum(['audio', 'midi']),
  clips: z.array(clipSchema).default([]),
});
export type Track = z.infer<typeof trackSchema>;
export const trackOrder: KeyOrder = {
  keys: ['name', 'type', 'clips'],
  children: { clips: { items: clipOrder } },
};

// songs/<song>/takes/<track>/<take-id>.yaml — one performance, referencing
// an immutable asset. Takes store both time representations but declare the
// anchor; the derived one is verified by `bloom check` (project-core.md §3.1).
export const takeSchema = z.strictObject({
  id: z.string().regex(/^take-\d{8}-\d{6}$/, 'take ids are take-YYYYMMDD-HHMMSS'),
  track: slug,
  asset: z.string().min(1),
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
