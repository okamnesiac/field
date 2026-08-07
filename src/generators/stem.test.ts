import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { buildLabels, queryDeps } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import type { GeneratorRunner } from '../graph/build.js';
import { loadProject } from '../model/project.js';
import { trackSchema, type Track } from '../schema/index.js';
import { TempoMap } from '../time/tempo.js';
import { placedWindow, planTrack, stemGenerator, type PlacedClip } from './stem.js';

// 120 bpm at 48 kHz: one beat = 960 ticks = 0.5 s = 24000 samples.
const map120 = new TempoMap([{ at: 0, bpm: 120 }], 48000);

function track(clips: unknown[]): Track {
  // Fixture times are scalar ticks, so the parse output already satisfies
  // the resolved Track type — the same promise the loader's cast makes
  // after resolution (musical-time.md §1.6).
  return trackSchema.parse({ name: 'drums', type: 'audio', clips }) as Track;
}

const clip = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  source: 'kick',
  position: 960,
  duration: 960,
  ...over,
});

describe('placedWindow', () => {
  it('projects musical clips through the tempo map', () => {
    const [c] = track([clip()]).clips;
    expect(placedWindow(c!, map120)).toEqual({ start: 24000, duration: 24000 });
  });

  it('projects both edges, so a clip spanning a ramp gets its true length', () => {
    const ramp = new TempoMap(
      [
        { at: 0, bpm: 120, ramp: 'linear' },
        { at: 1920, bpm: 60 },
      ],
      48000,
    );
    const [c] = track([clip({ position: 0, duration: 1920 })]).clips;
    const w = placedWindow(c!, ramp);
    expect(w.start).toBe(0);
    // Two beats ramping 120→60 take longer than 1 s but less than 2 s; the
    // exact value comes from the closed-form ramp integral.
    expect(w.duration).toBe(ramp.ticksToSamples(1920));
    expect(w.duration).toBeGreaterThan(48000);
    expect(w.duration).toBeLessThan(96000);
  });

  it('passes absolute clips through untouched', () => {
    const [c] = track([clip({ anchor: 'absolute', position: 100, duration: 50 })]).clips;
    expect(placedWindow(c!, map120)).toEqual({ start: 100, duration: 50 });
  });
});

const hashes = new Map([
  ['kick', '1111111111111111111111111111111111111111111111111111111111111111'],
  ['snare', '2222222222222222222222222222222222222222222222222222222222222222'],
]);

describe('loop expansion (clip-looping.md)', () => {
  // One beat of kick (24000 samples at 120), looped over a four-beat window.
  const frames = new Map([['kick', 24000]]);

  it('tiles at source length when every is omitted, seams click-guarded', () => {
    const spec = planTrack(
      track([clip({ position: 0, duration: 3840, loop: { enabled: true }, fade_in: 100, fade_out: 200 })]),
      map120,
      hashes,
      frames,
    );
    expect(spec.clips.map((c) => [c.start, c.duration, c.fade_in, c.fade_out])).toEqual([
      [0, 24000, 100, 480],
      [24000, 24000, 480, 480],
      [48000, 24000, 480, 480],
      [72000, 24000, 480, 200], // window fade_out on the last repetition
    ]);
  });

  it('every ticks keeps repeats on the grid, with a partial last slot', () => {
    const spec = planTrack(
      track([clip({ position: 0, duration: 2400, loop: { every: 960 } })]),
      map120,
      hashes,
      frames,
    );
    // Repeats at beats 0, 1, 2; the window ends mid-slot at 2.5 beats.
    expect(spec.clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 24000],
      [24000, 24000],
      [48000, 12000],
    ]);
  });

  it('overlay repetitions ring to the window edge and sum', () => {
    const spec = planTrack(
      track([clip({ position: 0, duration: 2880, loop: { every: 960, mode: 'overlay' }, fade_out: 300 })]),
      map120,
      hashes,
      frames,
    );
    // Each voice runs to the window end; reads past the source end are
    // silence, so voices end where their content does.
    expect(spec.clips.map((c) => [c.start, c.duration, c.fade_out])).toEqual([
      [0, 72000, 300],
      [24000, 48000, 300],
      [48000, 24000, 300],
    ]);
  });

  it('enabled: false is not a loop, and the plan matches a plain clip exactly', () => {
    const plain = planTrack(track([clip()]), map120, hashes);
    const disabled = planTrack(
      track([clip({ loop: { enabled: false, every: 960 } })]),
      map120,
      hashes,
      frames,
    );
    expect(disabled.clips).toEqual(plain.clips);
  });

  it('a loop reproducing hand-tiled clips produces the identical plan', () => {
    // The field keys shape: butt-jointed repeats with 480-sample seams.
    const looped = planTrack(
      track([clip({ position: 0, duration: 2880, loop: { every: 960 }, fade_out: 200 })]),
      map120,
      hashes,
      frames,
    );
    const hand = planTrack(
      track([
        clip({ id: 'k1', position: 0, duration: 960, fade_out: 480 }),
        clip({ id: 'k2', position: 960, duration: 960, fade_in: 480, fade_out: 480 }),
        clip({ id: 'k3', position: 1920, duration: 960, fade_in: 480, fade_out: 200 }),
      ]),
      map120,
      hashes,
    );
    expect(looped.clips).toEqual(hand.clips);
  });

  it('refuses to tile a source exhausted by its read offset', () => {
    expect(() =>
      planTrack(
        track([clip({ position: 0, duration: 3840, loop: { enabled: true }, source_offset: 24000 })]),
        map120,
        hashes,
        frames,
      ),
    ).toThrow('source content after its read offset');
  });
});

