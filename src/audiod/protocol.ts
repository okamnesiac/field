import { z } from 'zod';

// The bloom-audiod control protocol (playback.md §3.3): NDJSON over a unix
// socket at .bloom/audiod.sock. These zod schemas are the source of truth;
// the C++ side (native/audiod) mirrors them by hand — the protocol is kept
// small enough that drift would fail the protocol tests immediately.

export const PROTOCOL_VERSION = 1;

export const helloResponseSchema = z.object({
  ok: z.literal(true),
  protocol: z.number().int(),
  daemon: z.string(),
  version: z.string(),
});

export const deviceSchema = z.object({
  name: z.string(),
  default: z.boolean(),
});

export const devicesResponseSchema = z.object({
  ok: z.literal(true),
  devices: z.array(deviceSchema),
  null_output: z.boolean(),
});

export const loadResponseSchema = z.object({
  ok: z.literal(true),
  samples: z.number().int(),
  sample_rate: z.number(),
  channels: z.number().int(),
});

export const transportState = z.enum(['playing', 'paused', 'stopped']);

export const statusResponseSchema = z.object({
  ok: z.literal(true),
  state: transportState,
  sample: z.number().int(),
  samples: z.number().int(),
  path: z.string().nullable(),
  null_output: z.boolean(),
  device: z.object({ name: z.string(), sample_rate: z.number() }).optional(),
  resampling: z.boolean(),
  looping: z.boolean().optional(), // daemon >= 0.3
});

export const okResponseSchema = z.object({ ok: z.literal(true) });

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export const eventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('state'), state: transportState }),
  z.object({ event: z.literal('position'), sample: z.number().int() }),
  // The output moved underneath the clients: default-follow tracked a
  // system-default change, or the held device vanished and the daemon
  // fell back (playback.md §5).
  z.object({ event: z.literal('device'), name: z.string(), sample_rate: z.number() }),
  // A queued reload took over at the loop wrap (daemon >= 0.4) — emitted
  // when the swap actually sounds, not when it was requested.
  z.object({ event: z.literal('reloaded'), path: z.string() }),
]);
export type AudiodEvent = z.infer<typeof eventSchema>;
