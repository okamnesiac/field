import { join } from 'node:path';
import { wavFrameCount } from '../audio/wav.js';
import {
  formatLabel,
  matchesPattern,
  sharedAssetName,
  SHARED_ASSETS_PKG,
  type Label,
  type LabelPattern,
} from '../labels.js';
import type { LoadedProject } from '../model/project.js';
import { generatorFor, type GeneratorSpec } from '../generators/index.js';
import { planMix } from '../generators/mix.js';
import { planTrack } from '../generators/stem.js';
import { TempoMap } from '../time/tempo.js';
import type { Asset } from '../schema/index.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';

// The dependency graph, derived from the project model by convention
// (project-core.md §3.4). Node kinds so far: source assets (song and
// shared ledgers), defined sounds (sounds/), and implicit track stems —
// every audio track with clips is buildable as
// //songs/<song>/track:<name> (mix-assembly.md §3). "Node" and "rule"
// are deliberately the engine's words (project-layout.md §4): the
// format speaks sounds and types, and this module realizes them.

export interface AssetNode {
  kind: 'asset';
  label: Label;
  // Project-relative scope root the asset's file resolves against:
  // songs/<song>, or shared (project-layout.md §1.6).
  scopeDir: string;
  asset: Asset;
}

export interface GeneratorNode {
  kind: 'rule';
  label: Label;
  songDir: string;
  // A declared sound, or a spec synthesized from the model (stem, mix).
  spec: GeneratorSpec;
  deps: Label[];
}

// A deliberate sound's committed audio (project-layout.md §1.4):
// content-addressed like an asset. The sound's own label
// (//songs/<song>/sound:<name>) resolves to its *chosen* variant — that
// node is what clips and rules consume — while every variant is
// additionally auditionable as :<name>-<n>. `bloom choose` repoints
// which variant the sound's label means; nothing is ever re-run.
export interface GenerationNode {
  kind: 'generation';
  label: Label;
  songDir: string;
  file: string; // song-dir-relative (audio/<name>/<n>.wav)
  sha256: string;
}

export type GraphNode = AssetNode | GeneratorNode | GenerationNode;

export interface Graph {
  nodes: Map<string, GraphNode>; // keyed by formatted label
}