describe('planTrack', () => {
  it('resolves clips to samples and indexes distinct assets in hash order', () => {
    const spec = planTrack(
      track([
        clip({ id: 'c1', source: 'snare', position: 960, duration: 960 }),
        clip({ id: 'c2', source: 'kick', position: 0, duration: 960, slip: 100 }),
      ]),
      map120,
      hashes,
    );
    expect(spec.sources).toEqual(['kick', 'snare']);
    expect(spec.clips).toEqual([
      {
        input: 0,
        start: 0,
        duration: 24000,
        read_offset: -100,
        gain_db: 0,
        fade_in: 0,
        fade_out: 0,
      },
      {
        input: 1,
        start: 24000,
        duration: 24000,
        read_offset: 0,
        gain_db: 0,
        fade_in: 0,
        fade_out: 0,
      },
    ]);
  });

  it('is invariant under YAML clip order (summing is commutative)', () => {
    const a = clip({ id: 'c1', source: 'kick', position: 960 });
    const b = clip({ id: 'c2', source: 'snare', position: 0 });
    expect(planTrack(track([a, b]), map120, hashes)).toEqual(
      planTrack(track([b, a]), map120, hashes),
    );
  });

  it('wires assets by content hash, not name, so renames cannot permute inputs', () => {
    const byHash = new Map([
      ['apple', 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
      ['kick', '0000000000000000000000000000000000000000000000000000000000000000'],
    ]);
    const spec = planTrack(
      track([clip({ id: 'c1', source: 'apple' }), clip({ id: 'c2', source: 'kick' })]),
      map120,
      byHash,
    );
    // Name order would be [apple, kick]; hash order wins.
    expect(spec.sources).toEqual(['kick', 'apple']);
  });
});

describe('stemGenerator.execute', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-stem-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function monoAsset(samples: number[], sampleRate = 48000): string {
    const path = join(dir, `src-${Math.random()}.wav`);
    writeWavFloat32(path, sampleRate, [Float32Array.from(samples)]);
    return path;
  }

  async function render(clips: Partial<PlacedClip>[], inputPaths: string[]) {
    const out = join(dir, 'stem.wav');
    await stemGenerator.execute(
      {
        name: 'drums',
        type: 'stem',
        sources: inputPaths.map((_, i) => `a${i}`),
        clips: clips.map((c) => ({
          input: 0,
          start: 0,
          duration: 4,
          read_offset: 0,
          gain_db: 0,
          fade_in: 0,
          fade_out: 0,
          ...c,
        })),
      },
      inputPaths,
      out,
      { root: dir, sampleRate: 48000 },
    );
    return readWav(out);
  }

  it('places a window at its start sample, mono onto both stem channels', async () => {
    const src = monoAsset([1, 0.5, 0, 0]);
    const stem = await render([{ start: 5, duration: 3 }], [src]);
    expect(stem.channels).toHaveLength(2);
    expect(stem.channels[0]).toHaveLength(8);
    expect([...stem.channels[0]!]).toEqual([0, 0, 0, 0, 0, 1, 0.5, 0]);
    expect([...stem.channels[1]!]).toEqual([0, 0, 0, 0, 0, 1, 0.5, 0]);
  });

  it('plays silence outside the asset: negative read offset and past the end', async () => {
    const src = monoAsset([1, 1]);
    // Slipped later than the source has content: 2 samples of silence, then
    // the asset's 2 samples, then silence again.
    const stem = await render([{ duration: 6, read_offset: -2 }], [src]);
    expect([...stem.channels[0]!]).toEqual([0, 0, 1, 1, 0, 0]);
  });

  it('applies clip gain and linear fades inside the window', async () => {
    const src = monoAsset([1, 1, 1, 1, 1, 1, 1, 1]);
    const faded = await render([{ duration: 8, fade_in: 4, fade_out: 4 }], [src]);
    expect([...faded.channels[0]!]).toEqual([0, 0.25, 0.5, 0.75, 0.75, 0.5, 0.25, 0]);

    const quiet = await render([{ duration: 1 }, { duration: 1, gain_db: -6 }], [src]);
    // Two overlapping copies: unity plus −6 dB.
    expect(quiet.channels[0]![0]).toBeCloseTo(1 + 10 ** (-6 / 20), 5);
  });

  it('sums overlapping clips (a crossfade is two faded clips)', async () => {
    const src = monoAsset([1, 1, 1, 1]);
    const stem = await render(
      [
        { duration: 4, fade_out: 4 },
        { start: 2, duration: 4, fade_in: 4 },
      ],
      [src],
    );
    // First clip fades 3/4, 2/4, 1/4, 0; second enters at 2 with 0, 1/4, …
    expect(stem.channels[0]![2]).toBeCloseTo(0.25 + 0, 5);
    expect(stem.channels[0]![3]).toBeCloseTo(0 + 0.25, 5);
  });

  it('keeps stereo assets stereo', async () => {
    const path = join(dir, 'stereo.wav');
    writeWavFloat32(path, 48000, [Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    const stem = await render([{ duration: 2 }], [path]);
    expect([...stem.channels[0]!]).toEqual([1, 0]);
    expect([...stem.channels[1]!]).toEqual([0, 1]);
  });

  it('refuses to resample implicitly', async () => {
    const src = monoAsset([1], 44100);
    await expect(render([{}], [src])).rejects.toThrow(
      'is 44100 Hz but the project is 48000 Hz',
    );
  });

  it('refuses more than two channels', async () => {
    const path = join(dir, '3ch.wav');
    writeWavFloat32(path, 48000, [new Float32Array(2), new Float32Array(2), new Float32Array(2)]);
    await expect(render([{}], [path])).rejects.toThrow('mono or stereo only');
  });
});

describe('track stems in the build graph', () => {
  let root: string;

  const trackYaml = (lines: string[]) => ['name: drums', 'type: audio', 'clips:', ...lines, ''].join('\n');

  const clipYaml = (over: Record<string, string | number> = {}) => {
    const fields: Record<string, string | number> = {
      id: 'kick-1',
      source: 'kick',
      position: 960,
      duration: 960,
      ...over,
    };
    return Object.entries(fields).map(([k, v], i) => `  ${i === 0 ? '- ' : '  '}${k}: ${v}`);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'field-trackgraph-'));
    init({ dir: root, name: 'test-album' });
    createSong(root, 'creek');
    createTrack(root, 'creek', 'drums', 'audio');
    const src = join(root, '..', `field-track-src-${Math.random()}.wav`);
    writeWavFloat32(src, 48000, [Float32Array.from([1, 0.5, 0.25, 0])]);
    await importAsset(root, 'creek', src, 'kick');
    rmSync(src);
    writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), trackYaml(clipYaml()));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('renders a stem end-to-end and caches it', async () => {
    expect(queryDeps(root, '//songs/creek/track:drums')).toEqual(['//songs/creek/track:drums']);
    expect(queryDeps(root, 'deps(//songs/creek/track:drums)')).toEqual([
      '//songs/creek/asset:kick',
      '//songs/creek/track:drums',
    ]);

    const first = await buildLabels(root, ['//songs/creek/track:drums']);
    const stemOutcome = first.find((o) => o.label === '//songs/creek/track:drums')!;
    expect(stemOutcome.cached).toBe(false);
    expect(existsSync(stemOutcome.outputPath!)).toBe(true);

    const stem = readWav(stemOutcome.outputPath!);
    expect(stem.channels).toHaveLength(2);
    // 960 ticks at 120 bpm = 24000 samples in; window is 24000 samples but
    // the 4-sample asset then plays silence.
    expect(stem.channels[0]).toHaveLength(48000);
    expect(stem.channels[0]![24000]).toBe(1);
    expect(stem.channels[0]![24001]).toBe(0.5);
    expect(stem.channels[0]![23999]).toBe(0);

    const second = await buildLabels(root, ['//songs/creek/track:drums']);
    expect(second.find((o) => o.label === '//songs/creek/track:drums')!.cached).toBe(true);
  });

  it('rebuilds musical clips on tempo edits; absolute clips ride through', async () => {
    const counting = () => {
      const state = { runs: 0 };
      const runner: GeneratorRunner = async (_node, _inputPaths, outputPath) => {
        state.runs++;
        writeFileSync(outputPath, 'stem');
      };
      return { state, runner };
    };

    const { state, runner } = counting();
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(1);

    // Same placement → cache hit.
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(1);

    // A tempo edit moves the musical clip → rebuild.
    const tempoPath = join(root, 'songs/creek/tempo.yaml');
    writeFileSync(tempoPath, readFileSync(tempoPath, 'utf8').replace('bpm: 120', 'bpm: 90'));
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(2);

    // An absolute-anchored clip is untouched by tempo.
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      trackYaml(clipYaml({ anchor: 'absolute', position: 100, duration: 200 })),
    );
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(3);
    writeFileSync(tempoPath, readFileSync(tempoPath, 'utf8').replace('bpm: 90', 'bpm: 240'));
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(3); // cache hit despite the tempo change
  });

  it('ignores fader moves and YAML clip order in the stem action key', async () => {
    const counting = () => {
      const state = { runs: 0 };
      const runner: GeneratorRunner = async (_node, _inputPaths, outputPath) => {
        state.runs++;
        writeFileSync(outputPath, 'stem');
      };
      return { state, runner };
    };

    const { state, runner } = counting();
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(1);

    // Track gain/pan are mix parameters, not stem contents.
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      ['name: drums', 'type: audio', 'gain_db: -6', 'pan: 0.5', 'clips:', ...clipYaml(), ''].join(
        '\n',
      ),
    );
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(1);

    // Reordering clips in the file is not an edit to the sound.
    const c1 = clipYaml();
    const c2 = clipYaml({ id: 'kick-2', position: 1920 });
    writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), trackYaml([...c1, ...c2]));
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(2); // new clip: renders once…
    writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), trackYaml([...c2, ...c1]));
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(2); // …and the reordered file is a cache hit
  });

  it('survives an order-permuting asset rename as a cache hit (#9 review)', async () => {
    // A second asset so a rename can permute name order: apple < kick < snare.
    const src = join(root, '..', `field-track-src2-${Math.random()}.wav`);
    writeWavFloat32(src, 48000, [Float32Array.from([0.5, 0.5])]);
    await importAsset(root, 'creek', src, 'snare');
    rmSync(src);
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      trackYaml([...clipYaml(), ...clipYaml({ id: 'snare-1', source: 'snare', position: 1920 })]),
    );

    const state = { runs: 0 };
    const runner: GeneratorRunner = async (_node, _inputPaths, outputPath) => {
      state.runs++;
      writeFileSync(outputPath, 'stem');
    };
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(1);

    // snare → apple sorts before kick by name, but content hashes are the
    // wiring order, so nothing in the action key moves.
    const assetsPath = join(root, 'songs/creek/assets.yaml');
    writeFileSync(assetsPath, readFileSync(assetsPath, 'utf8').replace('name: snare', 'name: apple'));
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      trackYaml([...clipYaml(), ...clipYaml({ id: 'snare-1', source: 'apple', position: 1920 })]),
    );
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(state.runs).toBe(1);
  });

  it('diagnoses fades that exceed the clip window', () => {
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      trackYaml(clipYaml({ fade_in: 20000, fade_out: 8000 })),
    );
    const project = loadProject(root);
    expect(project.diagnostics.map((d) => d.message).join('\n')).toContain(
      'fades (20000 + 8000 samples) exceed its 24000-sample window',
    );
  });

  it('leaves midi and empty tracks out of the graph', async () => {
    createTrack(root, 'creek', 'sketch', 'midi');
    createTrack(root, 'creek', 'spare', 'audio');
    expect(queryDeps(root, '//songs/creek/track:all')).toEqual(['//songs/creek/track:drums']);
  });
});

