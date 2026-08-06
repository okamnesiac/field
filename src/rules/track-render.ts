import { applyInsertChain } from '../audio/insert-chain.js';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import type { Clip, Insert, Track } from '../schema/index.js';
import type { TempoMap } from '../time/tempo.js';
import type { RuleImpl } from './types.js';

// track-render: the implicit stem target behind //songs/<song>/tracks:<name>
// (mix-assembly.md §3). The spec is synthesized from the track file, not
// declared in targets.yaml: clip windows are projected through the tempo map
// to samples *before* hashing, so the action key sees the resolved placement
// plan. A tempo edit therefore rebuilds exactly the tracks whose musical
// clips moved; reordering clips in YAML or renaming an asset changes
// nothing. Stems render pre-fader (track gain_db/pan are mix parameters)
// and start at timeline sample 0 so the mix can sum by alignment alone.

export interface PlacedClip {
  input: number; // index into spec.assets
  start: number; // stem sample where the clip window begins
  duration: number; // window length in samples
  // Sample of the asset playing at the window start (source_offset − slip,
  // project-core.md §3.2). May be negative or run past the asset's end:
  // out-of-range reads are silence — slipping never errors.
  read_offset: number;
  gain_db: number;
  fade_in: number; // samples, linear, from the window start
  fade_out: number; // samples, linear, to the window end
}

export interface TrackRenderSpec {
  name: string;
  rule: 'track-render';
  // Wiring: clips index into the concatenation [assets..., targets...],
  // matching the graph's dep order. Assets sort by content hash (renames
  // cannot reach the key); targets sort by name — their content hashes
  // don't exist until they build, and a target rename is a real relabel.
  assets: string[];
  targets: string[];
  clips: PlacedClip[];
  // Inserts bake into the stem (effects.md §5): parameters here mean an
  // insert edit re-renders it. Omitted entirely when the track has none,
  // so insert-less stems keep their pre-inserts action keys.
  inserts?: Insert[];
}

// A clip's window on the stem timeline, in samples. Musical clips project
// both edges through the tempo map (the window end is position + duration
// in ticks, so a clip spanning a ramp gets its true sample length); absolute
// clips are already samples.
export function placedWindow(clip: Clip, tempoMap: TempoMap): { start: number; duration: number } {
  if (clip.anchor === 'absolute') {
    return { start: clip.position, duration: clip.duration };
  }
  const start = tempoMap.ticksToSamples(clip.position);
  return { start, duration: tempoMap.ticksToSamples(clip.position + clip.duration) - start };
}

// Loop expansion (clip-looping.md §1.6): a looped clip becomes the same
// resolved per-repetition entries equivalent hand-written clips would
// produce — the renderer and the action-key format don't know loops exist.
// Returns entries without input wiring; planTrack fills that in. Exported
// for validate, which runs the same expansion to diagnose exhausted
// sources and fades that outgrow their slots before any graph exists —
// the throw below is a backstop the gate makes unreachable.
export function expandLoop(
  clip: Clip,
  loop: NonNullable<Clip['loop']>,
  tempoMap: TempoMap,
  sourceFrames: number | undefined,
): Omit<PlacedClip, 'input'>[] {
  const { start, duration } = placedWindow(clip, tempoMap);
  const windowEnd = start + duration;
  const readOffset = clip.source_offset - clip.slip;

  // Repetition boundaries on the stem timeline, in samples.
  const bounds: number[] = [];
  if (loop.every !== undefined) {
    // Anchor units, like position/duration: musical loops repeat on the
    // grid straight through tempo ramps.
    for (let at = clip.position; ; at += loop.every) {
      const sample = clip.anchor === 'absolute' ? at : tempoMap.ticksToSamples(at);
      if (sample >= windowEnd) break;
      bounds.push(sample);
    }
  } else {
    // Tile at the source's own length. A target's length is unknown at
    // plan time (validate already demands `every` there); an asset whose
    // content is exhausted by the read offset has nothing to tile.
    const interval = (sourceFrames ?? 0) - readOffset;
    if (interval <= 0) {
      throw new Error(
        `clip "${clip.id}": loop without 'every' needs source content after its read offset`,
      );
    }
    for (let at = start; at < windowEnd; at += interval) bounds.push(at);
  }

  return bounds.map((slotStart, k) => {
    const last = k === bounds.length - 1;
    const slotEnd = last ? windowEnd : bounds[k + 1]!;
    // truncate cuts each repetition at its slot; overlay lets it ring to
    // the window's edge — reads past the source's end are silence, so the
    // voice ends where its content does, and overlapping voices sum like
    // any overlapping clips.
    const repDuration = loop.mode === 'overlay' ? windowEnd - slotStart : slotEnd - slotStart;
    return {
      start: slotStart,
      duration: repDuration,
      read_offset: readOffset,
      gain_db: clip.gain_db,
      // Whole-clip fades keep their meaning (first head, window tail);
      // seams get the loop's click-guard. Overlay voices all end at the
      // window edge, so the window fade covers whatever is cut there.
      fade_in: k === 0 ? clip.fade_in : loop.fade,
      fade_out:
        loop.mode === 'overlay' ? clip.fade_out : last ? clip.fade_out : loop.fade,
    };
  });
}

