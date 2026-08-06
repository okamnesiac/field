import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NormalizeSound } from '../schema/index.js';
import { singleInputSources, validateSingleInput } from './single-input.js';
import type { RuleImpl } from './types.js';

const execFileAsync = promisify(execFile);

// normalize: sample-rate/bit-depth conversion of one source via macOS
// afconvert (project-core.md §5). Accepting sounds as sources is what
// makes "add a normalize sound" a complete fix for rate-mismatched
// renders.
export const normalizeRule: RuleImpl<NormalizeSound> = {
  version: 1,
  wiringFields: ['source'],
  sources: singleInputSources,
  validate: validateSingleInput,

  async execute(sound, inputPaths, outputPath) {
    await execFileAsync('afconvert', [
      '-f',
      'WAVE',
      '-d',
      `LEI${sound.bit_depth}@${sound.sample_rate}`,
      inputPaths[0]!,
      outputPath,
    ]);
  },
};
