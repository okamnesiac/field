import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { sampleRate, slug, ticks, timeSpan } from './common.js';

// Tempo and meter events, shared by the song's `time:` and a track's
// (nested-tracks.md §1.5 — a local map reads like the song map it
// overrides rather than like a different kind of thing).
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

// The song's `time:` — the root of the inheritance every track's
// optional `time:` falls back to, so both halves are required here:
// there is nothing further to inherit from.
export const songTimeSchema = z.strictObject({
  tempo: z.array(tempoEventSchema).min(1),
  meter: z.array(meterEventSchema).min(1),
});
export type SongTime = z.infer<typeof songTimeSchema>;

// One KeyOrder for a `time:` block wherever it appears — song.yaml and
// track files emit the same shape in the same order.
export const timeOrder: KeyOrder = {
  keys: ['tempo', 'meter'],
  children: {
    tempo: { items: { keys: ['at', 'bpm', 'ramp'] } },
    meter: { items: { keys: ['at', 'numerator', 'denominator'] } },
  },
};

// songs/<song>/song.yaml
export const songSchema = z.strictObject({
  name: slug,
  title: z.string().optional(),
  // The song's default rate: every track without its own `rate:`
  // renders at this, and the song's output (`main`) always does —
  // hierarchy track.rate ?? song.rate ?? project sample_rate
  // (multi-rate.md decision 3, amended 2026-08-10).
  rate: sampleRate.optional(),
  // The song's tempo and meter maps — a fact about the song, in the
  // song's file.
  time: songTimeSchema.optional(),
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
  keys: ['name', 'title', 'rate', 'time', 'length', 'loop'],
  children: { time: timeOrder, length: { flow: true } },
};

