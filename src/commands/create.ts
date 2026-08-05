import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSlug } from '../ids.js';
import {
  songOrder,
  songSchema,
  tempoFileOrder,
  tempoFileSchema,
  trackOrder,
  trackSchema,
} from '../schema/schemas.js';
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
