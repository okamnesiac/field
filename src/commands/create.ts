import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, isSeq } from 'yaml';
import { isSlug } from '../ids.js';
import { RESERVED_LABEL_NAME, SONG_OUTPUT_NAME } from '../labels.js';
import {
  songOrder,
  songSchema,
  tempoFileOrder,
  tempoFileSchema,
  trackOrder,
  trackSchema,
} from '../schema/index.js';
import { canonicalizeDocument, stringifyCanonical, stringifyDocument } from '../yaml/emit.js';

export function createSong(root: string, name: string): string {
  if (!isSlug(name)) throw new Error(`song name "${name}" must be a lowercase-slug`);
  const dir = join(root, 'songs', name);
  if (existsSync(join(dir, 'song.yaml'))) {
    throw new Error(`song "${name}" already exists`);
  }
  mkdirSync(join(dir, 'tracks'), { recursive: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
  writeFileSync(join(dir, 'tracks', '.gitkeep'), '');
  writeFileSync(join(dir, 'audio', '.gitkeep'), '');

  // song.yaml is the existence marker the guard above checks, so it is
  // written last: a partial failure leaves a directory that createSong can
  // still be re-run against.
  const tempo = tempoFileSchema.parse({
    tempo: [{ at: 0, bpm: 120 }],
    meter: [{ at: 0, numerator: 4, denominator: 4 }],
  });
  writeFileSync(join(dir, 'tempo.yaml'), stringifyCanonical(tempo, tempoFileOrder));
  // Every song has an output from birth, and it is a track now: the bare
  // song name resolves to //songs/<name>/track:main (labels.ts
  // SONG_OUTPUT_NAME), so the thing that label points at has to be what
  // the tool creates. Scaffolding a mix here instead would leave every new
  // song unreachable by its own name.
  //
  // It starts empty, and placing tracks in it is the author's step. A mix
  // with `tracks:` omitted meant "all of them" implicitly; a track holds
  // exactly what is placed in it, which is what lets one definition sit in
  // more than one parent (nested-tracks.md §1.3) and is why membership is
  // written down rather than inferred.
  //
  // `field track create` places each track it makes into this one, which
  // is the half of the mix's implicit "all audio tracks" people actually
  // relied on: create a track, put clips in it, hear it. That placement is
  // legal from the moment the track exists because an empty track renders
  // as silence (stem.ts renderableTrack).
  const main = trackSchema.parse({ name: SONG_OUTPUT_NAME, type: 'audio' });
  writeFileSync(
    join(dir, 'tracks', `${SONG_OUTPUT_NAME}.yaml`),
    stringifyCanonical(main, trackOrder),
  );
  writeFileSync(join(dir, 'song.yaml'), stringifyCanonical(songSchema.parse({ name }), songOrder));
  return dir;
}

export function createTrack(
  root: string,
  song: string,
  name: string,
  type: 'audio' | 'midi',
): string {
  if (!isSlug(name)) throw new Error(`track name "${name}" must be a lowercase-slug`);
  if (name === RESERVED_LABEL_NAME) {
    throw new Error(`"${RESERVED_LABEL_NAME}" is reserved by the label grammar`);
  }
  const songDir = join(root, 'songs', song);
  if (!existsSync(join(songDir, 'song.yaml'))) {
    throw new Error(`song "${song}" does not exist (field song create ${song})`);
  }
  const path = join(songDir, 'tracks', `${name}.yaml`);
  if (existsSync(path)) throw new Error(`track "${name}" already exists in "${song}"`);
  mkdirSync(join(songDir, 'tracks'), { recursive: true });
  writeFileSync(path, stringifyCanonical(trackSchema.parse({ name, type }), trackOrder));
  placeInSongOutput(songDir, name, type);
  return path;
}

// A new track joins the song's output, at its start, so a song this tool
// creates is playable by its own name as soon as it has content. Somebody
// has to write the placement now that containment is explicit
// (nested-tracks.md §1.4), and the command that creates the track is the
// one that knows.
//
// Quiet about what it cannot serve: a midi track has no stem to place,
// `main` cannot place itself, and a song predating the output track has
// nowhere to put it. None is an error — they are songs this has nothing to
// add to.
function placeInSongOutput(songDir: string, name: string, type: 'audio' | 'midi'): void {
  if (type !== 'audio' || name === SONG_OUTPUT_NAME) return;
  const outputPath = join(songDir, 'tracks', `${SONG_OUTPUT_NAME}.yaml`);
  if (!existsSync(outputPath)) return;
  // Edited as a document rather than round-tripped through JS: the output
  // track is a file people write comments in — bloom's says why its
  // limiter is there — and `toJS()` would drop every one. Same idiom as
  // `field import` appending to the asset ledger.
  const doc = parseDocument(readFileSync(outputPath, 'utf8'));
  if (doc.errors.length > 0) return; // a file we cannot parse is not ours to rewrite
  const parsed = trackSchema.safeParse(doc.toJS());
  if (!parsed.success) return;
  if (parsed.data.inputs.some((i) => i.track === name)) return;
  if (!isSeq(doc.getIn(['inputs']))) doc.setIn(['inputs'], doc.createNode([]));
  // Only what is not a default: placed at the song's start, nothing else
  // asserted. `check` accepts the omissions and `fmt` leaves them.
  doc.addIn(['inputs'], doc.createNode({ track: name, at: 0 }));
  canonicalizeDocument(doc, trackOrder);
  writeFileSync(outputPath, stringifyDocument(doc));
}
