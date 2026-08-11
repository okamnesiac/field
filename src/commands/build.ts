import { relative, sep } from 'node:path';
import { parseLabel, parsePattern } from '../labels.js';
import {
  diagnosticErrors,
  diagnosticWarnings,
  formatDiagnostic,
  loadProject,
  type LoadedProject,
} from '../model/project.js';
import { build, explain, type BuildOutcome, type Explanation, type GeneratorRunner } from '../graph/build.js';
import { buildGraph, deps, expandPattern, resolveLabel, type Graph } from '../graph/graph.js';
import { formatLabel } from '../labels.js';

// Output paths print relative to the project root. Every path a build
// reports is inside the project, so the absolute prefix is the same on
// every line and says nothing — while pushing the part that differs off
// the edge of a terminal, which is also what swamped the status column's
// alignment (#38 review). A path that somehow lands outside the root
// stays absolute rather than being spelled in `../..`: it is the one
// case where the prefix carries the information.
export function projectRelative(root: string, path: string): string {
  const rel = relative(root, path);
  // "Outside the root" means `..` itself or a leading `..` *segment* —
  // not any name that merely begins with two dots, which a bare
  // startsWith would also catch (#42 review). Unreachable for build
  // outputs, whose path parts are slugs by grammar, but the line should
  // mean what it looks like it means.
  const outside = rel === '..' || rel.startsWith(`..${sep}`);
  return rel === '' || outside ? path : rel;
}

// Building trusts only a valid project: schema or reference errors fail
// fast rather than producing artifacts from a model check would reject.
// Warnings don't hold the gate — they ride back as formatted lines for
// the caller to surface (the CLI's build prints them; query commands
// stay quiet).
export function loadValid(root: string): {
  project: LoadedProject;
  graph: Graph;
  warnings: string[];
} {
  const project = loadProject(root);
  if (diagnosticErrors(project.diagnostics).length > 0) {
    const lines = project.diagnostics.map(formatDiagnostic).join('\n');
    throw new Error(`project has errors (field check):\n${lines}`);
  }
  const warnings = diagnosticWarnings(project.diagnostics).map(formatDiagnostic);
  return { project, graph: buildGraph(project), warnings };
}

export async function buildLabels(
  root: string,
  patterns: string[],
  runner?: GeneratorRunner,
  onWarning?: (line: string) => void,
  signal?: AbortSignal,
): Promise<BuildOutcome[]> {
  const { project, graph, warnings } = loadValid(root);
  for (const line of warnings) onWarning?.(line);
  const nodes = patterns.flatMap((p) => expandPattern(graph, parsePattern(p)));
  return build(project, graph, nodes, runner, signal);
}

export function queryDeps(root: string, query: string): string[] {
  const { graph } = loadValid(root);
  const m = /^deps\(([^)]+)\)$/.exec(query.trim());
  if (m) {
    const node = resolveLabel(graph, parseLabel(m[1]!.trim()));
    return deps(graph, node).map((n) => formatLabel(n.label));
  }
  // A bare pattern lists what it matches.
  return expandPattern(graph, parsePattern(query.trim())).map((n) => formatLabel(n.label));
}

export async function explainLabel(root: string, label: string): Promise<Explanation> {
  const { project, graph } = loadValid(root);
  return explain(project, graph, resolveLabel(graph, parseLabel(label)));
}
