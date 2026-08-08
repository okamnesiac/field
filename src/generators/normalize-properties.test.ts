import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWav, readWavHeader, writeWavFloat32 } from '../audio/wav.js';
import { buildLabels } from '../commands/build.js';
import { createSong } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';

// Properties of `normalize` — sample-rate conversion and bit-depth
// reduction in the daemon's built-in tier (render-pipeline.md decisions 9
// and 10), measured from rendered output through the build rules, the
// same rule the effect properties follow.
//
// This file matters more than most. Every other rule in this migration
// was a transliteration with a reference implementation to diff against,
// so byte-identity carried the correctness argument. `normalize` replaced
// a macOS binary we cannot diff against and never could, so there is no
// oracle: what the resampler must do is *only* what these properties say
// it does.

vi.setConfig({ testTimeout: 30_000 });

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-normalize-props-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSound(name: string, lines: string[]): void {
  mkdirSync(join(root, 'songs/creek/sounds'), { recursive: true });
  writeFileSync(
    join(root, `songs/creek/sounds/${name}.yaml`),
    [`name: ${name}`, ...lines, ''].join('\n'),
  );
}

async function importTone(name: string, rate: number, frequency: number, seconds: number) {
  const n = Math.round(rate * seconds);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * frequency * i) / rate);
  const src = join(root, '..', `field-normalize-src-${name}.wav`);
  writeWavFloat32(src, rate, [samples]);
  await importAsset(root, 'creek', src, name);
  rmSync(src);
}

async function renderPath(label: string): Promise<string> {
  const outcomes = await buildLabels(root, [`//songs/creek/sound:${label}`]);
  return outcomes.find((o) => o.label.endsWith(`:${label}`))!.outputPath!;
}

async function render(label: string) {
  return readWav(await renderPath(label));
}

// Coherent amplitude at one frequency: every probe sits on a DFT bin
// because the window is a whole number of seconds, so this is exact for a
// steady tone and spends no tolerance on measurement error.
function magnitudeAt(samples: Float32Array, frequency: number, rate: number, seconds: number) {
  const n = Math.round(seconds * rate);
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const phase = (2 * Math.PI * frequency * i) / rate;
    const v = samples[i]!;
    re += v * Math.cos(phase);
    im += v * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / n;
}

