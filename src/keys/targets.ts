import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { resolveRecordTarget } from '../commands/record.js';
import { findProjectRoot, loadProject, type LoadedSong } from '../model/project.js';
import { instrumentPath } from './voice-host.js';

// A bare instrument name resolves on the project's instruments shelf, as a
// supercollider: entry's source does; a path resolves from the project
// root, or from here outside a project (keyboard-instrument.md §2.1).
export function resolveInstrument(spec: string, cwd = process.cwd()): string {
  const root = findProjectRoot(cwd);
  if (root === undefined && !spec.includes('/')) {
    throw new Error(
      `field keys ${spec}: a bare instrument name resolves in a project's shared/instruments/, ` +
        'and this is not inside a Field project; give the program by path instead',
    );
  }
  const path = instrumentPath(spec, root ?? cwd);
  if (!existsSync(path)) {
    const shelf = root !== undefined ? `\n${describeShelf(root)}` : '';
    throw new Error(`field keys ${spec}: no instrument program at ${path}${shelf}`);
  }
  return path;
}

// The programs on a project's instruments shelf, by name, split by whether
// they can play from notes. A program that never reads FIELD_MODE cannot
// answer voice mode, so its text is enough to tell, without starting
// sclang for each one (keys.md "Make an instrument playable"). Each is
// listed by a name field keys resolves: `.scd` is added back only to a
// name with no extension, so pad.v2.scd lists whole.
function shelfInstruments(root: string): { playable: string[]; renderOnly: string[] } {
  const dir = join(root, 'shared', 'instruments');
  const playable: string[] = [];
  const renderOnly: string[] = [];
  if (!existsSync(dir)) return { playable, renderOnly };
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.scd'))
    .map((entry) => entry.name)
    .sort();
  for (const file of files) {
    const stem = file.slice(0, -'.scd'.length);
    const name = extname(stem) === '' ? stem : file;
    (readFileSync(join(dir, file), 'utf8').includes('FIELD_MODE') ? playable : renderOnly).push(name);
  }
  return { playable, renderOnly };
}

function describeShelf(root: string): string {
  const { playable, renderOnly } = shelfInstruments(root);
  if (playable.length + renderOnly.length === 0) return 'shared/instruments/ has no programs yet.';
  const lines = ['In shared/instruments/:', `  plays from notes: ${playable.length > 0 ? playable.join(', ') : 'none'}`];
  if (renderOnly.length > 0) {
    lines.push(`  renders only:     ${renderOnly.join(', ')} (no FIELD_MODE=voice branch; Field's docs/keys.md says how to add one)`);
  }
  return lines.join('\n');
}

// What `field keys` plays (arming.md §2.1): each instrument it was given
// by program, and each MIDI track it was given or found under a track it
// was given, all at once.
export interface ArmedInstrument {
  program: string; // absolute path to the instrument's program
  track?: string; // the MIDI track it plays for, `song/track`
  // Tracks from the one named down to the MIDI track whose inserts the
  // voice does not pass through yet (live-supercollider.md).
  unheardEffects: string[];
}

export function isTrackTarget(target: string): boolean {
  return target.includes('track:');
}

// A target with `track:` in it is a track; anything else is an
// instrument, by name or path, as keyboard-instrument.md §2.1 resolves
// one. Tracks need a project; instruments by path do not.
export function resolveKeysTargets(targets: string[], cwd = process.cwd()): ArmedInstrument[] {
  const armed: ArmedInstrument[] = [];
  const seen = new Set<string>();
  const add = (instrument: ArmedInstrument): void => {
    const key = instrument.track ?? instrument.program;
    if (seen.has(key)) return;
    seen.add(key);
    armed.push(instrument);
  };
  for (const target of targets) {
    if (!isTrackTarget(target)) {
      add({ program: resolveInstrument(target, cwd), unheardEffects: [] });
      continue;
    }
    const root = findProjectRoot(cwd);
    if (root === undefined) throw new Error(`field keys ${target}: a track resolves inside a Field project`);
    const { song: songName, track } = resolveRecordTarget(root, target);
    const project = loadProject(root);
    const song = project.songs.find((s) => s.name === songName)!;
    const found = midiTracksUnder(song, track);
    if (found.length === 0) {
      throw new Error(
        `field keys ${target}: no MIDI track there — a MIDI track is one whose record entry names an ` +
          'instrument (instrument: under record:), on the track or on a track under it',
      );
    }
    if (found.length > 1) {
      throw new Error(
        `field keys ${target}: ${found.length} MIDI tracks are under ${track}, and field keys plays the ` +
          `ones you name: ${found.map((f) => `${songName}/track:${f.track}`).join(', ')}`,
      );
    }
    const [midi] = found as [MidiTrack];
    const program = instrumentPath(midi.instrument, root);
    if (!existsSync(program)) {
      throw new Error(`field keys ${target}: ${midi.track}'s instrument ${midi.instrument} has no program at ${program}`);
    }
    add({ program, track: `${songName}/${midi.track}`, unheardEffects: midi.effects });
  }
  return armed;
}

interface MidiTrack {
  track: string;
  instrument: string;
  effects: string[]; // tracks on the way down, this one included, that have inserts
}

// The named track itself when its record entry names an instrument;
// otherwise every such track under it, down its `track:` inputs.
function midiTracksUnder(song: LoadedSong, name: string): MidiTrack[] {
  const byName = new Map(song.tracks.map((t) => [t.data.name, t.data]));
  const found: MidiTrack[] = [];
  const visit = (trackName: string, above: string[], path: Set<string>): void => {
    const track = byName.get(trackName);
    if (track === undefined || path.has(trackName)) return;
    const effects = track.inserts.length > 0 ? [...above, trackName] : above;
    const instrument = track.inputs.find((e) => e.record?.instrument !== undefined)?.record?.instrument;
    if (instrument !== undefined) {
      found.push({ track: trackName, instrument, effects });
      return;
    }
    const onPath = new Set(path).add(trackName);
    for (const entry of track.inputs) if (entry.track !== undefined) visit(entry.track, effects, onPath);
  };
  visit(name, [], new Set());
  return found;
}
