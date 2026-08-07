import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { buildLabels } from '../commands/build.js';
import { createSong } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';

// Properties of the three shipped effects, measured from rendered output
// (render-pipeline.md §2.3, chunk 1).
//
// This is the migration harness, and its one structural rule is that
// everything goes through the build rules — write a recipe, build the
// target, read the WAV. Nothing here imports `src/audio/` except
// `wav.ts`, which chunk 4 keeps. So when the daemon becomes the single
// executor and the TypeScript DSP is deleted, this file does not change
// hands: it asserts field's own semantics rather than that a biquad is a
// biquad, and it would fail on a renderer that quietly stopped matching
// the coefficient math.
//
// The measurement is a coherent multi-tone probe. Every probe frequency
// is an integer number of Hz and every window is a whole number of
// seconds, so each tone sits exactly on a DFT bin and the bins are
// orthogonal: no window function, no leakage, and no tolerance spent on
// measurement error rather than on the property.

const RATE = 48000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-effect-props-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// One file per sound (project-layout.md §1.3, §4).
function writeSound(name: string, lines: string[]): void {
  mkdirSync(join(root, 'songs/creek/sounds'), { recursive: true });
  writeFileSync(
    join(root, `songs/creek/sounds/${name}.yaml`),
    [`name: ${name}`, ...lines, ''].join('\n'),
  );
}

async function importSource(name: string, samples: Float32Array): Promise<void> {
  const src = join(root, '..', `field-effect-props-src-${name}.wav`);
  writeWavFloat32(src, RATE, [samples]);
  await importAsset(root, 'creek', src, name);
  rmSync(src);
}

async function render(label: string): Promise<Float32Array> {
  const outcomes = await buildLabels(root, [`//songs/creek/sound:${label}`]);
  return readWav(outcomes.find((o) => o.label.endsWith(`:${label}`))!.outputPath!).channels[0]!;
}

// Amplitude at one frequency over a whole number of seconds. Coherent by
// construction (see the header), so this is exact for a steady tone.
function magnitudeAt(samples: Float32Array, frequency: number, start: number, seconds: number) {
  const n = seconds * RATE;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const phase = (2 * Math.PI * frequency * i) / RATE;
    const v = samples[start + i]!;
    re += v * Math.cos(phase);
    im += v * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / n;
}

// Distinct integer frequencies, log-spaced. Integer so the probe stays
// coherent; the rounding costs at most 0.0003 dB on the normalize
// integral below, which is far under any tolerance here.
function logSpaced(low: number, high: number, points: number): number[] {
  const set = new Set<number>();
  for (let i = 0; i < points; i++) {
    set.add(Math.round(low * Math.pow(high / low, i / (points - 1))));
  }
  return [...set].sort((a, b) => a - b);
}

// Equal-amplitude sines at every probe frequency. Schroeder phases keep
// the crest factor near √2, so a hundred tones still fit well under full
// scale without pushing any one of them down into the noise.
function multitone(frequencies: number[], seconds: number): Float32Array {
  const out = new Float32Array(seconds * RATE);
  const amp = 0.5 / Math.sqrt(frequencies.length);
  frequencies.forEach((f, k) => {
    const phase = (Math.PI * k * (k + 1)) / frequencies.length;
    for (let i = 0; i < out.length; i++) {
      out[i] = out[i]! + amp * Math.sin((2 * Math.PI * f * i) / RATE + phase);
    }
  });
  return out;
}

// Response in dB at each probe, measured over seconds 1–3 so the filter's
// startup transient is outside the window.
function responseDb(rendered: Float32Array, source: Float32Array, probes: number[]) {
  return probes.map((f) => ({
    f,
    db: 20 * Math.log10(magnitudeAt(rendered, f, RATE, 2) / magnitudeAt(source, f, RATE, 2)),
  }));
}

function rms(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < Math.min(end, samples.length); i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / (Math.min(end, samples.length) - start));
}

