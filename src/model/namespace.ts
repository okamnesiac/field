import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  assetsFileSchema,
  generativeTakesSchema,
  soundSchema,
  TAKES_FILENAME,
} from '../schema/index.js';

// The song's one namespace (project-layout.md §4.3), read cheaply from
// disk for command pre-flight: asset names, sound names, and the
// <name>-<n> audition labels generative sounds mint. Commands that
// introduce a name (import, generate) check here so a collision is an
// upfront error instead of a check-red project after the work — and the
// model-minutes — are already spent. Unparseable files contribute their
// filename only: pre-flight must never crash on a file field check owns
// diagnosing.
export function takenSongNames(songDir: string): Set<string> {
  const taken = new Set<string>();
  const assetsPath = join(songDir, 'assets.yaml');
  if (existsSync(assetsPath)) {
    const parsed = assetsFileSchema.safeParse(
      parseDocument(readFileSync(assetsPath, 'utf8')).toJS(),
    );
    if (parsed.success) for (const asset of parsed.data.assets) taken.add(asset.name);
  }
  const soundsDir = join(songDir, 'sounds');
  if (existsSync(soundsDir)) {
    for (const file of readdirSync(soundsDir)) {
      // Dotfiles are editor debris, not sounds — and a dangling one
      // (Emacs' `.#hum.yaml`) would throw ENOENT on the read below,
      // which is exactly the crash this pre-flight promises not to be.
      if (!file.endsWith('.yaml') || file.startsWith('.')) continue;
      taken.add(basename(file, '.yaml'));
      const parsed = soundSchema.safeParse(
        parseDocument(readFileSync(join(soundsDir, file), 'utf8')).toJS(),
      );
      if (parsed.success && parsed.data.type === 'generative') {
        // Audition labels are minted by takes, and takes live beside the
        // audio (bloom-in-tree.md §7). A recipe with no run behind it
        // mints none, which is why this reads the other file rather than
        // the one it just parsed.
        const name = parsed.data.name;
        const takesFile = join(songDir, 'audio', name, TAKES_FILENAME);
        if (existsSync(takesFile)) {
          const takes = generativeTakesSchema.safeParse(
            parseDocument(readFileSync(takesFile, 'utf8')).toJS(),
          );
          if (takes.success) {
            takes.data.variants.forEach((_, i) => taken.add(`${name}-${i + 1}`));
          }
        }
      }
    }
  }
  return taken;
}
