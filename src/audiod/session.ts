import { z } from 'zod';

// The live session (realtime.md §3, chunk 2): what the CLI compiles from
// the graph and the daemon evaluates in the callback. Everything is
// samples and file paths — the daemon never learns what a bar is
// (playback.md §3.6), and all delay-compensation arithmetic happens here
// in the compiler (graph/live.ts), so the engine only ever applies
// offsets it was handed.
//
// Versioned like the render plan and for the same reason: an engine
// evaluating a session whose meaning it misreads is a quietly wrong
// monitor. Bumped whenever the shape's meaning changes.

// 2: track rates are load-bearing at edges — a session may carry a
// track at a foreign rate and the engine converts where it is consumed
// (cross-rate-live.md decision 4). An engine that would sum the raw
// samples must refuse, which the version check is.
export const SESSION_VERSION = 2;

// One placed window, mirroring the render plan's clip exactly — same
// fields, same units, same omit-when-centred pan rule — except that the
// source is named inline: a `file` window reads a committed or built
// artifact; a `track` window reads another live track's output ring at
// a delay. `duration` is always resolved here (the compiler runs after
// the build, so every source length is known).
// No loop here on purpose: loops expand at plan time into per-repetition
// windows (clip-looping.md §1.6 — the renderer never knows loops exist),
// and the session inherits the same pre-expanded clips.
const windowFields = {
  start: z.number().int().min(0),
  duration: z.number().int().min(0),
  read_offset: z.number().int(),
  gain_db: z.number(),
  pan: z.number().min(-1).max(1).optional(),
  fade_in: z.number().int().min(0),
  fade_out: z.number().int().min(0),
};

export const fileWindowSchema = z.strictObject({
  file: z.string().min(1), // project-root-relative
  // The content behind the path (BuildOutcome.sha256). A source can
  // change bytes under a stable path — a regenerated take, a re-edited
  // asset — and a session that named only the path would serialize
  // identically, so diffSessions would call the edit `same` and the
  // daemon would keep playing what it preloaded (Codex's finding on
  // #139). The engine never reads this field — a swap reloads every
  // file fresh — it exists so identity comparisons see the bytes.
  sha256: z.string().min(1),
  ...windowFields,
});

export const trackWindowSchema = z.strictObject({
  track: z.string().min(1), // a track name in this session
  ...windowFields,
  // Delay compensation, computed by the compiler: extra samples of
  // delay on this tap so sibling inputs with unequal chain latencies
  // arrive aligned (realtime.md chunk 2). Zero when siblings agree.
  comp_delay: z.number().int().min(0),
});

// A cable arrival (nested-tracks.md §19): the receiver reads the
// sender's ring — pre-chain when the edge taps pre — at each arrival
// offset, with the edge's gain. Structurally a track window plus the
// tap choice; kept separate because the model keeps them separate.
export const receiveWindowSchema = z.strictObject({
  receive: z.string().min(1), // the sending track
  tap: z.enum(['pre', 'post']),
  ...windowFields,
  comp_delay: z.number().int().min(0),
});

export const sessionInsertSchema = z.discriminatedUnion('effect', [
  z.strictObject({
    effect: z.literal('eq'),
    normalize: z.boolean(),
    bands: z.array(
      z.strictObject({
        type: z.enum(['highpass', 'lowshelf', 'bell', 'highshelf', 'lowpass']),
        frequency: z.number().positive(),
        gain_db: z.number(),
        bandwidth: z.number().positive(),
      }),
    ),
  }),
  z.strictObject({
    effect: z.literal('limit'),
    ceiling_db: z.number(),
    lookahead_ms: z.number().positive(),
    release_ms: z.number().positive(),
    // The live horizon (realtime.md chunk 2's call, deferred there by
    // the limiter header): the streaming window covers this much
    // reduction depth. The compiler sets 60 dB — one attack ramp of
    // latency; deeper reductions start their ramp late while
    // monitoring, and the offline render stays exact.
    horizon_db: z.number().positive(),
  }),
  z.strictObject({
    effect: z.literal('reverb'),
    mix: z.number().min(0).max(1),
    decay: z.number().positive(),
    predelay_ms: z.number().min(0),
    damping: z.number().min(0).max(1),
  }),
  z.strictObject({
    effect: z.literal('plate'),
    mix: z.number().min(0).max(1),
    // The authoring floor is load-bearing here too: the tank's fixed
    // diffusion rings ~0.9 s, so a shorter T60 would out-ring the
    // analytic tail the compiler and engine both count on — a session
    // carrying one would be quietly wrong, which is what this parse
    // exists to refuse (cursor's finding on #144). Same for the
    // diffusion cap: an allpass at 1 stops decaying.
    decay: z.number().min(1),
    predelay_ms: z.number().min(0),
    damping: z.number().min(0).max(1),
    diffusion: z.number().min(0).max(0.98),
    modulation: z.number().min(0).max(1),
  }),
]);

export const sessionTrackSchema = z.strictObject({
  name: z.string().min(1),
  // The track's own rate (multi-rate.md decision 3). When it differs
  // from a consumer's, that edge pulls through a streaming resampler
  // (decision 7); the compiler has already included the resampler's
  // group delay in the consumer's comp_delay arithmetic.
  rate: z.number().int().positive(),
  chain: z.array(sessionInsertSchema).default([]),
  inputs: z.array(z.union([fileWindowSchema, trackWindowSchema, receiveWindowSchema])).default([]),
  // This track's accumulated latency at its output ring, compiler
  // computed: max over inputs of (input latency + edge delays) plus the
  // chain's own. Carried so `status` can report it and so the engine
  // can assert the compiler's arithmetic against its own instances.
  latency: z.number().int().min(0),
});

export const sessionSchema = z.strictObject({
  version: z.literal(SESSION_VERSION),
  // The song this session was compiled from — identity for transport
  // status and locate, which have no artifact path to derive it from.
  song: z.string().min(1),
  rate: z.number().int().positive(), // the engine clock: the song's rate
  // The song's declared extent at the session rate; with loop, the
  // clock wraps there — sample-exact, no takeover machinery.
  length_samples: z.number().int().positive().optional(),
  loop: z.boolean().optional(),
  output: z.string().min(1), // the track whose ring feeds the device
  tracks: z.array(sessionTrackSchema).min(1),
});
export type Session = z.infer<typeof sessionSchema>;
export type SessionTrack = z.infer<typeof sessionTrackSchema>;
export type SessionInsert = z.infer<typeof sessionInsertSchema>;

// Live parameter changes (decision 5): a ramp reaching the callback as
// a short dB-linear glide landing next block. Chunk 2 ships the verb;
// chunk 3 wires file-watching diffs to it.
export const rampRequestSchema = z.strictObject({
  op: z.literal('ramp'),
  track: z.string().min(1),
  // Which number moves: a window's gain is addressed by its index in
  // the track's inputs; 'send' addresses a receive window the same way
  // from the receiving track.
  input: z.number().int().min(0),
  gain_db: z.number(),
  ramp_ms: z.number().min(0).default(15),
});
