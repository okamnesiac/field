import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, isSeq, parseDocument } from 'yaml';
import { readWavHeader } from '../audio/wav.js';
import { takeSchema, type Take } from '../audiod/protocol.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import { generatorName, placedWindow } from '../generators/stem.js';
import { sha256File } from '../hash.js';
import { parseLabel, SONG_OUTPUT_NAME } from '../labels.js';
import { takenSongNames } from '../model/namespace.js';
import { loadProject, recordTakesPath, type LoadedProject, type LoadedSong } from '../model/project.js';
import { recordTakesOrder, recordTakesSchema, type InputEntry, type RecordedTake } from '../schema/index.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';
import { appendLedgerRow, openLedger } from './import.js';

// Landing a take (recording.md §3, chunk 2): the daemon finalized a
// transaction under .field/recording/<id>/ — bytes, manifest, journal —
// and this is what turns it into a take of the project. The bytes move
// to audio/<node>/<id>.wav and pin in the song's ledger, where recorded
// audio pins (project-layout.md §1.6); the record goes beside them as a
// row in audio/<node>/takes.yaml, placed on the recording track's own
// timeline; the new take is chosen (§11, resolved 2026-09-06: tracking
// wants to hear what it just sang); and the transaction directory goes
// away, because the project now holds everything it held.

export interface RecordNode {
  song: LoadedSong;
  trackName: string;
  node: string; // the record node: the track's name, or <track>-<id>
  entry: InputEntry;
}

// The record entry a track carries, resolved from the label a take
// names. One per track for now: a second would need the take to say
// which node it lands in, which nothing asks yet.
export function recordNodeFor(project: LoadedProject, trackLabel: string): RecordNode {
  const label = parseLabel(trackLabel);
  const songDir = label.pkg.replace(/\/track$/, '');
  const song = project.songs.find((s) => s.dir === songDir);
  const track = song?.tracks.find((t) => t.data.name === label.name);
  if (song === undefined || track === undefined) {
    throw new Error(`no such track ${trackLabel}`);
  }
  const entries = track.data.inputs.filter((e) => e.record !== undefined);
  if (entries.length === 0) {
    throw new Error(
      `${track.data.name} has no \`record:\` entry — add \`- record:\` to its inputs so its ` +
        `takes have somewhere to attach (recording.md §4)`,
    );
  }
  if (entries.length > 1) {
    throw new Error(
      `${track.data.name} carries ${entries.length} record entries; a take lands in one, and ` +
        `nothing says which yet — keep one`,
    );
  }
  const entry = entries[0]!;
  return { song, trackName: track.data.name, node: generatorName(entry, track.data.name), entry };
}

// Where a track's timeline begins on the song's: the sum of the `at`s
// down its first placement path from the output track, in seconds.
// The daemon reported the take's start on the song's timeline (the
// session it played), and the take is placed on the track's, so this is
// the difference between them. A track placed more than once records
// against its earliest placement — `placements` says how many there
// were, so the caller can say so — and a track the song does not place
// at all has its own timeline from zero.
export function trackOrigin(
  project: LoadedProject,
  song: LoadedSong,
  target: string,
): { seconds: number; placements: number } {
  const songRate = song.song?.data.rate ?? project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const tempo = song.time ? new TempoMap(song.time.tempo, songRate) : undefined;
  const byName = new Map(song.tracks.map((t) => [t.data.name, t.data]));
  const origins: number[] = [];
  const visit = (name: string, origin: number, path: Set<string>): void => {
    if (name === target) {
      origins.push(origin);
      return;
    }
    const track = byName.get(name);
    if (track === undefined || path.has(name)) return;
    const onPath = new Set(path).add(name);
    for (const entry of track.inputs) {
      if (entry.track === undefined) continue;
      // `at` is samples at the placing track's rate when absolute, ticks
      // under the song's map otherwise (validate resolved every array).
      const at =
        entry.anchor === 'absolute'
          ? entry.at / (track.rate ?? songRate)
          : tempo !== undefined
            ? tempo.ticksToSeconds(entry.at)
            : 0;
      visit(entry.track, origin + at, onPath);
    }
  };
  visit(SONG_OUTPUT_NAME, 0, new Set());
  return { seconds: origins.length > 0 ? Math.min(...origins) : 0, placements: origins.length };
}