export function planTrack(
  track: Track,
  tempoMap: TempoMap,
  sha256ByAsset: Map<string, string>,
  framesByAsset: Map<string, number> = new Map(),
): TrackRenderSpec {
  // Asset wiring order is content-hash order (name tiebreak for
  // determinism), so renaming an asset cannot permute the input list or
  // the clip indices — names never reach the action key at all (#9 review).
  const assets = [...new Set(track.clips.flatMap((c) => (c.asset ? [c.asset] : [])))].sort(
    (a, b) => {
      const ha = sha256ByAsset.get(a) ?? '';
      const hb = sha256ByAsset.get(b) ?? '';
      return ha < hb ? -1 : ha > hb ? 1 : a < b ? -1 : 1;
    },
  );
  const targets = [...new Set(track.clips.flatMap((c) => (c.target ? [c.target] : [])))].sort();
  const inputIndex = new Map<string, number>([
    ...assets.map((name, i): [string, number] => [`asset:${name}`, i]),
    ...targets.map((name, i): [string, number] => [`target:${name}`, assets.length + i]),
  ]);
  const clips = track.clips.flatMap((clip): PlacedClip[] => {
    const source = clip.asset ? `asset:${clip.asset}` : `target:${clip.target}`;
    const input = inputIndex.get(source)!;
    const loop = clip.loop?.enabled ? clip.loop : undefined;
    if (loop) {
      const frames = clip.asset ? framesByAsset.get(clip.asset) : undefined;
      return expandLoop(clip, loop, tempoMap, frames).map((rep) => ({ input, ...rep }));
    }
    const { start, duration } = placedWindow(clip, tempoMap);
    return [
      {
        input,
        start,
        duration,
        read_offset: clip.source_offset - clip.slip,
        gain_db: clip.gain_db,
        fade_in: clip.fade_in,
        fade_out: clip.fade_out,
      },
    ];
  });
  // Canonical order: summing is commutative, so the action key must not
  // depend on YAML clip order.
  clips.sort(
    (a, b) =>
      a.start - b.start ||
      a.input - b.input ||
      a.read_offset - b.read_offset ||
      a.duration - b.duration ||
      a.gain_db - b.gain_db ||
      a.fade_in - b.fade_in ||
      a.fade_out - b.fade_out,
  );
  return {
    name: track.name,
    rule: 'track-render',
    assets,
    targets,
    clips,
    ...(track.inserts.length > 0 ? { inserts: track.inserts } : {}),
  };
}

export const trackRenderRule: RuleImpl<TrackRenderSpec> = {
  version: 1,
  wiringFields: ['assets', 'targets'],

  assetDeps(spec) {
    return spec.assets;
  },

  targetDeps(spec) {
    // Clip-source targets: a clip on an SC render pulls the whole recipe
    // into the stem's subgraph (mix-assembly.md §5).
    return spec.targets;
  },

  validate() {
    // Synthesized specs are never declared in YAML; clip references and
    // fade fit are validated on the track file itself (model/project.ts).
  },

  async execute(spec, inputPaths, outputPath, ctx) {
    const sources = [...spec.assets, ...spec.targets].map((name, i) => {
      const wav = readWav(inputPaths[i]!);
      if (wav.sampleRate !== ctx.sampleRate) {
        throw new Error(
          `input "${name}" is ${wav.sampleRate} Hz but the project is ${ctx.sampleRate} Hz — ` +
            `Bloom never resamples implicitly; render or convert it at the project rate ` +
            `(a normalize target at ${ctx.sampleRate}, or afconvert and re-import)`,
        );
      }
      if (wav.channels.length > 2) {
        throw new Error(`input "${name}" has ${wav.channels.length} channels; mono or stereo only`);
      }
      return wav;
    });

    const length = spec.clips.reduce((n, c) => Math.max(n, c.start + c.duration), 0);
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    for (const clip of spec.clips) {
      const src = sources[clip.input]!;
      const srcL = src.channels[0]!;
      const srcR = src.channels[1] ?? srcL; // mono content on both stem channels
      const gain = Math.pow(10, clip.gain_db / 20);
      for (let i = 0; i < clip.duration; i++) {
        const s = clip.read_offset + i;
        if (s < 0 || s >= srcL.length) continue;
        let g = gain;
        if (i < clip.fade_in) g *= i / clip.fade_in;
        const fromEnd = clip.duration - 1 - i;
        if (fromEnd < clip.fade_out) g *= fromEnd / clip.fade_out;
        const at = clip.start + i;
        left[at] = left[at]! + srcL[s]! * g;
        right[at] = right[at]! + srcR[s]! * g;
      }
    }
    let channels: Float32Array[] = [left, right];
    if (spec.inserts !== undefined) {
      channels = applyInsertChain(channels, spec.inserts, ctx.sampleRate);
    }
    writeWavFloat32(outputPath, ctx.sampleRate, channels);
  },
};
