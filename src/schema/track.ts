import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { assetRef, labelName, samples, slug, timePosition, timeSpan } from './common.js';
import { insertOrder, insertSchema } from './effects.js';

// A clip is a window (position, duration, in anchor units) on content
// (source, source_offset, slip, in samples). Effective read offset =
// source_offset − slip (project-core.md §3.2). The content is exactly one
// of: a committed asset (assets.yaml) or a same-song rule target
// (targets.yaml) — clipping a target means the arrangement plays a render
// that is never committed, only its recipe (mix-assembly.md §5).
// Looping (clip-looping.md §1): the window is authoritative and the source
// tiles to fill it — extending a loop is extending `duration`. `every` is
// the repetition interval in anchor units (grid-locked through tempo
// ramps); omitted, repeats tile at the source's sample length. `mode` says
// what happens when a repeat outlives its slot: cut, or ring over its
// successors (summed like any overlapping clips). `fade` guards each seam.
export const clipLoopSchema = z.strictObject({
  enabled: z.boolean().default(true), // switch a loop off without deleting it
  every: timeSpan.optional(), // anchor units, or a musical span on musical clips
  mode: z.enum(['truncate', 'overlay']).default('truncate'),
  fade: samples.default(480), // ≈10 ms at 48 k; the naive loop must not click
});
// File types (z.infer) admit musical arrays; the exported types are the
// post-load shape — loadProject resolves every array to a tick scalar
// before anything else sees the data (musical-time.md §1.6).
type ClipLoopFile = z.infer<typeof clipLoopSchema>;
export type ClipLoop = Omit<ClipLoopFile, 'every'> & { every?: number | undefined };

export const clipSchema = z
  .strictObject({
    id: slug,
    // A name from the song's assets.yaml, or //shared/assets:<name> from
    // the shared ledger — the one cross-scope spelling (project-layout.md
    // §1.5).
    asset: assetRef.optional(),
    target: slug.optional(), // a target name declared in the song's targets/
    anchor: z.enum(['musical', 'absolute']).default('musical'),
    position: timePosition, // ticks when musical, samples when absolute
    duration: timeSpan, // same units as position
    loop: clipLoopSchema.optional(),
    source_offset: samples.default(0),
    slip: z.number().int().default(0),
    gain_db: z.number().default(0),
    fade_in: samples.default(0),
    fade_out: samples.default(0),
  })
  .refine((c) => (c.asset === undefined) !== (c.target === undefined), {
    message: 'a clip sources exactly one of asset or target',
  });
type ClipFile = z.infer<typeof clipSchema>;
export type Clip = Omit<ClipFile, 'position' | 'duration' | 'loop'> & {
  position: number;
  duration: number;
  loop?: ClipLoop | undefined;
};
export const clipOrder: KeyOrder = {
  keys: [
    'id',
    'asset',
    'target',
    'anchor',
    'position',
    'duration',
    'loop',
    'source_offset',
    'slip',
    'gain_db',
    'fade_in',
    'fade_out',
  ],
  children: {
    position: { flow: true },
    duration: { flow: true },
    loop: { keys: ['enabled', 'every', 'mode', 'fade'], children: { every: { flow: true } } },
  },
};

// songs/<song>/tracks/<name>.yaml — name must match the filename; the slug
// is the identity (project-core.md §6). gain_db and pan are mix-stage
// parameters: stems render pre-fader, the mix rule applies them while
// summing (mix-assembly.md §3), so a fader nudge never rebuilds a stem.
export const trackSchema = z.strictObject({
  name: labelName,
  type: z.enum(['audio', 'midi']),
  gain_db: z.number().default(0),
  pan: z.number().min(-1).max(1).default(0), // constant-power balance, -1 left … 1 right
  // Inserts are content, not mix parameters: they bake into the stem, so
  // an insert edit re-renders it — the accepted cost model (effects.md §5).
  inserts: z.array(insertSchema).default([]),
  clips: z.array(clipSchema).default([]),
});
type TrackFile = z.infer<typeof trackSchema>;
export type Track = Omit<TrackFile, 'clips'> & { clips: Clip[] };
export const trackOrder: KeyOrder = {
  keys: ['name', 'type', 'gain_db', 'pan', 'inserts', 'clips'],
  children: { inserts: { items: insertOrder }, clips: { items: clipOrder } },
};
