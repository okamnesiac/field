import { parseLabel, parsePattern } from '../labels.js';
import { loadProject, type LoadedProject } from '../model/project.js';
import { build, explain, type BuildOutcome, type Explanation, type RuleRunner } from '../graph/build.js';
import { buildGraph, deps, expandPattern, resolveLabel, type Graph } from '../graph/graph.js';
import { formatLabel } from '../labels.js';

// Building trusts only a valid project: schema or reference errors fail
// fast rather than producing artifacts from a model check would reject.
function loadValid(root: string): { project: LoadedProject; graph: Graph } {
  const project = loadProject(root);
  if (project.diagnostics.length > 0) {
    const lines = project.diagnostics.map((d) => `${d.file}: ${d.message}`).join('\n');
    throw new Error(`project has errors (bloom check):\n${lines}`);
  }
  return { project, graph: buildGraph(project) };
}

export async function buildTargets(
  root: string,
  patterns: string[],
  runner?: RuleRunner,
): Promise<BuildOutcome[]> {
  const { project, graph } = loadValid(root);
  const nodes = patterns.flatMap((p) => expandPattern(graph, parsePattern(p)));
  return build(project, graph, nodes, runner);
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

export async function explainTarget(root: string, label: string): Promise<Explanation> {
  const { project, graph } = loadValid(root);
  return explain(project, graph, resolveLabel(graph, parseLabel(label)));
}
