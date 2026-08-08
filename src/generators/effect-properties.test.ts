import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
// `wav.ts`. That rule is what let chunk 4 delete the TypeScript DSP
// without this file changing hands: it asserts field's own semantics
// rather than that a biquad is a biquad, and it fails on a renderer that
// quietly stops matching the coefficient math. It is now the only thing
// that does — the daemon is the sole executor, so every assertion below
// is measured from C++ output.
//
// The measurement is a coherent multi-tone probe. Every probe frequency
// is an integer number of Hz and every window is a whole number of
// seconds, so each tone sits exactly on a DFT bin and the bins are
// orthogonal: no window function, no leakage, and no tolerance spent on
// measurement error rather than on the property.

// These are measurements, not latency assertions: each one builds through
// the graph and then runs a few million trig operations. A loaded runner
// must not be able to turn one into a timeout — the same reason
// `say.test.ts` sets its own — so the ceiling is generous and file-wide.
vi.setConfig({ testTimeout: 30_000 });

const RATE = 48000;

// Probe geometry. The source runs two seconds and the measurement window
// is the second of them, so the filter's startup transient is outside it
// and every integer-Hz tone is still coherent over a whole second. Both
// numbers are here rather than inline because they have to agree: a
// window that is not a whole number of seconds silently reintroduces
// leakage, and one that starts at zero measures the transient.
const PROBE_SECONDS = 2;
const WINDOW_SECONDS = 1;

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

async function importSource(name: string, ...channels: Float32Array[]): Promise<void> {
  const src = join(root, '..', `field-effect-props-src-${name}.wav`);
  writeWavFloat32(src, RATE, channels);
  await importAsset(root, 'creek', src, name);
  rmSync(src);
}

async function renderChannels(label: string): Promise<Float32Array[]> {
  const outcomes = await buildLabels(root, [`//songs/creek/sound:${label}`]);
  return readWav(outcomes.find((o) => o.label.endsWith(`:${label}`))!.outputPath!).channels;
}

async function render(label: string): Promise<Float32Array> {
  return (await renderChannels(label))[0]!;
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

// Response in dB at each probe, over the measurement window.
function responseDb(rendered: Float32Array, source: Float32Array, probes: number[]) {
  return probes.map((f) => ({
    f,
    db:
      20 *
      Math.log10(
        magnitudeAt(rendered, f, RATE, WINDOW_SECONDS) /
          magnitudeAt(source, f, RATE, WINDOW_SECONDS),
      ),
  }));
}

function rms(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < Math.min(end, samples.length); i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / (Math.min(end, samples.length) - start));
}

// Level, as `autoGainDB` defines it: mean power across the probe set,
// which is equal energy per octave because the probes are log-spaced.
// Shared by the three normalize properties below, all of which are
// comparisons of this quantity before and after compensation.
function meanPowerDb(curve: { db: number }[]): number {
  return (
    10 * Math.log10(curve.reduce((sum, p) => sum + Math.pow(10, p.db / 10), 0) / curve.length)
  );
}