export interface LandOptions {
  monitoring?: string | undefined; // audio-engine.md "Monitoring": apollo-direct is V1
  consolePreset?: string | undefined;
}

export interface LandedTake {
  song: string;
  track: string;
  node: string;
  asset: string; // the take's ledger name
  file: string; // song-relative
  row: RecordedTake;
  placedAt: number; // track samples: the entry's window start + started_at_samples - latency
  placements: number; // how many times the song places the track
  frames: number;
  sampleRate: number;
}

// A finalized transaction's manifest, read back from disk for --land.
export function readTransaction(root: string, id: string): Take {
  const path = join(root, '.field', 'recording', id, 'manifest.json');
  if (!existsSync(path)) throw new Error(`no recording transaction ${id}`);
  const take = takeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (!take.complete) {
    throw new Error(`${id} is not complete — field record --recover ${id} finalizes it first`);
  }
  return take;
}

function musicalPosition(meter: MeterMap, ticks: number): number[] {
  const parts = meter
    .format(Math.max(0, ticks))
    .split('.')
    .map((p) => Number(p));
  // [17, 1, 1] is bar 17, which the array form spells [17].
  while (parts.length > 1 && parts[parts.length - 1] === 1) parts.pop();
  return parts;
}

export async function landTake(root: string, take: Take, options: LandOptions = {}): Promise<LandedTake> {
  if (!take.complete || take.frames === undefined) {
    throw new Error(`${take.id} is not complete — field record --recover ${take.id} finalizes it first`);
  }
  const project = loadProject(root);
  const errors = project.diagnostics.filter((d) => d.severity !== 'warning');
  if (errors.length > 0) {
    throw new Error(`project has errors (field check) — fix them before landing ${take.id}`);
  }
  const { song, trackName, node, entry } = recordNodeFor(project, take.track);
  const songDir = join(root, song.dir);
  const track = song.tracks.find((t) => t.data.name === trackName)!.data;

  // The bytes, into the song's ledger under the record node's directory.
  const source = join(root, take.file);
  if (!existsSync(source)) throw new Error(`${take.file} is missing — nothing to land`);
  const { doc: ledger, assets } = openLedger(songDir);
  if (assets.some((a) => a.name === take.id) || takenSongNames(songDir).has(take.id)) {
    throw new Error(`"${take.id}" is already a name in ${song.name} — was this take landed already?`);
  }
  const file = `audio/${node}/${take.id}.wav`;
  const dest = join(songDir, 'audio', node, `${take.id}.wav`);
  mkdirSync(join(songDir, 'audio', node), { recursive: true });
  copyFileSync(source, dest);
  const header = readWavHeader(dest);
  const sha256 = await sha256File(dest);
  const bytes = statSync(dest).size;

  // The record: placement counted from the record entry's own window,
  // at the track's rate — the same reading the graph makes (graph.ts
  // withTakes adds the window start back), so the entry's placement
  // fields mean what they mean on every other kind and moving its `at`
  // moves its takes. The daemon's start is on the bed's timeline at the
  // bed's rate; the track's origin on that timeline comes off, the rate
  // changes, then the entry's window start comes off in track samples.
  // Latency is the device's declared round trip (§12.3 — input plus
  // output, which is what a performer hearing the interface's direct
  // path actually runs behind), scaled from device samples the same way.
  const songRate = song.song?.data.rate ?? project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const trackRate = track.rate ?? songRate;
  const timelineRate = take.timeline_rate ?? take.sample_rate;
  const origin = trackOrigin(project, song, trackName);
  const startedOnBed = take.started_at_samples ?? 0;
  const onTrack = Math.round(
    ((startedOnBed - Math.round(origin.seconds * timelineRate)) * trackRate) / timelineRate,
  );
  // The entry's window under the track's own map, as the graph projects
  // it (nested-tracks.md §13): a track's `time:` when it has one, else
  // the song's at the track's rate.
  const tempoEvents = track.time?.tempo ?? song.time?.tempo;
  const windowStart =
    tempoEvents !== undefined
      ? placedWindow(entry, new TempoMap(tempoEvents, trackRate)).start
      : entry.anchor === 'absolute'
        ? entry.at
        : 0;
  const startedAt = onTrack - windowStart;
  const latency = Math.round(((take.input_latency + take.output_latency) * trackRate) / take.sample_rate);
  const position =
    take.song !== undefined && song.time !== undefined
      ? musicalPosition(
          new MeterMap(song.time.meter),
          Math.round(new TempoMap(song.time.tempo, timelineRate).samplesToTicks(startedOnBed)),
        )
      : undefined;
  const row: RecordedTake = {
    asset: take.id,
    started_at_samples: startedAt,
    ...(position !== undefined ? { musical_position: position } : {}),
    latency,
    device: take.device,
    input: take.input,
    ...(options.monitoring !== undefined ? { monitoring: options.monitoring } : {}),
    ...(options.consolePreset !== undefined ? { console_preset: options.consolePreset } : {}),
    recorded_at: take.started_wall,
  };

  // Ledger first, then the row that names it, then the transaction goes:
  // at every point a crash leaves a project `check` can describe — an
  // orphan file, a pinned asset no row names — rather than a row whose
  // bytes are not there.
  appendLedgerRow(songDir, ledger, { name: take.id, file, sha256, bytes, header });
  const takesPath = recordTakesPath(songDir, node);
  let doc: Document;
  if (existsSync(takesPath)) {
    doc = parseDocument(readFileSync(takesPath, 'utf8'));
    if (doc.errors.length > 0) {
      throw new Error(`invalid YAML in ${takesPath}: ${doc.errors[0]!.message}`);
    }
    const parsed = recordTakesSchema.safeParse(doc.toJS());
    if (!parsed.success || parsed.data.record !== node) {
      throw new Error(`the takes in audio/${node}/ are invalid or attach elsewhere (field check)`);
    }
  } else {
    doc = new Document({ record: node, takes: [] });
  }
  if (!isSeq(doc.getIn(['takes']))) doc.setIn(['takes'], doc.createNode([]));
  doc.addIn(['takes'], doc.createNode(row));
  doc.setIn(['chosen'], take.id);
  canonicalizeDocument(doc, recordTakesOrder);
  writeFileSync(takesPath, stringifyDocument(doc));
  rmSync(join(root, '.field', 'recording', take.id), { recursive: true, force: true });

  return {
    song: song.name,
    track: trackName,
    node,
    asset: take.id,
    file,
    row,
    placedAt: windowStart + startedAt - latency,
    placements: origin.placements,
    frames: header.frames,
    sampleRate: header.sampleRate,
  };
}

