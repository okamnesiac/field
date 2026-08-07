import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { sha256FileSync } from '../hash.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { beatGrid, withClick } from './click.js';

// The metronome grid projects each beat through the tempo map, so ramps
// click at the ramped tempo and odd meters accent their own downbeats.

const ctx44 = {
  tempo: new TempoMap([{ at: 0, bpm: 120 }], 48000),
  meter: new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]),
};

describe('beatGrid', () => {
  it('places beats on the grid with downbeat accents', () => {
    const grid = beatGrid(ctx44, 96001, 48000); // just over one bar at 120
    expect(grid.map((g) => g.sample)).toEqual([0, 24000, 48000, 72000, 96000]);
    expect(grid.map((g) => g.accent)).toEqual([true, false, false, false, true]);
  });

  it('follows meter changes: 7/8 beats are eighths, accents every seven', () => {
    const ctx = {
      tempo: new TempoMap([{ at: 0, bpm: 120 }], 48000),
      meter: new MeterMap([{ at: 0, numerator: 7, denominator: 8 }]),
    };
    const grid = beatGrid(ctx, 480000, 48000);
    // Eighths at 120: 12000 samples each; bar = 7 of them.
    expect(grid[1]!.sample).toBe(12000);
    expect(grid[7]!.accent).toBe(true);
    expect(grid.slice(1, 7).every((g) => !g.accent)).toBe(true);
  });

  it('clicks at the ramped tempo, not the starting one', () => {
    const ctx = {
      tempo: new TempoMap(
        [
          { at: 0, bpm: 120, ramp: 'linear' as const },
          { at: 3840, bpm: 60 },
        ],
        48000,
      ),
      meter: new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]),
    };
    const grid = beatGrid(ctx, 480000, 48000);
    const gaps = grid.slice(1).map((g, i) => g.sample - grid[i]!.sample);
    // Each beat takes longer than the last through the decelerating ramp.
    for (let i = 1; i < 4; i++) expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!);
  });
});

describe('withClick', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bloom-click-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('overlays clicks on beats and leaves the space between silent', () => {
    const src = join(root, 'silent.wav');
    writeWavFloat32(src, 48000, [new Float32Array(48000), new Float32Array(48000)]);
    const clicked = withClick(root, ctx44, {
      label: '//songs/x/mix:main',
      pkg: 'songs/x/mix',
      path: src,
      sha256: 'deadbeef'.repeat(8),
    });

    const wav = readWav(clicked.path);
    expect(wav.channels[0]).toHaveLength(48000); // length untouched
    expect(Math.abs(wav.channels[0]![24001]!)).toBeGreaterThan(0.01); // beat 2 clicks
    expect(Math.abs(wav.channels[0]![23000]!)).toBe(0); // between beats: silence
    expect(clicked.path).not.toBe(src); // the artifact itself is never touched
  });

  it('re-hashes: sha256 describes the clicked file, not the source', () => {
    const src = join(root, 'silent.wav');
    writeWavFloat32(src, 48000, [new Float32Array(48000), new Float32Array(48000)]);
    const clicked = withClick(root, ctx44, {
      label: '//songs/x/mix:main',
      pkg: 'songs/x/mix',
      path: src,
      sha256: sha256FileSync(src),
    });

    // The invariant the field carries — "the hash of what path holds" —
    // is what watch seeds its baseline from, so the click must not leave
    // a hash describing a different file (#35 review).
    expect(clicked.sha256).toBe(sha256FileSync(clicked.path));
    expect(clicked.sha256).not.toBe(sha256FileSync(src));
  });
});
