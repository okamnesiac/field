import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { autoGainDb, responseDb, type EqBandLike } from './eq-response.js';

// eq-response.ts is a recorded partial reversal of render-pipeline.md
// decision 4, and this file is the price that decision sets for a
// TypeScript autoGainDb. The three properties below are the three the
// delete needed written first — the ones every earlier normalize
// assertion missed, each confirmed by mutation against the C++ before
// being written (#55). They are asserted here against the port, and
// then the port is held equal to the C++ itself through
// field-dsp-check's eq-response mode, skipped like every native-gated
// test when the build is absent.

const RATE = 48000;

describe('autoGainDb properties (render-pipeline.md decision 4)', () => {
  it('makes up for cuts, not only pads boosts', () => {
    // A net-cut curve loses energy; the compensation must be positive
    // make-up gain. min(0, compensation) — the mutation that ignored
    // cuts — passed every pre-existing assertion.
    const cut: EqBandLike[] = [{ type: 'bell', frequency: 1000, gain_db: -6, bandwidth: 2 }];
    expect(autoGainDb(cut, RATE)).toBeGreaterThan(0.5);
  });

  it('clamps to ±12 dB', () => {
    // Wide maximum-gain shelves push the raw compensation far past the
    // bound; deleting the clamp passed every pre-existing assertion.
    const loud: EqBandLike[] = [
      { type: 'lowshelf', frequency: 8000, gain_db: 24, bandwidth: 8 },
      { type: 'bell', frequency: 1000, gain_db: 24, bandwidth: 8 },
    ];
    const quiet: EqBandLike[] = [
      { type: 'lowshelf', frequency: 8000, gain_db: -24, bandwidth: 8 },
      { type: 'bell', frequency: 1000, gain_db: -24, bandwidth: 8 },
    ];
    expect(autoGainDb(loud, RATE)).toBe(-12);
    expect(autoGainDb(quiet, RATE)).toBe(12);
  });

  it('charges a narrow bell less than a wide one', () => {
    // The energy integral is what makes a narrow boost nearly free and
    // a wide one proportionally expensive — the property the naive
    // pad-by-max-boost version broke, and the one a compensation
    // computed at the wrong bandwidth silently breaks again.
    const narrow = autoGainDb([{ type: 'bell', frequency: 1000, gain_db: 6, bandwidth: 0.3 }], RATE);
    const wide = autoGainDb([{ type: 'bell', frequency: 1000, gain_db: 6, bandwidth: 4 }], RATE);
    expect(Math.abs(narrow)).toBeLessThan(Math.abs(wide) / 3);
  });
});

// Parity against the C++ the port transliterates. The corpus leans on
// the corners: cuts, the clamp, a narrow band, every filter type, and
// a composite curve mixing them.
const CORPUS: EqBandLike[][] = [
  [{ type: 'bell', frequency: 1000, gain_db: 6, bandwidth: 1 }],
  [{ type: 'bell', frequency: 1000, gain_db: -6, bandwidth: 2 }],
  [{ type: 'bell', frequency: 3200, gain_db: 6, bandwidth: 0.3 }],
  [{ type: 'lowshelf', frequency: 8000, gain_db: 24, bandwidth: 8 }],
  [
    { type: 'highpass', frequency: 40, gain_db: 0, bandwidth: 2 },
    { type: 'lowshelf', frequency: 90, gain_db: -3, bandwidth: 2 },
    { type: 'bell', frequency: 220, gain_db: 4, bandwidth: 1.5 },
    { type: 'bell', frequency: 1200, gain_db: -2, bandwidth: 0.5 },
    { type: 'highshelf', frequency: 8000, gain_db: 2.5, bandwidth: 2 },
    { type: 'lowpass', frequency: 18000, gain_db: 0, bandwidth: 2 },
  ],
];

const execFileAsync = promisify(execFile);
const binary = (() => {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const candidates = [
    join(packageRoot, 'native/audiod/build/field-dsp-check'),
    join(packageRoot, 'native/audiod/build/field-dsp-check.exe'),
    join(packageRoot, 'native/audiod/build/Release/field-dsp-check.exe'),
  ];
  return candidates.find((c) => existsSync(c));
})();

describe.skipIf(!binary)('parity with the C++ (field-dsp-check eq-response)', () => {
  it('matches the native response and auto-gain across the corpus', async () => {
    for (const bands of CORPUS) {
      const spec = bands.map((b) => `${b.type}:${b.frequency}:${b.gain_db ?? 0}:${b.bandwidth ?? 2}`);
      const { stdout } = await execFileAsync(binary!, ['eq-response', String(RATE), ...spec]);
      const lines = stdout.trim().split('\n');
      const points = lines
        .filter((l) => l.startsWith('point '))
        .map((l) => l.split(' ').slice(1).map(Number) as [number, number]);
      const nativeGain = Number(lines.find((l) => l.startsWith('autogain '))!.split(' ')[1]);

      const ours = responseDb(bands, RATE, points.length);
      for (let i = 0; i < points.length; i++) {
        expect(Math.abs(ours[i]!.db - points[i]![1])).toBeLessThan(1e-6);
      }
      expect(Math.abs(autoGainDb(bands, RATE) - nativeGain)).toBeLessThan(1e-6);
    }
  });
});
