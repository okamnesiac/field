import { formatLabel, matchesPattern, type Label, type LabelPattern } from '../labels.js';
import type { LoadedProject } from '../model/project.js';
import { ruleImpl, type RuleSpec } from '../rules/index.js';
import { planMix } from '../rules/mix.js';
import { planTrack } from '../rules/track-render.js';
import { TempoMap } from '../time/tempo.js';
import type { Asset } from '../schema/schemas.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';

// The dependency graph, derived from the project model by convention
// (project-core.md §3.4). Node kinds so far: source assets, declared rule
// targets (targets.yaml), and implicit track stems — every audio track with
// clips is buildable as //songs/<song>/tracks:<name> (mix-assembly.md §3).

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
  // A declared target, or a spec synthesized from the model (track-render).
  spec: RuleSpec;
  deps: Label[];
}

export type GraphNode = AssetNode | RuleNode;

export interface Graph {
  nodes: Map<string, GraphNode>; // keyed by formatted label
}

// Requires a project with no diagnostics: the graph trusts what validate
// accepted (unique names, known references, valid tempo maps).
export function buildGraph(project: LoadedProject): Graph {
  const sampleRate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const nodes = new Map<string, GraphNode>();
  const addRule = (label: Label, songDir: string, spec: RuleSpec) => {
    // Each rule declares which same-song assets it consumes; those are the
    // graph edges. Other inputs (like sc programs) participate by content
    // hash without being nodes.
    const deps: Label[] = ruleImpl(spec)
      .assetDeps(spec)
      .map((name) => ({ pkg: `${songDir}/assets`, name }));
    nodes.set(formatLabel(label), { kind: 'rule', label, songDir, spec, deps });
  };

  for (const song of project.songs) {
    const pkgBase = song.dir;
    const sha256ByAsset = new Map<string, string>();
    if (song.assets) {
      for (const asset of song.assets.data.assets) {
        const label: Label = { pkg: `${pkgBase}/assets`, name: asset.name };
        nodes.set(formatLabel(label), { kind: 'asset', label, songDir: song.dir, asset });
        sha256ByAsset.set(asset.name, asset.sha256);
      }
    }
    if (song.targets) {
      for (const target of song.targets.data.targets) {
        addRule({ pkg: `${pkgBase}/targets`, name: target.name }, song.dir, target);
      }
    }
    const mixable = song.tracks
      .filter((t) => t.data.type === 'audio' && t.data.clips.length > 0)
      .map((t) => t.data);
    if (song.tempo) {
      const tempoMap = new TempoMap(song.tempo.data.tempo, sampleRate);
      for (const track of mixable) {
        // MIDI tracks have no audio to render, and an empty stem is not a
        // useful artifact — implicit targets exist where there is content.
        const spec = planTrack(track, tempoMap, sha256ByAsset);
        const label: Label = { pkg: `${pkgBase}/tracks`, name: track.name };
        // Dep order mirrors the spec's input order: assets, then clip-source
        // targets — a clip on an SC render pulls the whole recipe into the
        // stem's subgraph (mix-assembly.md §5).
        const deps: Label[] = [
          ...spec.assets.map((name): Label => ({ pkg: `${pkgBase}/assets`, name })),
          ...spec.targets.map((name): Label => ({ pkg: `${pkgBase}/targets`, name })),
        ];
        nodes.set(formatLabel(label), { kind: 'rule', label, songDir: song.dir, spec, deps });
      }
      if (song.mix) {
        for (const mix of song.mix.data.mixes) {
          const spec = planMix(mix, mixable);
          if (spec.tracks.length === 0) continue; // nothing to mix yet
          // Mix inputs are track stems — rule→rule edges, wired here where
          // the spec is synthesized rather than through assetDeps (which is
          // for asset-package edges).
          const label: Label = { pkg: `${pkgBase}/mix`, name: mix.name };
          const deps = spec.tracks.map((name): Label => ({ pkg: `${pkgBase}/tracks`, name }));
          nodes.set(formatLabel(label), { kind: 'rule', label, songDir: song.dir, spec, deps });
        }
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