describe('normalize properties', () => {
  it('converts the rate and keeps the tone that survives it', async () => {
    // The passband claim, end to end: a 1 kHz tone at 44.1k becomes a
    // 1 kHz tone at 48k at the same amplitude, and the file is as long
    // in seconds as it was.
    await importTone('src', 44100, 1000, 2);
    writeSound('up', ['type: normalize', 'source: src', 'sample_rate: 48000', 'bit_depth: 32']);
    const wav = await render('up');

    expect(wav.sampleRate).toBe(48000);
    expect(wav.channels[0]!.length).toBe(96000);
    // Skip the filter's startup, then measure a whole second.
    const settled = wav.channels[0]!.subarray(48000);
    expect(magnitudeAt(settled, 1000, 48000, 1)).toBeCloseTo(0.5, 2);
  });

  it('holds the passband flat all the way to 19 kHz', async () => {
    // 1 kHz alone defends nothing: it sits so far inside any plausible
    // filter that dropping `tapsPerPhase` from 128 to 32 — an ordinary
    // performance edit — left every property here green while 19 kHz fell
    // by about 16 dB (#57 review). The stated quality target has to be
    // asserted where it is actually spent, at the top of the band.
    //
    // Each probe is its own render because two tones in one source would
    // let intermodulation, not the filter, explain a level change.
    for (const frequency of [10000, 15000, 19000]) {
      const label = `p${frequency}`;
      await importTone(`src${frequency}`, 44100, frequency, 2);
      writeSound(label, [
        'type: normalize',
        `source: src${frequency}`,
        'sample_rate: 48000',
        'bit_depth: 32',
      ]);
      const wav = await render(label);
      const settled = wav.channels[0]!.subarray(48000);
      const db = 20 * Math.log10(magnitudeAt(settled, frequency, 48000, 1) / 0.5);
      expect(db, `${frequency} Hz`).toBeGreaterThan(-0.2);
      expect(db, `${frequency} Hz`).toBeLessThan(0.2);
    }
  });

  it('writes integer PCM at the depth the sound declared', async () => {
    // The format tag, not the decoded values. `normalize` promised
    // `LEI<depth>` when it was afconvert and still promises it; a decoded
    // sample sits on the same grid whether the file says PCM or float, so
    // the grid test cannot tell the two writers apart — routing 16-bit
    // through the float writer left all six properties green (#57
    // review). 32 is included because that is the one that regressed.
    await importTone('src', 48000, 1000, 1);
    for (const depth of [16, 24, 32] as const) {
      const label = `fmt${depth}`;
      writeSound(label, [
        'type: normalize',
        'source: src',
        'sample_rate: 48000',
        `bit_depth: ${depth}`,
      ]);
      const header = readWavHeader(await renderPath(label));
      expect(header.format, `${depth}-bit format tag`).toBe(1); // 1 = integer PCM
      expect(header.bitsPerSample, `${depth}-bit width`).toBe(depth);
    }
  });

  it('does not round a short source away to nothing', async () => {
    // Two frames at 96 kHz is 0.92 of a frame at 44.1 kHz. Flooring made
    // that zero, so a short one-shot rendered as an empty file and the
    // action key said it had worked (#57 review). Whole-second fixtures
    // are exactly the ones that cannot see this.
    const samples = Float32Array.from([0.5, -0.5]);
    const src = join(root, '..', 'field-normalize-src-short.wav');
    writeWavFloat32(src, 96000, [samples]);
    await importAsset(root, 'creek', src, 'short');
    rmSync(src);

    writeSound('tiny2', ['type: normalize', 'source: short', 'sample_rate: 44100', 'bit_depth: 32']);
    const wav = await render('tiny2');
    expect(wav.channels[0]!.length).toBeGreaterThan(0);
  });

  it('rejects content above the output Nyquist instead of folding it back', async () => {
    // The property that separates a resampler from an interpolator, and
    // the reason JUCE's was not used: its kernel width ignores the ratio,
    // so downsampling filters at the *input* Nyquist and everything above
    // the output Nyquist aliases into the band.
    //
    // 30 kHz at 96k has no home in a 44.1k file. A correct resampler
    // removes it; one that merely interpolates folds it to |44100 − 30000|
    // = 14.1 kHz, loud and in the middle of the band. So the assertion is
    // about the *alias*, not about the original: if 14.1 kHz shows up,
    // something folded.
    await importTone('hf', 96000, 30000, 2);
    writeSound('down', ['type: normalize', 'source: hf', 'sample_rate: 44100', 'bit_depth: 32']);
    const wav = await render('down');

    expect(wav.sampleRate).toBe(44100);
    const settled = wav.channels[0]!.subarray(44100);
    const alias = magnitudeAt(settled, 14100, 44100, 1);
    // −100 dB relative to the source tone, which is the design target.
    expect(20 * Math.log10(alias / 0.5)).toBeLessThan(-100);
  });

  it('lands every sample on the bit depth it was asked for', async () => {
    // 16-bit means the samples are multiples of 2^-15 — the grid, not
    // merely "quieter" or "rounded somehow". A renderer that wrote float
    // and relabelled the header would pass a length check and fail this.
    await importTone('src', 48000, 1000, 1);
    writeSound('depth16', ['type: normalize', 'source: src', 'sample_rate: 48000', 'bit_depth: 16']);
    const wav = await render('depth16');

    const step = Math.pow(2, -15);
    for (const v of wav.channels[0]!) {
      expect(Math.abs(v / step - Math.round(v / step))).toBeLessThan(1e-4);
    }
  });

  it('dithers: quantizing does not silence what sits below one LSB', async () => {
    // A tone a little under half an LSB truncates to digital black
    // without dither — the distortion-versus-noise trade decision 10
    // makes. With TPDF the signal survives as modulation of the noise, so
    // the output is not identically zero and its energy at the tone's own
    // frequency is above the surrounding floor.
    //
    // This is what a "simplify the dither away" change would break, and
    // nothing else here would notice.
    const rate = 48000;
    const n = rate;
    const amplitude = Math.pow(2, -16) * 0.4; // well under 1 LSB at 16-bit
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * 997 * i) / rate);
    const src = join(root, '..', 'field-normalize-src-tiny.wav');
    writeWavFloat32(src, rate, [samples]);
    await importAsset(root, 'creek', src, 'tiny');
    rmSync(src);

    writeSound('quiet', ['type: normalize', 'source: tiny', 'sample_rate: 48000', 'bit_depth: 16']);
    const wav = await render('quiet');

    const out = wav.channels[0]!;
    expect(out.some((v) => v !== 0)).toBe(true);
    // And the *signal* survived, which is the actual claim. Asserting
    // only that nonzero samples exist proves the dither exists, not that
    // it preserved anything: replacing the input with the dither alone
    // left this green (#57 review). So measure 997 Hz against neighbour
    // bins — under a sub-LSB tone the tone still stands above the noise
    // it is riding on, which is the whole reason dither is used.
    const tone = magnitudeAt(out, 997, rate, 1);
    const neighbours = [811, 1201, 1499].map((f) => magnitudeAt(out, f, rate, 1));
    const floor = neighbours.reduce((a, b) => a + b, 0) / neighbours.length;
    expect(tone).toBeGreaterThan(floor * 3);
    // …and it is dither rather than a stuck bit: the mean is near zero
    // rather than parked on a step.
    let sum = 0;
    for (const v of out) sum += v;
    expect(Math.abs(sum / out.length)).toBeLessThan(Math.pow(2, -15));
  });

  it('word-aligns an odd data chunk', async () => {
    // RIFF chunks are word-aligned. Mono 24-bit with an odd frame count
    // is the only shape `normalize` can produce with an odd `data`
    // payload, so the stereo golden could never exercise it and did not
    // (#57 review). The pad byte counts toward the RIFF size and not
    // toward the chunk's declared size — and our own reader already
    // advances by `size + (size % 2)`, so the writer was out of step
    // with its own reader.
    const samples = new Float32Array(27);
    for (let i = 0; i < 27; i++) samples[i] = 0.25 * Math.sin(i);
    const src = join(root, '..', 'field-normalize-src-odd.wav');
    writeWavFloat32(src, 48000, [samples]);
    await importAsset(root, 'creek', src, 'odd');
    rmSync(src);

    writeSound('odd24', ['type: normalize', 'source: odd', 'sample_rate: 48000', 'bit_depth: 24']);
    const path = await renderPath('odd24');
    const bytes = readFileSync(path);

    // 27 frames × 1 channel × 3 bytes = 81, odd by construction.
    const dataAt = bytes.indexOf('data', 12, 'ascii');
    expect(bytes.readUInt32LE(dataAt + 4)).toBe(81);
    expect(bytes.length % 2).toBe(0);
    // RIFF size counts everything after the first eight bytes, pad included.
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    // And it still reads back as 27 frames rather than 27-and-a-bit.
    expect(readWavHeader(path).frames).toBe(27);
  });

  it('is deterministic, dither and all', async () => {
    // Same key, same bytes — the guarantee decision 10 says the PRNG must
    // not break. Two renders of the same recipe into different projects
    // must agree sample for sample.
    await importTone('src', 44100, 440, 1);
    writeSound('a', ['type: normalize', 'source: src', 'sample_rate: 48000', 'bit_depth: 16']);
    writeSound('b', ['type: normalize', 'source: src', 'sample_rate: 48000', 'bit_depth: 16']);
    const [a, b] = [await render('a'), await render('b')];
    expect([...a.channels[0]!]).toEqual([...b.channels[0]!]);
  });

  it('leaves a same-rate conversion alone except for the depth', async () => {
    // A 1:1 ratio must not run the filter.
    //
    // This asserted bit-exact identity until 32-bit became integer PCM
    // (#57 review), and the change is honest rather than a weakening:
    // int32 cannot represent every float32, so a quantization step now
    // stands between input and output even with no resampling. One LSB
    // at 32-bit is 2^-31, and a filter that actually ran would miss by
    // orders of magnitude more than that — the bound still catches the
    // thing the property exists to catch.
    await importTone('src', 48000, 1000, 1);
    writeSound('same', ['type: normalize', 'source: src', 'sample_rate: 48000', 'bit_depth: 32']);
    const wav = await render('same');

    const n = 48000;
    const expected = new Float32Array(n);
    for (let i = 0; i < n; i++) expected[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      worst = Math.max(worst, Math.abs(wav.channels[0]![i]! - expected[i]!));
    }
    expect(worst).toBeLessThanOrEqual(Math.pow(2, -31));
  });
});
