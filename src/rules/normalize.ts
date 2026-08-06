import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NormalizeTarget } from '../schema/index.js';
import {
  singleInputAssetDeps,
  singleInputTargetDeps,
  validateSingleInput,
} from './single-input.js';
import type { RuleImpl } from './types.js';

const execFileAsync = promisify(execFile);

// normalize: sample-rate/bit-depth conversion of one asset or target via
// macOS afconvert (project-core.md §5). Accepting targets is what makes
// "add a normalize target" a complete fix for rate-mismatched renders.
export const normalizeRule: RuleImpl<NormalizeTarget> = {
  version: 1,
  wiringFields: ['asset', 'target'],
  assetDeps: singleInputAssetDeps,
  targetDeps: singleInputTargetDeps,
  validate: validateSingleInput,

  async execute(target, inputPaths, outputPath) {
    await execFileAsync('afconvert', [
      '-f',
      'WAVE',
      '-d',
      `LEI${target.bit_depth}@${target.sample_rate}`,
      inputPaths[0]!,
      outputPath,
    ]);
  },
};
