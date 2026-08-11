import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Block-size invariance for the streaming DSP classes (realtime.md
// decision 3): field-dsp-check runs every processor whole and partitioned
// at several block sizes and bit-compares the outputs. The harness lives
// in C++ (native/audiod/src/dsp-check.cpp) because the property is about
// the C++ classes; this test is only the CI caller. Skipped like every
// native-gated test when the build is absent.

const execFileAsync = promisify(execFile);

const binary = (() => {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const built = join(packageRoot, 'native/audiod/build/field-dsp-check');
  return existsSync(built) ? built : undefined;
})();

describe.skipIf(!binary)('streaming DSP block-size invariance', () => {
  it('emits the same bits at every block partition', async () => {
    const { stdout } = await execFileAsync(binary!, []);
    expect(stdout).toContain('dsp-check: all block partitions bit-identical');
  });
});