describe('eq properties', () => {
  it('a bell of bandwidth B octaves has half-gain points 2^B apart', async () => {
    // The parity-proven parameterization: bandwidth in octaves via the
    // sinh alpha (effects.md §2). This is the property that says so —
    // JUCE's Q-parameterised `ArrayCoefficients` fails it, which is why
    // the port feeds field's own coefficients to `dsp::IIR::Filter`
    // rather than adopting its designer (render-pipeline.md §3).
    const [f0, gainDb, bandwidth] = [1000, 12, 2];
    const probes = logSpaced(250, 4000, 120);
    const source = multitone(probes, 3);
    await importSource('probe', source);
    writeSound('bell', [
      'type: eq',
      'source: probe',
      'normalize: false',
      'bands:',
      '  - type: bell',
      `    frequency: ${f0}`,
      `    gain_db: ${gainDb}`,
      `    bandwidth: ${bandwidth}`,
    ]);

    const curve = responseDb(await render('bell'), source, probes);

    // The bell reaches its stated gain at its stated frequency.
    const peak = curve.reduce((best, p) => (p.db > best.db ? p : best));
    expect(peak.db).toBeCloseTo(gainDb, 1);
    expect(peak.f / f0).toBeCloseTo(1, 1);

    // …and the half-gain points bracket it 2^B apart. Interpolating the
    // measured curve in log frequency: the crossings are the definition
    // of bandwidth, so this is the assertion the octaves claim rests on.
    const half = gainDb / 2;
    const crossings: number[] = [];
    for (let i = 1; i < curve.length; i++) {
      const [a, b] = [curve[i - 1]!, curve[i]!];
      if (a.db < half !== b.db < half) {
        const t = (half - a.db) / (b.db - a.db);
        crossings.push(Math.exp(Math.log(a.f) + t * (Math.log(b.f) - Math.log(a.f))));
      }
    }
    expect(crossings).toHaveLength(2);
    expect(crossings[1]! / crossings[0]!).toBeCloseTo(Math.pow(2, bandwidth), 1);
  });

  it('normalize returns the level it was handed, weighted as autoGainDB defines level', async () => {
    // `autoGainDB` averages power at 48 log-spaced points from 20 Hz to
    // 20 kHz — equal energy per octave, which is pink weighting, and the
    // source says so. Probing at those same 48 frequencies is the tight
    // form of the property, and it is the parity test in disguise: the
    // compensation is computed from the coefficients and checked here
    // against rendered audio, so a renderer that stopped matching the
    // coefficient math fails without anyone thinking to look.
    const probes = logSpaced(20, 20000, 48);
    const source = multitone(probes, 3);
    await importSource('probe', source);
    const shelf = [
      'bands:',
      '  - type: highshelf',
      '    frequency: 500',
      '    gain_db: 6',
      '    bandwidth: 2',
    ];
    writeSound('norm', ['type: eq', 'source: probe', 'normalize: true', ...shelf]);
    writeSound('raw', ['type: eq', 'source: probe', 'normalize: false', ...shelf]);

    const meanPowerDb = (curve: { db: number }[]) =>
      10 *
      Math.log10(
        curve.reduce((sum, p) => sum + Math.pow(10, p.db / 10), 0) / curve.length,
      );

    const normalized = responseDb(await render('norm'), source, probes);
    const raw = responseDb(await render('raw'), source, probes);

    expect(meanPowerDb(normalized)).toBeCloseTo(0, 1);
    // The compensation is doing real work: the same curve unnormalized
    // gains most of the shelf's 6 dB.
    expect(meanPowerDb(raw)).toBeGreaterThan(3);

    // The weighting is not incidental, and this is the line that keeps
    // someone from "fixing" a failure by switching to white noise.
    // Re-weighting the very same measurements per-Hz — each probe
    // carrying bandwidth proportional to its frequency, which is what
    // broadband white noise measures — moves the answer by more than a
    // dB, in the direction that made a white-noise probe of this shelf
    // read +1.91 dB.
    const perHz =
      10 *
      Math.log10(
        normalized.reduce((sum, p, i) => sum + Math.pow(10, p.db / 10) * probes[i]!, 0) /
          probes.reduce((sum, f) => sum + f, 0),
      );
    expect(perHz).toBeGreaterThan(1);
  });
});

