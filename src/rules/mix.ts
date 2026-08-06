import { applyInsertChain } from '../audio/insert-chain.js';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import type { Insert, MixTarget, Track } from '../schema/index.js';
import type { RuleImpl } from './types.js';

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
  rule: 'mix';
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
  target: MixTarget,
  mixableTracks: Track[],
  lengthSamples?: number,
  loop?: boolean,
): MixSpec {
  const byName = new Map(mixableTracks.map((t) => [t.name, t]));
  const names = [...(target.tracks ?? byName.keys())].sort();
  return {
    name: target.name,
    rule: 'mix',
    tracks: names,
    faders: names.map((name) => {
      const track = byName.get(name)!;
      return { gain_db: track.gain_db, pan: track.pan };
    }),
    gain_db: target.gain_db,
    ...(target.master.length > 0 ? { master: target.master } : {}),
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

export const mixRule: RuleImpl<MixSpec> = {
  version: 1,
  wiringFields: ['tracks'],

  assetDeps() {
    // Inputs are track stems, not assets; the graph wires those edges when
    // it synthesizes the spec (graph.ts).
    return [];
  },

  validate() {
    // Declared mixes are validated on mix.yaml itself (model/project.ts):
    // referenced tracks must exist and be mixable.
  },

  async execute(spec, inputPaths, outputPath, ctx) {
    const stems = spec.tracks.map((name, i) => {
      const wav = readWav(inputPaths[i]!);
      if (wav.sampleRate !== ctx.sampleRate) {
        throw new Error(
          `stem for track "${name}" is ${wav.sampleRate} Hz but the project is ` +
            `${ctx.sampleRate} Hz — rebuild it (bloom build)`,
        );
      }
      return wav;
    });

    const length = stems.reduce((n, s) => Math.max(n, s.channels[0]!.length), 0);
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    for (let i = 0; i < stems.length; i++) {
      const stem = stems[i]!;
      const fader = spec.faders[i]!;
      const gain = Math.pow(10, fader.gain_db / 20);
      const balance = balanceGains(fader.pan);
      const srcL = stem.channels[0]!;
      const srcR = stem.channels[1] ?? srcL;
      const gL = gain * balance.left;
      const gR = gain * balance.right;
      for (let at = 0; at < srcL.length; at++) {
        left[at] = left[at]! + srcL[at]! * gL;
        right[at] = right[at]! + srcR[at]! * gR;
      }
    }
    const master = Math.pow(10, spec.gain_db / 20);
    if (master !== 1) {
      for (let at = 0; at < length; at++) {
        left[at] = left[at]! * master;
        right[at] = right[at]! * master;
      }
    }
    let channels: Float32Array[] = [left, right];
    if (spec.master !== undefined) {
      channels = applyInsertChain(channels, spec.master, ctx.sampleRate);
    }
    // The declared length is exact and applies last — after the master
    // chain, so even tails the chain grew respect the bar line. loop
    // folds the overhang back onto the start (the seamless-loop bounce:
    // one pass of the infinite performance); otherwise it is cut.
    const declared = spec.length_samples;
    if (declared !== undefined) {
      channels = channels.map((ch) => {
        const out = new Float32Array(declared);
        out.set(ch.subarray(0, declared));
        if (spec.loop === true) {
          for (let from = declared; from < ch.length; from += declared) {
            const n = Math.min(declared, ch.length - from);
            for (let i = 0; i < n; i++) out[i] = out[i]! + ch[from + i]!;
          }
        }
        return out;
      });
    }
    writeWavFloat32(outputPath, ctx.sampleRate, channels);
  },
};
