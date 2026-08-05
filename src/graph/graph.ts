import { formatLabel, matchesPattern, type Label, type LabelPattern } from '../labels.js';
import type { LoadedProject } from '../model/project.js';
import type { Asset, Target } from '../schema/schemas.js';

// The dependency graph, derived from the project model by convention
// (project-core.md §3.4). Two node kinds so far: source assets and
// declared rule targets.

export interface AssetNode {
  kind: 'asset';
  label: Label;
  songDir: string; // project-relative song directory
  asset: Asset;
}

export interface RuleNode {
  kind: 'rule';
  label: Label;
  songDir: string;
  target: Target;
  deps: Label[];
}

export type GraphNode = AssetNode | RuleNode;

export interface Graph {
  nodes: Map<string, GraphNode>; // keyed by formatted label
}

// Requires a project with no diagnostics: the graph trusts what validate
// accepted (unique names, known references).
export function buildGraph(project: LoadedProject): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const song of project.songs) {
    const pkgBase = song.dir.split('/').join('/');
    if (song.assets) {
      for (const asset of song.assets.data.assets) {
        const label: Label = { pkg: `${pkgBase}/assets`, name: asset.name };
        nodes.set(formatLabel(label), { kind: 'asset', label, songDir: song.dir, asset });
      }
    }
    if (song.targets) {
      for (const target of song.targets.data.targets) {
        const label: Label = { pkg: `${pkgBase}/targets`, name: target.name };
        // Only asset references become graph edges; an sc-render program is
        // an input by content hash, not a node.
        const deps: Label[] =
          target.rule === 'normalize' ? [{ pkg: `${pkgBase}/assets`, name: target.input }] : [];
        nodes.set(formatLabel(label), {
          kind: 'rule',
          label,
          songDir: song.dir,
          target,
          deps,
        });
      }
    }
  }
  return { nodes };
}

export function resolveLabel(graph: Graph, label: Label): GraphNode {
  const node = graph.nodes.get(formatLabel(label));
  if (!node) throw new Error(`no such target: ${formatLabel(label)}`);
  return node;
}

export function expandPattern(graph: Graph, pattern: LabelPattern): GraphNode[] {
  const matched = [...graph.nodes.values()].filter((n) => matchesPattern(n.label, pattern));
  if (matched.length === 0) {
    throw new Error('pattern matched no targets');
  }
  return matched;
}

// Transitive dependencies of a node, dependencies first, node last.
export function deps(graph: Graph, start: GraphNode): GraphNode[] {
  const out: GraphNode[] = [];
  const seen = new Set<string>();
  const visit = (node: GraphNode) => {
    const key = formatLabel(node.label);
    if (seen.has(key)) return;
    seen.add(key);
    if (node.kind === 'rule') {
      for (const dep of node.deps) visit(resolveLabel(graph, dep));
    }
    out.push(node);
  };
  visit(start);
  return out;
}
