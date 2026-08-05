import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { buildTargets, explainTarget, queryDeps } from '../commands/build.js';
import type { RuleRunner } from './build.js';

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

const targetsYaml = (rate: number) =>
  [
    'targets:',
    '  - name: pad-normalized',
    '    rule: normalize',
    '    input: pad',
    `    sample_rate: ${rate}`,
    '    bit_depth: 16',
    '',
  ].join('\n');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bloom-build-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  const src = join(root, '..', `bloom-build-src-${Math.random()}.wav`);
  writeWav(src);
  await importAsset(root, 'creek', src, 'pad');
  rmSync(src);
  writeFileSync(join(root, 'songs/creek/targets.yaml'), targetsYaml(96000));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const countingRunner = () => {
  const state = { runs: 0 };
  const runner: RuleRunner = async (_node, inputPath, outputPath) => {
    state.runs++;
    copyFileSync(inputPath, outputPath);
  };
  return { state, runner };
};

describe('build', () => {
  it('builds, caches, and rebuilds on parameter change', async () => {
    const { state, runner } = countingRunner();

    const first = await buildTargets(root, ['//songs/creek/targets:pad-normalized'], runner);
    expect(state.runs).toBe(1);
    const target = first.find((o) => o.label.endsWith(':pad-normalized'))!;
    expect(target.cached).toBe(false);
    expect(existsSync(target.outputPath!)).toBe(true);

    const second = await buildTargets(root, ['//songs/creek/targets:pad-normalized'], runner);
    expect(state.runs).toBe(1); // action-cache hit, nothing executed
    expect(second.find((o) => o.label.endsWith(':pad-normalized'))!.cached).toBe(true);

    writeFileSync(join(root, 'songs/creek/targets.yaml'), targetsYaml(44100));
    await buildTargets(root, ['//songs/creek/targets:pad-normalized'], runner);
    expect(state.runs).toBe(2); // key changed, rule re-ran
  });

  it('expands wildcards, including the everything pattern', async () => {
    const { state, runner } = countingRunner();
    const outcomes = await buildTargets(root, ['//songs/...'], runner);
    expect(outcomes.map((o) => o.label).sort()).toEqual([
      '//songs/creek/assets:pad',
      '//songs/creek/targets:pad-normalized',
    ]);
    expect(state.runs).toBe(1);
    const everything = await buildTargets(root, ['//...'], runner);
    expect(everything).toHaveLength(2);
  });

  it('reserves "all" as a name', async () => {
    const src = join(root, '..', `bloom-build-all-${Math.random()}.wav`);
    writeWav(src);
    await expect(importAsset(root, 'creek', src, 'all')).rejects.toThrow('reserved');
    rmSync(src);
    // Hand-written YAML is caught by the schema.
    writeFileSync(
      join(root, 'songs/creek/targets.yaml'),
      targetsYaml(96000).replace('name: pad-normalized', 'name: all'),
    );
    await expect(buildTargets(root, ['//songs/...'])).rejects.toThrow('reserved');
  });

  it('refuses to build an invalid project', async () => {
    writeFileSync(join(root, 'songs/creek/targets.yaml'), targetsYaml(96000).replace('input: pad', 'input: ghost'));
    await expect(buildTargets(root, ['//songs/...'])).rejects.toThrow('unknown asset');
  });

  it('errors on unmatched patterns and unknown labels', async () => {
    await expect(buildTargets(root, ['//nowhere/...'])).rejects.toThrow('matched no targets');
    expect(() => queryDeps(root, 'deps(//songs/creek/targets:ghost)')).toThrow('no such target');
  });

  it('refuses to build when input bytes disagree with the declaration', async () => {
    const { state, runner } = countingRunner();
    const assetPath = join(root, 'songs/creek/audio/pad.wav');
    const original = readFileSync(assetPath);
    writeFileSync(assetPath, Buffer.concat([original, Buffer.from([0, 0])]));
    await expect(
      buildTargets(root, ['//songs/creek/targets:pad-normalized'], runner),
    ).rejects.toThrow('refusing to build');
    expect(state.runs).toBe(0); // nothing executed, nothing cached

    // Same-size tamper is caught by the hash, not the size.
    writeFileSync(assetPath, Buffer.from(original.map((b, i) => (i === 50 ? b ^ 0xff : b))));
    await expect(
      buildTargets(root, ['//songs/creek/targets:pad-normalized'], runner),
    ).rejects.toThrow('refusing to build');
    expect(state.runs).toBe(0);

    // Restore the declared bytes and the build proceeds.
    writeFileSync(assetPath, original);
    const outcomes = await buildTargets(root, ['//songs/creek/targets:pad-normalized'], runner);
    expect(state.runs).toBe(1);
    expect(outcomes.find((o) => o.label.endsWith(':pad-normalized'))!.cached).toBe(false);
  });

  it('treats a corrupt action entry as a cache miss and repairs it', async () => {
    const { state, runner } = countingRunner();
    await buildTargets(root, ['//songs/creek/targets:pad-normalized'], runner);
    expect(state.runs).toBe(1);

    const actionsDir = join(root, '.bloom/cache/actions');
    const entry = readdirSync(actionsDir).find((f) => f.endsWith('.json'))!;
    writeFileSync(join(actionsDir, entry), '{"rule": "norm'); // crash mid-write

    const outcomes = await buildTargets(root, ['//songs/creek/targets:pad-normalized'], runner);
    expect(state.runs).toBe(2); // re-ran instead of crashing
    expect(outcomes.find((o) => o.label.endsWith(':pad-normalized'))!.cached).toBe(false);

    const again = await buildTargets(root, ['//songs/creek/targets:pad-normalized'], runner);
    expect(state.runs).toBe(2); // entry rewritten; cache healthy again
    expect(again.find((o) => o.label.endsWith(':pad-normalized'))!.cached).toBe(true);
  });

  it('normalizes real audio through afconvert', async () => {
    const outcomes = await buildTargets(root, ['//songs/creek/targets:pad-normalized']);
    const target = outcomes.find((o) => o.label.endsWith(':pad-normalized'))!;
    expect(target.cached).toBe(false);
    expect(existsSync(target.outputPath!)).toBe(true);
    // Second build is a cache hit even with the real runner.
    const again = await buildTargets(root, ['//songs/creek/targets:pad-normalized']);
    expect(again.find((o) => o.label.endsWith(':pad-normalized'))!.cached).toBe(true);
  });
});

describe('query and explain', () => {
  it('lists deps in dependency order', () => {
    expect(queryDeps(root, 'deps(//songs/creek/targets:pad-normalized)')).toEqual([
      '//songs/creek/assets:pad',
      '//songs/creek/targets:pad-normalized',
    ]);
  });

  it('lists pattern matches', () => {
    expect(queryDeps(root, '//songs/creek/assets:all')).toEqual(['//songs/creek/assets:pad']);
  });

  it('explains a rule target', async () => {
    const before = explainTarget(root, '//songs/creek/targets:pad-normalized');
    expect(before.rule).toBe('normalize');
    expect(before.cached).toBe(false);
    expect(before.parameters).toEqual({ sample_rate: 96000, bit_depth: 16 });
    expect(before.inputs[0]!.label).toBe('//songs/creek/assets:pad');

    const { runner } = countingRunner();
    await buildTargets(root, ['//songs/creek/targets:pad-normalized'], runner);
    const after = explainTarget(root, '//songs/creek/targets:pad-normalized');
    expect(after.cached).toBe(true);
    expect(after.actionKey).toBe(before.actionKey);
    expect(after.outputs).toHaveLength(1);
  });
});
