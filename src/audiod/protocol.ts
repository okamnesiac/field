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
  // The daemon's process id (daemon >= 0.12): what a test kills to prove
  // a take survives its daemon.
  pid: z.number().int().optional(),
});

export const deviceSchema = z.object({
  name: z.string(),
  default: z.boolean(),
});

// An input device and how many channels `arm` may name on it
// (recording.md §6).
export const inputDeviceSchema = z.object({
  name: z.string(),
  default: z.boolean(),
  channels: z.number().int(),
});

export const devicesResponseSchema = z.object({
  ok: z.literal(true),
  devices: z.array(deviceSchema),
  inputs: z.array(inputDeviceSchema).default([]), // daemon feature "record"
  null_output: z.boolean(),
});

// The input side (recording.md §5–6), as `status` reports it: idle,
// armed on an input, or recording into a transaction. `input_peak` is
// the largest |sample| on the armed input since the last status read —
// the V1 meter — and the daemon resets it on read, so one reader at a
// time sees the whole picture. Armed for MIDI (keyboard-instrument.md
// §12.4), `kind` and `sources` replace `device` and `input`, the peak is
// 0, and a take reports `events`.
export const recordState = z.enum(['idle', 'armed', 'recording']);
export const recordStatusSchema = z.object({
  state: recordState,
  track: z.string().optional(),
  device: z.string().optional(),
  input: z.number().int().optional(),
  kind: z.literal('midi').optional(), // daemon feature "record-midi"
  sources: z.array(z.string()).optional(), // the MIDI inputs the arm opened
  input_peak: z.number().optional(),
  transaction: z.string().optional(),
  file: z.string().optional(), // project-root-relative take.wav or take.midi.ndjson
  started_at_samples: z.number().int().optional(), // -1 until the callback latches
  pending: z.boolean().optional(), // a pre-rolled take waiting for its position (daemon >= 0.13)
  // Punch-out and loop takes (daemon >= 0.14): where the take ends,
  // whether every pass is a take, how many have finalized, and how many
  // passes began with no transaction ready.
  until: z.number().int().optional(),
  loop: z.boolean().optional(),
  loop_takes: z.number().int().optional(),
  missed: z.number().int().optional(),
  frames: z.number().int().optional(), // pushed by the callback; a MIDI take's samples elapsed
  written: z.number().int().optional(), // reached the file (audio takes)
  events: z.number().int().optional(), // a MIDI take's messages captured so far
  dropped: z.number().int().optional(), // the FIFO refused (a stalled writer)
});

// What arm opened: the device and input, its channel count, the rate
// the take's bytes will be at, and the latencies the device reports.
// The latencies are recorded, not yet applied — which of them placement
// subtracts is settled against real hardware (recording.md §3).
export const armResponseSchema = z.object({
  ok: z.literal(true),
  device: z.string(),
  input: z.number().int(),
  channels: z.number().int(),
  sample_rate: z.number(),
  input_latency: z.number().int(),
  output_latency: z.number().int(),
});

// What arm opened for MIDI (keyboard-instrument.md §12.4): every MIDI
// input the daemon could see, by name; the device's rate, which a MIDI
// take's times count in; and the output latency, the one placement
// subtracts from a MIDI take (§12.2).
export const armMidiResponseSchema = z.object({
  ok: z.literal(true),
  kind: z.literal('midi'),
  sources: z.array(z.string()),
  sample_rate: z.number(),
  output_latency: z.number().int(),
});

export const recordResponseSchema = z.object({
  ok: z.literal(true),
  transaction: z.string(),
  file: z.string(),
  started_at_samples: z.number().int(), // -1 while a pre-rolled take waits for its position
});

// The metronome schedule (recording.md §7): tick positions on the bed's
// timeline at `rate`, with downbeat accents. The CLI projects the tempo
// map into it; the daemon synthesizes the ticks in the callback and never
// learns what a bar is. An empty list clears.
export const clickTickSchema = z.strictObject({
  sample: z.number().int().min(0),
  accent: z.boolean(),
});
export const clickScheduleSchema = z.strictObject({
  rate: z.number().positive(),
  ticks: z.array(clickTickSchema),
});
export type ClickSchedule = z.infer<typeof clickScheduleSchema>;

