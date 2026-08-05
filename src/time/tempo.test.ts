import { describe, expect, it } from 'vitest';
import { MeterMap, TempoMap } from './tempo.js';
import { PPQ } from '../constants.js';

describe('TempoMap', () => {
  it('converts ticks to seconds at constant tempo', () => {
    const map = new TempoMap([{ at: 0, bpm: 120 }], 48000);
    expect(map.ticksToSeconds(0)).toBe(0);
    expect(map.ticksToSeconds(PPQ)).toBeCloseTo(0.5, 10); // one beat at 120
    expect(map.ticksToSeconds(PPQ * 4)).toBeCloseTo(2, 10);
  });

  it('handles tempo changes', () => {
    const map = new TempoMap(
      [
        { at: 0, bpm: 120 },
        { at: PPQ * 4, bpm: 60 },
      ],
      48000,
    );
    // 4 beats at 120 (2s) + 4 beats at 60 (4s)
    expect(map.ticksToSeconds(PPQ * 8)).toBeCloseTo(6, 10);
  });

  it('integrates linear ramps in closed form', () => {
    const map = new TempoMap(
      [
        { at: 0, bpm: 120, ramp: 'linear' },
        { at: PPQ * 4, bpm: 240 },
      ],
      48000,
    );
    // ∫ 60/bpm(b) db over 4 beats, 120→240: 60·4·ln(2)/120 = 2·ln 2
    expect(map.ticksToSeconds(PPQ * 4)).toBeCloseTo(2 * Math.log(2), 10);
  });

  it('round-trips seconds to ticks through ramps and changes', () => {
    const map = new TempoMap(
      [
        { at: 0, bpm: 90, ramp: 'linear' },
        { at: PPQ * 8, bpm: 140 },
        { at: PPQ * 16, bpm: 121.3 },
      ],
      96000,
    );
    for (const ticks of [0, 1, 480, PPQ * 3, PPQ * 8, PPQ * 12, PPQ * 20]) {
      expect(map.secondsToTicks(map.ticksToSeconds(ticks))).toBeCloseTo(ticks, 6);
    }
  });

  it('converts to samples at the project rate', () => {
    const map = new TempoMap([{ at: 0, bpm: 120 }], 96000);
    expect(map.ticksToSamples(PPQ)).toBe(48000);
  });

  it('rejects invalid maps', () => {
    expect(() => new TempoMap([], 48000)).toThrow();
    expect(() => new TempoMap([{ at: 100, bpm: 120 }], 48000)).toThrow('tick 0');
    expect(
      () =>
        new TempoMap(
          [
            { at: 0, bpm: 120 },
            { at: 0, bpm: 100 },
          ],
          48000,
        ),
    ).toThrow('ordered');
  });
});

describe('MeterMap', () => {
  it('formats 1-based bar.beat.tick in 4/4', () => {
    const map = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
    expect(map.format(0)).toBe('1.1.1');
    expect(map.format(PPQ)).toBe('1.2.1');
    expect(map.format(PPQ * 4)).toBe('2.1.1');
    expect(map.format(PPQ * 4 + PPQ + 1)).toBe('2.2.2');
  });

  it('parses positions, defaulting beat and tick to 1', () => {
    const map = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
    expect(map.parse('1.1.1')).toBe(0);
    expect(map.parse('2')).toBe(PPQ * 4);
    expect(map.parse('2.2')).toBe(PPQ * 5);
    expect(map.parse('42.2.1')).toBe(PPQ * 4 * 41 + PPQ);
  });

  it('round-trips through meter changes', () => {
    const map = new MeterMap([
      { at: 0, numerator: 4, denominator: 4 },
      { at: PPQ * 8, numerator: 7, denominator: 8 }, // bar 3 becomes 7/8
    ]);
    expect(map.format(PPQ * 8)).toBe('3.1.1');
    // one 7/8 bar = 7 · 480 ticks
    expect(map.format(PPQ * 8 + 7 * 480)).toBe('4.1.1');
    for (const pos of ['1.1.1', '2.4.480', '3.7.1', '5.2.3']) {
      expect(map.format(map.parse(pos))).toBe(pos);
    }
  });

  it('rejects meter changes off the bar boundary', () => {
    expect(
      () =>
        new MeterMap([
          { at: 0, numerator: 4, denominator: 4 },
          { at: PPQ * 3, numerator: 3, denominator: 4 },
        ]),
    ).toThrow('bar boundary');
  });

  it('rejects out-of-range beats and ticks', () => {
    const map = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
    expect(() => map.parse('1.5.1')).toThrow('out of range');
    expect(() => map.parse('1.1.961')).toThrow('out of range');
    expect(() => map.parse('0.1.1')).toThrow('>= 1');
  });
});
