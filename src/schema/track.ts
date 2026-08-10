import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName, sampleRate, samples, slug, sourceRef, timePosition, timeSpan } from './common.js';
import { insertOrder, insertSchema } from './effects.js';
import { meterEventSchema, tempoEventSchema } from './song.js';
import { generativeEntrySchema } from './sounds.js';

// One list (nested-tracks.md §18): a track file is a name, an optional
// `time:`, optional `inserts:`, and `inputs:`. Every entry places one
// thing on the track's timeline, and the thing is named by the entry's
// field — the kind lives in the field name, never in a value prefix:
//
//   - `track:` — another track's render
//   - `audio:` — committed bytes: the song's ledger, or the one
//     cross-scope spelling, `//shared/asset:<name>`
//   - `sound:` — a defined sound, **transitional**: it exists exactly as
//     long as `sounds/` does, and retires when the last sound folds into
//     a track (§18 sequencing). It is not in §18's three kinds; it is
//     the bridge to them, so `audio:` never quietly accepts a name that
//     renders — that would rebuild the bytes-versus-definitions
//     ambiguity kind-in-field exists to remove.
//
// Generator entries are §18's third kind: authored spec inline, the
// render minted as its own node under `gen:` (option A — uniformly,
// whether the entry is a leaf's sole content or windowed among
// siblings). `supercollider:` renders in-graph; `generative:` is
// deliberate — its takes live beside the audio under the gen node's
// name, and nothing in the build may run it (project-layout.md §1.2).
//
// Placement fields are uniform across kinds, because none of them means
// something different depending on what produced the audio. A window is
// (at, duration) in anchor units; the content offsets are samples, with
// effective read offset = source_offset − slip (project-core.md §3.2).
// Looping (clip-looping.md §1): the window is authoritative and the
// source tiles to fill it. `id` is how automation attaches to a
// placement (§18 decision 3); optional until something needs to attach.
export const clipLoopSchema = z.strictObject({
  enabled: z.boolean().default(true), // switch a loop off without deleting it
  every: timeSpan.optional(), // anchor units, or a musical span on musical entries
  mode: z.enum(['truncate', 'overlay']).default('truncate'),
  fade: samples.default(480), // ≈10 ms at 48 k; the naive loop must not click
});
// File types (z.infer) admit musical arrays; the exported types are the
// post-load shape — loadProject resolves every array to a tick scalar
// before anything else sees the data (musical-time.md §1.6).
type ClipLoopFile = z.infer<typeof clipLoopSchema>;
export type ClipLoop = Omit<ClipLoopFile, 'every'> & { every?: number | undefined };

// Retired spellings forward rather than answering "Unrecognized key":
// the two-list format merged into `inputs:` (nested-tracks.md §18), and
// a file still speaking it should be told the move, not the grammar.
const RETIRED_POSITION = 'position: is now at: (nested-tracks.md §18)';
const RETIRED_SOURCE =
  'source: split by kind — audio: for committed bytes, sound: for a defined ' +
  'sound, track: for a track (nested-tracks.md §18)';

// The authored half of a SuperCollider render, inline: the sound schema
// (schema/sounds.ts) minus name and type, which the entry supplies by
// where it sits and what field it is. Same fields, same meanings, same
// defaults — the action key sees identical parameters, which is what
// makes folding a sound into a track a cache hit rather than a render.
export const supercolliderEntrySchema = z.strictObject({
  source: z.string().min(1), // the program; bare names resolve in shared/instruments/
  seed: z.number().int().min(0),
  duration: z.number().positive().max(3600), // seconds
  channels: z.union([z.literal(1), z.literal(2)]).default(2),
});
export type SupercolliderEntry = z.infer<typeof supercolliderEntrySchema>;

export const inputEntrySchema = z
  .strictObject({
    id: slug.optional(),
    // Exactly one of these names what the entry plays; the superRefine
    // below is the arity check.
    track: slug.optional(), // a track in this song
    audio: sourceRef.optional(), // ledger name, or //shared/asset:<name>
    sound: slug.optional(), // transitional; retires with sounds/
    supercollider: supercolliderEntrySchema.optional(), // an inline render
    generative: generativeEntrySchema.optional(), // a deliberate request
    anchor: z.enum(['musical', 'absolute']).default('musical'),
    // Omitted means the track's start — the leaf case reads as bare
    // content (`- supercollider: {...}` with nothing else), and tick 0
    // and sample 0 are the same instant, so the default is anchor-safe.
    at: timePosition.default(0), // ticks when musical, samples when absolute
    // Omitted means the whole source — the placement declining to
    // truncate (nested-tracks.md §1.6). A looping entry still declares
    // one: the window is authoritative and the source tiles to fill it,
    // so "as long as the source" and "tile to fill the window" are
    // contrary instructions rather than a default.
    duration: timeSpan.optional(), // same units as at
    loop: clipLoopSchema.optional(),
    source_offset: samples.default(0),
    slip: z.number().int().default(0),
    gain_db: z.number().default(0),
    // Balance, -1 left … 1 right, applied by this track while summing
    // (nested-tracks.md §1.13); a hard pan silences one channel.
    pan: z.number().min(-1).max(1).default(0),
    fade_in: samples.default(0),
    fade_out: samples.default(0),
    position: z.never({ error: RETIRED_POSITION }).optional(),
    source: z.never({ error: RETIRED_SOURCE }).optional(),
  })
  .superRefine((entry, ctx) => {
    const kinds = [
      entry.track,
      entry.audio,
      entry.sound,
      entry.supercollider,
      entry.generative,
    ].filter((v) => v !== undefined);
    if (kinds.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          'an entry plays exactly one thing — name it with track:, audio:, ' +
          'supercollider:, generative:, or (until sounds fold) sound:',
      });
    }
  });
