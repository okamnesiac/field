import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { buildLabels, explainLabel, queryDeps } from '../commands/build.js';
import { resolvePlayables } from '../commands/play.js';
import { runScProgram } from '../generators/supercollider.js';
import type { GeneratorRunner } from './build.js';

let root: string;

// A tiny valid 48 kHz 16-bit mono WAV (100 samples of silence).
function writeWav(path: string): void {
  const n = 100;
  const data = Buffer.alloc(n * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

// One file per sound (project-layout.md §1.3, §4): sounds/<name>.yaml.
const writeSound = (name: string, yaml: string) => {
  mkdirSync(join(root, 'songs/creek/sounds'), { recursive: true });
  writeFileSync(join(root, `songs/creek/sounds/${name}.yaml`), yaml);
};

const normalizeYaml = (rate: number) =>
  ['name: pad-normalized', 'type: normalize', 'source: pad', `sample_rate: ${rate}`, 'bit_depth: 16', ''].join('\n');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bloom-build-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  const src = join(root, '..', `bloom-build-src-${Math.random()}.wav`);
  writeWav(src);
  await importAsset(root, 'creek', src, 'pad');
  rmSync(src);
  writeSound('pad-normalized', normalizeYaml(96000));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const countingRunner = () => {
  const state = { runs: 0 };
  const runner: GeneratorRunner = async (node, inputPaths, outputPath) => {
    state.runs++;
    // Rules with asset inputs copy the first through; input-less rules
    // (sc-render) get deterministic placeholder content.
    if (inputPaths.length > 0) copyFileSync(inputPaths[0]!, outputPath);
    else writeFileSync(outputPath, `out:${node.label.pkg}:${node.label.name}`);
  };
  return { state, runner };
};

describe('build', () => {
  it('builds, caches, and rebuilds on parameter change', async () => {
    const { state, runner } = countingRunner();

    const first = await buildLabels(root, ['//songs/creek/sounds:pad-normalized'], runner);
    expect(state.runs).toBe(1);
    const target = first.find((o) => o.label.endsWith(':pad-normalized'))!;
    expect(target.cached).toBe(false);
    expect(existsSync(target.outputPath!)).toBe(true);

    const second = await buildLabels(root, ['//songs/creek/sounds:pad-normalized'], runner);
    expect(state.runs).toBe(1); // action-cache hit, nothing executed
    expect(second.find((o) => o.label.endsWith(':pad-normalized'))!.cached).toBe(true);

    writeSound('pad-normalized', normalizeYaml(44100));
    await buildLabels(root, ['//songs/creek/sounds:pad-normalized'], runner);
    expect(state.runs).toBe(2); // key changed, rule re-ran
  });

  it('expands wildcards, including the everything pattern', async () => {
    const { state, runner } = countingRunner();
    const outcomes = await buildLabels(root, ['//songs/...'], runner);
    expect(outcomes.map((o) => o.label).sort()).toEqual([
      '//songs/creek/assets:pad',
      '//songs/creek/sounds:pad-normalized',
    ]);
    expect(state.runs).toBe(1);
    const everything = await buildLabels(root, ['//...'], runner);
    expect(everything).toHaveLength(2);
  });

  it('reserves "all" as a name', async () => {
    const src = join(root, '..', `bloom-build-all-${Math.random()}.wav`);
    writeWav(src);
    await expect(importAsset(root, 'creek', src, 'all')).rejects.toThrow('reserved');
    rmSync(src);
    // Hand-written YAML is caught by the schema.
    writeSound('pad-normalized', normalizeYaml(96000).replace('name: pad-normalized', 'name: all'));
    await expect(buildLabels(root, ['//songs/...'])).rejects.toThrow('reserved');
  });

  it('refuses to build an invalid project', async () => {
    writeSound('pad-normalized', normalizeYaml(96000).replace('source: pad', 'source: ghost'));
    await expect(buildLabels(root, ['//songs/...'])).rejects.toThrow('unknown source');
  });

  it('errors on unmatched patterns and unknown labels', async () => {
    await expect(buildLabels(root, ['//nowhere/...'])).rejects.toThrow('matched no labels');
    expect(() => queryDeps(root, 'deps(//songs/creek/sounds:ghost)')).toThrow('no such label');
  });

  it('refuses to build when input bytes disagree with the declaration', async () => {
    const { state, runner } = countingRunner();
    const assetPath = join(root, 'songs/creek/audio/pad.wav');
    const original = readFileSync(assetPath);
    writeFileSync(assetPath, Buffer.concat([original, Buffer.from([0, 0])]));
    await expect(
      buildLabels(root, ['//songs/creek/sounds:pad-normalized'], runner),
    ).rejects.toThrow('refusing to build');
    expect(state.runs).toBe(0); // nothing executed, nothing cached

    // Same-size tamper is caught by the hash, not the size.
    writeFileSync(assetPath, Buffer.from(original.map((b, i) => (i === 50 ? b ^ 0xff : b))));
    await expect(
      buildLabels(root, ['//songs/creek/sounds:pad-normalized'], runner),
    ).rejects.toThrow('refusing to build');
    expect(state.runs).toBe(0);

    // Restore the declared bytes and the build proceeds.
    writeFileSync(assetPath, original);
    const outcomes = await buildLabels(root, ['//songs/creek/sounds:pad-normalized'], runner);
    expect(state.runs).toBe(1);
    expect(outcomes.find((o) => o.label.endsWith(':pad-normalized'))!.cached).toBe(false);
  });

  it('treats a corrupt action entry as a cache miss and repairs it', async () => {
    const { state, runner } = countingRunner();
    await buildLabels(root, ['//songs/creek/sounds:pad-normalized'], runner);
    expect(state.runs).toBe(1);

    const actionsDir = join(root, '.bloom/cache/actions');
    const entry = readdirSync(actionsDir).find((f) => f.endsWith('.json'))!;
    writeFileSync(join(actionsDir, entry), '{"rule": "norm'); // crash mid-write

    const outcomes = await buildLabels(root, ['//songs/creek/sounds:pad-normalized'], runner);
    expect(state.runs).toBe(2); // re-ran instead of crashing
    expect(outcomes.find((o) => o.label.endsWith(':pad-normalized'))!.cached).toBe(false);

    const again = await buildLabels(root, ['//songs/creek/sounds:pad-normalized'], runner);
    expect(state.runs).toBe(2); // entry rewritten; cache healthy again
    expect(again.find((o) => o.label.endsWith(':pad-normalized'))!.cached).toBe(true);
  });

  it('normalizes real audio through afconvert', async () => {
    const outcomes = await buildLabels(root, ['//songs/creek/sounds:pad-normalized']);
    const target = outcomes.find((o) => o.label.endsWith(':pad-normalized'))!;
    expect(target.cached).toBe(false);
    expect(existsSync(target.outputPath!)).toBe(true);
    // Second build is a cache hit even with the real runner.
    const again = await buildLabels(root, ['//songs/creek/sounds:pad-normalized']);
    expect(again.find((o) => o.label.endsWith(':pad-normalized'))!.cached).toBe(true);
  });
});

const scYaml = (seed: number) =>
  [
    'name: texture',
    'type: supercollider',
    'source: shared/instruments/texture.scd',
    `seed: ${seed}`,
    'duration: 0.25',
    'channels: 1',
    '',
  ].join('\n');

describe('supercollider', () => {
  beforeEach(() => {
    writeFileSync(join(root, 'shared/instruments/texture.scd'), '// fake program v1\n');
    writeSound('texture', scYaml(42));
  });

  it('builds, caches, and rebuilds when seed or program change', async () => {
    const { state, runner } = countingRunner();
    const label = '//songs/creek/sounds:texture';

    const first = await buildLabels(root, [label], runner);
    expect(state.runs).toBe(1);
    expect(first[0]!.cached).toBe(false);

    await buildLabels(root, [label], runner);
    expect(state.runs).toBe(1); // cache hit

    writeSound('texture', scYaml(43));
    await buildLabels(root, [label], runner);
    expect(state.runs).toBe(2); // seed is a parameter

    writeFileSync(join(root, 'shared/instruments/texture.scd'), '// fake program v2\n');
    await buildLabels(root, [label], runner);
    expect(state.runs).toBe(3); // program content is an input
  });

  it('has no graph deps but shows the program as an explain input', async () => {
    expect(queryDeps(root, 'deps(//songs/creek/sounds:texture)')).toEqual([
      '//songs/creek/sounds:texture',
    ]);
    const e = await explainLabel(root, '//songs/creek/sounds:texture');
    expect(e.rule).toBe('supercollider');
    expect(e.inputs).toHaveLength(1);
    expect(e.inputs[0]!.label).toBe('shared/instruments/texture.scd');
    expect(e.parameters).toEqual({ seed: 42, duration: 0.25, channels: 1 });
  });

  it('rejects missing and escaping program paths', async () => {
    writeSound('texture', scYaml(42).replace('shared/instruments/texture.scd', 'shared/instruments/ghost.scd'));
    await expect(buildLabels(root, ['//songs/...'])).rejects.toThrow('not found');

    writeSound('texture', scYaml(42).replace('shared/instruments/texture.scd', '../outside.scd'));
    await expect(buildLabels(root, ['//songs/...'])).rejects.toThrow('escapes the project');
  });
});

describe('runScProgram edges (no sclang needed)', () => {
  const scratch = () => join(root, '.bloom');
  const params = { seed: 1, duration: 0.1, channels: 1 as const, sampleRate: 48000 };

  const withSclang = async (binary: string, fn: () => Promise<void>) => {
    const prev = process.env['BLOOM_SCLANG'];
    process.env['BLOOM_SCLANG'] = binary;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env['BLOOM_SCLANG'];
      else process.env['BLOOM_SCLANG'] = prev;
    }
  };

  it('errors hard when BLOOM_SCLANG points at a missing binary', async () => {
    await withSclang('/nonexistent/sclang-determinism-wrapper', async () => {
      await expect(
        runScProgram(join(root, 'x.scd'), join(scratch(), 'out.wav'), params),
      ).rejects.toThrow('BLOOM_SCLANG points at a missing binary');
    });
  });

  it('diagnoses a timeout as a missing 0.exit, not a generic failure', async () => {
    const hang = join(root, 'hang.sh');
    writeFileSync(hang, '#!/bin/sh\nsleep 5\n');
    chmodSync(hang, 0o755);
    await withSclang(hang, async () => {
      await expect(
        runScProgram(join(root, 'x.scd'), join(scratch(), 'out.wav'), { ...params, timeoutMs: 300 }),
      ).rejects.toThrow('0.exit');
    });
  });

  it('surfaces sclang stdout in failures (where SC prints its errors)', async () => {
    const fail = join(root, 'fail.sh');
    writeFileSync(fail, '#!/bin/sh\necho "ERROR: Class not defined: Blah"\necho "boring stderr" >&2\nexit 1\n');
    chmodSync(fail, 0o755);
    await withSclang(fail, async () => {
      await expect(
        runScProgram(join(root, 'x.scd'), join(scratch(), 'out.wav'), params),
      ).rejects.toThrow('Class not defined: Blah');
    });
  });

  it('refuses to cache when the program changes during the render', async () => {
    writeFileSync(join(root, 'shared/instruments/texture.scd'), '// v1\n');
    writeSound('texture', scYaml(42));
    const midRenderEdit: GeneratorRunner = async (_node, _inputPath, outputPath) => {
      writeFileSync(join(root, 'shared/instruments/texture.scd'), '// edited mid-render\n');
      writeFileSync(outputPath, 'audio');
    };
    await expect(
      buildLabels(root, ['//songs/creek/sounds:texture'], midRenderEdit),
    ).rejects.toThrow('changed during the render');

    // Nothing was cached: the next build executes again.
    const { state, runner } = countingRunner();
    await buildLabels(root, ['//songs/creek/sounds:texture'], runner);
    expect(state.runs).toBe(1);
  });
});

const sclangPresent =
  existsSync('/Applications/SuperCollider.app/Contents/MacOS/sclang') ||
  (process.env['PATH'] ?? '').split(':').some((p) => p !== '' && existsSync(join(p, 'sclang')));

describe.skipIf(!sclangPresent)('sc-render integration (requires sclang)', () => {
  const SC_PROGRAM = `(
var seed = "BLOOM_SEED".getenv.asInteger;
var dur = "BLOOM_DURATION".getenv.asFloat;
var rate = "BLOOM_SAMPLE_RATE".getenv.asInteger;
var out = "BLOOM_OUTPUT".getenv;
var chans = "BLOOM_CHANNELS".getenv.asInteger;
var freq, score;
thisThread.randSeed = seed;
freq = rrand(200.0, 800.0);
SynthDef(\\bloomTestTone, { |freq = 440|
	var env = EnvGen.kr(Env.linen(0.01, dur - 0.02, 0.01), doneAction: 2);
	Out.ar(0, (SinOsc.ar(freq) * 0.2 * env) ! chans);
}).store;
score = Score([
	[0.0, Synth.basicNew(\\bloomTestTone).newMsg(args: [\\freq, freq])],
	[dur, [0]]
]);
score.recordNRT(
	outputFilePath: out,
	sampleRate: rate,
	headerFormat: "WAV",
	sampleFormat: "int16",
	options: ServerOptions.new.numOutputBusChannels_(chans),
	duration: dur,
	action: { 0.exit }
);
)
`;

  it('renders a seeded tone deterministically through real sclang', { timeout: 120_000 }, async () => {
    writeFileSync(join(root, 'shared/instruments/texture.scd'), SC_PROGRAM);
    writeSound('texture', scYaml(42));
    const label = '//songs/creek/sounds:texture';

    const first = await buildLabels(root, [label]);
    expect(first[0]!.cached).toBe(false);
    expect(existsSync(first[0]!.outputPath!)).toBe(true);
    expect(readFileSync(first[0]!.outputPath!).length).toBeGreaterThan(1000);

    const again = await buildLabels(root, [label]);
    expect(again[0]!.cached).toBe(true);

    // Same seed, wiped cache: the render is reproducible bit-for-bit.
    rmSync(join(root, '.bloom/cache'), { recursive: true, force: true });
    const rebuilt = await buildLabels(root, [label]);
    expect(rebuilt[0]!.cached).toBe(false);
    expect(rebuilt[0]!.sha256).toBe(first[0]!.sha256);
  });
});

describe('play resolution', () => {
  it('resolves assets to files and rule targets to built outputs, deduped', async () => {
    const { state, runner } = countingRunner();
    const items = await resolvePlayables(
      root,
      ['//songs/creek/assets:pad', '//songs/creek/sounds:pad-normalized', '//songs/creek/assets:pad'],
      runner,
    );
    expect(items.map((i) => i.label)).toEqual([
      '//songs/creek/assets:pad',
      '//songs/creek/sounds:pad-normalized',
    ]);
    expect(items[0]!.path).toBe(join(root, 'songs/creek/audio/pad.wav'));
    expect(existsSync(items[1]!.path)).toBe(true);
    expect(state.runs).toBe(1); // the rule target was built
  });
});

describe('query and explain', () => {
  it('lists deps in dependency order', () => {
    expect(queryDeps(root, 'deps(//songs/creek/sounds:pad-normalized)')).toEqual([
      '//songs/creek/assets:pad',
      '//songs/creek/sounds:pad-normalized',
    ]);
  });

  it('lists pattern matches', () => {
    expect(queryDeps(root, '//songs/creek/assets:all')).toEqual(['//songs/creek/assets:pad']);
  });

  it('explains a rule target', async () => {
    const before = await explainLabel(root, '//songs/creek/sounds:pad-normalized');
    expect(before.rule).toBe('normalize');
    expect(before.cached).toBe(false);
    expect(before.parameters).toEqual({ sample_rate: 96000, bit_depth: 16 });
    expect(before.inputs[0]!.label).toBe('//songs/creek/assets:pad');

    const { runner } = countingRunner();
    await buildLabels(root, ['//songs/creek/sounds:pad-normalized'], runner);
    const after = await explainLabel(root, '//songs/creek/sounds:pad-normalized');
    expect(after.cached).toBe(true);
    expect(after.actionKey).toBe(before.actionKey);
    expect(after.outputs).toHaveLength(1);
  });
});
