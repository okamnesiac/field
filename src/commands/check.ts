import {
  diagnosticErrors,
  loadProject,
  unformattedFiles,
  verifyAssetHashes,
  type Diagnostic,
} from '../model/project.js';
import { pinBeforeCheck, type PinEdit } from './plugins.js';

export interface CheckResult {
  diagnostics: Diagnostic[];
  unformatted: string[];
  // Identity lines this check wrote back (plugin-hosting.md decision 2)
  // — the first check after `- plugin: <name>` is what pins it, and the
  // caller says so, because a check that edits files silently would be
  // hidden state with extra steps.
  pinned: PinEdit[];
  ok: boolean;
}

export async function check(root: string): Promise<CheckResult> {
  const pinned = pinBeforeCheck(root);
  const project = loadProject(root);
  const diagnostics = [...project.diagnostics, ...(await verifyAssetHashes(project))];
  const errors = diagnosticErrors(diagnostics);
  // Formatting is only judged for files that parsed and validated; schema
  // errors already make the run fail. Warnings don't: a warned file is
  // still a valid file, and its formatting is still worth judging.
  const unformatted = errors.length === 0 ? unformattedFiles(project) : [];
  return {
    diagnostics,
    unformatted,
    pinned,
    // Warnings report without failing the gate (model/project.ts).
    ok: errors.length === 0 && unformatted.length === 0,
  };
}
