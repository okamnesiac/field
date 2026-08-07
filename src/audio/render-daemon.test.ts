import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daemonBinary } from '../audiod/client.js';
import { RENDER_PLAN_VERSION, renderInsertChain } from './render-daemon.js';
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

const execFileAsync = promisify(execFile);

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
     op: 'effects',
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

  // Stems and mixes get their own locks (chunk 3). The summing paths are
  // new arithmetic — clip fades, constant-power pan, loop folding — and
  // the effects golden says nothing about any of it.
  it('renders a stem to the same bytes on every platform', async () => {
    const stereo = join(dir, 'a.wav');
    const mono = join(dir, 'b.wav');
    writeWavFloat32(stereo, RATE, fixture());
    writeWavFloat32(mono, RATE, [fixture()[0]!.subarray(0, 12000)]);

    const output = join(dir, 'stem.wav');
    await renderInsertChain({
      op: 'stem',
      output,
      sample_rate: RATE,
      inputs: [stereo, mono],
      // Deliberately awkward: a negative read offset, a clip running past
      // its source, mono content on a stereo stem, overlapping windows,
      // and fades short enough to be a single-sample ramp.
      clips: [
        { input: 0, start: 0, duration: 8000, read_offset: -500, gain_db: -3, fade_in: 1000, fade_out: 2000 },
        { input: 1, start: 4000, duration: 9000, read_offset: 2000, gain_db: 2.5, fade_in: 333, fade_out: 777 },
        { input: 0, start: 11000, duration: 15000, read_offset: 9000, gain_db: 0, fade_in: 0, fade_out: 0 },
        { input: 1, start: 15000, duration: 6000, read_offset: 11000, gain_db: -6, fade_in: 2, fade_out: 3 },
      ],
      inserts: [{ effect: 'limit', ceiling_db: -1.5, lookahead_ms: 6, release_ms: 120 }],
    });

    expect(createHash('sha256').update(readFileSync(output)).digest('hex')).toBe('ed46895161b919ffc51be663f43a400003f5f4924928160e18f3f86444afce58');
  });

  it('renders a mix to the same bytes on every platform', async () => {
    const one = join(dir, 's1.wav');
    const two = join(dir, 's2.wav');
    writeWavFloat32(one, RATE, fixture());
    writeWavFloat32(two, RATE, [fixture()[1]!.subarray(0, 15000)]);

    const output = join(dir, 'mix.wav');
    await renderInsertChain({
      op: 'mix',
      output,
      sample_rate: RATE,
      inputs: [one, two],
      // Pan is the new transcendental here (constant-power cosine), and
      // loop folding is the one path that reads past the declared end.
      faders: [
        { gain_db: -2, pan: -0.6 },
        { gain_db: 1.5, pan: 0.35 },
      ],
      gain_db: -1.5,
      master: [{ effect: 'limit', ceiling_db: -2, lookahead_ms: 4, release_ms: 90 }],
      length_samples: 18000,
      loop: true,
    });

    expect(createHash('sha256').update(readFileSync(output)).digest('hex')).toBe('5db5d230ea9f55016dad4d135d5d0d93b58203d92f2a321e14a0d0fe1793d262');
  });

  it('reports the daemon’s own error rather than the exec wrapper’s', async () => {
    await expect(
      renderInsertChain({
       op: 'effects',
        input: join(dir, 'missing.wav'),
        output: join(dir, 'out.wav'),
        inserts: [],
      }),
    ).rejects.toThrow('cannot open');
  });

  // Everything the binary does not understand must be an error, not a
  // plausible render. `daemonBinary()` reuses whatever build already
  // exists, so "control plane newer than binary" is the ordinary case;
  // the failure it produces has to be loud, because the alternative is
  // audio cached under an action key that describes a different chain.
  it('refuses an eq band type it does not know', async () => {
    // This one shipped broken: `design` returned an identity filter for
    // an unfamiliar type, so a +12 dB band rendered as though it were not
    // there and the output was byte-identical to the input (#53 review).
    const input = join(dir, 'in.wav');
    writeWavFloat32(input, RATE, [new Float32Array(256)]);
    await expect(
      renderInsertChain({
        op: 'effects',
        input,
        output: join(dir, 'out.wav'),
        inserts: [
          {
            effect: 'eq',
            normalize: false,
            bands: [
              { type: 'future-band', frequency: 1000, gain_db: 12, bandwidth: 1 },
            ],
          } as unknown as never,
        ],
      }),
    ).rejects.toThrow('unknown eq band type');
  });

  it('refuses a plan version it does not speak', async () => {
    const input = join(dir, 'in.wav');
    writeWavFloat32(input, RATE, [new Float32Array(256)]);
    const planPath = join(dir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        version: RENDER_PLAN_VERSION + 1,
        op: 'effects',
        input,
        output: join(dir, 'out.wav'),
        inserts: [],
      }),
    );
    await expect(execFileAsync(binary!, ['--render', planPath])).rejects.toThrow(
      /render plan version .* but this field-audiod speaks/,
    );
  });

  it('refuses an insert missing a field rather than defaulting it', async () => {
    // The schema fills every field before serializing, so an absent one
    // means the two sides disagree about the shape.
    const input = join(dir, 'in.wav');
    writeWavFloat32(input, RATE, [new Float32Array(256)]);
    await expect(
      renderInsertChain({
       op: 'effects',
        input,
        output: join(dir, 'out.wav'),
        inserts: [{ effect: 'limit', ceiling_db: -1 } as unknown as never],
      }),
    ).rejects.toThrow(/limit insert is missing/);
  });

  it('refuses an insert it does not know instead of dropping it', async () => {
    // A chain the binary renders without one of its links would cache
    // audio that does not match what was declared — silently, under an
    // action key that says it does.
    const input = join(dir, 'in.wav');
    writeWavFloat32(input, RATE, [new Float32Array(128)]);
    await expect(
      renderInsertChain({
       op: 'effects',
        input,
        output: join(dir, 'out.wav'),
        // Version skew is the real case: a control plane newer than the
        // binary. Cast because the schema cannot express one.
        inserts: [{ effect: 'chorus' } as unknown as never],
      }),
    ).rejects.toThrow('unknown insert effect');
  });
});
