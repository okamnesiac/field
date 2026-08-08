import { join } from 'node:path';
import { wavFrameCount } from '../audio/wav.js';
import {
  formatLabel,
  matchesPattern,
  sharedAssetName,
  SHARED_ASSETS_PKG,
  SONG_OUTPUT_NAME,
  type Label,
  type LabelPattern,
} from '../labels.js';
import type { LoadedProject } from '../model/project.js';
import { generatorFor, type GeneratorSpec } from '../generators/index.js';
import { planMix } from '../generators/mix.js';
import { planTrack, renderableTrack, trackRefName } from '../generators/stem.js';
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
// additionally auditionable as :<name>-<n>. `field choose` repoints
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
      // A placed track (nested-tracks.md §1.3) — the one ref that is not
      // a name in the song's namespace, hence the one that carries its
      // package with it.
      const placed = trackRefName(ref);
      if (placed !== undefined) return { pkg: `${pkgBase}/track`, name: placed };
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
    const mixable = song.tracks.filter((t) => renderableTrack(t.data)).map((t) => t.data);
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
      // A declared song length projects to samples here, where the tempo
      // map lives; whatever renders the song renders exactly that long.
      const lengthSamples =
        song.song?.data.length !== undefined
          ? tempoMap.ticksToSamples(song.song.data.length)
          : undefined;
      for (const track of mixable) {
        // MIDI tracks have no audio to render, and an empty stem is not a
        // useful artifact — implicit stems exist where there is content
        // (renderableTrack). A track that only contains tracks has
        // content: its children's, summed at their placements.
        //
        // The song's output track carries the song's extent, the way the
        // mix does. Which track that is, is the same convention a bare
        // song name resolves through, read from the same constant rather
        // than spelled twice (nested-tracks.md §1.2).
        const extent =
          track.name === SONG_OUTPUT_NAME
            ? { lengthSamples, loop: song.song?.data.loop }
            : {};
        addRule(
          { pkg: `${pkgBase}/track`, name: track.name },
          song.dir,
          planTrack(track, tempoMap, sha256BySource, framesBySource, extent),
          refLabel,
        );
      }
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

// The canonical spelling of a pattern, for error messages: with
// songs-relative shorthand, what the user typed is not always what was
// looked up.
function formatPattern(pattern: LabelPattern): string {
  if (pattern.kind === 'label') return formatLabel(pattern.label);
  if (pattern.kind === 'package-all') return `//${pattern.pkg}:all`;
  return pattern.pkg === '' ? '//...' : `//${pattern.pkg}/...`;
}

// Packages went singular in the same change that made them read like
// what they address ("the keys track"), and the plural is what fingers
// and old docs still type. A bare "no such label" is a bad way to learn
// that, so a pattern that would have matched under the old spelling says
// so — for as long as anyone is still typing it.
//
// The suggestion keeps the shape it was given: a tree pattern is
// answered with a tree pattern, `:all` with `:all`, a label with that
// same label. Correcting the package but not the shape would hand back
// something that also does not work (#41 review).
// `targets` is the exception that is not a plural at all: it is the
// package that became `sounds` in the layout migration (#31), one PR
// before packages went singular. It had no hint of any kind, so the
// spelling every doc and finger from that era produces was a flat dead
// end — worse than the plural it sits beside here. It corrects straight
// to `sound`, and says why in its own words rather than borrowing the
// grammar lesson, which would be false for it.
// `why` carries its own punctuation: the two lead-ins do not share a
// shape, and gluing a colon on in the template gave `targets:` two.
const PACKAGE_HINTS: Record<string, { to: string; why: string }> = {
  sounds: { to: 'sound', why: 'packages are singular:' },
  tracks: { to: 'track', why: 'packages are singular:' },
  assets: { to: 'asset', why: 'packages are singular:' },
  mixes: { to: 'mix', why: 'packages are singular:' },
  targets: { to: 'sound', why: 'targets: is now sound:' },
};

function singularHint(graph: Graph, pattern: LabelPattern): string {
  const pkg = pattern.kind === 'label' ? pattern.label.pkg : pattern.pkg;
  let why = '';
  const singular = pkg.replace(/[^/]+$/, (last) => {
    const hint = PACKAGE_HINTS[last];
    if (hint === undefined) return last;
    why = hint.why;
    return hint.to;
  });
  if (singular === pkg) return '';
  // Only when that package really exists here: no guessing at a package
  // this project does not have.
  if (![...graph.nodes.values()].some((n) => n.label.pkg === singular)) return '';
  const corrected: LabelPattern =
    pattern.kind === 'label'
      ? { kind: 'label', label: { ...pattern.label, pkg: singular } }
      : { ...pattern, pkg: singular };
  return ` (${why} try ${formatPattern(corrected)})`;
}

export function resolveLabel(graph: Graph, label: Label): GraphNode {
  const node = graph.nodes.get(formatLabel(label));
  if (!node) {
    const hint = singularHint(graph, { kind: 'label', label });
    throw new Error(`no such label: ${formatLabel(label)}${hint}`);
  }
  return node;
}

export function expandPattern(graph: Graph, pattern: LabelPattern): GraphNode[] {
  const matched = [...graph.nodes.values()].filter((n) => matchesPattern(n.label, pattern));
  if (matched.length === 0) {
    throw new Error(
      `pattern matched no labels: ${formatPattern(pattern)}${singularHint(graph, pattern)}`,
    );
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
