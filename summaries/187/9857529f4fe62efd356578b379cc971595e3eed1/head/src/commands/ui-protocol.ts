// The `field ui` wire format, in one place both ends compile against.
//
// This file exists because the client's copy of these shapes drifted
// from the server's and blanked the window: the device list is
// `{name, default}` objects, the client's hand-written interface said
// `string[]`, and the first render threw on an object where React
// expected a child. Nothing caught it — the interface was internally
// consistent, so the client typechecked, and the server typechecked
// against the daemon's real schemas, and the two were never compared.
//
// Deliberately types only, with no imports: `ui/` is a separate package
// with a DOM tsconfig and no Node types, so anything importable by both
// has to be free of both worlds. The server assigns daemon-schema values
// into these shapes, which is where a daemon schema change now surfaces
// as a compile error rather than as a blank page.

export interface UiDevice {
  name: string;
  default: boolean;
}

export interface UiStatus {
  state: string;
  sample: number;
  samples: number;
  musical: string;
  device?: { name: string; sample_rate: number } | undefined;
}

// What the view needs to run its own clock. The daemon emits position
// events on a 250 ms heartbeat, so a readout that only moves when one
// arrives ticks four times a second and reads as broken — no amount of
// machine speed fixes that, because the rate is the daemon's and the
// samples in between simply are not sent. The view therefore projects
// the playhead itself between events and resynchronises on each one.
//
// The maps travel as the plain event arrays the project already stores,
// and the client builds the same `TempoMap`/`MeterMap` this process
// uses — the class is pure arithmetic over these arrays, so both ends
// run one implementation rather than two that can disagree. The daemon
// still hears only samples (playback.md §3.6); what moved is which
// client of the daemon spells bars, which ui.md §6 records.
export interface UiClock {
  sampleRate: number;
  tempo: { at: number; bpm: number; ramp?: 'linear' | undefined }[];
  meter: { at: number; numerator: number; denominator: number }[];
}

export interface UiSnapshot {
  type: 'snapshot';
  song: string;
  // The song's main file, named in the view's footer. Edits carry each
  // lane's own file and hash (UiTimelineLane), not this.
  file: { path: string };
  soloed: string | null;
  devices: { devices: UiDevice[]; null_output: boolean };
  status: UiStatus;
  clock?: UiClock | undefined; // absent when the song has no tempo map
  timeline?: UiTimeline | undefined;
}

export interface UiError {
  type: 'error';
  message: string;
}

export interface UiEvent {
  type: 'event';
  event: { event: string; state?: string; sample?: number; name?: string };
  musical?: string;
}

// Server → client.
export type UiDown = UiSnapshot | UiError | UiEvent;

// One insert in a track's chain, parsed with defaults applied — the
// client renders knobs from these values and sends whole-param edits
// back against the track file's own hash. `effect` is the discriminant
// for built-ins; a hosted plugin arrives as 'plugin' and is read-only
// here (its knobs belong to its own editor window).
export interface UiInsert {
  entry: number;
  effect: string;
  params: Record<string, unknown>;
}

// The song in time. Absolute sample windows, projected server-side
// through the planner's own arithmetic, plus one mark per bar — bars are
// not linear in samples across a tempo ramp, so the ruler ships marks
// rather than asking the view to interpolate.
export interface UiMark {
  sample: number;
  bar: number;
}

export interface UiClip {
  start: number;
  duration: number;
  // False when the placement declined to declare a length: the source's
  // extent is not knowable while planning, and the block says so rather
  // than drawing a guess as measurement.
  exact: boolean;
  name: string;
}

export interface UiTimelineLane {
  entry: number; // index within `file` below — the edit locator
  // Which file this lane's placement lives in. A top-level lane is a
  // placement in main.yaml; a child lane is a placement in the placing
  // track's own file, so an edit has to say which. The server validates
  // this against the song's known track paths and never joins it.
  file: string;
  sha256: string; // per-file stale guard, since a lane may edit any of them
  name: string;
  start: number;
  duration: number;
  depth: number;
  gain_db: number;
  pan: number;
  mute: boolean;
  canSolo: boolean;
  // The placed track's own file — where its inserts live — with its
  // hash as the stale guard for insert ops. Null when the placement is
  // not a track (raw audio, a generator), which is also the panel's
  // signal that there is no chain to show.
  trackFile: string | null;
  trackSha256: string | null;
  inserts: UiInsert[] | null;
  // The rate the placed track renders at — its own `rate:`, or the
  // song's — which is the rate its EQ designs its filters at. Null when
  // the placement is not a track.
  trackRate: number | null;
  // Null when this lane places audio rather than a track: there is
  // nothing underneath, so no twirl is offered.
  children: UiTimelineLane[] | null;
  clips: UiClip[];
  peaks?: number[] | undefined;
}

export interface UiTimeline {
  rate: number;
  length: number;
  marks: UiMark[];
  lanes: UiTimelineLane[];
}
