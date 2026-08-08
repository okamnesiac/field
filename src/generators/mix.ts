import { renderInsertChain } from '../audio/render-daemon.js';
import { readWavHeader } from '../audio/wav.js';
import type { Insert, Mix, Track } from '../schema/index.js';
import type { Generator } from './types.js';

// mix: sums track stems into the listenable artifact behind
// //songs/<song>/mix:<name> (mix-assembly.md §3). Inputs are track-render
// outputs — the graph's first rule→rule edges — aligned at sample 0, so
// mixing is pure summing. Track gain_db/pan live here as parameters, not in
// the stems: a fader move re-runs only this cheap sum while every stem
// stays cached.

export interface Fader {
  gain_db: number;
  pan: number;
}

export interface MixSpec {
  name: string;
  type: 'mix';
  tracks: string[]; // wiring: track names, sorted; dep and fader order
  faders: Fader[]; // aligned with tracks
  gain_db: number; // master, applied before the master chain
  // Post-sum, post-gain (effects.md §5): a final limiter's ceiling guards
  // the true output. Omitted when empty so chainless mixes keep their
  // pre-inserts action keys.
  master?: Insert[];
  // The song's declared length projected to samples: the output is exactly
  // this long — so a song's extent is authored, not emergent. Omitted (no
  // declared length) keeps the old behavior and the old action keys.
  length_samples?: number;
  // With loop, the overhang folds back onto the start instead of being
  // cut: the render is one seamless pass of the infinite loop. Without
  // it, tails truncate and short content pads — a bounce that ends.
  loop?: boolean;
}

// Resolve a declared mix against the song's mixable tracks (audio, with
// clips). Track order is name-sorted for a canonical key — summing is
// commutative, so declaration order must not matter.
export function planMix(
  mix: Mix,
  mixableTracks: Track[],
  lengthSamples?: number,
  loop?: boolean,
): MixSpec {
  const byName = new Map(mixableTracks.map((t) => [t.name, t]));
  const names = [...(mix.tracks ?? byName.keys())].sort();
  return {
    name: mix.name,
    type: 'mix',
    tracks: names,
    faders: names.map((name) => {
      const track = byName.get(name)!;
      return { gain_db: track.gain_db, pan: track.pan };
    }),
    gain_db: mix.gain_db,
    ...(mix.master.length > 0 ? { master: mix.master } : {}),
    ...(lengthSamples !== undefined ? { length_samples: lengthSamples } : {}),
    ...(loop === true && lengthSamples !== undefined ? { loop: true } : {}),
  };
}

// Constant-power balance (mix-assembly.md §4): unity at center, cosine
// taper of the opposite side toward the edges.
export function balanceGains(pan: number): { left: number; right: number } {
  return {
    left: pan > 0 ? Math.cos((pan * Math.PI) / 2) : 1,
    right: pan < 0 ? Math.cos((-pan * Math.PI) / 2) : 1,
  };
}

export const mixGenerator: Generator<MixSpec> = {
  version: 1,
  wiringFields: ['tracks'],

  sources() {
    // Inputs are track stems, not assets; the graph wires those edges when
    // it synthesizes the spec (graph.ts).
    return [];
  },

  validate() {
    // Declared mixes are validated on their own files (model/project.ts):
    // referenced tracks must exist and be mixable.
  },

  async execute(spec, inputPaths, outputPath, ctx) {
    // As in stem.ts: the rate check stays here, where its message can say
    // something useful, and the daemon does the arithmetic.
    spec.tracks.forEach((name, i) => {
      const header = readWavHeader(inputPaths[i]!);
      if (header.sampleRate !== ctx.sampleRate) {
        throw new Error(
          `stem for track "${name}" is ${header.sampleRate} Hz but the project is ` +
            `${ctx.sampleRate} Hz — rebuild it (field build)`,
        );
      }
    });

    await renderInsertChain({
      op: 'mix',
      output: outputPath,
      sample_rate: ctx.sampleRate,
      inputs: inputPaths,
      faders: spec.faders,
      gain_db: spec.gain_db,
      ...(spec.master !== undefined ? { master: spec.master } : {}),
      ...(spec.length_samples !== undefined ? { length_samples: spec.length_samples } : {}),
      ...(spec.loop === true ? { loop: true } : {}),
    });
  }
};
