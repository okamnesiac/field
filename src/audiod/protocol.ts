import { z } from 'zod';

// The field-audiod control protocol (playback.md §3.3): NDJSON over a unix
// socket at .field/audiod.sock. These zod schemas are the source of truth;
// the C++ side (native/audiod) mirrors them by hand — the protocol is kept
// small enough that drift would fail the protocol tests immediately.

export const PROTOCOL_VERSION = 1;

// Who this daemon is and where it listens. Exported because two files
// need them and only one had them: `field --version` declared its own
// copies, so changing the socket path here would have left that command
// probing the old one and reporting a running daemon as not running —
// the answer nobody double-checks (#70 review). The workers get this from
// their WorkerSpec; audiod is the one daemon that had no such record.
export const DAEMON_NAME = 'field-audiod';
export const SOCKET_RELATIVE = '.field/audiod.sock';

export const helloResponseSchema = z.object({
  ok: z.literal(true),
  protocol: z.number().int(),
  daemon: z.string(),
  version: z.string(),
  // Capability names (realtime.md §3): clients gate on these rather
  // than parsing `version`. Absent from daemons that predate the field;
  // the default keeps them meaning "none of the newer verbs".
  features: z.array(z.string()).default([]),
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
  live: z.boolean().optional(), // a live session is loaded (daemon feature "session")
  song: z.string().optional(), // the live session's song (live only)
  sample_rate: z.number().optional(), // the live session's rate (live only)
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
