import { loadProject, type LoadedProject } from '../model/project.js';
import { SONG_OUTPUT_NAME } from '../labels.js';
import { trackRefName } from '../generators/stem.js';
import { barTicks, MeterMap, TempoMap } from '../time/tempo.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import { renderableTrack } from '../generators/stem.js';

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
  at: number; // ticks
  bars: string; // bar.beat.tick, projected through the song's meter map
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
  if (!renderableTrack(output.data)) {
    throw new Error(`"${SONG_OUTPUT_NAME}" in ${songName} is not an audio track`);
  }
  const meter = song.tempo ? new MeterMap(song.tempo.data.meter) : undefined;
  const placements: Placement[] = [];
  for (const input of output.data.inputs ?? []) {
    // Placements name a track; anything else on `inputs:` is not structure.
    const name = trackRefName(input.track) ?? input.track;
    placements.push({
      track: name,
      at: input.at,
      bars: meter ? meter.format(input.at) : String(input.at),
      gainDb: input.gain_db,
      pan: input.pan,
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
  // arrangement.yaml carried as `chorus` at bar 13.
  const bar = song?.tempo ? barTicks(song.tempo.data.meter[0]!) : undefined;
  const length =
    view.lengthTicks !== undefined && bar
      ? ` (${fmtBars(view.lengthTicks / bar)})`
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
    lines.push(
      `  ${p.bars.padEnd(width)}${seconds}  ${p.track}${level ? `  (${level})` : ''}`,
    );
  }
  return lines.join('\n');
}

function fmtBars(n: number): string {
  const rounded = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${rounded} bar${n === 1 ? '' : 's'}`;
}

function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export function arrangement(root: string, songName: string): string {
  const project = loadProject(root);
  return formatArrangement(songArrangement(project, songName), project);
}
