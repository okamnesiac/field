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
import { ruleImpl, type RuleSpec } from '../rules/index.js';
import { planMix } from '../rules/mix.js';
import { planTrack } from '../rules/track-render.js';
import { TempoMap } from '../time/tempo.js';
import type { Asset } from '../schema/index.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';

// The dependency graph, derived from the project model by convention
// (project-core.md §3.4). Node kinds so far: source assets (song and
// shared ledgers), declared rule targets (targets/), and implicit track
// stems — every audio track with clips is buildable as
// //songs/<song>/tracks:<name> (mix-assembly.md §3).

export interface AssetNode {
  kind: 'asset';
  label: Label;
  // Project-relative scope root the asset's file resolves against:
  // songs/<song>, or shared (project-layout.md §1.6).
  scopeDir: string;
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

// A deliberate target's variant (project-layout.md §1.4): committed,
// content-addressed audio like an asset, addressable as
// //songs/<song>/targets:<name>-<n> so `bloom play` can audition it — but
// not referenceable by clips or rules. Promotion via `bloom choose` is
// what turns a variant into an asset.
export interface GenerationNode {
  kind: 'generation';
  label: Label;
  songDir: string;
  file: string; // song-dir-relative (audio/<name>/<n>.wav)
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
  // An asset ref is a bare name (the song's own ledger) or a
  // //shared/assets:<name> label — the ref string itself is the key
  // everywhere a spec carries one, so both spellings resolve here.
  const refLabel = (ref: string, songDir: string): Label => {
    const shared = sharedAssetName(ref);
    return shared !== undefined
      ? { pkg: SHARED_ASSETS_PKG, name: shared }
      : { pkg: `${songDir}/assets`, name: ref };
  };
  const addRule = (label: Label, songDir: string, spec: RuleSpec) => {
    // Each rule declares which assets and same-song targets it consumes;
    // those are the graph edges, in that order — matching the input order
    // every impl expects. Other inputs (like sc programs) participate by
    // content hash without being nodes.
    const impl = ruleImpl(spec);
    const deps: Label[] = [
      ...impl.assetDeps(spec).map((ref) => refLabel(ref, songDir)),
      ...(impl.targetDeps?.(spec) ?? []).map(
        (name): Label => ({ pkg: `${songDir}/targets`, name }),
      ),
    ];
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
    // Keyed by ref string — bare names for the song's ledger, full
    // //shared/assets: labels for shared pins — matching what clips carry.
    const sha256ByAsset = new Map<string, string>();
    for (const [name, asset] of sharedByName) {
      sha256ByAsset.set(`//${SHARED_ASSETS_PKG}:${name}`, asset.sha256);
    }
    if (song.assets) {
      for (const asset of song.assets.data.assets) {
        const label: Label = { pkg: `${pkgBase}/assets`, name: asset.name };
        nodes.set(formatLabel(label), { kind: 'asset', label, scopeDir: song.dir, asset });
        sha256ByAsset.set(asset.name, asset.sha256);
      }
    }
    for (const file of song.targets) {
      const target = file.data;
      if (target.rule === 'generate') {
        // A deliberate target contributes audition nodes for its committed
        // variants, never a rule node — nothing may re-run it
        // (project-layout.md §1.2/§1.4).
        target.variants.forEach((variant, i) => {
          const label: Label = { pkg: `${pkgBase}/targets`, name: `${target.name}-${i + 1}` };
          nodes.set(formatLabel(label), {
            kind: 'generation',
            label,
            songDir: song.dir,
            file: variant.file,
            sha256: variant.sha256,
          });
        });
      } else {
        addRule({ pkg: `${pkgBase}/targets`, name: target.name }, song.dir, target);
      }
    }
    const mixable = song.tracks
      .filter((t) => t.data.type === 'audio' && t.data.clips.length > 0)
      .map((t) => t.data);
    if (song.tempo) {
      const tempoMap = new TempoMap(song.tempo.data.tempo, sampleRate);
      // Loops without `every` tile at the source's length, so the plan
      // needs frame counts — but only for the assets such loops touch.
      const sourcePath = (ref: string): string | undefined => {
        const shared = sharedAssetName(ref);
        const file =
          shared !== undefined
            ? sharedByName.get(shared)?.file
            : song.assets?.data.assets.find((a) => a.name === ref)?.file;
        if (file === undefined) return undefined;
        return join(project.root, shared !== undefined ? 'shared' : song.dir, file);
      };
      const framesByAsset = new Map<string, number>();
      for (const track of mixable) {
        for (const clip of track.clips) {
          if (clip.loop?.enabled && clip.loop.every === undefined && clip.asset) {
            const path = sourcePath(clip.asset);
            if (path !== undefined && !framesByAsset.has(clip.asset)) {
              framesByAsset.set(clip.asset, wavFrameCount(path));
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
        const deps = spec.tracks.map((name): Label => ({ pkg: `${pkgBase}/tracks`, name }));
        nodes.set(formatLabel(label), { kind: 'rule', label, songDir: song.dir, spec, deps });
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
