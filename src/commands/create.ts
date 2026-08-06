import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSlug } from '../ids.js';
import { RESERVED_TARGET_NAME } from '../labels.js';
import {
  mixOrder,
  mixSchema,
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
  // Every song is mixable from birth: main mixes all audio tracks with
  // clips, so //songs/<name>/mix:main exists as soon as there is content.
  mkdirSync(join(dir, 'mixes'), { recursive: true });
  const mix = mixSchema.parse({ name: 'main' });
  writeFileSync(join(dir, 'mixes', 'main.yaml'), stringifyCanonical(mix, mixOrder));
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
  if (name === RESERVED_TARGET_NAME) {
    throw new Error(`"${RESERVED_TARGET_NAME}" is reserved by the label grammar`);
  }
  const songDir = join(root, 'songs', song);
  if (!existsSync(join(songDir, 'song.yaml'))) {
    throw new Error(`song "${song}" does not exist (bloom song create ${song})`);
  }
  const path = join(songDir, 'tracks', `${name}.yaml`);
  if (existsSync(path)) throw new Error(`track "${name}" already exists in "${song}"`);
  mkdirSync(join(songDir, 'tracks'), { recursive: true });
  writeFileSync(path, stringifyCanonical(trackSchema.parse({ name, type }), trackOrder));
  return path;
}
