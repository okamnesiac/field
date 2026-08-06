import { applyInsertChain } from '../audio/insert-chain.js';
import type { EqSound, LimitSound, ReverbSound } from '../schema/index.js';
import { singleInputSources, transformAudio, validateSingleInput } from './single-input.js';
import type { Generator } from './types.js';

// The three offline effects as standalone rules (effects.md §2). Each is
// a one-entry insert chain over its single source — the same DSP that
// runs as track inserts and in the mix master chain lives in
// src/audio/insert-chain.ts, where the future live engine can treat it as
// the reference implementation. The executor is the replaceable part.

export const eqGenerator: Generator<EqSound> = {
  version: 1,
  wiringFields: ['source'],
  sources: singleInputSources,
  validate: validateSingleInput,

  async execute(sound, inputPaths, outputPath) {
    transformAudio(inputPaths[0]!, outputPath, (wav) =>
      applyInsertChain(
        wav.channels,
        [{ effect: 'eq', bands: sound.bands, normalize: sound.normalize }],
        wav.sampleRate,
      ),
    );
  },
};

export const limitGenerator: Generator<LimitSound> = {
  version: 1,
  wiringFields: ['source'],
  sources: singleInputSources,
  validate: validateSingleInput,

  async execute(sound, inputPaths, outputPath) {
    transformAudio(inputPaths[0]!, outputPath, (wav) =>
      applyInsertChain(
        wav.channels,
        [
          {
            effect: 'limit',
            ceiling_db: sound.ceiling_db,
            lookahead_ms: sound.lookahead_ms,
            release_ms: sound.release_ms,
          },
        ],
        wav.sampleRate,
      ),
    );
  },
};

export const reverbGenerator: Generator<ReverbSound> = {
  version: 1,
  wiringFields: ['source'],
  sources: singleInputSources,
  validate: validateSingleInput,

  async execute(sound, inputPaths, outputPath) {
    transformAudio(inputPaths[0]!, outputPath, (wav) =>
      applyInsertChain(
        wav.channels,
        [
          {
            effect: 'reverb',
            mix: sound.mix,
            decay: sound.decay,
            predelay_ms: sound.predelay_ms,
            damping: sound.damping,
          },
        ],
        wav.sampleRate,
      ),
    );
  },
};
