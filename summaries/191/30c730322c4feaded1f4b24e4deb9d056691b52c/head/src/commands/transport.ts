import { relative, resolve, sep } from 'node:path';
import { readWavHeader } from '../audio/wav.js';
import { AudiodClient } from '../audiod/client.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import type { LoadedProject } from '../model/project.js';
import { MeterMap, TempoMap } from '../time/tempo.js';

// Musical time stays CLI-side (playback.md §3.6): the daemon only ever
// hears samples. These helpers project bar.beat.tick through a song's
// tempo map both ways, deriving which song's map applies from the label
// or artifact path being played.

export interface MusicalContext {
  tempo: TempoMap;
  meter: MeterMap;
}

export function musicalContext(
  project: LoadedProject,
  songDir: string | undefined,
  // The rate of the file being played, which is what every projection
  // here must speak: a track may render at its own rate (multi-rate.md
  // decision 3), so bar 2 of a 44.1 kHz stem is sample 88200 of the file
  // the daemon is reading — the project's rate would seek an
  // eighth-note late (#112 review). Callers read it off the load
  // response or the artifact's own header (playedRate).
  sampleRate: number,
): MusicalContext | undefined {
  const song = project.songs.find((s) => s.dir === songDir);
  if (!song?.time) return undefined;
  return {
    tempo: new TempoMap(song.time.tempo, sampleRate),
    meter: new MeterMap(song.time.meter),
  };
}

// The played artifact's own rate, from its header — the song's (then
// the project's) only when the header cannot be read, which keeps a
// vanished or truncated file from taking the status line down with it.
export function playedRate(project: LoadedProject, path: string): number {
  try {
    return readWavHeader(path).sampleRate;
  } catch {
    const song = project.songs.find((s) => s.dir === songDirOfPath(project.root, path));
    return song?.song?.data.rate ?? project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  }
}

// songs/<song>/... → songs/<song> (the label package or a package prefix).
export function songDirOfPkg(pkg: string): string | undefined {
  const m = /^(songs\/[^/]+)(\/|$)/.exec(pkg);
  return m ? m[1] : undefined;
}

// Recover the song from an artifact or asset path: both live under a
// songs/<song>/ segment (assets directly, outputs under .field/out/).
export function songDirOfPath(root: string, path: string): string | undefined {
  const rel = relative(resolve(root), resolve(path));
  const parts = rel.split(sep);
  const at = parts.lastIndexOf('songs');
  if (at < 0 || at + 1 >= parts.length) return undefined;
  return `songs/${parts[at + 1]}`;
}

// bar[.beat[.tick]] → samples through the song's maps.
export function parseMusicalPosition(position: string, ctx: MusicalContext): number {
  return ctx.tempo.ticksToSamples(ctx.meter.parse(position));
}

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

export function formatPosition(
  sample: number,
  sampleRate: number,
  ctx: MusicalContext | undefined,
): string {
  const seconds = clock(sample / sampleRate);
  if (!ctx) return `sample ${sample} (${seconds})`;
  return `${ctx.meter.format(Math.round(ctx.tempo.samplesToTicks(sample)))} (${seconds})`;
}

// `field transport …`: reach the daemon a running `field play` (or a prior
// command) left behind. Never spawns — transport on a dead daemon is a
// clear error, not a silent no-op player with nothing loaded.
export async function connectTransport(root: string): Promise<AudiodClient> {
  try {
    return await AudiodClient.connect(root, { spawnIfNeeded: false });
  } catch {
    throw new Error('field-audiod is not running (field play starts it)');
  }
}

export async function transportStatusLines(
  root: string,
  project: LoadedProject,
): Promise<string[]> {
  const client = await connectTransport(root);
  try {
    const status = await client.status();
    const lines: string[] = [];
    if (status.live === true) {
      // A live session has no artifact path; its identity is the song
      // the compiler stamped into it.
      const rate = status.sample_rate ?? DEFAULT_SAMPLE_RATE;
      const ctx = status.song ? musicalContext(project, `songs/${status.song}`, rate) : undefined;
      const looping = status.looping === true ? '  (looping)' : '';
      lines.push(`${status.state}  ${formatPosition(status.sample, rate, ctx)}${looping}`);
      lines.push(`live session: ${status.song ?? '(unknown song)'}`);
    } else if (status.path === null) {
      lines.push(`stopped (nothing loaded)`);
    } else {
      const rate = playedRate(project, status.path);
      const ctx = musicalContext(project, songDirOfPath(root, status.path), rate);
      const looping = status.looping === true ? '  (looping)' : '';
      lines.push(`${status.state}  ${formatPosition(status.sample, rate, ctx)}${looping}`);
      lines.push(`file: ${relative(root, status.path) || status.path}`);
    }
    if (status.device) {
      const note = status.resampling ? ' (resampling)' : '';
      lines.push(`device: ${status.device.name} @ ${status.device.sample_rate} Hz${note}`);
    }
    // The input side (recording.md §6): a `field record` blocking in
    // another terminal shows up here, which is also how you learn why
    // the daemon is refusing to idle-exit.
    if (status.record !== undefined && status.record.state !== 'idle') {
      // Every armed track, the primary first (arming.md §2.2); a MIDI
      // track listens to the arm's sources rather than to an input.
      const record = status.record;
      const tracks = record.armed ?? [{ track: record.track ?? '', kind: record.kind ?? 'audio', input: record.input }];
      const midiFrom = `MIDI from ${(record.sources ?? []).join(', ')}`;
      const input = tracks
        .map((a) => `${a.kind === 'midi' ? midiFrom : `${record.device} input ${a.input}`} → ${a.track}`)
        .join(', ');
      if (record.state === 'recording') {
        const frames = record.frames !== undefined ? ` (${record.frames} frames)` : '';
        lines.push(`recording: ${record.transaction}${frames} on ${input}`);
      } else {
        lines.push(`armed: ${input}`);
      }
    }
    // Answers "am I on the latest daemon?" without folklore.
    lines.push(`daemon: field-audiod ${client.daemonVersion}`);
    return lines;
  } finally {
    client.close();
  }
}

export async function transportLocate(
  root: string,
  project: LoadedProject,
  position: string,
): Promise<string> {
  const client = await connectTransport(root);
  try {
    const status = await client.status();
    if (status.live !== true && status.path === null)
      throw new Error('nothing loaded (field play something first)');
    const rate =
      status.live === true ? (status.sample_rate ?? DEFAULT_SAMPLE_RATE) : playedRate(project, status.path!);
    const ctx =
      status.live === true
        ? status.song
          ? musicalContext(project, `songs/${status.song}`, rate)
          : undefined
        : musicalContext(project, songDirOfPath(root, status.path!), rate);
    if (!ctx) {
      throw new Error(`cannot derive a tempo map for ${status.path}; locate needs a song artifact`);
    }
    const sample = parseMusicalPosition(position, ctx);
    await client.locate(sample);
    return formatPosition(sample, rate, ctx);
  } finally {
    client.close();
  }
}

export async function transportCommand(
  root: string,
  op: 'play' | 'pause' | 'stop' | 'quit',
): Promise<void> {
  const client = await connectTransport(root);
  try {
    await client[op]();
  } finally {
    client.close();
  }
}
