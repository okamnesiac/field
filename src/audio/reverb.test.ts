import { describe, expect, it } from 'vitest';
import { reverb } from './reverb.js';

const RATE = 48000;
const settings = { mix: 0.5, decaySeconds: 0.5, predelayMs: 0, damping: 0.5, sampleRate: RATE };

function impulse(frames = 4800): Float32Array {
  const samples = new Float32Array(frames);
  samples[0] = 1;
  return samples;
}

describe('reverb', () => {
  it('grows the output by the tail and decays toward -60 dB', () => {
    const [out] = reverb([impulse()], settings);
    expect(out!.length).toBe(4800 + RATE * 0.5);
    const early = rms(out!.subarray(0, 4800));
    const late = rms(out!.subarray(out!.length - 2400));
    expect(early).toBeGreaterThan(0);
    expect(late).toBeLessThan(early / 100); // well down the tail
  });

  it('mix 0 is a dry passthrough with a silent tail', () => {
    const dry = impulse();
    const [out] = reverb([dry], { ...settings, mix: 0 });
    expect(out![0]).toBeCloseTo(1, 6);
    expect(rms(out!.subarray(4800))).toBe(0);
  });

  it('predelay shifts the wet start', () => {
    const [out] = reverb([impulse()], { ...settings, mix: 1, predelayMs: 100 });
    const predelaySamples = RATE * 0.1;
    // The earliest comb tap lands after predelay + the shortest comb.
    expect(rms(out!.subarray(0, predelaySamples))).toBe(0);
    expect(rms(out!.subarray(predelaySamples, predelaySamples + 9600))).toBeGreaterThan(0);
  });

  it('is deterministic and spreads the channels', () => {
    const a = reverb([impulse(), impulse()], settings);
    const b = reverb([impulse(), impulse()], settings);
    expect([...a[0]!]).toEqual([...b[0]!]);
    expect([...a[1]!]).toEqual([...b[1]!]);
    expect([...a[0]!]).not.toEqual([...a[1]!]); // stereo spread
  });
});

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
}
