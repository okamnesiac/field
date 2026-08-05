import { join } from 'node:path';
import { parsePattern } from '../labels.js';
import { formatLabel } from '../labels.js';
import { build, type RuleRunner } from '../graph/build.js';
import { expandPattern } from '../graph/graph.js';
import { loadValid } from './build.js';

export interface Playable {
  label: string;
  path: string; // absolute path to a playable file
}

// What `bloom play` plays: asset targets resolve to their files directly;
// rule targets are built (cache-aware) and resolve to their materialized
// outputs. This is the audition path until the real-time engine exists —
// playback.md owns transport, mixing, and the daemon.
export async function resolvePlayables(
  root: string,
  patterns: string[],
  runner?: RuleRunner,
): Promise<Playable[]> {
  const { project, graph } = loadValid(root);
  const requested = patterns.flatMap((p) => expandPattern(graph, parsePattern(p)));

  const seen = new Set<string>();
  const nodes = requested.filter((n) => {
    const label = formatLabel(n.label);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });

  const outcomes = await build(project, graph, nodes, runner);
  const outputs = new Map(outcomes.map((o) => [o.label, o]));

  return nodes.map((node) => {
    const label = formatLabel(node.label);
    if (node.kind === 'asset') {
      return { label, path: join(project.root, node.songDir, node.asset.file) };
    }
    const outcome = outputs.get(label);
    if (!outcome?.outputPath) throw new Error(`no output for ${label}`);
    return { label, path: outcome.outputPath };
  });
}