describe('reverb properties', () => {
  const impulse = (seconds: number) => {
    const samples = new Float32Array(seconds * RATE);
    samples[0] = 1;
    return samples;
  };

  it('the tail decays 60 dB per decay-second', async () => {
    // `decay` is T60 and means it: comb feedback is derived per comb from
    // its own length, which is what makes the knob measurable at all.
    // JUCE's `roomSize` drives one feedback for all eight combs, so each
    // decays at a different real rate and this property has nothing to
    // measure (render-pipeline.md §2.4). Damping is off here because it
    // is a second, deliberate loss on top of T60.
    const decay = 1;
    await importSource('imp', impulse(1));
    writeSound('tail', [
      'type: reverb',
      'source: imp',
      `decay: ${decay}`,
      'mix: 1',
      'damping: 0',
    ]);
    const rendered = await render('tail');

    // Least squares through the dB envelope over 10%–90% of the decay,
    // rather than a ratio against an "early" window: the first
    // milliseconds are the sparse tap burst, not the steady envelope, and
    // measuring from there understates the slope by nearly 20 dB.
    const window = Math.round(0.05 * RATE);
    const points: { t: number; db: number }[] = [];
    for (let t = Math.round(0.1 * decay * RATE); t < 0.9 * decay * RATE; t += window) {
      const level = rms(rendered, t, t + window);
      if (level > 0) points.push({ t: t / RATE, db: 20 * Math.log10(level) });
    }
    const meanT = points.reduce((s, p) => s + p.t, 0) / points.length;
    const meanDb = points.reduce((s, p) => s + p.db, 0) / points.length;
    const slope =
      points.reduce((s, p) => s + (p.t - meanT) * (p.db - meanDb), 0) /
      points.reduce((s, p) => s + (p.t - meanT) ** 2, 0);
    expect(slope * decay).toBeGreaterThan(-63);
    expect(slope * decay).toBeLessThan(-57);
  });

  it('has no wet output before the predelay, and the first tap lands one comb later', async () => {
    // Predelay gates the *input* to a network that has its own latency,
    // so the onset is predelay + the shortest comb: at 48 kHz with 100 ms
    // that is 4800 + 1215 = 6015, not 4800.
    //
    // Asserting the exact sample is deliberate. field rounds its scaled
    // delay lengths and JUCE truncates the same base table, so a port
    // that reached for JUCE's sizing because the tables match would put
    // this at 6014 and shift every tap in the network
    // (render-pipeline.md §2.4). This is the cheap guard on that.
    await importSource('imp', impulse(1));
    writeSound('pre', [
      'type: reverb',
      'source: imp',
      'decay: 0.5',
      'mix: 1',
      'predelay_ms: 100',
      'damping: 0',
    ]);
    const rendered = await render('pre');
    const shortestComb = Math.round((1116 * RATE) / 44100);
    expect(rendered.findIndex((v) => v !== 0)).toBe(0.1 * RATE + shortestComb);
  });

  it('the diffusion chain is allpass: the tail carries exactly the comb bank energy', async () => {
    // A canonical Schroeder allpass has unit magnitude at every
    // frequency, so the four diffusers spread the tail without adding or
    // removing energy. That makes the wet energy computable from the comb
    // bank alone: comb k is y[n] = x[n] + g_k·y[n−L_k], whose impulse
    // response carries 1/(1−g_k²), and the bank averages eight of them.
    // The derivation is the point — nothing in `reverb.ts` computes this,
    // so the assertion is independent of the implementation rather than a
    // transcription of it.
    //
    // This is the property that catches the divergence none of the others
    // do. JUCE's `AllPassFilter::process` returns `read − x` — Jezar's
    // Freeverb variant, which is not a true allpass. Swapping field's
    // equation for it leaves every other assertion in this file green and
    // moves this one by 14.7 dB (render-pipeline.md §2.4). Chunk 4
    // deletes `reverb.ts`; this is what would notice.
    //
    // It locks the rest of the bank in passing: the per-comb feedback
    // derived from T60, the scaled delay lengths, and the ⅛ average all
    // have to be right for the number to come out.
    const combTunings = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const decay = 1;
    await importSource('imp', impulse(1));
    writeSound('bank', ['type: reverb', 'source: imp', `decay: ${decay}`, 'mix: 1', 'damping: 0']);
    const rendered = await render('bank');

    const predicted =
      combTunings.reduce((sum, tuning) => {
        const length = Math.max(1, Math.round((tuning * RATE) / 44100));
        const feedback = Math.pow(10, (-3 * length) / (decay * RATE));
        return sum + 1 / (1 - feedback * feedback);
      }, 0) / 64;

    let energy = 0;
    for (const v of rendered) energy += v * v;
    expect(10 * Math.log10(energy)).toBeCloseTo(10 * Math.log10(predicted), 1);
  });

  it('damping only ever shortens the tail', async () => {
    await importSource('imp', impulse(1));
    for (const damping of [0, 0.5, 1]) {
      writeSound(`d${String(damping).replace('.', '')}`, [
        'type: reverb',
        'source: imp',
        'decay: 1',
        'mix: 1',
        `damping: ${damping}`,
      ]);
    }
    const at80 = async (label: string) => {
      const out = await render(label);
      return rms(out, Math.round(0.8 * RATE), Math.round(0.8 * RATE) + 2400);
    };
    const [none, half, full] = [await at80('d0'), await at80('d05'), await at80('d1')];
    expect(half).toBeLessThan(none);
    expect(full).toBeLessThan(half);
  });
});