// `field choose <song>/<node> --take <name>`: repoint which take the
// record entry plays, the way choosing a variant repoints a gen node.
// One line in audio/<node>/takes.yaml; the bytes never move.
export async function chooseTake(
  root: string,
  songName: string,
  node: string,
  takeName: string,
): Promise<{ previous?: string | undefined }> {
  const project = loadProject(root);
  const song = project.songs.find((s) => s.name === songName);
  if (song === undefined) throw new Error(`song "${songName}" does not exist`);
  const minted = song.tracks.some((t) =>
    t.data.inputs.some((e) => e.record !== undefined && generatorName(e, t.data.name) === node),
  );
  if (!minted) throw new Error(`no record entry "${node}" in ${songName}`);
  const takesPath = recordTakesPath(join(root, song.dir), node);
  if (!existsSync(takesPath)) {
    throw new Error(`"${node}" has no takes yet — field record ${songName}/track:${node}`);
  }
  const doc = parseDocument(readFileSync(takesPath, 'utf8'));
  const parsed = recordTakesSchema.safeParse(doc.toJS());
  if (!parsed.success || parsed.data.record !== node) {
    throw new Error(`the takes in audio/${node}/ are invalid or attach elsewhere (field check)`);
  }
  if (!parsed.data.takes.some((t) => t.asset === takeName)) {
    throw new Error(
      `no take "${takeName}" in audio/${node}/ — the takes are: ${parsed.data.takes.map((t) => t.asset).join(', ')}`,
    );
  }
  const previous = parsed.data.chosen;
  doc.setIn(['chosen'], takeName);
  canonicalizeDocument(doc, recordTakesOrder);
  writeFileSync(takesPath, stringifyDocument(doc));
  return { previous };
}
