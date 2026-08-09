import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName, samples, slug, sourceRef, timePosition, timeSpan } from './common.js';
import { insertOrder, insertSchema } from './effects.js';

// A clip is a window (position, duration, in anchor units) on content
// (source, source_offset, slip, in samples). Effective read offset =
// source_offset − slip (project-core.md §3.2). `source:` names the
// content (project-layout.md §4.3): an asset or a sound in the song's
// one namespace, or a shared pin — clipping a buildable sound means the
// arrangement plays a render that is never committed, only its
// definition (mix-assembly.md §5), and clipping a generate sound plays
// its chosen committed variant.
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

export const clipSchema = z.strictObject({
  id: slug,
  source: sourceRef, // what the clip plays (§4.3): asset, sound, or shared pin
  anchor: z.enum(['musical', 'absolute']).default('musical'),
  position: timePosition, // ticks when musical, samples when absolute
  duration: timeSpan, // same units as position
  loop: clipLoopSchema.optional(),
  source_offset: samples.default(0),
  slip: z.number().int().default(0),
  gain_db: z.number().default(0),
  fade_in: samples.default(0),
  fade_out: samples.default(0),
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
    'source',
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

// A child track placed in this one (nested-tracks.md §1.3). The time
// lives on the *reference*, not on the track, so one definition can be
// placed more than once and in more than one parent — which is the whole
// reason to nest.
//
// This is a clip in every respect except what it plays: a clip places a
// sound or asset, this places a track, and both resolve to a rendered
// source dropped on the parent's timeline at an offset (§1.11, "a clip is
// a placement, and a placement is a stem at a time"). The two lists merge
// once sounds fold into tracks; until then they sit side by side rather
// than pretending to be one thing prematurely.
export const trackInputSchema = z.strictObject({
  track: slug, // a track in this song
  anchor: z.enum(['musical', 'absolute']).default('musical'),
  at: timePosition, // ticks when musical, samples when absolute
  // Omitted means the child's whole render. Declared means a window on
  // it — which is the placement truncating explicitly, never the parent
  // truncating implicitly (§1.6).
  duration: timeSpan.optional(),
  // The placement's level, not the child's fader, and the two are applied
  // in different places: this one is baked into the parent's stem while it
  // sums, so nudging it *does* re-render the parent. The child's own
  // gain_db is the mix-stage parameter that does not (see trackSchema).
  gain_db: z.number().default(0),
  // Pan is the same gain stage as gain_db and lives in the same place —
  // on the edge, where it can differ per placement (nested-tracks.md
  // §1.13). A track's own `pan` is the one that retires.
  pan: z.number().min(-1).max(1).default(0),
  fade_in: samples.default(0),
  fade_out: samples.default(0),
});
type TrackInputFile = z.infer<typeof trackInputSchema>;
export type TrackInput = Omit<TrackInputFile, 'at' | 'duration'> & {
  at: number;
  duration?: number | undefined;
};

// songs/<song>/tracks/<name>.yaml — name must match the filename; the slug
// is the identity (project-core.md §6).
//
// No `gain_db` or `pan` here. A level lives on the placement that consumes
// this track (nested-tracks.md §1.13), where it can differ per parent —
// which a field on the track cannot do, and which is why these retired
// with the mix rule that used to apply them. Leaving them as fields
// nothing reads would be worse than removing them: a `-24` sitting in a
// track file, passing check, changing nothing.
export const trackSchema = z.strictObject({
  name: labelName,
  type: z.enum(['audio', 'midi']),
  // Inserts are content, not mix parameters: they bake into the stem, so
  // an insert edit re-renders it — the accepted cost model (effects.md §5).
  inserts: z.array(insertSchema).default([]),
  clips: z.array(clipSchema).default([]),
  inputs: z.array(trackInputSchema).default([]),
});
type TrackFile = z.infer<typeof trackSchema>;
export type Track = Omit<TrackFile, 'clips' | 'inputs'> & {
  clips: Clip[];
  inputs: TrackInput[];
};
export const trackOrder: KeyOrder = {
  keys: ['name', 'type', 'inserts', 'inputs', 'clips'],
  children: {
    inserts: { items: insertOrder },
    clips: { items: clipOrder },
    inputs: {
      items: {
        keys: ['track', 'anchor', 'at', 'duration', 'gain_db', 'pan', 'fade_in', 'fade_out'],
        children: { at: { flow: true }, duration: { flow: true } },
      },
    },
  },
};
