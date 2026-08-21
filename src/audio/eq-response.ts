// The engine's EQ arithmetic, ported line-for-line from
// native/audiod/src/dsp/biquad.cpp so the curve the UI's editor draws
// and the compensation it reports are the render's own numbers. If the
// two implementations ever disagree, the picture lies — so this file
// mirrors design(), magnitudeDb() and autoGainDb() exactly, including
// the 45%-of-Nyquist clamp and the w/sin(w) bandwidth correction.
//
// This is a recorded partial reversal of render-pipeline.md decision 4,
// which deleted the TypeScript DSP: response arithmetic (never sample
// processing) re-exists here because the editor redraws its curve under
// a pointer drag at frame rate, and a socket round trip per pointer
// move is the same latency mistake the clock already made once
// (ui.md §6). The price decision 4 sets for a TS autoGainDb is paid in
// eq-response.test.ts: its three properties — make-up for cuts, the
// ±12 dB clamp, narrow-vs-wide proportionality — plus parity against
// the C++ itself through field-dsp-check's eq-response mode.

export interface EqBandLike {
  type: string;
  frequency: number;
  gain_db?: number | undefined;
  bandwidth?: number | undefined;
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function design(band: EqBandLike, sampleRate: number): Biquad {
  const frequency = Math.min(band.frequency, sampleRate * 0.45);
  const w = (2 * Math.PI * frequency) / sampleRate;
  const sn = Math.sin(w);
  const cs = Math.cos(w);
  const A = Math.pow(10, (band.gain_db ?? 0) / 40);
  const alpha = sn * Math.sinh(((Math.log(2) / 2) * (band.bandwidth ?? 2) * w) / sn);

  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  if (band.type === 'bell') {
    b0 = 1 + alpha * A;
    b1 = -2 * cs;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cs;
    a2 = 1 - alpha / A;
  } else if (band.type === 'lowpass') {
    b0 = (1 - cs) / 2;
    b1 = 1 - cs;
    b2 = (1 - cs) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cs;
    a2 = 1 - alpha;
  } else if (band.type === 'highpass') {
    b0 = (1 + cs) / 2;
    b1 = -(1 + cs);
    b2 = (1 + cs) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cs;
    a2 = 1 - alpha;
  } else if (band.type === 'lowshelf') {
    const sa = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 - (A - 1) * cs + sa);
    b1 = 2 * A * (A - 1 - (A + 1) * cs);
    b2 = A * (A + 1 - (A - 1) * cs - sa);
    a0 = A + 1 + (A - 1) * cs + sa;
    a1 = -2 * (A - 1 + (A + 1) * cs);
    a2 = A + 1 + (A - 1) * cs - sa;
  } else if (band.type === 'highshelf') {
    const sa = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 + (A - 1) * cs + sa);
    b1 = -2 * A * (A - 1 + (A + 1) * cs);
    b2 = A * (A + 1 + (A - 1) * cs - sa);
    a0 = A + 1 - (A - 1) * cs + sa;
    a1 = 2 * (A - 1 - (A + 1) * cs);
    a2 = A + 1 - (A - 1) * cs - sa;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function magnitudeDb(bq: Biquad, frequency: number, sampleRate: number): number {
  const w = (2 * Math.PI * Math.min(frequency, sampleRate * 0.45)) / sampleRate;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const c2w = Math.cos(2 * w);
  const s2w = Math.sin(2 * w);
  const numRe = bq.b0 + bq.b1 * cw + bq.b2 * c2w;
  const numIm = -(bq.b1 * sw + bq.b2 * s2w);
  const denRe = 1 + bq.a1 * cw + bq.a2 * c2w;
  const denIm = -(bq.a1 * sw + bq.a2 * s2w);
  const magnitude = Math.sqrt(
    (numRe * numRe + numIm * numIm) / Math.max(denRe * denRe + denIm * denIm, 1e-18),
  );
  return 20 * Math.log10(Math.max(magnitude, 1e-9));
}

// The composite response at n log-spaced points, 20 Hz to 20 kHz —
// what the curve draws.
export function responseDb(
  bands: EqBandLike[],
  sampleRate: number,
  n: number,
): { frequency: number; db: number }[] {
  const biquads = bands.map((b) => design(b, sampleRate));
  const out: { frequency: number; db: number }[] = [];
  for (let i = 0; i < n; i++) {
    const frequency = 20 * Math.pow(20000 / 20, i / (n - 1));
    let db = 0;
    for (const bq of biquads) db += magnitudeDb(bq, frequency, sampleRate);
    out.push({ frequency, db });
  }
  return out;
}

// Fyra's response-based compensation, the engine's exact loop: mean
// energy over 48 log-spaced samples, negated, clamped to ±12 dB. Shown
// in the editor because the rule is no invisible gain, ever.
export function autoGainDb(bands: EqBandLike[], sampleRate: number): number {
  const points = 48;
  const biquads = bands.map((b) => design(b, sampleRate));
  let meanEnergy = 0;
  for (let i = 0; i < points; i++) {
    const frequency = 20 * Math.pow(20000 / 20, i / (points - 1));
    let db = 0;
    for (const bq of biquads) db += magnitudeDb(bq, frequency, sampleRate);
    meanEnergy += Math.pow(10, db / 10) / points;
  }
  const compensation = -10 * Math.log10(Math.max(meanEnergy, 1e-12));
  return Math.max(-12, Math.min(12, compensation));
}
