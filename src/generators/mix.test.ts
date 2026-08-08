import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { buildLabels, explainLabel, queryDeps } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import type { GeneratorRunner } from '../graph/build.js';
import { loadProject } from '../model/project.js';
import { mixSchema, trackSchema, type Track } from '../schema/index.js';
import { balanceGains, mixGenerator, planMix } from './mix.js';

// Fixture times are scalar ticks, so the parse output already satisfies
// the resolved Track type — the same promise the loader's cast makes
// after resolution (musical-time.md §1.6).
const mkTrack = (name: string, over: Record<string, unknown> = {}): Track =>
  trackSchema.parse({
    name,
    type: 'audio',
    clips: [{ id: 'c', source: 'a', position: 0, duration: 960 }],
    ...over,
  }) as Track;

describe('planMix', () => {
  it('defaults to every mixable track, name-sorted, faders aligned', () => {
    const spec = planMix(mixSchema.parse({ name: 'main' }), [
      mkTrack('snare', { pan: 0.5 }),
      mkTrack('kick', { gain_db: -3 }),
    ]);
    expect(spec.tracks).toEqual(['kick', 'snare']);
    expect(spec.faders).toEqual([
      { gain_db: -3, pan: 0 },
      { gain_db: 0, pan: 0.5 },
    ]);
    expect(spec.gain_db).toBe(0);
  });

  it('honors an explicit subset, still name-sorted', () => {
    const spec = planMix(
      mixSchema.parse({ name: 'drums', tracks: ['snare', 'kick'], gain_db: -1 }),
      [mkTrack('kick'), mkTrack('snare'), mkTrack('pad')],
    );
    expect(spec.tracks).toEqual(['kick', 'snare']);
    expect(spec.gain_db).toBe(-1);
  });
});

describe('balanceGains', () => {
  it('is unity at center and cosine-tapers the opposite side', () => {
    expect(balanceGains(0)).toEqual({ left: 1, right: 1 });
    expect(balanceGains(1).left).toBeCloseTo(0, 6);
    expect(balanceGains(1).right).toBe(1);
    expect(balanceGains(-0.5).left).toBe(1);
    expect(balanceGains(-0.5).right).toBeCloseTo(Math.cos(Math.PI / 4), 6);
  });
});

describe('mixGenerator.execute', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-mix-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function mix(
    stems: { left: number[]; right: number[] }[],
    faders: { gain_db: number; pan: number }[],
    gain_db = 0,
    lengthSamples?: number,
    loop?: boolean,
  ) {
    const inputPaths = stems.map((s, i) => {
      const path = join(dir, `stem-${i}.wav`);
      writeWavFloat32(path, 48000, [Float32Array.from(s.left), Float32Array.from(s.right)]);
      return path;
    });
    const out = join(dir, 'mix.wav');
    await mixGenerator.execute(
      {
        name: 'main',
        type: 'mix',
        tracks: stems.map((_, i) => `t${i}`),
        faders,
        gain_db,
        ...(lengthSamples !== undefined ? { length_samples: lengthSamples } : {}),
        ...(loop === true ? { loop: true } : {}),
      },
      inputPaths,
      out,
      { root: dir, sampleRate: 48000 },
    );
    return readWav(out);
  }

  it('sums stems with per-track gain and balance, then master gain', async () => {
    const out = await mix(
      [
        { left: [1, 1], right: [0.5, 0.5] },
        { left: [0.25, 0], right: [0.25, 0] },
      ],
      [
        { gain_db: -6, pan: 0 },
        { gain_db: 0, pan: 1 }, // full right: left side silenced
      ],
      -6,
    );
    const g6 = 10 ** (-6 / 20);
    expect(out.channels[0]![0]).toBeCloseTo(1 * g6 * g6, 5); // stem2 left killed by pan
    expect(out.channels[1]![0]).toBeCloseTo((0.5 * g6 + 0.25) * g6, 5);
  });

  it('a declared length is exact: tails truncate, short content pads', async () => {
    const truncated = await mix(
      [{ left: [1, 1, 1, 1, 1], right: [1, 1, 1, 1, 1] }],
      [{ gain_db: 0, pan: 0 }],
      0,
      3,
    );
    expect([...truncated.channels[0]!]).toEqual([1, 1, 1]);

    const padded = await mix([{ left: [1], right: [1] }], [{ gain_db: 0, pan: 0 }], 0, 4);
    expect([...padded.channels[0]!]).toEqual([1, 0, 0, 0]);
  });

  it('loop folds the overhang onto the start — one pass of the infinite loop', async () => {
    // 3-sample loop, 8 samples of content: the tail wraps twice.
    // out[0] = c[0]+c[3]+c[6], out[1] = c[1]+c[4]+c[7], out[2] = c[2]+c[5].
    const out = await mix(
      [{ left: [1, 2, 3, 0.5, 0.25, 0.125, 0.0625, 0.03125], right: [0, 0, 0, 0, 0, 0, 0, 0] }],
      [{ gain_db: 0, pan: 0 }],
      0,
      3,
      true,
    );
    expect([...out.channels[0]!]).toEqual([1.5625, 2.28125, 3.125]);
    expect(out.channels[0]).toHaveLength(3);
  });

  it('pads shorter stems with silence', async () => {
    const out = await mix(
      [
        { left: [1], right: [1] },
        { left: [0, 0, 0.5], right: [0, 0, 0.5] },
      ],
      [
        { gain_db: 0, pan: 0 },
        { gain_db: 0, pan: 0 },
      ],
    );
    expect(out.channels[0]).toHaveLength(3);
    expect([...out.channels[0]!]).toEqual([1, 0, 0.5]);
  });
});

