import { loadProject, type LoadedProject } from '../model/project.js';
import { SONG_OUTPUT_NAME } from '../labels.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';

// `field arrangement <song>` — the song's structure, derived.
//
// `arrangement.yaml` used to store this: a list of named sections and the
// bar each began at. It was validated and never read, which is the shape a
// stored copy takes just before it drifts — creek's said `chorus` at bar 13
// of a twelve-bar song, and nothing noticed because nothing consumed it
// (nested-tracks.md §5, §11).
//
// So the structure is computed from the one place that cannot be wrong: the
// output track's placements, which are what actually renders. A song that
// says it has three passes has three placements, or it does not have three
// passes.

export interface Placement {
  track: string; // the placed track's name
  at: number; // ticks, whatever the placement's anchor was
  bars: string; // bar.beat.tick, projected through the song's meter map
  absolute: boolean; // pinned to time rather than to the grid
  gainDb: number;
  pan: number;
}

export interface ArrangementView {
  song: string;
  lengthTicks?: number | undefined;
  placements: Placement[];
}

export function songArrangement(project: LoadedProject, songName: string): ArrangementView {
  const song = project.songs.find((s) => s.name === songName);
  if (!song) throw new Error(`no such song "${songName}"`);
  const output = song.tracks.find((t) => t.data.name === SONG_OUTPUT_NAME);
  if (!output) {
    throw new Error(
      `song "${songName}" has no track named "${SONG_OUTPUT_NAME}" — a song's output is that ` +
        `track (nested-tracks.md §7 chunk 2)`,
    );
  }
  const meter = song.tempo ? new MeterMap(song.tempo.data.meter) : undefined;
  const rate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const tempo = song.tempo ? new TempoMap(song.tempo.data.tempo, rate) : undefined;
  const placements: Placement[] = [];
  for (const entry of output.data.inputs ?? []) {
    // Structure means placed *tracks* (nested-tracks.md §18): an audio or
    // generator entry on the output is material, not a section.
    if (entry.track === undefined) continue;
    // `at` is ticks when the placement is musical and samples when it is
    // absolute (schema/track.ts). Formatting samples through the meter map
    // is not a rounding error — a placement one second in came out as bar
    // 13 of an eight-bar song, which is the same class of lie this command
    // exists to stop telling.
    const absolute = entry.anchor === 'absolute';
    const at = absolute ? (tempo ? tempo.samplesToTicks(entry.at) : entry.at) : entry.at;
    placements.push({
      track: entry.track,
      at,
      bars: meter && (!absolute || tempo) ? meter.format(at) : String(at),
      absolute,
      gainDb: entry.gain_db,
      pan: entry.pan,
    });
  }
  // Reading order is time order — the file's order is authoring order, and
  // a reader asking "what happens when" wants the timeline.
  placements.sort((a, b) => a.at - b.at || a.track.localeCompare(b.track));
  return { song: songName, lengthTicks: song.song?.data.length, placements };
}

export function formatArrangement(view: ArrangementView, project: LoadedProject): string {
  const song = project.songs.find((s) => s.name === view.song);
  const rate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const tempo = song?.tempo ? new TempoMap(song.tempo.data.tempo, rate) : undefined;
  const lines: string[] = [];
  // A length is a span, not a position. Formatting it as bar.beat.tick
  // prints the downbeat *after* the song — creek's twelve bars come out as
  // "13.1.1", which is precisely the off-by-one the retired
  // arrangement.yaml carried as `chorus` at bar 13. So the span is that
  // reading minus one bar.
  //
  // Through the meter map rather than by dividing by the opening meter's
  // bar: a song that changes meter has no single bar length, and dividing
  // by the first one printed 10 for creek's twelve bars on a project that
  // checked ok — the one number not computed from the map being the one
  // that was wrong.
  const meter = song?.tempo ? new MeterMap(song.tempo.data.meter) : undefined;
  const length =
    view.lengthTicks !== undefined && meter
      ? ` (${fmtSpan(meter.format(view.lengthTicks))})`
      : '';
  lines.push(`${view.song}${length}`);
  if (view.placements.length === 0) {
    lines.push('  nothing placed — the output track sums no tracks');
    return lines.join('\n');
  }
  const width = Math.max(...view.placements.map((p) => p.bars.length));
  for (const p of view.placements) {
    const seconds = tempo ? ` ${fmtSeconds(tempo.ticksToSeconds(p.at))}` : '';
    const level = [
      p.gainDb !== 0 ? `${p.gainDb > 0 ? '+' : ''}${p.gainDb} dB` : '',
      p.pan !== 0 ? `pan ${p.pan}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    // An absolute placement is pinned to time, so its bar reading moves if
    // the tempo map does. Saying which it is costs four characters.
    const note = [p.absolute ? 'absolute' : '', level].filter(Boolean).join(', ');
    lines.push(`  ${p.bars.padEnd(width)}${seconds}  ${p.track}${note ? `  (${note})` : ''}`);
  }
  return lines.join('\n');
}

// The end position as a span: "13.1.1" is twelve whole bars, "12.3.1" is
// eleven bars and two beats.
function fmtSpan(endPosition: string): string {
  const [bar = 1, beat = 1, tick = 1] = endPosition.split('.').map(Number);
  const parts: string[] = [plural(bar - 1, 'bar')];
  if (beat > 1) parts.push(plural(beat - 1, 'beat'));
  if (tick > 1) parts.push(plural(tick - 1, 'tick'));
  return parts.join(' ');
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export function arrangement(root: string, songName: string): string {
  const project = loadProject(root);
  // A derived view is only worth trusting if it refuses to guess, and
  // unresolved musical time is exactly where it would: positions that
  // never resolved print as raw arrays, which read like bar numbers.
  // `build` (loadValid) and `fmt` both stop here; this was the outlier.
  if (project.diagnostics.length > 0) {
    const lines = project.diagnostics.map((d) => `${d.file}: ${d.message}`).join('\n');
    throw new Error(`project has errors (field check):\n${lines}`);
  }
  return formatArrangement(songArrangement(project, songName), project);
}
