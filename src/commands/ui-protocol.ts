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

export interface UiLane {
  entry: number; // index into main's inputs — the edit locator
  kind: 'track' | 'audio' | 'other';
  name: string;
  gain_db: number;
  pan: number;
  mute: boolean;
  canSolo: boolean;
  inserts: string[];
}

export interface UiStatus {
  state: string;
  sample: number;
  samples: number;
  musical: string;
  device?: { name: string; sample_rate: number } | undefined;
}

export interface UiSnapshot {
  type: 'snapshot';
  song: string;
  lanes: UiLane[];
  file: { path: string; sha256: string };
  soloed: string | null;
  devices: { devices: UiDevice[]; null_output: boolean };
  status: UiStatus;
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
