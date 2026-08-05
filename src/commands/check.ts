import { loadProject, unformattedFiles, verifyAssetHashes, type Diagnostic } from '../model/project.js';

export interface CheckResult {
  diagnostics: Diagnostic[];
  unformatted: string[];
  ok: boolean;
}

export async function check(root: string): Promise<CheckResult> {
  const project = loadProject(root);
  const diagnostics = [...project.diagnostics, ...(await verifyAssetHashes(project))];
  // Formatting is only judged for files that parsed and validated; schema
  // errors already make the run fail.
  const unformatted = diagnostics.length === 0 ? unformattedFiles(project) : [];
  return {
    diagnostics,
    unformatted,
    ok: diagnostics.length === 0 && unformatted.length === 0,
  };
}
