import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NormalizeTarget } from '../schema/schemas.js';
import type { RuleImpl } from './types.js';

const execFileAsync = promisify(execFile);

// normalize: sample-rate/bit-depth conversion of one declared asset via
// macOS afconvert (project-core.md §5).
export const normalizeRule: RuleImpl<NormalizeTarget> = {
  version: 1,
  wiringFields: ['input'],

  assetDeps(target) {
    return [target.input];
  },

  validate(target, ctx) {
    if (!ctx.assetNames.has(target.input)) {
      ctx.push(`references unknown asset "${target.input}"`);
    }
  },

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
