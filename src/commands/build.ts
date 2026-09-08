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
import { pinBeforeCheck } from './plugins.js';
import { buildGraph, deps, expandPattern, resolveLabel, type Graph } from '../graph/graph.js';
import { formatLabel } from '../labels.js';
import { RemoteReads, projectCache } from '../remote/cache.js';
import { RemoteClient } from '../remote/client.js';
import { defaultCredentialStore, resolveToken, type CredentialStore } from '../remote/credentials.js';
import { resolveProjectRemote } from '../remote/origin.js';

// The project's remote as a read-through cache, or undefined when there
// is none (remote.md §5 decisions 3 and 4): reads are on whenever the
// origin is an audiofield git host or `FIELD_REMOTE` names one, off for
// `FIELD_REMOTE=off`, and off for one build with `--no-remote`. This is
// the command layer's job, not the engine's — `build()` and `explain()`
// take the result as a parameter so a build test never reads Git or
// the environment to find out whether a network is in reach.
export interface RemoteOptions {
  noRemote?: boolean | undefined;
  notice?: ((line: string) => void) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  store?: CredentialStore | undefined;
}

export function remoteReads(root: string, options: RemoteOptions = {}): RemoteReads | undefined {
  if (options.noRemote === true) return undefined;
  const env = options.env ?? process.env;
  const resolution = resolveProjectRemote(root, env);
  if (resolution.kind !== 'remote') return undefined;
  const { remote } = resolution;
  const token = resolveToken(remote.api, options.store ?? defaultCredentialStore(), env)?.token;
  const client = new RemoteClient(remote.api, { token });
  return new RemoteReads(projectCache(client, remote), options.notice);
}

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
  // "The first check or build" pins (plugin-hosting.md decision 2) —
  // build goes through here, not through check, so the pin step runs in
  // both gates or the settled workflow is half true (Codex). Edits
  // surface on the warnings channel; pin problems are diagnostics like
  // any other and hold the gate below.
  const pinOutcome = pinBeforeCheck(root);
  const project = loadProject(root);
  for (const { file, message } of pinOutcome.problems) {
    project.diagnostics.push({ file, message });
  }
  if (diagnosticErrors(project.diagnostics).length > 0) {
    const lines = project.diagnostics.map(formatDiagnostic).join('\n');
    throw new Error(`project has errors (field check):\n${lines}`);
  }
  const warnings = [
    ...pinOutcome.edits.map(
      (e) => `pinned ${e.plugin} → ${e.format} ${e.identifier} ${e.version} (${e.file})`,
    ),
    ...diagnosticWarnings(project.diagnostics).map(formatDiagnostic),
  ];
  return { project, graph: buildGraph(project), warnings };
}

export async function buildLabels(
  root: string,
  patterns: string[],
  runner?: GeneratorRunner,
  onWarning?: (line: string) => void,
  signal?: AbortSignal,
  remote?: RemoteReads,
): Promise<BuildOutcome[]> {
  const { project, graph, warnings } = loadValid(root);
  for (const line of warnings) onWarning?.(line);
  const nodes = patterns.flatMap((p) => expandPattern(graph, parsePattern(p)));
  return build(project, graph, nodes, runner, signal, remote);
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

export async function explainLabel(
  root: string,
  label: string,
  remote?: RemoteReads,
): Promise<Explanation> {
  const { project, graph } = loadValid(root);
  return explain(project, graph, resolveLabel(graph, parseLabel(label)), new Map(), remote);
}
