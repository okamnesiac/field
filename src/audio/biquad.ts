// RBJ audio-EQ-cookbook biquads, ported from Fyra's eq.cpp so the two
// systems agree band-for-band (effects.md §2): bandwidth in OCTAVES via
// the sinh alpha (shelves driven from that same alpha), frequency clamped
// to 45% of Nyquist, and — for response math — per-band dB summing, which
// discards phase interaction but matches what Fyra displays and
// compensates against.

export type BandType = 'highpass' | 'lowshelf' | 'bell' | 'highshelf' | 'lowpass';

export interface Band {
  type: BandType;
  frequency: number;
  gain_db: number; // meaningful for bell and shelves only
  bandwidth: number; // octaves
}

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function design(band: Band, sampleRate: number): Biquad {
  // Clamped to 45% of Nyquist: a bell parked at the very top of the range
  // would otherwise produce coefficients that blow up.
  const frequency = Math.min(band.frequency, sampleRate * 0.45);
  const w = (2 * Math.PI * frequency) / sampleRate;
  const sn = Math.sin(w);
  const cs = Math.cos(w);
  const A = Math.pow(10, band.gain_db / 40);
  const alpha = sn * Math.sinh(((Math.log(2) / 2) * band.bandwidth * w) / sn);

  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (band.type) {
    case 'bell':
      b0 = 1 + alpha * A;
      b1 = -2 * cs;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cs;
      a2 = 1 - alpha / A;
      break;
    case 'lowpass':
      b0 = (1 - cs) / 2;
      b1 = 1 - cs;
      b2 = (1 - cs) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cs;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cs) / 2;
      b1 = -(1 + cs);
      b2 = (1 + cs) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cs;
      a2 = 1 - alpha;
      break;
    case 'lowshelf': {
      const sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cs + sa);
      b1 = 2 * A * (A - 1 - (A + 1) * cs);
      b2 = A * (A + 1 - (A - 1) * cs - sa);
      a0 = A + 1 + (A - 1) * cs + sa;
      a1 = -2 * (A - 1 + (A + 1) * cs);
      a2 = A + 1 + (A - 1) * cs - sa;
      break;
    }
    case 'highshelf': {
      const sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cs + sa);
      b1 = -2 * A * (A - 1 + (A + 1) * cs);
      b2 = A * (A + 1 + (A - 1) * cs - sa);
      a0 = A + 1 - (A - 1) * cs + sa;
      a1 = 2 * (A - 1 - (A + 1) * cs);
      a2 = A + 1 - (A - 1) * cs - sa;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function magnitudeDB(biquad: Biquad, frequency: number, sampleRate: number): number {
  const w = (2 * Math.PI * Math.min(frequency, sampleRate * 0.45)) / sampleRate;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const c2w = Math.cos(2 * w);
  const s2w = Math.sin(2 * w);
  const numRe = biquad.b0 + biquad.b1 * cw + biquad.b2 * c2w;
  const numIm = -(biquad.b1 * sw + biquad.b2 * s2w);
  const denRe = 1 + biquad.a1 * cw + biquad.a2 * c2w;
  const denIm = -(biquad.a1 * sw + biquad.a2 * s2w);
  const magnitude = Math.sqrt(
    (numRe * numRe + numIm * numIm) / Math.max(denRe * denRe + denIm * denIm, 1e-18),
  );
  return 20 * Math.log10(Math.max(magnitude, 1e-9));
}

// Fyra's response-based auto-gain (effects.md §2, docs/eq.md there):
// composite response at 48 log-spaced points 20 Hz–20 kHz, converted to
// power and averaged (uniform log samples = pink-noise weighting),
// compensation = −10·log10(mean), clamped ±12 dB. Deterministic from the
// curve alone — EQ moves change tone, not level.
export function autoGainDB(bands: Band[], sampleRate: number): number {
  const points = 48;
  let meanEnergy = 0;
  const biquads = bands.map((band) => design(band, sampleRate));
  for (let i = 0; i < points; i++) {
    const frequency = 20 * Math.pow(20000 / 20, i / (points - 1));
    let db = 0;
    for (const biquad of biquads) db += magnitudeDB(biquad, frequency, sampleRate);
    meanEnergy += Math.pow(10, db / 10) / points;
  }
  const compensation = -10 * Math.log10(Math.max(meanEnergy, 1e-12));
  return Math.max(-12, Math.min(12, compensation));
}

// One biquad over one channel, in place, double-precision state.
export function processBiquad(samples: Float32Array, biquad: Biquad): void {
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!;
    const y = biquad.b0 * x + z1;
    z1 = biquad.b1 * x - biquad.a1 * y + z2;
    z2 = biquad.b2 * x - biquad.a2 * y;
    samples[i] = y;
  }
}
