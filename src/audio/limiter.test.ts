import { describe, expect, it } from 'vitest';
import { limit } from './limiter.js';

const settings = { ceilingDb: -6, lookaheadMs: 5, releaseMs: 50, sampleRate: 48000 };
const ceiling = Math.pow(10, -6 / 20);

describe('limit', () => {
  it('never lets a sample over the ceiling', () => {
    const hot = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 7)); // ~full scale
    limit([hot], settings);
    for (const v of hot) expect(Math.abs(v)).toBeLessThanOrEqual(ceiling + 1e-6);
  });

  it('leaves signal below the ceiling untouched', () => {
    const quiet = Float32Array.from({ length: 4800 }, (_, i) => 0.2 * Math.sin(i / 7));
    const copy = Float32Array.from(quiet);
    limit([quiet], settings);
    expect([...quiet]).toEqual([...copy]);
  });

  it('ramps in ahead of a spike and releases after it', () => {
    const spikeAt = 2400;
    const samples = new Float32Array(4800).fill(0.1);
    samples[spikeAt] = 1.0;
    limit([samples], settings);
    // Lookahead: gain is already coming down just before the spike. (The
    // −6 dB reduction spans exactly 24 samples at this slope, so probe
    // mid-ramp — spike−24 is the fencepost where the ramp reaches 0 dB.)
    expect(Math.abs(samples[spikeAt]!)).toBeLessThanOrEqual(ceiling + 1e-6);
    expect(samples[spikeAt - 12]!).toBeLessThan(0.1);
    // …attack is a ramp, not a cliff (monotonic into the spike)…
    expect(samples[spikeAt - 12]!).toBeLessThan(samples[spikeAt - 120]!);
    // …and release recovers gradually, reaching unity well after.
    expect(samples[spikeAt + 24]!).toBeLessThan(0.1);
    expect(samples[4700]).toBeCloseTo(0.1, 3);
  });

  it('links channels: a left spike ducks the right identically', () => {
    const left = new Float32Array(4800).fill(0.1);
    const right = new Float32Array(4800).fill(0.1);
    left[2400] = 1.0;
    limit([left, right], settings);
    expect(right[2400]!).toBeLessThan(0.1); // ducked by the left's spike
    expect(right[2400]! / 0.1).toBeCloseTo(Math.abs(left[2400]!) / 1.0, 5); // same gain
  });
});
