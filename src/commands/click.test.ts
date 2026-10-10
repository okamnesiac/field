import { describe, expect, it } from 'vitest';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { beatGrid, CLICK_FALLBACK_SECONDS, clickSchedule, countInSchedule, countInStart } from './click.js';

// The metronome grid projects each beat through the tempo map, so ramps
// click at the ramped tempo and odd meters accent their own downbeats.
// Since recording.md chunk 3 the grid is what crosses the socket — a
// schedule the daemon synthesizes — rather than a DSP over a temp file.

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

describe('clickSchedule', () => {
  it('is the grid over the bed at the bed\'s rate, as the wire wants it', () => {
    const schedule = clickSchedule(ctx44, 96001, 48000);
    expect(schedule.rate).toBe(48000);
    expect(schedule.ticks).toEqual([
      { sample: 0, accent: true },
      { sample: 24000, accent: false },
      { sample: 48000, accent: false },
      { sample: 72000, accent: false },
      { sample: 96000, accent: true },
    ]);
  });

  it('projects into the bed\'s rate when it differs from the map\'s', () => {
    // The map counts at 48 kHz; a 44.1 kHz bed's beat 2 is sample 22050.
    const schedule = clickSchedule(ctx44, 44100, 44100);
    expect(schedule.rate).toBe(44100);
    expect(schedule.ticks.map((t) => t.sample)).toEqual([0, 22050]);
  });

  it('covers ten minutes when the bed\'s extent is unknown', () => {
    const schedule = clickSchedule(ctx44, 0, 48000);
    expect(schedule.ticks.at(-1)!.sample).toBeLessThan(CLICK_FALLBACK_SECONDS * 48000);
    expect(schedule.ticks.length).toBe(CLICK_FALLBACK_SECONDS * 2); // two beats a second at 120
  });
});

describe('count-in', () => {
  it('starts whole bars before the position, on the same beat, never before bar 1', () => {
    const bar3beat2 = ctx44.meter.parse('3.2');
    expect(ctx44.meter.format(countInStart(ctx44, bar3beat2, 1))).toBe('2.2.1');
    expect(ctx44.meter.format(countInStart(ctx44, bar3beat2, 2))).toBe('1.2.1');
    expect(ctx44.meter.format(countInStart(ctx44, bar3beat2, 5))).toBe('1.2.1');
  });

  it('schedules only the beats from the count-in start up to the take', () => {
    // Counting one bar into bar 3: beats at bars 2.1–2.4, nothing at 3.1
    // or after — the performer hears the bar before and then silence.
    const from = ctx44.tempo.ticksToSamples(ctx44.meter.parse('2.1'));
    const to = ctx44.tempo.ticksToSamples(ctx44.meter.parse('3.1'));
    const schedule = countInSchedule(ctx44, from, to, 48000);
    expect(schedule.ticks).toEqual([
      { sample: 96000, accent: true },
      { sample: 120000, accent: false },
      { sample: 144000, accent: false },
      { sample: 168000, accent: false },
    ]);
  });
});