describe('limit properties', () => {
  // One float32 ulp, relative. The gain curve pins every peak to the
  // ceiling exactly in double precision; storing the result as float32
  // rounds to nearest, which can land half an ulp above. That is the
  // honest bound — the guarantee is in the arithmetic, and the format is
  // what spends it.
  const ULP = Math.pow(2, -23);

  it('never exceeds the ceiling, on transients built to break it', async () => {
    const ceilingDb = -1;
    const ceiling = Math.pow(10, ceilingDb / 20);
    // Every shape that could get past a lookahead limiter: a peak in the
    // first sample and in the last, where there is no room to ramp; an
    // alternating full-scale square, which never lets gain recover; a
    // step from near-silence; sustained material far over the ceiling;
    // and a single sample 100× above it.
    const parts: Float32Array[] = [
      Float32Array.from({ length: 4800 }, (_, i) => (i === 0 ? 1 : 0.05)),
      Float32Array.from({ length: 4800 }, (_, i) => (i === 4799 ? 1 : 0.05)),
      Float32Array.from({ length: 4800 }, (_, i) => (i % 2 ? 1 : -1)),
      Float32Array.from({ length: 4800 }, (_, i) => (i < 2400 ? 0.01 : 1)),
      new Float32Array(4800).fill(4),
      Float32Array.from({ length: 4800 }, (_, i) => (i === 2400 ? 100 : 0.01)),
    ];
    const source = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (source.set(p, at), at + p.length), 0);

    await importSource('hot', source);
    writeSound('safe', ['type: limit', 'source: hot', `ceiling_db: ${ceilingDb}`]);
    const rendered = await render('safe');

    let peak = 0;
    for (const v of rendered) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(ceiling * (1 + ULP));
    // …and it actually reached the ceiling, so the bound above is not
    // passing because the limiter over-attenuated everything.
    expect(peak).toBeGreaterThan(ceiling * (1 - ULP));
  });

  it('reaches the ceiling by gain reduction, not by clipping', async () => {
    // The advantage over `juce::dsp::Limiter`, stated exactly:
    // JUCE guarantees 0 dBFS by hard-clipping to [−1, 1]
    // (`juce_Limiter.h:40`, `:94`), field reaches an *arbitrary*
    // `ceiling_db` by pulling gain down (render-pipeline.md §2.4). Both
    // honour a ceiling; only one keeps the waveform.
    //
    // So the reference is computed here rather than hard-coded: clip the
    // same source at the same ceiling and compare harmonics. A renderer
    // that quietly became a clipper passes every other assertion in this
    // file and fails this one.
    const ceilingDb = -1;
    const ceiling = Math.pow(10, ceilingDb / 20);
    const source = Float32Array.from(
      { length: 3 * RATE },
      (_, i) => 2 * Math.sin((2 * Math.PI * 1000 * i) / RATE),
    );
    await importSource('over', source);
    writeSound('reduced', ['type: limit', 'source: over', `ceiling_db: ${ceilingDb}`]);
    const rendered = await render('reduced');

    const thd = (buf: Float32Array) => {
      const fundamental = magnitudeAt(buf, 1000, RATE, 2);
      const harmonics = [3, 5, 7, 9].map((k) => magnitudeAt(buf, 1000 * k, RATE, 2));
      return Math.sqrt(harmonics.reduce((s, v) => s + v * v, 0)) / fundamental;
    };
    const clipped = Float32Array.from(source, (v) => Math.max(-ceiling, Math.min(ceiling, v)));
    expect(20 * Math.log10(thd(rendered) / thd(clipped))).toBeLessThan(-20);
  });

  it('the attack ramp reaches back by lookahead_ms', async () => {
    // Lookahead is the other half of §2.4's claim, and it is the half
    // with no coverage anywhere else once chunk 4 deletes
    // `limiter.test.ts`: removing the backward pass entirely leaves every
    // other assertion in this file green.
    //
    // The slope is scaled so the deepest plausible reduction spans
    // exactly the configured window, so a spike 60 dB over the ceiling
    // ramps for very close to `lookahead_ms` — which makes the window
    // itself measurable rather than merely present.
    const spikeAt = 2400;
    const source = new Float32Array(4800).fill(0.1);
    source[spikeAt] = 1000; // ~60 dB over a −1 dB ceiling
    await importSource('spike', source);

    const rampMs = async (lookaheadMs: number) => {
      writeSound(`la${lookaheadMs}`, [
        'type: limit',
        'source: spike',
        'ceiling_db: -1',
        `lookahead_ms: ${lookaheadMs}`,
      ]);
      const out = await render(`la${lookaheadMs}`);
      let first = spikeAt;
      while (first > 0 && out[first - 1]! < source[first - 1]! * (1 - 1e-6)) first--;
      return ((spikeAt - first) / RATE) * 1000;
    };

    for (const lookaheadMs of [1, 5, 20]) {
      expect(await rampMs(lookaheadMs)).toBeGreaterThan(lookaheadMs * 0.9);
      expect(await rampMs(lookaheadMs)).toBeLessThan(lookaheadMs * 1.15);
    }
  });

  it('passes audio under the ceiling through bit-exact', async () => {
    // Not "close to unity": the slew is a cap on how fast gain may rise,
    // so audio the limiter never touched sits at exactly 0 dB and the
    // multiply is by exactly 1. Anything else means the gain curve
    // leaked into material it had no reason to touch.
    const source = Float32Array.from({ length: 48000 }, (_, i) => 0.3 * Math.sin(i / 11));
    await importSource('quiet', source);
    writeSound('untouched', ['type: limit', 'source: quiet', 'ceiling_db: -1']);
    expect([...(await render('untouched'))]).toEqual([...source]);
  });
});
