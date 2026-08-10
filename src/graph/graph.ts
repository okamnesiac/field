import { join } from 'node:path';
import { readWavHeader, wavFrameCount } from '../audio/wav.js';
import {
  convertRef,
  convertRefName,
  formatLabel,
  genRef,
  genRefName,
  matchesPattern,
  sharedAssetName,
  SHARED_ASSETS_PKG,
  SONG_OUTPUT_NAME,
  trackRefName,
  type Label,
  type LabelPattern,
} from '../labels.js';
import type { LoadedProject } from '../model/project.js';
import { generatorFor, type GeneratorSpec } from '../generators/index.js';
import type { ResampleSpec } from '../generators/resample.js';
import { entryRef, generatorName, planTrack } from '../generators/stem.js';
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
  // A declared sound, or a spec synthesized from the model (stem,
  // resample).
  spec: GeneratorSpec;
  deps: Label[];
  // The rate this node renders at (multi-rate.md decision 3): the owning
  // track's effective rate for stems and entry generators, the target
  // rate for a resample edge, the project rate for declared sounds. It
  // reaches the action key and the run context, which is what makes a
  // `rate:` edit re-render exactly the tracks it moved.
  sampleRate: number;
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
  // Deliberate sounds whose recipe exists but whose takes do not
  // (bloom-in-tree.md §3). They mint no node: there is nothing to build,
  // because nothing may run them mechanically, and nothing committed to
  // point at either. So resolution fails — correctly — and this is what
  // makes it fail saying which command fills them rather than claiming
  // the label does not exist, which is the one thing that is not true.
  ungenerated: Map<string, UngeneratedSound>; // keyed by formatted label
}

// A recipe waiting to be filled. Carries its label as well as its key so
// patterns can be matched against it, not only exact labels — the two
// spellings fail in different functions and both have to say this.
export interface UngeneratedSound {
  label: Label;
  song: string;
  name: string;
}

function fillCommand(pending: UngeneratedSound): string {
  return `field generate ${pending.name} --song ${pending.song} --seed <n>`;
}

