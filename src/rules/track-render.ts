import { readWav, writeWavFloat32 } from '../audio/wav.js';
import type { Clip, Track } from '../schema/schemas.js';
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
  assets: string[]; // wiring: distinct asset names, sorted; clips index into it
  clips: PlacedClip[];
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

export function planTrack(track: Track, tempoMap: TempoMap): TrackRenderSpec {
  const assets = [...new Set(track.clips.map((c) => c.asset))].sort();
  const inputIndex = new Map(assets.map((name, i) => [name, i]));
  const clips = track.clips.map((clip): PlacedClip => {
    const { start, duration } = placedWindow(clip, tempoMap);
    return {
      input: inputIndex.get(clip.asset)!,
      start,
      duration,
      read_offset: clip.source_offset - clip.slip,
      gain_db: clip.gain_db,
      fade_in: clip.fade_in,
      fade_out: clip.fade_out,
    };
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
  return { name: track.name, rule: 'track-render', assets, clips };
}

export const trackRenderRule: RuleImpl<TrackRenderSpec> = {
  version: 1,
  wiringFields: ['assets'],

  assetDeps(spec) {
    return spec.assets;
  },

  validate() {
    // Synthesized specs are never declared in YAML; clip references and
    // fade fit are validated on the track file itself (model/project.ts).
  },

  async execute(spec, inputPaths, outputPath, ctx) {
    const sources = spec.assets.map((name, i) => {
      const wav = readWav(inputPaths[i]!);
      if (wav.sampleRate !== ctx.sampleRate) {
        throw new Error(
          `asset "${name}" is ${wav.sampleRate} Hz but the project is ${ctx.sampleRate} Hz — ` +
            `Bloom never resamples implicitly; convert it (afconvert, or a normalize target) ` +
            `and re-import`,
        );
      }
      if (wav.channels.length > 2) {
        throw new Error(`asset "${name}" has ${wav.channels.length} channels; mono or stereo only`);
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
    writeWavFloat32(outputPath, ctx.sampleRate, [left, right]);
  },
};