// A take's manifest (capture.cpp writeManifest): the transaction's
// facts, plus the frame count once it is complete. `recordings` lists
// these, `stop` and `pause` return the one they finalized, `recover`
// returns the one it patched, and the `take` event broadcasts it.
export const takeSchema = z.object({
  id: z.string(),
  file: z.string(), // project-root-relative
  track: z.string(),
  song: z.string().optional(),
  source: z.string().optional(),
  device: z.string(),
  input: z.number().int(),
  sample_rate: z.number(),
  timeline_rate: z.number().optional(), // the bed's rate; absent for a free-running take
  channels: z.number().int(),
  bit_depth: z.number().int(),
  format: z.string(),
  input_latency: z.number().int(),
  output_latency: z.number().int(),
  started_at_samples: z.number().int().optional(),
  started_wall: z.string(),
  daemon: z.string(),
  complete: z.boolean(),
  frames: z.number().int().optional(), // present once complete
  dropped: z.number().int().optional(),
  recovered: z.boolean().optional(),
  journaled_frames: z.number().int().optional(),
});
export type Take = z.infer<typeof takeSchema>;

// A MIDI take's manifest (keyboard-instrument.md §12.4): the messages
// are in `file`, take.midi.ndjson, one midiTakeLineSchema line each.
// `frames` is the samples from the start to the stop or `until`, and
// `events` the lines written, both at `sample_rate`, the device's.
export const midiTakeSchema = z.object({
  id: z.string(),
  file: z.string(), // project-root-relative
  track: z.string(),
  song: z.string().optional(),
  source: z.string().optional(),
  kind: z.literal('midi'),
  sources: z.array(z.string()), // the MIDI inputs the take listened to
  sample_rate: z.number(),
  timeline_rate: z.number().optional(), // the bed's rate; absent for a free-running take
  output_latency: z.number().int(),
  started_at_samples: z.number().int().optional(),
  started_wall: z.string(),
  daemon: z.string(),
  complete: z.boolean(),
  frames: z.number().int().optional(), // present once complete
  events: z.number().int().optional(), // present once complete
  dropped: z.number().int().optional(),
  recovered: z.boolean().optional(),
  journaled_frames: z.number().int().optional(),
  journaled_events: z.number().int().optional(),
});
export type MidiTake = z.infer<typeof midiTakeSchema>;

// One line of take.midi.ndjson: a channel message's bytes, `at` samples
// from the take's start. Lines are in `at` order.
export const midiTakeLineSchema = z.strictObject({
  at: z.number().int().min(0),
  midi: z.array(z.number().int().min(0).max(255)).min(1).max(3),
});
export type MidiTakeLine = z.infer<typeof midiTakeLineSchema>;

// Either kind of take; an audio manifest carries no `kind`, so
// `'kind' in take` tells them apart.
export const anyTakeSchema = z.union([midiTakeSchema, takeSchema]);
export type AnyTake = z.infer<typeof anyTakeSchema>;

// One entry of the `recordings` list: the manifest as far as it got,
// with what is on disk beside it. A MIDI transaction counts its whole
// lines as `events_on_disk`, and its `frames_on_disk` is 0.
const recordingEntryFields = {
  id: z.string(),
  file: z.string(),
  complete: z.boolean(),
  active: z.boolean(), // the one still being written
  frames_on_disk: z.number().int(),
};
export const recordingEntrySchema = z.union([
  midiTakeSchema.partial().extend({
    ...recordingEntryFields,
    kind: z.literal('midi'),
    events_on_disk: z.number().int(),
  }),
  takeSchema.partial().extend(recordingEntryFields),
]);
export type RecordingEntry = z.infer<typeof recordingEntrySchema>;

export const recordingsResponseSchema = z.object({
  ok: z.literal(true),
  recordings: z.array(recordingEntrySchema),
});

export const recoverResponseSchema = z.object({
  ok: z.literal(true),
  take: anyTakeSchema,
});

// stop and pause: ok, plus the take they finalized when one was running.
export const stopResponseSchema = z.object({
  ok: z.literal(true),
  take: anyTakeSchema.optional(),
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
  // Converted delivery's in-flight frames (live only, daemon >= 0.7):
  // the skew cross-rate-live.md decision 3 bounds, made visible.
  conv_queued: z.number().int().optional(),
  record: recordStatusSchema.optional(), // daemon feature "record"
  click_ticks: z.number().int().optional(), // ticks in the loaded schedule (daemon feature "click")
  // The live session's region loop, when one is set (daemon feature "loop-region").
  loop_from: z.number().int().optional(),
  loop_to: z.number().int().optional(),
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
  // The input side moved: something armed, a take began, a take ended.
  z.object({ event: z.literal('record'), state: recordState }),
  // A take finalized — by the stop that ended it, a remote stop, or the
  // bed running out — with its manifest. Nested, because the manifest's
  // own `id` is the transaction's and a top-level `id` marks a response.
  z.object({ event: z.literal('take'), take: anyTakeSchema }),
]);
export type AudiodEvent = z.infer<typeof eventSchema>;