// Requires a project with no diagnostics: the graph trusts what validate
// accepted (unique names, known references, valid tempo maps).
export function buildGraph(project: LoadedProject): Graph {
  const projectRate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const nodes = new Map<string, GraphNode>();
  const ungenerated = new Map<string, UngeneratedSound>();
  const addRule = (
    label: Label,
    songDir: string,
    spec: GeneratorSpec,
    refLabel: (ref: string) => Label,
    sampleRate: number,
  ) => {
    // Each rule declares its ordered sources; the classifier maps each
    // ref — a name in the song's one namespace or a //shared/asset:
    // label — onto the node it means. Other inputs (like sc programs)
    // participate by content hash without being nodes.
    const impl = generatorFor(spec);
    const deps: Label[] = impl.sources(spec).map(refLabel);
    nodes.set(formatLabel(label), { kind: 'rule', label, songDir, spec, deps, sampleRate });
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
    const assetByName = new Map<string, Asset>();
    for (const [name, asset] of sharedByName) {
      sha256BySource.set(`//${SHARED_ASSETS_PKG}:${name}`, asset.sha256);
    }
    if (song.assets) {
      for (const asset of song.assets.data.assets) {
        const label: Label = { pkg: `${pkgBase}/asset`, name: asset.name };
        nodes.set(formatLabel(label), { kind: 'asset', label, scopeDir: song.dir, asset });
        sha256BySource.set(asset.name, asset.sha256);
        assetByName.set(asset.name, asset);
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
      // A placed track (nested-tracks.md §1.3) — a ref that is not a
      // name in the song's namespace, hence one that carries its
      // package with it. A generator entry's node is the same shape.
      const placed = trackRefName(ref);
      if (placed !== undefined) return { pkg: `${pkgBase}/track`, name: placed };
      const gen = genRefName(ref);
      if (gen !== undefined) return { pkg: `${pkgBase}/gen`, name: gen };
      const conv = convertRefName(ref);
      if (conv !== undefined) return { pkg: `${pkgBase}/convert`, name: conv };
      if (assetByName.has(ref)) return { pkg: `${pkgBase}/asset`, name: ref };
      return { pkg: `${pkgBase}/sound`, name: ref };
    };
    for (const file of song.sounds) {
      const sound = file.data;
      if (sound.type === 'generative') {
        // A deliberate sound contributes committed-content nodes, never a
        // rule node — nothing may re-run it (project-layout.md §1.2/§1.4).
        // Its own label resolves to the chosen variant; every variant is
        // auditionable by number.
        if (sound.variants.length === 0) {
          const label: Label = { pkg: `${pkgBase}/sound`, name: sound.name };
          ungenerated.set(formatLabel(label), { label, song: song.name, name: sound.name });
        }
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
        // Declared sounds belong to the song and render at the project
        // rate — a supercollider render asks for it, and the effects
        // process at their input's own rate without reading it.
        addRule({ pkg: `${pkgBase}/sound`, name: sound.name }, song.dir, sound, refLabel, projectRate);
      }
    }
    // Generator entries mint their own nodes (nested-tracks.md §18
    // step 2, option A — uniformly, whether the entry is a leaf's sole
    // content or windowed among siblings): //songs/<song>/gen:<name>,
    // named by the owning track, or <track>-<id> when the entry carries
    // an id. A supercollider entry becomes a rule: the spec is the
    // supercollider sound schema's shape with the entry's fields, so a
    // sound folded into a track keeps its action key verbatim — name and
    // type never reach a key (build.ts ruleParameters), and the
    // parameters are identical by construction. A generative entry is
    // deliberate and contributes committed-content nodes exactly as a
    // generative sound does, in the gen: package: its label resolves to
    // the chosen take, every take is auditionable by number, and a
    // request with no takes joins `ungenerated` so resolution fails
    // naming the command that fills it.
    // A track's effective rate (multi-rate.md decision 3): its own, or
    // the project's — never the placing parent's, because a track renders
    // once.
    const trackRate = (track: { rate?: number | undefined }): number =>
      track.rate ?? projectRate;
    // Entry generators render at their owner's rate — the render is the
    // track's own content, so producing it at the project rate only to
    // convert it back at the edge would be a conversion nobody asked for.
    const scEntryRate = new Map<string, number>();
    for (const file of song.tracks) {
      for (const entry of file.data.inputs) {
        if (entry.supercollider !== undefined) {
          const name = generatorName(entry, file.data.name);
          scEntryRate.set(name, trackRate(file.data));
          addRule(
            { pkg: `${pkgBase}/gen`, name },
            song.dir,
            { name, type: 'supercollider', ...entry.supercollider },
            refLabel,
            trackRate(file.data),
          );
        } else if (entry.generative !== undefined) {
          const name = generatorName(entry, file.data.name);
          const takes = song.genTakes.get(name)?.data;
          const variants = takes?.variants ?? [];
          if (variants.length === 0) {
            const label: Label = { pkg: `${pkgBase}/gen`, name };
            ungenerated.set(formatLabel(label), { label, song: song.name, name });
          }
          variants.forEach((variant, i) => {
            const label: Label = { pkg: `${pkgBase}/gen`, name: `${name}-${i + 1}` };
            nodes.set(formatLabel(label), {
              kind: 'generation',
              label,
              songDir: song.dir,
              file: variant.file,
              sha256: variant.sha256,
            });
          });
          if (takes?.chosen !== undefined) {
            const variant = variants[takes.chosen - 1]!;
            const label: Label = { pkg: `${pkgBase}/gen`, name };
            nodes.set(formatLabel(label), {
              kind: 'generation',
              label,
              songDir: song.dir,
              file: variant.file,
              sha256: variant.sha256,
            });
            sha256BySource.set(genRef(name), variant.sha256);
            fileBySource.set(genRef(name), { base: song.dir, file: variant.file });
          }
        }
      }
    }
    // What rate a source arrives at, so a placement can convert at the
    // edge when it differs from the consuming track's (multi-rate.md
    // decision 4). Committed content answers from the ledger's recorded
    // fact where the import wrote one, else from its own header — the
    // same 44-byte seek-read the loop planner already pays; a placed
    // track answers from the model; an entry generator from its owner;
    // an effect sound with its source's rate, because effects process at
    // the file's own rate. Undefined means unknowable here (an
    // ungenerated recipe, an unreadable file): no conversion is minted,
    // and the stem rule's own header check is the backstop.
    const headerRate = (base: string, file: string): number | undefined => {
      try {
        return readWavHeader(join(project.root, base, file)).sampleRate;
      } catch {
        return undefined;
      }
    };
    const committedRate = (ref: string): number | undefined => {
      const committed = fileBySource.get(ref);
      return committed === undefined ? undefined : headerRate(committed.base, committed.file);
    };
    const soundByName = new Map(song.sounds.map((f) => [f.data.name, f.data]));
    const trackByName = new Map(song.tracks.map((f) => [f.data.name, f.data]));
    const rateMemo = new Map<string, number | undefined>();
    const sourceRate = (ref: string): number | undefined => {
      if (rateMemo.has(ref)) return rateMemo.get(ref);
      rateMemo.set(ref, undefined); // settles a source cycle; check refuses them first
      let rate: number | undefined;
      const shared = sharedAssetName(ref);
      const placed = trackRefName(ref);
      const gen = genRefName(ref);
      const asset = assetByName.get(ref);
      if (shared !== undefined) {
        const pinned = sharedByName.get(shared);
        if (pinned !== undefined) rate = pinned.sample_rate ?? headerRate('shared', pinned.file);
      } else if (placed !== undefined) {
        const child = trackByName.get(placed);
        if (child !== undefined) rate = trackRate(child);
      } else if (gen !== undefined) {
        rate = scEntryRate.get(gen) ?? committedRate(ref);
      } else if (asset !== undefined) {
        rate = asset.sample_rate ?? headerRate(song.dir, asset.file);
      } else {
        const sound = soundByName.get(ref);
        if (sound?.type === 'generative') rate = committedRate(ref);
        else if (sound?.type === 'supercollider') rate = projectRate;
        else if (sound !== undefined) rate = sourceRate(sound.source);
      }
      rateMemo.set(ref, rate);
      return rate;
    };
    const renderable = song.tracks.map((t) => t.data);
    if (song.tempo) {
      const tempoMap = new TempoMap(song.tempo.data.tempo, projectRate);
      // Loops without `every` tile at the source's length, so the plan
      // needs frame counts — but only for the sources such loops touch.
      const framesBySource = new Map<string, number>();
      for (const track of renderable) {
        for (const entry of track.inputs) {
          if (entry.loop?.enabled && entry.loop.every === undefined) {
            const ref = entryRef(entry, track.name);
            const committed = fileBySource.get(ref);
            if (committed !== undefined && !framesBySource.has(ref)) {
              framesBySource.set(
                ref,
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
      for (const track of renderable) {
        // Every track gets a node, an empty one rendering as the silence
        // it contains — which is what lets a song answer to its own name
        // from the moment `field song create` writes its output track.
        //
        // The song's output track carries the song's extent, the way the
        // mix did before it retired. Which track that is, is the same
        // convention a bare song name resolves through, read from the same
        // constant rather than spelled twice (nested-tracks.md §1.2).
        const extent =
          track.name === SONG_OUTPUT_NAME
            ? { lengthSamples, loop: song.song?.data.loop }
            : {};
        const rate = trackRate(track);
        // Rates convert at the placement (multi-rate.md decision 4): a
        // source arriving at another rate gets a resample node between it
        // and this stem, named for the source and the rate it becomes —
        // track: and gen: refs keep their kind in the name, so a track
        // and a sound legally sharing a name cannot mint one node for two
        // sources. One node per (source, rate) however many placements
        // consume it; the action cache extends that across songs. The
        // guard is for a name crafted to collide anyway (a sound
        // literally named "track-foo"), which validate does not chase.
        const convertBySource = new Map<string, string>();
        for (const entry of track.inputs) {
          const raw = entryRef(entry, track.name);
          if (convertBySource.has(raw)) continue;
          const src = sourceRate(raw);
          if (src === undefined || src === rate) continue;
          const shared = sharedAssetName(raw);
          const base = shared !== undefined ? `shared-${shared}` : raw.replace(':', '-');
          const name = `${base}-${rate}`;
          const label: Label = { pkg: `${pkgBase}/convert`, name };
          const existing = nodes.get(formatLabel(label));
          if (existing !== undefined) {
            if (existing.kind !== 'rule' || (existing.spec as ResampleSpec).source !== raw) {
              throw new Error(
                `convert node ${formatLabel(label)} is claimed by two different sources — rename one`,
              );
            }
          } else {
            addRule(label, song.dir, { name, type: 'resample', source: raw, sample_rate: rate }, refLabel, rate);
          }
          convertBySource.set(raw, convertRef(name));
        }
        // A track plans in its own time (nested-tracks.md §13). The two
        // timelines never have to be reconciled as maps: this stem's
        // positions resolve to samples here, its parent's `at` resolves to
        // samples under the parent's map, and the daemon sums by sample
        // offset — so a 7/8 child inside a 4/4 parent is an addition, not
        // a conversion. Across a rate boundary the addition holds, each
        // side computed in its own rate (§13 as amended by multi-rate).
        //
        // The song's map when the track declares none — at the track's
        // rate, because ticks project to samples differently at 96 kHz
        // than at 48; a track at the project rate keeps the song's own
        // map, so nothing that exists now changes key.
        const local = track.time?.tempo
          ? new TempoMap(track.time.tempo, rate)
          : rate === projectRate
            ? tempoMap
            : new TempoMap(song.tempo.data.tempo, rate);
        addRule(
          { pkg: `${pkgBase}/track`, name: track.name },
          song.dir,
          planTrack(track, local, sha256BySource, framesBySource, extent, convertBySource),
          refLabel,
          rate,
        );
      }
    }
  }
  return { nodes, ungenerated };
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
  // `mix:` retired with mixes/ (nested-tracks.md §7 chunk 2), so both the
  // plural and the singular now point at the track that replaced them —
  // correcting `mixes:` to `mix:` would hand back a second dead end, which
  // is the mistake `targets:` was already fixed for.
  mixes: { to: 'track', why: 'mix: is now track:' },
  mix: { to: 'track', why: 'mix: is now track:' },
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
  const formatted = formatLabel(label);
  const node = graph.nodes.get(formatted);
  if (!node) {
    // The recipe is right there on disk, so "no such label" would be
    // false in the way that costs the most time: it sends you looking for
    // a typo in a name that is spelled correctly. Reached both by asking
    // for the sound directly and by building anything that depends on it,
    // because every resolution comes through here.
    const pending = graph.ungenerated.get(formatted);
    if (pending !== undefined) {
      throw new Error(`${formatted} has no takes yet — ${fillCommand(pending)}`);
    }
    const hint = singularHint(graph, { kind: 'label', label });
    throw new Error(`no such label: ${formatted}${hint}`);
  }
  return node;
}

export function expandPattern(graph: Graph, pattern: LabelPattern): GraphNode[] {
  const matched = [...graph.nodes.values()].filter((n) => matchesPattern(n.label, pattern));
  if (matched.length === 0) {
    // Naming a label on the command line comes through here rather than
    // through resolveLabel, so this is the spelling a person actually
    // types and it has to give the same answer: a pattern that matches
    // only takeless sounds matched something real, and "matched no
    // labels" would send them hunting for a typo. All of them, not the
    // first — a pattern is a request for the set.
    const pending = [...graph.ungenerated.values()].filter((u) =>
      matchesPattern(u.label, pattern),
    );
    if (pending.length === 1) {
      throw new Error(
        `${formatLabel(pending[0]!.label)} has no takes yet — ${fillCommand(pending[0]!)}`,
      );
    }
    if (pending.length > 1) {
      throw new Error(
        `${formatPattern(pattern)} matched ${pending.length} sounds with no takes yet:\n` +
          pending.map((p) => `  ${fillCommand(p)}`).join('\n'),
      );
    }
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
