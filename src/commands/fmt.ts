import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject, unformattedFiles } from '../model/project.js';
import { canonicalText } from '../yaml/emit.js';
import {
  arrangementOrder,
  projectOrder,
  songOrder,
  takeOrder,
  tempoFileOrder,
  trackOrder,
} from '../schema/schemas.js';
import type { KeyOrder } from '../yaml/emit.js';

// Rewrite unformatted files to canonical form. Comments survive: fmt
// reorders the parsed document rather than re-emitting from data
// (project-core.md §3.6).
export function fmt(root: string): { formatted: string[]; errors: string[] } {
  const project = loadProject(root);
  const errors = project.diagnostics.map((d) => `${d.file}: ${d.message}`);
  if (errors.length > 0) return { formatted: [], errors };

  const orderFor = (path: string): KeyOrder => {
    if (path === 'bloom.yaml') return projectOrder;
    if (path.endsWith('song.yaml')) return songOrder;
    if (path.endsWith('tempo.yaml')) return tempoFileOrder;
    if (path.endsWith('arrangement.yaml')) return arrangementOrder;
    if (path.includes('/takes/')) return takeOrder;
    return trackOrder;
  };

  const formatted: string[] = [];
  for (const path of unformattedFiles(project)) {
    const abs = join(project.root, path);
    const raw = [project.manifest, ...project.songs.flatMap((s) => [s.song, s.tempo, s.arrangement, ...s.tracks, ...s.takes])]
      .find((f) => f?.path === path)?.raw;
    if (raw === undefined) continue;
    writeFileSync(abs, canonicalText(raw, orderFor(path)));
    formatted.push(path);
  }
  return { formatted, errors: [] };
}
