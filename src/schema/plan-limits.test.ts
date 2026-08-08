import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The daemon validates a render plan against the same domains zod enforces
// on the way in, and `native/audiod/src/plan-limits.h` carries them across
// the language boundary. It is generated, not written, because a
// hand-copied second set of numbers drifts — and a *partial* copy, which
// is what it replaced, has the same drift risk with none of the coverage
// (#54 review).
//
// This is the thing that keeps generation honest: regenerate and compare.
// Widening a range in `src/schema/` without running `pnpm gen:limits`
// fails here rather than silently leaving the daemon enforcing the old
// contract — which would be the drift the generation exists to prevent,
// arriving by a different door.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const header = join(root, 'native/audiod/src/plan-limits.h');

describe('generated plan limits', () => {
  it('is in step with the zod schemas', () => {
    const committed = readFileSync(header, 'utf8');
    execFileSync('pnpm', ['gen:limits'], { cwd: root, stdio: 'pipe' });
    const regenerated = readFileSync(header, 'utf8');
    expect(regenerated, 'run `pnpm gen:limits` and commit the result').toBe(committed);
  });

  it('carries the ranges the daemon has to enforce', () => {
    const committed = readFileSync(header, 'utf8');
    // A spot check that the extraction is reading real bounds rather than
    // emitting defaults: these are the two the review caught rendering as
    // no-ops, so if either goes missing the file is not doing its job.
    expect(committed).toMatch(/eqBandwidthMin = 0\.1;/);
    expect(committed).toMatch(/limitCeilingDbMax = 0;/);
    expect(committed).toMatch(/sampleRates\[\] = \{ 44100, 48000/);
  });
});
