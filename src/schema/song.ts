import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { slug, ticks, timePosition, timeSpan } from './common.js';

// songs/<song>/song.yaml
export const songSchema = z.strictObject({
  name: slug,
  title: z.string().optional(),
  // Declared song length — ticks, or a musical span from bar 1
  // ([12] = twelve bars): the song's output renders exactly this long —
  // tails truncate, short content pads — so a song's extent is authored,
  // not emergent from whichever stem happens to ring longest. The output
  // is the mix, or the track named `main` (labels.ts SONG_OUTPUT_NAME)
  // now that a track can be one; the extent belongs to the song either
  // way, which is why it lives here rather than on whatever renders it.
  length: timeSpan.optional(),
  // The song is a loop: everything past `length` folds back onto the
  // start (bar 12's reverb tail rings into bar 1), so the render is
  // exactly one loop of the infinite performance. A looping song's
  // length IS its loop length — no second field to disagree with.
  loop: z.boolean().optional(),
});
// File types (z.infer) admit musical arrays; the exported types are the
// post-load shape — loadProject resolves every array to a tick scalar
// before anything else sees the data (musical-time.md §1.6).
type SongFile = z.infer<typeof songSchema>;
export type Song = Omit<SongFile, 'length'> & { length?: number | undefined };
export const songOrder: KeyOrder = {
  keys: ['name', 'title', 'length', 'loop'],
  children: { length: { flow: true } },
};

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
  at: timePosition, // ticks, or [bar, beat?, tick?]
});

export const arrangementSchema = z.strictObject({
  sections: z.array(sectionSchema),
});
type SectionFile = z.infer<typeof sectionSchema>;
export type Section = Omit<SectionFile, 'at'> & { at: number };
type ArrangementFile = z.infer<typeof arrangementSchema>;
export type Arrangement = Omit<ArrangementFile, 'sections'> & { sections: Section[] };
export const arrangementOrder: KeyOrder = {
  keys: ['sections'],
  children: { sections: { items: { keys: ['name', 'at'], children: { at: { flow: true } } } } },
};