describe('clips over rule outputs', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'field-clipsrc-'));
    init({ dir: root, name: 'test-album' });
    createSong(root, 'creek');
    createTrack(root, 'creek', 'drums', 'audio');
    const src = join(root, '..', `field-clipsrc-${Math.random()}.wav`);
    writeWavFloat32(src, 48000, [Float32Array.from([1, 0.5, 0.25, 0])]);
    await importAsset(root, 'creek', src, 'kick');
    rmSync(src);
    mkdirSync(join(root, 'songs/creek/sounds'), { recursive: true });
    writeFileSync(
      join(root, 'songs/creek/sounds/kick-24.yaml'),
      [
        'name: kick-24',
        'type: normalize',
        'source: kick',
        'sample_rate: 48000',
        'bit_depth: 24',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      [
        'name: drums',
        'type: audio',
        'clips:',
        '  - id: kick-1',
        '    source: kick-24',
        '    anchor: absolute',
        '    position: 3',
        '    duration: 4',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects clips without a source', () => {
    const base = { id: 'c', position: 0, duration: 1 };
    expect(() => trackSchema.parse({ name: 't', type: 'audio', clips: [base] })).toThrow();
  });

  it('plans buildable-sound sources after hash-sorted committed ones, name-sorted', () => {
    const spec = planTrack(
      track([
        clip({ id: 'c1', source: 'kick' }),
        clip({ id: 'c2', source: 'pad-sc', position: 0 }),
        clip({ id: 'c3', source: 'kit-sc', position: 0 }),
      ]),
      map120,
      hashes, // kick has a hash; pad-sc/kit-sc are buildable
    );
    expect(spec.sources).toEqual(['kick', 'kit-sc', 'pad-sc']);
    const byInput = [...spec.clips].sort((a, b) => a.input - b.input).map((c) => c.input);
    expect(byInput).toEqual([0, 1, 2]); // kick, kit-sc, pad-sc
  });

  it('diagnoses a clip on an unknown source', () => {
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      ['name: drums', 'type: audio', 'clips:', '  - id: c1', '    source: ghost', '    position: 0', '    duration: 4', ''].join('\n'),
    );
    expect(loadProject(root).diagnostics.map((d) => d.message).join('\n')).toContain(
      'clip "c1" references unknown source "ghost"',
    );
  });

  it('builds the whole recipe chain: asset → target → stem, with real rules', async () => {
    expect(queryDeps(root, 'deps(//songs/creek/track:drums)')).toEqual([
      '//songs/creek/asset:kick',
      '//songs/creek/sound:kick-24',
      '//songs/creek/track:drums',
    ]);

    // Real normalize (afconvert) feeding the real TS mixer: the stem plays
    // a render nothing ever committed.
    const outcomes = await buildLabels(root, ['//songs/creek/track:drums']);
    const stem = outcomes.find((o) => o.label === '//songs/creek/track:drums')!;
    const wav = readWav(stem.outputPath!);
    expect(wav.channels[0]).toHaveLength(7);
    expect(wav.channels[0]![3]).toBeCloseTo(1, 4);
    expect(wav.channels[0]![4]).toBeCloseTo(0.5, 4);

    const again = await buildLabels(root, ['//songs/creek/track:drums']);
    expect(again.every((o) => o.cached)).toBe(true);
  });

  it('cascades a recipe edit through the stem', async () => {
    // Content tracks the spec and the inputs, so an upstream parameter
    // change flows through every downstream hash.
    const runs: string[] = [];
    const runner: GeneratorRunner = async (node, inputPaths, outputPath) => {
      runs.push(node.label.name);
      const inputs = inputPaths.map((p) => readFileSync(p).toString('base64').slice(0, 64));
      writeFileSync(outputPath, JSON.stringify({ spec: node.spec, inputs }));
    };

    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(runs).toEqual(['kick-24', 'drums']);

    runs.length = 0;
    const soundPath = join(root, 'songs/creek/sounds/kick-24.yaml');
    writeFileSync(soundPath, readFileSync(soundPath, 'utf8').replace('bit_depth: 24', 'bit_depth: 32'));
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(runs).toEqual(['kick-24', 'drums']); // the edit rebuilt the render AND the stem
  });
});
