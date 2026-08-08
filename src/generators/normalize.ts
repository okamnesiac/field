import { renderInsertChain } from '../audio/render-daemon.js';
import type { NormalizeSound } from '../schema/index.js';
import { singleInputSources, validateSingleInput } from './single-input.js';
import type { Generator } from './types.js';

// normalize: sample-rate and bit-depth conversion of one source, rendered
// in the daemon's built-in tier (render-pipeline.md decisions 9 and 10).
// Accepting sounds as sources is what makes "add a normalize sound" a
// complete fix for rate-mismatched renders.
//
// This was `afconvert` until chunk 5, which is why the version moves. It
// is the one rule in this migration whose output is *not* byte-identical
// to what it replaced — there was no reference implementation to
// transliterate, only a macOS binary to displace, so a bump and a
// re-render are unavoidable here in a way they were not for the effects.
export const normalizeGenerator: Generator<NormalizeSound> = {
  // 1 → 2: rendered by field-audiod's polyphase resampler rather than by
  // afconvert. Different bytes by construction, so every normalize
  // artifact re-renders once.
  version: 2,
  wiringFields: ['source'],
  sources: singleInputSources,
  validate: validateSingleInput,

  async execute(sound, inputPaths, outputPath) {
    await renderInsertChain({
      op: 'normalize',
      input: inputPaths[0]!,
      output: outputPath,
      sample_rate: sound.sample_rate,
      bit_depth: sound.bit_depth,
    });
  },
};
