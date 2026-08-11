import { renderInsertChain } from '../audio/render-daemon.js';
import type { Generator } from './types.js';

// resample: the edge conversion (multi-rate.md decision 4). Synthesized
// by the graph when a source's rate differs from its consuming track's,
// never declared — which is what distinguishes it from the normalize
// sound it replaces: a conversion the diagnostic knew the one right
// answer to is a conversion nobody should have to author. Rate and
// nothing else; the daemon writes float32, because this op sits between
// two float stages and quantizing here would clip a stem legitimately
// above 0 dBFS before its edge gain applies. Delivery quantization
// stayed where it belongs, on `field export --bit-depth`.
export interface ResampleSpec {
  name: string;
  type: 'resample';
  // The ref being converted, exactly as the consuming entry spells it —
  // a name in the song's namespace, a //shared/asset: label, a track: or
  // gen: ref. Wiring, so it never reaches the action key.
  source: string;
  sample_rate: number;
}

export const resampleGenerator: Generator<ResampleSpec> = {
  version: 1,
  wiringFields: ['source'],
  sources: (spec) => [spec.source],

  validate() {
    // Synthesized specs are never declared in YAML; the entry whose
    // mismatch minted this node was validated on its track file, and its
    // ref may be a track: or gen: spelling the namespace checker does not
    // speak (same reasoning as stem's no-op).
  },

  async execute(spec, inputPaths, outputPath, ctx) {
    await renderInsertChain(
      {
        op: 'resample',
        input: inputPaths[0]!,
        output: outputPath,
        sample_rate: spec.sample_rate,
      },
      { ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
    );
  },
};