describe('mix targets in the build graph', () => {
  let root: string;

  const trackYaml = (name: string, asset: string, at: number, extra: string[] = []) =>
    [
      `name: ${name}`,
      'type: audio',
      ...extra,
      'clips:',
      `  - id: ${name}-1`,
      `    source: ${asset}`,
      '    anchor: absolute',
      `    position: ${at}`,
      '    duration: 2',
      '',
    ].join('\n');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'field-mixgraph-'));
    init({ dir: root, name: 'test-album' });
    createSong(root, 'creek');
    // createSong scaffolds an output *track* now, so the mix these
    // cases are about is written here rather than inherited.
    mkdirSync(join(root, 'songs/creek/mixes'), { recursive: true });
    writeFileSync(join(root, 'songs/creek/mixes/main.yaml'), 'name: main\ntype: mix\ngain_db: 0\nmaster: []\n');
    rmSync(join(root, 'songs/creek/tracks/main.yaml'), { force: true });
    createTrack(root, 'creek', 'kick', 'audio');
    createTrack(root, 'creek', 'snare', 'audio');
    for (const [name, samples] of [
      ['kick-src', [1, 0.5]],
      ['snare-src', [0.25, 0.25]],
    ] as const) {
      const src = join(root, '..', `field-mix-src-${Math.random()}.wav`);
      writeWavFloat32(src, 48000, [Float32Array.from(samples)]);
      await importAsset(root, 'creek', src, name);
      rmSync(src);
    }
    writeFileSync(join(root, 'songs/creek/tracks/kick.yaml'), trackYaml('kick', 'kick-src', 0));
    writeFileSync(join(root, 'songs/creek/tracks/snare.yaml'), trackYaml('snare', 'snare-src', 1));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds the default mix end-to-end through rule→rule edges', async () => {
    expect(queryDeps(root, 'deps(//songs/creek/mix:main)')).toEqual([
      '//songs/creek/asset:kick-src',
      '//songs/creek/track:kick',
      '//songs/creek/asset:snare-src',
      '//songs/creek/track:snare',
      '//songs/creek/mix:main',
    ]);

    const before = await explainLabel(root, '//songs/creek/mix:main');
    expect(before.inputs.map((i) => i.sha256)).toEqual(['', '']); // stems not built yet
    expect(before.actionKey).toBeUndefined();

    const outcomes = await buildLabels(root, ['//songs/creek/mix:main']);
    const mixOutcome = outcomes.find((o) => o.label === '//songs/creek/mix:main')!;
    expect(mixOutcome.cached).toBe(false);

    // kick [1, 0.5] at 0, snare [0.25, 0.25] at 1, no faders:
    const out = readWav(mixOutcome.outputPath!);
    expect(out.channels[0]![0]).toBeCloseTo(1, 6);
    expect(out.channels[0]![1]).toBeCloseTo(0.5 + 0.25, 6);
    expect(out.channels[0]![2]).toBeCloseTo(0.25, 6);

    const after = await explainLabel(root, '//songs/creek/mix:main');
    expect(after.inputs.every((i) => /^[0-9a-f]{64}$/.test(i.sha256))).toBe(true);
    expect(after.cached).toBe(true);

    const again = await buildLabels(root, ['//songs/creek/mix:main']);
    expect(again.every((o) => o.cached)).toBe(true);
  });

  it('re-runs only the sum on a fader move; stems stay cached', async () => {
    const runs: string[] = [];
    const runner: GeneratorRunner = async (node, _inputPaths, outputPath) => {
      runs.push(`${node.label.pkg}:${node.label.name}`);
      writeFileSync(outputPath, `out:${node.label.name}`);
    };

    await buildLabels(root, ['//songs/creek/mix:main'], runner);
    expect(runs).toEqual(['songs/creek/track:kick', 'songs/creek/track:snare', 'songs/creek/mix:main']);

    runs.length = 0;
    writeFileSync(
      join(root, 'songs/creek/tracks/kick.yaml'),
      trackYaml('kick', 'kick-src', 0, ['gain_db: -6', 'pan: -0.25']),
    );
    await buildLabels(root, ['//songs/creek/mix:main'], runner);
    expect(runs).toEqual(['songs/creek/mix:main']);
  });

  it('stops at unchanged stems: a rebuilt-but-identical stem is early cutoff', async () => {
    const runs: string[] = [];
    const runner: GeneratorRunner = async (node, _inputPaths, outputPath) => {
      runs.push(`${node.label.pkg}:${node.label.name}`);
      writeFileSync(outputPath, `out:${node.label.name}`); // content ignores clip placement
    };

    await buildLabels(root, ['//songs/creek/mix:main'], runner);
    runs.length = 0;

    // Moving a clip re-renders that stem, but this fake renderer produces
    // identical bytes — so the mix's input hashes are unchanged and the sum
    // is a cache hit. Content-addressing gives early cutoff for free.
    writeFileSync(join(root, 'songs/creek/tracks/kick.yaml'), trackYaml('kick', 'kick-src', 7));
    await buildLabels(root, ['//songs/creek/mix:main'], runner);
    expect(runs).toEqual(['songs/creek/track:kick']);
  });

  it('diagnoses bad mix declarations; an empty mix has no node', async () => {
    writeFileSync(
      join(root, 'songs/creek/mixes/alt.yaml'),
      ['name: alt', 'tracks:', '  - kick', '  - ghost', ''].join('\n'),
    );
    const project = loadProject(root);
    expect(project.diagnostics.map((d) => d.message).join('\n')).toContain(
      'mix "alt" references unknown track "ghost"',
    );
    rmSync(join(root, 'songs/creek/mixes/alt.yaml'));

    // A fresh song's default mix has nothing to mix yet: legal, no node.
    createSong(root, 'sprout');
    // createSong scaffolds an output *track* now, so the mix these
    // cases are about is written here rather than inherited.
    mkdirSync(join(root, 'songs/sprout/mixes'), { recursive: true });
    writeFileSync(join(root, 'songs/sprout/mixes/main.yaml'), 'name: main\ntype: mix\ngain_db: 0\nmaster: []\n');
    rmSync(join(root, 'songs/sprout/tracks/main.yaml'), { force: true });
    expect(loadProject(root).diagnostics.filter((d) => d.file.includes('sprout'))).toEqual([]);
    expect(() => queryDeps(root, '//songs/sprout/mix:main')).toThrow('matched no labels');
  });
});
