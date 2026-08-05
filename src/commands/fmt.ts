import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allFiles, loadProject } from '../model/project.js';
import { canonicalText } from '../yaml/emit.js';

// Rewrite unformatted files to canonical form. Comments survive: fmt
// reorders the parsed document rather than re-emitting from data
// (project-core.md §3.6). Each file's KeyOrder comes from the loader, so
// fmt and check can never disagree about a file's role.
export function fmt(root: string): { formatted: string[]; errors: string[] } {
  const project = loadProject(root);
  const errors = project.diagnostics.map((d) => `${d.file}: ${d.message}`);
  if (errors.length > 0) return { formatted: [], errors };

  const formatted: string[] = [];
  for (const file of allFiles(project)) {
    const canonical = canonicalText(file.raw, file.order);
    if (canonical === file.raw) continue;
    writeFileSync(join(project.root, file.path), canonical);
    formatted.push(file.path);
  }
  return { formatted, errors: [] };
}
