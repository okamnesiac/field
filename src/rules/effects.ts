import { applyInsertChain } from '../audio/insert-chain.js';
import type { EqTarget, LimitTarget, ReverbTarget } from '../schema/schemas.js';
import {
  singleInputAssetDeps,
  singleInputTargetDeps,
  transformAudio,
  validateSingleInput,
} from './single-input.js';
import type { RuleImpl } from './types.js';

// The three offline effects as standalone rules (effects.md §2). Each is
// a one-entry insert chain over its single input — the same DSP that runs
// as track inserts and in the mix master chain lives in
// src/audio/insert-chain.ts, where the future live engine can treat it as
// the reference implementation. The executor is the replaceable part.

export const eqRule: RuleImpl<EqTarget> = {
  version: 1,
  wiringFields: ['asset', 'target'],
  assetDeps: singleInputAssetDeps,
  targetDeps: singleInputTargetDeps,
  validate: validateSingleInput,

  async execute(target, inputPaths, outputPath) {
    transformAudio(inputPaths[0]!, outputPath, (wav) =>
      applyInsertChain(
        wav.channels,
        [{ effect: 'eq', bands: target.bands, normalize: target.normalize }],
        wav.sampleRate,
      ),
    );
  },
};

export const limitRule: RuleImpl<LimitTarget> = {
  version: 1,
  wiringFields: ['asset', 'target'],
  assetDeps: singleInputAssetDeps,
  targetDeps: singleInputTargetDeps,
  validate: validateSingleInput,

  async execute(target, inputPaths, outputPath) {
    transformAudio(inputPaths[0]!, outputPath, (wav) =>
      applyInsertChain(
        wav.channels,
        [
          {
            effect: 'limit',
            ceiling_db: target.ceiling_db,
            lookahead_ms: target.lookahead_ms,
            release_ms: target.release_ms,
          },
        ],
        wav.sampleRate,
      ),
    );
  },
};

export const reverbRule: RuleImpl<ReverbTarget> = {
  version: 1,
  wiringFields: ['asset', 'target'],
  assetDeps: singleInputAssetDeps,
  targetDeps: singleInputTargetDeps,
  validate: validateSingleInput,

  async execute(target, inputPaths, outputPath) {
    transformAudio(inputPaths[0]!, outputPath, (wav) =>
      applyInsertChain(
        wav.channels,
        [
          {
            effect: 'reverb',
            mix: target.mix,
            decay: target.decay,
            predelay_ms: target.predelay_ms,
            damping: target.damping,
          },
        ],
        wav.sampleRate,
      ),
    );
  },
};