// Requires a project with no diagnostics: the graph trusts what validate
// accepted (unique names, known references, valid tempo maps).
export function buildGraph(project: LoadedProject): Graph {
  const sampleRate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const nodes = new Map<string, GraphNode>();
  const addRule = (
    label: Label,
    songDir: string,
    spec: GeneratorSpec,
    refLabel: (ref: string) => Label,
  ) => {
    // Each rule declares its ordered sources; the classifier maps each
    // ref — a name in the song's one namespace or a //shared/asset:
    // label — onto the node it means. Other inputs (like sc programs)
    // participate by content hash without being nodes.
    const impl = generatorFor(spec);
    const deps: Label[] = impl.sources(spec).map(refLabel);
    nodes.set(formatLabel(label), { kind: 'rule', label, songDir, spec, deps });
  };

  const sharedByName = new Map<string, Asset>();
  if (project.shared) {
    for (const asset of project.shared.data.assets) {
      const label: Label = { pkg: SHARED_ASSETS_PKG, name: asset.name };
      nodes.set(formatLabel(label), { kind: 'asset', label, scopeDir: 'shared', asset });
      sharedByName.set(asset.name, asset);
    }
  }

  for (const song of project.songs) {
    const pkgBase = song.dir;
    // Keyed by ref string — bare names in the song's namespace, full
    // //shared/asset: labels for shared pins — matching what clips and
    // sounds carry. Chosen generate variants are committed content, so
    // they join the map; a ref absent here is a buildable sound.
    const sha256BySource = new Map<string, string>();
    const assetNames = new Set<string>();
    for (const [name, asset] of sharedByName) {
      sha256BySource.set(`//${SHARED_ASSETS_PKG}:${name}`, asset.sha256);
    }
    if (song.assets) {
      for (const asset of song.assets.data.assets) {
        const label: Label = { pkg: `${pkgBase}/asset`, name: asset.name };
        nodes.set(formatLabel(label), { kind: 'asset', label, scopeDir: song.dir, asset });
        sha256BySource.set(asset.name, asset.sha256);
        assetNames.add(asset.name);
      }
    }
    // Where a committed source's bytes live, for loop tiling and for
    // materializing generation inputs.
    const fileBySource = new Map<string, { base: string; file: string }>();
    for (const [name, asset] of sharedByName) {
      fileBySource.set(`//${SHARED_ASSETS_PKG}:${name}`, { base: 'shared', file: asset.file });
    }
    if (song.assets) {
      for (const asset of song.assets.data.assets) {
        fileBySource.set(asset.name, { base: song.dir, file: asset.file });
      }
    }
    const refLabel = (ref: string): Label => {
      const shared = sharedAssetName(ref);
      if (shared !== undefined) return { pkg: SHARED_ASSETS_PKG, name: shared };
      if (assetNames.has(ref)) return { pkg: `${pkgBase}/asset`, name: ref };
      return { pkg: `${pkgBase}/sound`, name: ref };
    };
    for (const file of song.sounds) {
      const sound = file.data;
      if (sound.type === 'generative') {
        // A deliberate sound contributes committed-content nodes, never a
        // rule node — nothing may re-run it (project-layout.md §1.2/§1.4).
        // Its own label resolves to the chosen variant; every variant is
        // auditionable by number.
        sound.variants.forEach((variant, i) => {
          const label: Label = { pkg: `${pkgBase}/sound`, name: `${sound.name}-${i + 1}` };
          nodes.set(formatLabel(label), {
            kind: 'generation',
            label,
            songDir: song.dir,
            file: variant.file,
            sha256: variant.sha256,
          });
        });
        if (sound.chosen !== undefined) {
          const variant = sound.variants[sound.chosen - 1]!;
          const label: Label = { pkg: `${pkgBase}/sound`, name: sound.name };
          nodes.set(formatLabel(label), {
            kind: 'generation',
            label,
            songDir: song.dir,
            file: variant.file,
            sha256: variant.sha256,
          });
          sha256BySource.set(sound.name, variant.sha256);
          fileBySource.set(sound.name, { base: song.dir, file: variant.file });
        }
      } else {
        addRule({ pkg: `${pkgBase}/sound`, name: sound.name }, song.dir, sound, refLabel);
      }
    }
    const mixable = song.tracks
      .filter((t) => t.data.type === 'audio' && t.data.clips.length > 0)
      .map((t) => t.data);
    if (song.tempo) {
      const tempoMap = new TempoMap(song.tempo.data.tempo, sampleRate);
      // Loops without `every` tile at the source's length, so the plan
      // needs frame counts — but only for the sources such loops touch.
      const framesBySource = new Map<string, number>();
      for (const track of mixable) {
        for (const clip of track.clips) {
          if (clip.loop?.enabled && clip.loop.every === undefined) {
            const committed = fileBySource.get(clip.source);
            if (committed !== undefined && !framesBySource.has(clip.source)) {
              framesBySource.set(
                clip.source,
                wavFrameCount(join(project.root, committed.base, committed.file)),
              );
            }
          }
        }
      }
      for (const track of mixable) {
        // MIDI tracks have no audio to render, and an empty stem is not a
        // useful artifact — implicit stems exist where there is content.
        addRule(
          { pkg: `${pkgBase}/track`, name: track.name },
          song.dir,
          planTrack(track, tempoMap, sha256BySource, framesBySource),
          refLabel,
        );
      }
      // A declared song length projects to samples here, where the tempo
      // map lives; the mix renders exactly that long.
      const lengthSamples =
        song.song?.data.length !== undefined
          ? tempoMap.ticksToSamples(song.song.data.length)
          : undefined;
      for (const file of song.mixes) {
        const spec = planMix(file.data, mixable, lengthSamples, song.song?.data.loop);
        if (spec.tracks.length === 0) continue; // nothing to mix yet
        // Mix inputs are track stems — rule→rule edges, wired here where
        // the spec is synthesized rather than through assetDeps (which is
        // for asset-package edges).
        const label: Label = { pkg: `${pkgBase}/mix`, name: file.data.name };
        const deps = spec.tracks.map((name): Label => ({ pkg: `${pkgBase}/track`, name }));
        nodes.set(formatLabel(label), { kind: 'rule', label, songDir: song.dir, spec, deps });
      }
    }
  }
  return { nodes };
}

// Packages went singular in the same change that made them read like
// what they address ("the keys track"), and the plural is what fingers
// and old docs still type. A bare "no such label" is a bad way to learn
// that, so a pattern that would have matched under the old spelling says
// so — for as long as anyone is still typing it.
function singularHint(graph: Graph, pkg: string): string {
  const singular = pkg.replace(/(sounds|tracks|assets|mixes)$/, (plural) =>
    plural === 'mixes' ? 'mix' : plural.slice(0, -1),
  );
  if (singular === pkg) return '';
  const exists = [...graph.nodes.values()].some((n) => n.label.pkg === singular);
  return exists ? ` (packages are singular: try //${singular}:…)` : '';
}

export function resolveLabel(graph: Graph, label: Label): GraphNode {
  const node = graph.nodes.get(formatLabel(label));
  if (!node) {
    throw new Error(`no such label: ${formatLabel(label)}${singularHint(graph, label.pkg)}`);
  }
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
    const pkg = pattern.kind === 'label' ? pattern.label.pkg : pattern.pkg;
    throw new Error(`pattern matched no labels: ${expanded}${singularHint(graph, pkg)}`);
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
