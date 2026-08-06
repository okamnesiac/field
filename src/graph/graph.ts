import { join, posix } from 'node:path';
import { wavFrameCount } from '../audio/wav.js';
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

// A generation variant (ace-generation.md §3.1): committed, content-addressed
// audio like an asset, addressable so `bloom play` can audition it — but
// deliberately not referenceable by clips or rules. Promotion via
// `bloom ace choose` is what turns a variant into an asset.
export interface GenerationNode {
  kind: 'generation';
  label: Label;
  songDir: string;
  file: string; // song-dir-relative (generation/<name>/<variant>.wav)
  sha256: string;
}

export type GraphNode = AssetNode | RuleNode | GenerationNode;

export interface Graph {
  nodes: Map<string, GraphNode>; // keyed by formatted label
}

// Requires a project with no diagnostics: the graph trusts what validate
// accepted (unique names, known references, valid tempo maps).
export function buildGraph(project: LoadedProject): Graph {
  const sampleRate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const nodes = new Map<string, GraphNode>();
  const addRule = (label: Label, songDir: string, spec: RuleSpec) => {
    // Each rule declares which same-song assets and targets it consumes;
    // those are the graph edges, in that order — matching the input order
    // every impl expects. Other inputs (like sc programs) participate by
    // content hash without being nodes.
    const impl = ruleImpl(spec);
    const deps: Label[] = [
      ...impl.assetDeps(spec).map((name): Label => ({ pkg: `${songDir}/assets`, name })),
      ...(impl.targetDeps?.(spec) ?? []).map(
        (name): Label => ({ pkg: `${songDir}/targets`, name }),
      ),
    ];
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
    for (const recipe of song.generation) {
      recipe.data.variants.forEach((variant, i) => {
        // Numbered like the files on disk: //songs/<song>/generation:<name>-<i>.
        const label: Label = { pkg: `${pkgBase}/generation`, name: `${recipe.data.name}-${i + 1}` };
        nodes.set(formatLabel(label), {
          kind: 'generation',
          label,
          songDir: song.dir,
          file: posix.join('generation', variant.file),
          sha256: variant.sha256,
        });
      });
    }
    const mixable = song.tracks
      .filter((t) => t.data.type === 'audio' && t.data.clips.length > 0)
      .map((t) => t.data);
    if (song.tempo) {
      const tempoMap = new TempoMap(song.tempo.data.tempo, sampleRate);
      // Loops without `every` tile at the source's length, so the plan
      // needs frame counts — but only for the assets such loops touch.
      const fileByAsset = new Map(song.assets?.data.assets.map((a) => [a.name, a.file]) ?? []);
      const framesByAsset = new Map<string, number>();
      for (const track of mixable) {
        for (const clip of track.clips) {
          if (clip.loop?.enabled && clip.loop.every === undefined && clip.asset) {
            const file = fileByAsset.get(clip.asset);
            if (file && !framesByAsset.has(clip.asset)) {
              framesByAsset.set(clip.asset, wavFrameCount(join(project.root, song.dir, file)));
            }
          }
        }
      }
      for (const track of mixable) {
        // MIDI tracks have no audio to render, and an empty stem is not a
        // useful artifact — implicit targets exist where there is content.
        addRule(
          { pkg: `${pkgBase}/tracks`, name: track.name },
          song.dir,
          planTrack(track, tempoMap, sha256ByAsset, framesByAsset),
        );
      }
      if (song.mix) {
        // A declared song length projects to samples here, where the tempo
        // map lives; the mix renders exactly that long.
        const lengthSamples =
          song.song?.data.length !== undefined
            ? tempoMap.ticksToSamples(song.song.data.length)
            : undefined;
        for (const mix of song.mix.data.mixes) {
          const spec = planMix(mix, mixable, lengthSamples, song.song?.data.loop);
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
    // Echo the expanded form: with songs-relative shorthand, what the
    // user typed is not always what was looked up.
    const expanded =
      pattern.kind === 'label'
        ? formatLabel(pattern.label)
        : pattern.kind === 'package-all'
          ? `//${pattern.pkg}:all`
          : pattern.pkg === ''
            ? '//...'
            : `//${pattern.pkg}/...`;
    throw new Error(`pattern matched no targets: ${expanded}`);
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
