import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { generatorName } from '../generators/stem.js';
import { assetsFileSchema, trackSchema, type InputEntry } from '../schema/index.js';

// The song's one namespace (project-layout.md §4.3), read cheaply from
// disk for command pre-flight: asset names, plus the gen node names
// whose takes claim an audio/ directory. Commands that introduce a name
// (import, generate) check here so a collision is an upfront error
// instead of a check-red project after the work — and the
// model-minutes — are already spent. Unparseable files contribute
// nothing: pre-flight must never crash on a file field check owns
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
  // A generative entry's takes claim audio/<node>/ (nested-tracks.md
  // §18 step 3), so its gen node name is taken for the containment
  // reason — an import landing there would share the directory the
  // takes file pins.
  const tracksDir = join(songDir, 'tracks');
  if (existsSync(tracksDir)) {
    for (const file of readdirSync(tracksDir)) {
      if (!file.endsWith('.yaml') || file.startsWith('.')) continue;
      const parsed = trackSchema.safeParse(
        parseDocument(readFileSync(join(tracksDir, file), 'utf8')).toJS(),
      );
      if (!parsed.success) continue;
      for (const entry of parsed.data.inputs) {
        // A record entry's takes claim audio/<node>/ the same way
        // (recording.md §3).
        if (entry.generative === undefined && entry.record === undefined) continue;
        taken.add(generatorName(entry as InputEntry, parsed.data.name));
      }
    }
  }
  return taken;
}
