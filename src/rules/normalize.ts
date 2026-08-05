import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuleImpl } from './types.js';

const execFileAsync = promisify(execFile);

// normalize: sample-rate/bit-depth conversion of one declared asset via
// macOS afconvert (project-core.md §5).
export const normalizeRule: RuleImpl = {
  version: 1,
  wiringFields: ['input'],

  assetDeps(target) {
    if (target.rule !== 'normalize') throw new Error('wrong rule');
    return [target.input];
  },

  validate(target, ctx) {
    if (target.rule !== 'normalize') throw new Error('wrong rule');
    if (!ctx.assetNames.has(target.input)) {
      ctx.push(`references unknown asset "${target.input}"`);
    }
  },

  inputPath(_root, _target, assetPaths) {
    return assetPaths[0]!;
  },

  async execute(target, inputPath, outputPath) {
    if (target.rule !== 'normalize') throw new Error('wrong rule');
    await execFileAsync('afconvert', [
      '-f',
      'WAVE',
      '-d',
      `LEI${target.bit_depth}@${target.sample_rate}`,
      inputPath,
      outputPath,
    ]);
  },
};