type InputEntryFile = z.infer<typeof inputEntrySchema>;
export type InputEntry = Omit<InputEntryFile, 'at' | 'duration' | 'loop'> & {
  at: number;
  duration?: number | undefined;
  loop?: ClipLoop | undefined;
};
export const inputEntryOrder: KeyOrder = {
  keys: [
    'id',
    'track',
    'audio',
    'sound',
    'supercollider',
    'generative',
    'anchor',
    'at',
    'duration',
    'loop',
    'source_offset',
    'slip',
    'gain_db',
    'pan',
    'fade_in',
    'fade_out',
  ],
  children: {
    supercollider: { keys: ['source', 'seed', 'duration', 'channels'] },
    generative: {
      keys: [
        'prompt',
        'text',
        'voice_ref',
        'voice_ref_sha256',
        'exaggeration',
        'conviction',
        'lyrics',
        'bpm',
        'duration_seconds',
        'bars',
      ],
    },
    at: { flow: true },
    duration: { flow: true },
    loop: { keys: ['enabled', 'every', 'mode', 'fade'], children: { every: { flow: true } } },
  },
};

// A track's own tempo and meter (nested-tracks.md §1.5). A 7/8 figure
// inside a 4/4 song is a track with a local meter rather than a feature,
// which is what subsumes project-core.md §3.1's loops-with-their-own-
// timeline deferral.
//
// Each half is independently optional and falls back to the song's. The
// polymetric case usually wants a different meter at the *same* tempo, so
// requiring both would copy the song's bpm into a file that cannot be
// told when the song's changes — a second copy of one fact, which is the
// drift `arrangement.yaml` retired for (§11).
//
// Inheritance is from the song, never from the parent that places this
// track: a track may have two parents (§1.3) and renders exactly once, so
// its musical time has to mean one thing no matter who consumes it
// (§13).
export const trackTimeSchema = z
  .strictObject({
    tempo: z.array(tempoEventSchema).min(1).optional(),
    meter: z.array(meterEventSchema).min(1).optional(),
  })
  .refine((time) => time.tempo !== undefined || time.meter !== undefined, {
    error:
      'declare a `tempo`, a `meter`, or both — an empty `time:` inherits ' +
      'everything, which is what omitting it already does (nested-tracks.md §1.5)',
  });
export type TrackTime = z.infer<typeof trackTimeSchema>;

// songs/<song>/tracks/<name>.yaml — name must match the filename; the slug
// is the identity (project-core.md §6).
//
// No `gain_db` or `pan` here. A level lives on the placement that consumes
// this track (nested-tracks.md §1.13), where it can differ per parent —
// which a field on the track cannot do, and which is why these retired
// with the mix rule that used to apply them.
// Written for the suffix, like every other message here: the loader
// appends " at <field>", so the sentence has to end before the name rather
// than open with a verb whose subject arrives at the far end of it.
const RETIRED_FADER =
  'a level lives on the placement that consumes this track — put it on the ' +
  '`inputs:` entry that places this track, and delete it here ' +
  '(nested-tracks.md §1.13)';
// `type:` retired with the one-list format (nested-tracks.md §18): every
// track is audio, and `midi` was a kind that rendered nothing, placed
// nothing, and was placed by nothing. When MIDI becomes real it arrives
// as an entry kind — content a track plays — not as a track species.
const RETIRED_TYPE =
  'every track is audio — delete type:; midi returns as an inputs: entry ' +
  'kind when it is real (nested-tracks.md §18)';
// `clips:` merged into `inputs:` (nested-tracks.md §18): a clip was a
// placement wearing a second spelling, and the planner sorted the two
// lists as one all along. The forwarding names the field moves so a file
// mid-migration is told what to do, the way mixes/ was.
const RETIRED_CLIPS =
  'clips: merged into inputs: — move each clip there, renaming position: ' +
  'to at: and source: to audio:/sound:/track: by what it names ' +
  '(nested-tracks.md §18)';

export const trackSchema = z.strictObject({
  name: labelName,
  type: z.never({ error: RETIRED_TYPE }).optional(),
  // The rate this track renders at (multi-rate.md decision 3). Omitted
  // means the project's — the same inheritance shape as `time:`, and from
  // the song for the same reason: a track may have two parents and
  // renders exactly once, so its rate has to mean one thing no matter who
  // consumes it. Where a parent's rate differs, the edge converts
  // (decision 4); nothing here needs to know who is listening.
  rate: sampleRate.optional(),
  // Omitted means the song's maps, which is every track today.
  time: trackTimeSchema.optional(),
  gain_db: z.never({ error: RETIRED_FADER }).optional(),
  pan: z.never({ error: RETIRED_FADER }).optional(),
  // Inserts are content, not mix parameters: they bake into the stem, so
  // an insert edit re-renders it — the accepted cost model (effects.md §5).
  inserts: z.array(insertSchema).default([]),
  inputs: z.array(inputEntrySchema).default([]),
  clips: z.never({ error: RETIRED_CLIPS }).optional(),
});
type TrackFile = z.infer<typeof trackSchema>;
export type Track = Omit<TrackFile, 'inputs'> & {
  inputs: InputEntry[];
};
export const trackOrder: KeyOrder = {
  keys: ['name', 'rate', 'time', 'inserts', 'inputs'],
  children: {
    // Same shape and order as tempo.yaml's, so a local map reads like the
    // song map it overrides rather than like a different kind of thing.
    time: {
      keys: ['tempo', 'meter'],
      children: {
        tempo: { items: { keys: ['at', 'bpm', 'ramp'] } },
        meter: { items: { keys: ['at', 'numerator', 'denominator'] } },
      },
    },
    inserts: { items: insertOrder },
    inputs: { items: inputEntryOrder },
  },
};