describe('eq properties', () => {
  it('a bell of bandwidth B octaves has half-gain points 2^B apart', async () => {
    // The parity-proven parameterization: bandwidth in octaves via the
    // sinh alpha (effects.md §2). This is the property that says so —
    // JUCE's Q-parameterised `ArrayCoefficients` fails it, which is why
    // the port feeds field's own coefficients to `dsp::IIR::Filter`
    // rather than adopting its designer (render-pipeline.md §3).
    const [f0, gainDb, bandwidth] = [1000, 12, 2];
    const probes = logSpaced(250, 4000, 64);
    const source = multitone(probes, PROBE_SECONDS);
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

  it('each band type shapes the curve the way its name says', async () => {
    // The schema discriminates on five band types (effects.md §2) and the
    // assertions around this one exercise two. A renderer that treated
    // `highpass`, `lowpass` and `lowshelf` as identity — or that mapped
    // one type onto another — would pass everything else in this file.
    //
    // The probes sit well outside each corner, so what is asserted is the
    // shape the name promises rather than the exact corner behaviour,
    // which the bandwidth property above already pins.
    // Both probes have to be members of the tone set, or the DFT reads
    // leakage instead of a tone: 48 Hz and 9591 Hz are the set's nearest
    // entries to 50 Hz and 10 kHz.
    const tones = logSpaced(20, 20000, 48);
    const nearest = (target: number) =>
      tones.reduce((best, f) => (Math.abs(f - target) < Math.abs(best - target) ? f : best));
    const probes = [nearest(50), nearest(10000)];
    const source = multitone(tones, PROBE_SECONDS);
    await importSource('probe', source);

    const cases: { type: string; frequency: number; gainDb: number; atLow: number[]; atHigh: number[] }[] =
      [
        { type: 'highpass', frequency: 500, gainDb: 0, atLow: [-100, -25], atHigh: [-1, 1] },
        { type: 'lowpass', frequency: 2000, gainDb: 0, atLow: [-1, 1], atHigh: [-100, -25] },
        { type: 'lowshelf', frequency: 500, gainDb: 6, atLow: [5, 7], atHigh: [-1, 1] },
        { type: 'highshelf', frequency: 500, gainDb: 6, atLow: [-1, 1], atHigh: [5, 7] },
        { type: 'bell', frequency: 1000, gainDb: 6, atLow: [-1, 1], atHigh: [-1, 1] },
      ];

    for (const { type, frequency, gainDb, atLow, atHigh } of cases) {
      writeSound(type, [
        'type: eq',
        'source: probe',
        'normalize: false',
        'bands:',
        `  - type: ${type}`,
        `    frequency: ${frequency}`,
        `    gain_db: ${gainDb}`,
        '    bandwidth: 1',
      ]);
      const [low, high] = responseDb(await render(type), source, probes);
      expect(low!.db, `${type} at ${probes[0]} Hz`).toBeGreaterThanOrEqual(atLow[0]!);
      expect(low!.db, `${type} at ${probes[0]} Hz`).toBeLessThanOrEqual(atLow[1]!);
      expect(high!.db, `${type} at ${probes[1]} Hz`).toBeGreaterThanOrEqual(atHigh[0]!);
      expect(high!.db, `${type} at ${probes[1]} Hz`).toBeLessThanOrEqual(atHigh[1]!);
    }
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
    const source = multitone(probes, PROBE_SECONDS);
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

  it('normalize makes up a cut, not only pads a boost', async () => {
    // The compensation is signed, because a cut moves the level as surely
    // as a boost does and the rule is that EQ moves change tone, not
    // level. Every other normalize assertion here uses a boost, and so
    // does the byte-identity golden (a +6.6 dB bell), so a renderer that
    // clamped the compensation to negative — padding boosts, leaving cuts
    // alone — passed the entire suite. That is not a hypothetical: it is
    // the mutation that motivated this test, run against the C++ while
    // chunk 4 was deleting the TypeScript that used to assert it.
    const probes = logSpaced(20, 20000, 48);
    const source = multitone(probes, PROBE_SECONDS);
    await importSource('probe', source);
    const shelf = [
      'bands:',
      '  - type: highshelf',
      '    frequency: 500',
      '    gain_db: -6',
      '    bandwidth: 2',
    ];
    writeSound('cutnorm', ['type: eq', 'source: probe', 'normalize: true', ...shelf]);
    writeSound('cutraw', ['type: eq', 'source: probe', 'normalize: false', ...shelf]);

    const normalized = meanPowerDb(responseDb(await render('cutnorm'), source, probes));
    const raw = meanPowerDb(responseDb(await render('cutraw'), source, probes));

    expect(normalized).toBeCloseTo(0, 1);
    // …and it got there by adding gain, not by the cut happening to be
    // level already: unnormalized, the same curve sits measurably down.
    expect(raw).toBeLessThan(-2);
  });

  it('a narrow bell costs almost nothing; a wide shelf proportionally more', async () => {
    // The third of the Fyra auto-gain contracts (effects.md §5), and the
    // one that says the compensation is computed from the *curve* rather
    // than from the gain knob: a 0.3-octave bell at +6 dB barely moves
    // the mean, while a shelf at the same gain lifts everything above its
    // corner and costs several dB.
    //
    // Nothing else here renders a normalized band narrower than one
    // octave, which is what let it go missing (#55 review). The mutation
    // that found it widened narrow bands to 2 octaves *only* while
    // computing compensation, leaving the rendered filter alone — 38
    // relevant tests passed, this one fails.
    const probes = logSpaced(20, 20000, 48);
    const source = multitone(probes, PROBE_SECONDS);
    await importSource('probe', source);

    const applied = async (label: string, band: string[]) => {
      writeSound(`${label}norm`, ['type: eq', 'source: probe', 'normalize: true', ...band]);
      writeSound(`${label}raw`, ['type: eq', 'source: probe', 'normalize: false', ...band]);
      const norm = meanPowerDb(responseDb(await render(`${label}norm`), source, probes));
      const raw = meanPowerDb(responseDb(await render(`${label}raw`), source, probes));
      return norm - raw;
    };

    const narrow = await applied('narrow', [
      'bands:',
      '  - type: bell',
      '    frequency: 1000',
      '    gain_db: 6',
      '    bandwidth: 0.3',
    ]);
    const wide = await applied('wide', [
      'bands:',
      '  - type: highshelf',
      '    frequency: 500',
      '    gain_db: 6',
      '    bandwidth: 2',
    ]);

    expect(Math.abs(narrow), 'narrow bell').toBeLessThan(1);
    expect(wide, 'wide shelf').toBeLessThan(-2);
    expect(Math.abs(wide), 'proportionality').toBeGreaterThan(Math.abs(narrow) * 3);
  });

  it('the compensation saturates at ±12 dB rather than chasing the curve', async () => {
    // The make-up is bounded (biquad.ts, Fyra parity). Past the bound
    // normalize deliberately stops tracking, so an extreme EQ stays loud
    // instead of being hauled back to level by twenty-odd dB of gain the
    // user never asked for. Removing the clamp outright also survived the
    // whole suite before this existed.
    //
    // Both numbers here are measured rather than restated from the
    // implementation: `raw` is what the curve demands, and the difference
    // is what was actually spent. So the assertion reads "the demand
    // exceeded the bound, and exactly the bound was applied" without
    // re-deriving autoGainDB's arithmetic — which would make it a
    // transcription instead of a property.
    const probes = logSpaced(20, 20000, 48);
    const source = multitone(probes, PROBE_SECONDS);
    await importSource('probe', source);

    for (const [label, gainDb, clamp] of [
      ['hot', 24, -12],
      ['cold', -24, 12],
    ] as const) {
      const shelf = [
        'bands:',
        '  - type: lowshelf',
        '    frequency: 20000',
        `    gain_db: ${gainDb}`,
        '    bandwidth: 1',
      ];
      writeSound(`${label}norm`, ['type: eq', 'source: probe', 'normalize: true', ...shelf]);
      writeSound(`${label}raw`, ['type: eq', 'source: probe', 'normalize: false', ...shelf]);

      const normalized = meanPowerDb(responseDb(await render(`${label}norm`), source, probes));
      const raw = meanPowerDb(responseDb(await render(`${label}raw`), source, probes));

      // The curve asks for more than the bound allows…
      expect(Math.abs(raw), `${label}: demand`).toBeGreaterThan(12);
      // …exactly the bound is spent…
      expect(normalized - raw, `${label}: applied`).toBeCloseTo(clamp, 2);
      // …and the render is left off level on purpose, which is the whole
      // reason for bounding it. Without this line the test would still
      // pass on a renderer that clamped at some much larger value.
      expect(Math.abs(normalized), `${label}: residual`).toBeGreaterThan(5);
    }
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
    // moves this one by 14.7 dB (render-pipeline.md §2.4). `reverb.ts` is
    // gone as of chunk 4; this is what notices.
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

  it('spreads the right channel by the stereo offset', async () => {
    // The right channel runs every delay line 23 samples longer at the
    // Freeverb reference rate, scaled the same way as the tunings. That
    // is the whole of the stereo image, and it is exact: the right tap
    // lands at round((1116+23)·rate/44100) = 1240 where the left lands at
    // 1215. Deleting the spread leaves both channels identical, which
    // every mono assertion in this file is blind to.
    await importSource('imp', impulse(1), impulse(1));
    writeSound('wide', ['type: reverb', 'source: imp', 'decay: 0.5', 'mix: 1', 'damping: 0']);
    const [left, right] = await renderChannels('wide');

    const scaled = (tuning: number) => Math.max(1, Math.round((tuning * RATE) / 44100));
    expect(left!.findIndex((v) => v !== 0)).toBe(scaled(1116));
    expect(right!.findIndex((v) => v !== 0)).toBe(scaled(1116 + 23));
    expect([...right!]).not.toEqual([...left!]);
  });

  it('mix blends dry against wet by both stated coefficients', async () => {
    // `mix` is equal-sum dry/wet (effects.md §2): out = dry·(1−mix) +
    // wet·mix, and both coefficients need asserting. The first wet tap is
    // a whole comb away, so sample 0 pins the *dry* one exactly — but on
    // its own that leaves `wet · (mix === 0 ? 0 : 1)` passing, which
    // blends the dry correctly while running fully wet at every nonzero
    // mix.
    //
    // The source is a lone impulse, so every sample after the first is
    // wet only. Referenced against the `mix: 1` render, that pins the wet
    // coefficient twice over: the first tap scales as `mix`, and the
    // whole wet signal carries `mix²` of the energy. Both hold exactly.
    await importSource('imp', impulse(1));
    const renderAtMix = (mix: number) => {
      const label = `mix${String(mix).replace('.', '')}`;
      writeSound(label, [
        'type: reverb',
        'source: imp',
        'decay: 0.5',
        `mix: ${mix}`,
        'damping: 0',
      ]);
      return render(label);
    };
    const wetEnergy = (buffer: Float32Array) => {
      let energy = 0;
      for (let i = 1; i < buffer.length; i++) energy += buffer[i]! * buffer[i]!;
      return energy;
    };

    const fullyWet = await renderAtMix(1);
    const tap = fullyWet.findIndex((v) => v !== 0);
    const reference = wetEnergy(fullyWet);

    for (const mix of [0, 0.25, 0.5, 1]) {
      const rendered = await renderAtMix(mix);
      expect(rendered[0]!, `dry at mix ${mix}`).toBeCloseTo(1 - mix, 6);
      expect(rendered[tap]! / fullyWet[tap]!, `wet tap at mix ${mix}`).toBeCloseTo(mix, 6);
      expect(wetEnergy(rendered) / reference, `wet energy at mix ${mix}`).toBeCloseTo(mix * mix, 6);
    }
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
      { length: PROBE_SECONDS * RATE },
      (_, i) => 2 * Math.sin((2 * Math.PI * 1000 * i) / RATE),
    );
    await importSource('over', source);
    writeSound('reduced', ['type: limit', 'source: over', `ceiling_db: ${ceilingDb}`]);
    const rendered = await render('reduced');

    const thd = (buf: Float32Array) => {
      const fundamental = magnitudeAt(buf, 1000, RATE, WINDOW_SECONDS);
      const harmonics = [3, 5, 7, 9].map((k) => magnitudeAt(buf, 1000 * k, RATE, WINDOW_SECONDS));
      return Math.sqrt(harmonics.reduce((s, v) => s + v * v, 0)) / fundamental;
    };
    const clipped = Float32Array.from(source, (v) => Math.max(-ceiling, Math.min(ceiling, v)));
    expect(20 * Math.log10(thd(rendered) / thd(clipped))).toBeLessThan(-20);
  });

  it('the attack ramp reaches back by lookahead_ms', async () => {
    // Lookahead is the other half of §2.4's claim, and since chunk 4
    // deleted `limiter.test.ts` it is the half with no coverage anywhere
    // else: removing the backward pass entirely leaves every other
    // assertion in this file green.
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

  it('links the channels: a peak in one ducks the other by the same gain', async () => {
    // The gain curve is shared across channels on purpose — limiting must
    // not wander the image (effects.md §2). Limiting each channel on its
    // own gain passes every mono assertion in this file; `limiter.test.ts`
    // used to be the other thing that caught it, and chunk 4 deleted it,
    // so this is now the only one.
    const left = new Float32Array(4800).fill(0.1);
    const right = new Float32Array(4800).fill(0.1);
    left[2400] = 1;
    await importSource('pair', left, right);
    writeSound('linked', ['type: limit', 'source: pair', 'ceiling_db: -1']);
    const [outL, outR] = await renderChannels('linked');

    // The right channel never approached the ceiling, so anything that
    // moved it came from the left.
    expect(outR![2400]!).toBeLessThan(right[2400]! * 0.99);
    expect(outR![2400]! / right[2400]!).toBeCloseTo(outL![2400]! / left[2400]!, 5);
  });

  it('the release ramp runs for release_ms after the peak', async () => {
    // The mirror of the attack property: the forward pass caps how fast
    // gain may recover, and the slope is scaled so the deepest reduction
    // spans exactly `release_ms`. Without this, a renderer could hard-code
    // one release and pass everything else.
    const spikeAt = 2400;
    const source = new Float32Array(48000).fill(0.1);
    source[spikeAt] = 1000;
    await importSource('burst', source);

    const releaseMsOf = async (releaseMs: number) => {
      writeSound(`rel${releaseMs}`, [
        'type: limit',
        'source: burst',
        'ceiling_db: -1',
        `release_ms: ${releaseMs}`,
      ]);
      const out = await render(`rel${releaseMs}`);
      let last = spikeAt;
      while (last < out.length - 1 && out[last + 1]! < source[last + 1]! * (1 - 1e-6)) last++;
      return ((last - spikeAt) / RATE) * 1000;
    };

    for (const releaseMs of [20, 100, 400]) {
      const measured = await releaseMsOf(releaseMs);
      expect(measured).toBeGreaterThan(releaseMs * 0.9);
      expect(measured).toBeLessThan(releaseMs * 1.15);
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
