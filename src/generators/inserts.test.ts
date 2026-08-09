import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { buildLabels } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import type { GeneratorRunner } from '../graph/build.js';

// Inserts in their two remaining homes (effects.md §5): track chains that
// bake into the stem, and the mix master chain applied after the master
// gain. All real DSP.

let root: string;

const trackYaml = (extra: string[]) =>
  [
    'name: drums',
    ...extra,
    'inputs:',
    '  - id: c1',
    '    audio: tone',
    '    anchor: absolute',
    '    at: 0',
    '    duration: 48000',
    '',
  ].join('\n');

const eqInsert = (gain: number) => [
  'inserts:',
  '  - effect: eq',
  '    bands:',
  '      - type: bell',
  '        frequency: 1000',
  `        gain_db: ${gain}`,
  '    normalize: false',
];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'field-inserts-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  createTrack(root, 'creek', 'drums');
  const src = join(root, '..', `field-inserts-src-${Math.random()}.wav`);
  const tone = new Float32Array(48000);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
  writeWavFloat32(src, 48000, [tone]);
  await importAsset(root, 'creek', src, 'tone');
  rmSync(src);
  writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), trackYaml([]));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function rmsOf(path: string): number {
  const [channel] = readWav(path).channels;
  let sum = 0;
  for (const v of channel!) sum += v * v;
  return Math.sqrt(sum / channel!.length);
}

describe('track inserts', () => {
  it('bake into the stem and re-render it on edit; faders still do not', async () => {
    const runs: string[] = [];
    const runner: GeneratorRunner = async (node, _inputPaths, outputPath) => {
      runs.push(node.label.name);
      writeFileSync(outputPath, 'out');
    };
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(runs).toEqual(['drums']);

    // Adding an insert is a content edit: the stem re-renders.
    writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), trackYaml(eqInsert(-6)));
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(runs).toEqual(['drums', 'drums']);

    // A level move is not a content edit. It lives on the placement that
    // consumes this track (nested-tracks.md §1.13), so it re-sums the
    // parent and leaves this stem alone — which is the pre-fader property
    // surviving the retirement of the thing that used to carry it.
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      [
        'name: main',
        'inputs:',
        '  - track: drums',
        '    at: 0',
        '    gain_db: -6',
        '',
      ].join('\n'),
    );
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(runs).toEqual(['drums', 'drums']);
  });

  it('apply real DSP after clip summing', async () => {
    writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), trackYaml(eqInsert(-6)));
    const outcomes = await buildLabels(root, ['//songs/creek/track:drums']);
    const stem = outcomes.find((o) => o.label.endsWith(':drums'))!;
    // −6 dB bell right on the tone ≈ half amplitude; the dry tone RMS is
    // 0.1/√2 ≈ 0.0707.
    expect(20 * Math.log10(rmsOf(stem.outputPath!) / 0.0707)).toBeCloseTo(-6, 0);
  });

  it('a reverb insert grows the stem by its tail', async () => {
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      trackYaml(['inserts:', '  - effect: reverb', '    decay: 0.5']),
    );
    const outcomes = await buildLabels(root, ['//songs/creek/track:drums']);
    const stem = outcomes.find((o) => o.label.endsWith(':drums'))!;
    expect(readWav(stem.outputPath!).channels[0]!.length).toBe(48000 + 24000);
  });
});

describe("the output track's chain (what the master chain became)", () => {
  it('is applied after the level driving into it, so the limiter guards the output', async () => {
    // The mix's `gain_db` drove the sum into the master chain; a placement's
    // gain drives its child into the parent's inserts, which is the same
    // stage (nested-tracks.md §1.13) and the reason no separate field
    // survived the retirement.
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      [
        'name: main',
        'inserts:',
        '  - effect: limit',
        '    ceiling_db: -3',
        'inputs:',
        '  - track: drums',
        '    at: 0',
        '    gain_db: 24 # drive the sum well past full scale',
        '',
      ].join('\n'),
    );
    const outcomes = await buildLabels(root, ['//songs/creek/track:main']);
    const out = outcomes.find((o) => o.label.endsWith('track:main'))!;
    const ceiling = Math.pow(10, -3 / 20);
    for (const channel of readWav(out.outputPath!).channels) {
      for (const v of channel) expect(Math.abs(v)).toBeLessThanOrEqual(ceiling + 1e-6);
    }
  });

  it('re-runs only the output track on a chain edit; children stay cached', async () => {
    const runs: string[] = [];
    const runner: GeneratorRunner = async (node, _inputPaths, outputPath) => {
      runs.push(node.label.name);
      writeFileSync(outputPath, 'out');
    };
    const path = join(root, 'songs/creek/tracks/main.yaml');
    writeFileSync(
      path,
      ['name: main', 'inputs:', '  - track: drums', '    at: 0', ''].join('\n'),
    );
    await buildLabels(root, ['//songs/creek/track:main'], runner);
    expect(runs).toEqual(['drums', 'main']);

    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        'name: main\n',
        'name: main\ninserts:\n  - effect: limit\n    ceiling_db: -1\n',
      ),
    );
    await buildLabels(root, ['//songs/creek/track:main'], runner);
    expect(runs).toEqual(['drums', 'main', 'main']);
  });
});
