import { renderInsertChain } from '../audio/render-daemon.js';
import type { EqSound, LimitSound, ReverbSound } from '../schema/index.js';
import type { Insert } from '../schema/index.js';
import { singleInputSources, validateSingleInput } from './single-input.js';
import type { Generator } from './types.js';

// The three offline effects as standalone rules (effects.md §2). Each is a
// one-entry insert chain over its single source.
//
// These are the first rules to render in the daemon rather than in
// TypeScript (render-pipeline.md decision 8): one input and one set of
// parameters exercises the whole new path — spawn, plan, render — with
// nothing else changing. Track inserts and the mix master chain still go
// through src/audio/insert-chain.ts until chunk 3 moves them, which is
// why that file is still here.
//
// The rule versions do not change. The C++ port is byte-identical to the
// TypeScript it replaces — verified across 40 randomised chains and both
// platforms — so every cached artifact stays valid and nothing re-renders.

async function renderOne(
  inputPath: string,
  outputPath: string,
  insert: Insert,
): Promise<void> {
  await renderInsertChain({ input: inputPath, output: outputPath, inserts: [insert] });
}

export const eqGenerator: Generator<EqSound> = {
  version: 1,
  wiringFields: ['source'],
  sources: singleInputSources,
  validate: validateSingleInput,

  async execute(sound, inputPaths, outputPath) {
    await renderOne(inputPaths[0]!, outputPath, {
      effect: 'eq',
      bands: sound.bands,
      normalize: sound.normalize,
    });
  },
};

export const limitGenerator: Generator<LimitSound> = {
  version: 1,
  wiringFields: ['source'],
  sources: singleInputSources,
  validate: validateSingleInput,

  async execute(sound, inputPaths, outputPath) {
    await renderOne(inputPaths[0]!, outputPath, {
      effect: 'limit',
      ceiling_db: sound.ceiling_db,
      lookahead_ms: sound.lookahead_ms,
      release_ms: sound.release_ms,
    });
  },
};

export const reverbGenerator: Generator<ReverbSound> = {
  version: 1,
  wiringFields: ['source'],
  sources: singleInputSources,
  validate: validateSingleInput,

  async execute(sound, inputPaths, outputPath) {
    await renderOne(inputPaths[0]!, outputPath, {
      effect: 'reverb',
      mix: sound.mix,
      decay: sound.decay,
      predelay_ms: sound.predelay_ms,
      damping: sound.damping,
    });
  },
};
