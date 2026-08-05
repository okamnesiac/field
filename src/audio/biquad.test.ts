import { describe, expect, it } from 'vitest';
import { autoGainDB, design, magnitudeDB, processBiquad, type Band } from './biquad.js';

const RATE = 48000;

const bell = (frequency: number, gain_db: number, bandwidth = 2): Band => ({
  type: 'bell',
  frequency,
  gain_db,
  bandwidth,
});

describe('design + magnitudeDB', () => {
  it('a bell peaks at its own frequency and vanishes far away', () => {
    const biquad = design(bell(1000, 6), RATE);
    expect(magnitudeDB(biquad, 1000, RATE)).toBeCloseTo(6, 1);
    expect(Math.abs(magnitudeDB(biquad, 30, RATE))).toBeLessThan(0.2);
    expect(Math.abs(magnitudeDB(biquad, 18000, RATE))).toBeLessThan(0.3);
  });

  it('a highpass passes highs and buries lows', () => {
    const biquad = design({ type: 'highpass', frequency: 100, gain_db: 0, bandwidth: 2 }, RATE);
    expect(magnitudeDB(biquad, 20, RATE)).toBeLessThan(-20);
    expect(Math.abs(magnitudeDB(biquad, 10000, RATE))).toBeLessThan(0.5);
  });

  it('shelves shelve', () => {
    const biquad = design({ type: 'highshelf', frequency: 4000, gain_db: 6, bandwidth: 2 }, RATE);
    expect(magnitudeDB(biquad, 16000, RATE)).toBeCloseTo(6, 0);
    expect(Math.abs(magnitudeDB(biquad, 100, RATE))).toBeLessThan(0.5);
  });
});

describe('autoGainDB (Fyra parity properties)', () => {
  it('a narrow bell costs almost nothing; a wide shelf proportionally more', () => {
    const narrow = autoGainDB([bell(1000, 6, 0.3)], RATE);
    const wide = autoGainDB([{ type: 'highshelf', frequency: 500, gain_db: 6, bandwidth: 2 }], RATE);
    expect(Math.abs(narrow)).toBeLessThan(1);
    expect(wide).toBeLessThan(-2); // pads down against the boost
    expect(Math.abs(wide)).toBeGreaterThan(Math.abs(narrow) * 3);
  });

  it('is symmetric in direction: cuts get make-up gain as boosts get padding', () => {
    const boost = autoGainDB([bell(1000, 6)], RATE);
    const cut = autoGainDB([bell(1000, -6)], RATE);
    expect(boost).toBeLessThan(0);
    expect(cut).toBeGreaterThan(0);
    // Energy-domain compensation is inherently boost-heavy (10^(g/10)
    // dominates the mean), so "largely cancel" — Fyra's own wording — not
    // exactly cancel.
    expect(Math.abs(boost + cut)).toBeLessThan(1.5);
  });

  it('clamps to ±12 dB', () => {
    const extreme: Band = { type: 'lowshelf', frequency: 20000, gain_db: 24, bandwidth: 16 };
    expect(autoGainDB([extreme], RATE)).toBeGreaterThanOrEqual(-12);
    const extremeCut: Band = { ...extreme, gain_db: -24 };
    expect(autoGainDB([extremeCut], RATE)).toBeLessThanOrEqual(12);
  });
});

describe('processBiquad', () => {
  it('boosts a sine at the bell frequency by the bell gain', () => {
    const frames = RATE; // 1 s
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) samples[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / RATE);
    const before = rms(samples.slice(4800)); // skip the settle
    processBiquad(samples, design(bell(1000, 6), RATE));
    const after = rms(samples.slice(4800));
    expect(20 * Math.log10(after / before)).toBeCloseTo(6, 0);
  });
});

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
}
