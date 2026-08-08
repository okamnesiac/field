import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { stringifyCanonical } from '../yaml/emit.js';

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
  // `field track create` deliberately does *not* place the track it makes:
  // a track with no clips has no stem and so no node, and a placement of
  // one is refused. Placing at creation would mean every new song failed
  // `check` until its first clip landed. Whether creating a track should
  // place it — and therefore whether an empty track should render as
  // silence — is open.
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
  return path;
}
