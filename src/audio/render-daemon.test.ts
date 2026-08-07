import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daemonBinary } from '../audiod/client.js';
import { renderInsertChain } from './render-daemon.js';
import { writeWavFloat32 } from './wav.js';

// The render subprocess (render-pipeline.md decision 6), and the
// cross-platform byte lock its chunk 6 asks for.
//
// §4 scoped the determinism claim honestly and called it work to be done
// rather than an assumption. This is where it stops being a hope: the
// fixture below renders to the same bytes on macOS arm64, Linux arm64 and
// Linux x86-64, and both CI jobs check the same constant, so the two
// platforms are compared through the golden rather than against each
// other. A divergence fails on whichever platform moved.
//
// What makes it hold is `-ffp-contract=off` in the daemon's compile
// options plus IEEE arithmetic — measured, not assumed: 40 randomised
// chains across three sample rates and both channel counts came out
// byte-identical between macOS and Linux, and this fixture came out
// identical on x86-64 too.
//
// If this fails after an intentional DSP change, the hash is what needs
// updating, and the `rule_version` of every affected rule needs a bump in
// the same breath — the whole point of the constant is that it cannot
// change quietly.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const RATE = 48000;

// Deterministic, and deliberately hostile: content that actually limits
// (chunk 6 requires the fixture to exercise the limiter's per-sample
// `pow`, not just its zero-gain guard), a full three-effect chain, and
// frequencies that are not round numbers so the transcendentals are
// genuinely exercised.
function fixture(): Float32Array[] {
  let state = 4242 >>> 0;
  const next = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
  const left = new Float32Array(24000);
  const right = new Float32Array(24000);
  for (let i = 0; i < left.length; i++) {
    left[i] = 1.6 * Math.sin((2 * Math.PI * 220 * i) / RATE) + 0.5 * next();
    right[i] = 1.4 * Math.sin((2 * Math.PI * 330 * i) / RATE) + 0.5 * next();
  }
  return [left, right];
}

describe.skipIf(!binary)('render subprocess', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-render-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders the same bytes on every platform', async () => {
    const input = join(dir, 'in.wav');
    const output = join(dir, 'out.wav');
    writeWavFloat32(input, RATE, fixture());

    await renderInsertChain({
      input,
      output,
      inserts: [
        {
          effect: 'eq',
          normalize: true,
          bands: [{ type: 'bell', frequency: 777.7, gain_db: 6.6, bandwidth: 1.1 }],
        },
        { effect: 'reverb', mix: 0.29, decay: 0.9, predelay_ms: 17.5, damping: 0.63 },
        { effect: 'limit', ceiling_db: -2.5, lookahead_ms: 4.1, release_ms: 88.8 },
      ],
    });

    const digest = createHash('sha256').update(readFileSync(output)).digest('hex');
    expect(digest).toBe('f9fbcb23670e4c92000fdd2bd05e385c7877300f8c409a10ea281c3ab6525dcd');
  });

  it('reports the daemon’s own error rather than the exec wrapper’s', async () => {
    await expect(
      renderInsertChain({
        input: join(dir, 'missing.wav'),
        output: join(dir, 'out.wav'),
        inserts: [],
      }),
    ).rejects.toThrow('cannot open');
  });

  it('refuses an insert it does not know instead of dropping it', async () => {
    // A chain the binary renders without one of its links would cache
    // audio that does not match what was declared — silently, under an
    // action key that says it does.
    const input = join(dir, 'in.wav');
    writeWavFloat32(input, RATE, [new Float32Array(128)]);
    await expect(
      renderInsertChain({
        input,
        output: join(dir, 'out.wav'),
        // Version skew is the real case: a control plane newer than the
        // binary. Cast because the schema cannot express one.
        inserts: [{ effect: 'chorus' } as unknown as never],
      }),
    ).rejects.toThrow('unknown insert effect');
  });
});
