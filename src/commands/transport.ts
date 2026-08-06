import { relative, resolve, sep } from 'node:path';
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
): MusicalContext | undefined {
  const song = project.songs.find((s) => s.dir === songDir);
  if (!song?.tempo) return undefined;
  const rate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  return {
    tempo: new TempoMap(song.tempo.data.tempo, rate),
    meter: new MeterMap(song.tempo.data.meter),
  };
}

// songs/<song>/... → songs/<song> (the label package or a package prefix).
export function songDirOfPkg(pkg: string): string | undefined {
  const m = /^(songs\/[^/]+)(\/|$)/.exec(pkg);
  return m ? m[1] : undefined;
}

// Recover the song from an artifact or asset path: both live under a
// songs/<song>/ segment (assets directly, outputs under .bloom/out/).
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

// `bloom transport …`: reach the daemon a running `bloom play` (or a prior
// command) left behind. Never spawns — transport on a dead daemon is a
// clear error, not a silent no-op player with nothing loaded.
export async function connectTransport(root: string): Promise<AudiodClient> {
  try {
    return await AudiodClient.connect(root, { spawnIfNeeded: false });
  } catch {
    throw new Error('bloom-audiod is not running (bloom play starts it)');
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
    if (status.path === null) {
      lines.push(`stopped (nothing loaded)`);
    } else {
      const ctx = musicalContext(project, songDirOfPath(root, status.path));
      const rate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
      const looping = status.looping === true ? '  (looping)' : '';
      lines.push(`${status.state}  ${formatPosition(status.sample, rate, ctx)}${looping}`);
      lines.push(`file: ${relative(root, status.path) || status.path}`);
    }
    if (status.device) {
      const note = status.resampling ? ' (resampling)' : '';
      lines.push(`device: ${status.device.name} @ ${status.device.sample_rate} Hz${note}`);
    }
    // Answers "am I on the latest daemon?" without folklore.
    lines.push(`daemon: bloom-audiod ${client.daemonVersion}`);
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
    if (status.path === null) throw new Error('nothing loaded (bloom play something first)');
    const ctx = musicalContext(project, songDirOfPath(root, status.path));
    if (!ctx) {
      throw new Error(`cannot derive a tempo map for ${status.path}; locate needs a song artifact`);
    }
    const sample = parseMusicalPosition(position, ctx);
    await client.locate(sample);
    const rate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
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
