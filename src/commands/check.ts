import { loadProject, unformattedFiles, type Diagnostic } from '../model/project.js';

export interface CheckResult {
  diagnostics: Diagnostic[];
  unformatted: string[];
  ok: boolean;
}

export function check(root: string): CheckResult {
  const project = loadProject(root);
  // Formatting is only judged for files that parsed and validated; schema
  // errors already make the run fail.
  const unformatted = project.diagnostics.length === 0 ? unformattedFiles(project) : [];
  return {
    diagnostics: project.diagnostics,
    unformatted,
    ok: project.diagnostics.length === 0 && unformatted.length === 0,
  };
}
