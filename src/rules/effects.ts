import { autoGainDB, design, processBiquad, type Band } from '../audio/biquad.js';
import { limit } from '../audio/limiter.js';
import { reverb } from '../audio/reverb.js';
import type { EqTarget, LimitTarget, ReverbTarget } from '../schema/schemas.js';
import {
  singleInputAssetDeps,
  singleInputTargetDeps,
  transformAudio,
  validateSingleInput,
} from './single-input.js';
import type { RuleImpl } from './types.js';

// The three offline effects (effects.md §2). Deliberately thin: every
// parameter is spec content (hashed), every algorithm lives in src/audio/
// where the future live engine can treat it as the reference
// implementation — the executor is the replaceable part.

export const eqRule: RuleImpl<EqTarget> = {
  version: 1,
  wiringFields: ['asset', 'target'],
  assetDeps: singleInputAssetDeps,
  targetDeps: singleInputTargetDeps,
  validate: validateSingleInput,

  async execute(target, inputPaths, outputPath) {
    transformAudio(inputPaths[0]!, outputPath, (wav) => {
      const bands: Band[] = target.bands;
      for (const band of bands) {
        const biquad = design(band, wav.sampleRate);
        for (const channel of wav.channels) processBiquad(channel, biquad);
      }
      if (target.normalize) {
        const gain = Math.pow(10, autoGainDB(bands, wav.sampleRate) / 20);
        for (const channel of wav.channels) {
          for (let i = 0; i < channel.length; i++) channel[i] = channel[i]! * gain;
        }
      }
      return wav.channels;
    });
  },
};

export const limitRule: RuleImpl<LimitTarget> = {
  version: 1,
  wiringFields: ['asset', 'target'],
  assetDeps: singleInputAssetDeps,
  targetDeps: singleInputTargetDeps,
  validate: validateSingleInput,

  async execute(target, inputPaths, outputPath) {
    transformAudio(inputPaths[0]!, outputPath, (wav) => {
      limit(wav.channels, {
        ceilingDb: target.ceiling_db,
        lookaheadMs: target.lookahead_ms,
        releaseMs: target.release_ms,
        sampleRate: wav.sampleRate,
      });
      return wav.channels;
    });
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
      reverb(wav.channels, {
        mix: target.mix,
        decaySeconds: target.decay,
        predelayMs: target.predelay_ms,
        damping: target.damping,
        sampleRate: wav.sampleRate,
      }),
    );
  },
};
