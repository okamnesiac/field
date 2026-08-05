import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { buildTargets, queryDeps } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import type { RuleRunner } from '../graph/build.js';
import { loadProject } from '../model/project.js';
import { trackSchema, type Track } from '../schema/schemas.js';
import { TempoMap } from '../time/tempo.js';
import { placedWindow, planTrack, trackRenderRule, type PlacedClip } from './track-render.js';

// 120 bpm at 48 kHz: one beat = 960 ticks = 0.5 s = 24000 samples.
const map120 = new TempoMap([{ at: 0, bpm: 120 }], 48000);

function track(clips: unknown[]): Track {
  return trackSchema.parse({ name: 'drums', type: 'audio', clips });
}

const clip = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  asset: 'kick',
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

describe('planTrack', () => {
  it('resolves clips to samples and indexes sorted distinct assets', () => {
    const spec = planTrack(
      track([
        clip({ id: 'c1', asset: 'snare', position: 960, duration: 960 }),
        clip({ id: 'c2', asset: 'kick', position: 0, duration: 960, slip: 100 }),
      ]),
      map120,
    );
    expect(spec.assets).toEqual(['kick', 'snare']);
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
    const a = clip({ id: 'c1', asset: 'kick', position: 960 });
    const b = clip({ id: 'c2', asset: 'snare', position: 0 });
    expect(planTrack(track([a, b]), map120)).toEqual(planTrack(track([b, a]), map120));
  });
});

describe('trackRenderRule.execute', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bloom-stem-'));
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
    await trackRenderRule.execute(
      {
        name: 'drums',
        rule: 'track-render',
        assets: inputPaths.map((_, i) => `a${i}`),
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
      asset: 'kick',
      position: 960,
      duration: 960,
      ...over,
    };
    return Object.entries(fields).map(([k, v], i) => `  ${i === 0 ? '- ' : '  '}${k}: ${v}`);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'bloom-trackgraph-'));
    init({ dir: root, name: 'test-album' });
    createSong(root, 'creek');
    createTrack(root, 'creek', 'drums', 'audio');
    const src = join(root, '..', `bloom-track-src-${Math.random()}.wav`);
    writeWavFloat32(src, 48000, [Float32Array.from([1, 0.5, 0.25, 0])]);
    await importAsset(root, 'creek', src, 'kick');
    rmSync(src);
    writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), trackYaml(clipYaml()));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('renders a stem end-to-end and caches it', async () => {
    expect(queryDeps(root, '//songs/creek/tracks:drums')).toEqual(['//songs/creek/tracks:drums']);
    expect(queryDeps(root, 'deps(//songs/creek/tracks:drums)')).toEqual([
      '//songs/creek/assets:kick',
      '//songs/creek/tracks:drums',
    ]);

    const first = await buildTargets(root, ['//songs/creek/tracks:drums']);
    const stemOutcome = first.find((o) => o.label === '//songs/creek/tracks:drums')!;
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

    const second = await buildTargets(root, ['//songs/creek/tracks:drums']);
    expect(second.find((o) => o.label === '//songs/creek/tracks:drums')!.cached).toBe(true);
  });

  it('rebuilds musical clips on tempo edits; absolute clips ride through', async () => {
    const counting = () => {
      const state = { runs: 0 };
      const runner: RuleRunner = async (_node, _inputPaths, outputPath) => {
        state.runs++;
        writeFileSync(outputPath, 'stem');
      };
      return { state, runner };
    };

    const { state, runner } = counting();
    await buildTargets(root, ['//songs/creek/tracks:drums'], runner);
    expect(state.runs).toBe(1);

    // Same placement → cache hit.
    await buildTargets(root, ['//songs/creek/tracks:drums'], runner);
    expect(state.runs).toBe(1);

    // A tempo edit moves the musical clip → rebuild.
    const tempoPath = join(root, 'songs/creek/tempo.yaml');
    writeFileSync(tempoPath, readFileSync(tempoPath, 'utf8').replace('bpm: 120', 'bpm: 90'));
    await buildTargets(root, ['//songs/creek/tracks:drums'], runner);
    expect(state.runs).toBe(2);

    // An absolute-anchored clip is untouched by tempo.
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      trackYaml(clipYaml({ anchor: 'absolute', position: 100, duration: 200 })),
    );
    await buildTargets(root, ['//songs/creek/tracks:drums'], runner);
    expect(state.runs).toBe(3);
    writeFileSync(tempoPath, readFileSync(tempoPath, 'utf8').replace('bpm: 90', 'bpm: 240'));
    await buildTargets(root, ['//songs/creek/tracks:drums'], runner);
    expect(state.runs).toBe(3); // cache hit despite the tempo change
  });

  it('ignores fader moves and YAML clip order in the stem action key', async () => {
    const counting = () => {
      const state = { runs: 0 };
      const runner: RuleRunner = async (_node, _inputPaths, outputPath) => {
        state.runs++;
        writeFileSync(outputPath, 'stem');
      };
      return { state, runner };
    };

    const { state, runner } = counting();
    await buildTargets(root, ['//songs/creek/tracks:drums'], runner);
    expect(state.runs).toBe(1);

    // Track gain/pan are mix parameters, not stem contents.
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      ['name: drums', 'type: audio', 'gain_db: -6', 'pan: 0.5', 'clips:', ...clipYaml(), ''].join(
        '\n',
      ),
    );
    await buildTargets(root, ['//songs/creek/tracks:drums'], runner);
    expect(state.runs).toBe(1);

    // Reordering clips in the file is not an edit to the sound.
    const c1 = clipYaml();
    const c2 = clipYaml({ id: 'kick-2', position: 1920 });
    writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), trackYaml([...c1, ...c2]));
    await buildTargets(root, ['//songs/creek/tracks:drums'], runner);
    expect(state.runs).toBe(2); // new clip: renders once…
    writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), trackYaml([...c2, ...c1]));
    await buildTargets(root, ['//songs/creek/tracks:drums'], runner);
    expect(state.runs).toBe(2); // …and the reordered file is a cache hit
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
    expect(queryDeps(root, '//songs/creek/tracks:all')).toEqual(['//songs/creek/tracks:drums']);
  });
});
