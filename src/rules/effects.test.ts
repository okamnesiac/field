import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { buildTargets, queryDeps } from '../commands/build.js';
import { createSong } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { loadProject } from '../model/project.js';

// Effect rules end to end: chains as targets-referencing-targets, cache
// cascade on parameter edits, cycle and reference diagnostics
// (effects.md §3). All real DSP — no fake runners.

let root: string;

const targetsYaml = (lines: string[]) => ['targets:', ...lines, ''].join('\n');

const eqTarget = (name: string, source: string, gain: number, extra: string[] = []) => [
  `  - name: ${name}`,
  '    rule: eq',
  `    ${source}`,
  '    bands:',
  '      - type: bell',
  '        frequency: 1000',
  `        gain_db: ${gain}`,
  ...extra,
];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bloom-effects-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  const src = join(root, '..', `bloom-effects-src-${Math.random()}.wav`);
  // One second of 1 kHz sine at 0.1 — sits right on the test EQ's bell.
  const tone = new Float32Array(48000);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
  writeWavFloat32(src, 48000, [tone]);
  await importAsset(root, 'creek', src, 'tone');
  rmSync(src);
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

describe('effect chains', () => {
  it('builds asset → eq → reverb with real DSP, cached per link', async () => {
    writeFileSync(
      join(root, 'songs/creek/targets.yaml'),
      targetsYaml([
        ...eqTarget('tone-eq', 'asset: tone', -6),
        '  - name: tone-verb',
        '    rule: reverb',
        '    target: tone-eq',
        '    decay: 0.5',
      ]),
    );

    expect(queryDeps(root, 'deps(//songs/creek/targets:tone-verb)')).toEqual([
      '//songs/creek/assets:tone',
      '//songs/creek/targets:tone-eq',
      '//songs/creek/targets:tone-verb',
    ]);

    const first = await buildTargets(root, ['//songs/creek/targets:tone-verb']);
    const verb = first.find((o) => o.label.endsWith(':tone-verb'))!;
    expect(readWav(verb.outputPath!).channels[0]!.length).toBe(48000 + 24000); // + tail

    const again = await buildTargets(root, ['//songs/creek/targets:tone-verb']);
    expect(again.every((o) => o.cached)).toBe(true);

    // A parameter edit upstream cascades: eq and reverb rebuild, the
    // asset stays an asset.
    const path = join(root, 'songs/creek/targets.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('gain_db: -6', 'gain_db: -9'));
    const after = await buildTargets(root, ['//songs/creek/targets:tone-verb']);
    expect(after.filter((o) => !o.cached).map((o) => o.label)).toEqual([
      '//songs/creek/targets:tone-eq',
      '//songs/creek/targets:tone-verb',
    ]);
  });

  it('eq normalize holds level while shaping tone (Fyra semantics)', async () => {
    writeFileSync(
      join(root, 'songs/creek/targets.yaml'),
      targetsYaml([
        ...eqTarget('eq-norm', 'asset: tone', 6, ['    normalize: true']),
        ...eqTarget('eq-raw', 'asset: tone', 6, ['    normalize: false']),
      ]),
    );
    const outcomes = await buildTargets(root, ['//songs/creek/targets:all']);
    const norm = rmsOf(outcomes.find((o) => o.label.endsWith(':eq-norm'))!.outputPath!);
    const raw = rmsOf(outcomes.find((o) => o.label.endsWith(':eq-raw'))!.outputPath!);
    // Unnormalized: a bell boost right on the tone ≈ +6 dB of level. The
    // narrow-bell compensation is small but real, and always downward.
    expect(20 * Math.log10(raw / 0.0707)).toBeCloseTo(6, 0);
    expect(norm).toBeLessThan(raw);
  });

  it('limits a hot render to the ceiling', async () => {
    writeFileSync(
      join(root, 'songs/creek/targets.yaml'),
      targetsYaml([
        ...eqTarget('tone-hot', 'asset: tone', 24, ['    normalize: false']),
        '  - name: tone-safe',
        '    rule: limit',
        '    target: tone-hot',
        '    ceiling_db: -3',
      ]),
    );
    const outcomes = await buildTargets(root, ['//songs/creek/targets:tone-safe']);
    const safe = outcomes.find((o) => o.label.endsWith(':tone-safe'))!;
    const [channel] = readWav(safe.outputPath!).channels;
    const ceiling = Math.pow(10, -3 / 20);
    for (const v of channel!) expect(Math.abs(v)).toBeLessThanOrEqual(ceiling + 1e-6);
  });

  it('normalize accepts a target, closing the rate-fix loop', async () => {
    writeFileSync(
      join(root, 'songs/creek/targets.yaml'),
      targetsYaml([
        ...eqTarget('tone-eq', 'asset: tone', -3),
        '  - name: tone-eq-441',
        '    rule: normalize',
        '    target: tone-eq',
        '    sample_rate: 44100',
        '    bit_depth: 16',
      ]),
    );
    const outcomes = await buildTargets(root, ['//songs/creek/targets:tone-eq-441']);
    const converted = outcomes.find((o) => o.label.endsWith(':tone-eq-441'))!;
    expect(readWav(converted.outputPath!).sampleRate).toBe(44100);
  });

  it('diagnoses cycles, unknown references, and ambiguous sources', () => {
    writeFileSync(
      join(root, 'songs/creek/targets.yaml'),
      targetsYaml([
        '  - name: a',
        '    rule: reverb',
        '    target: b',
        '  - name: b',
        '    rule: reverb',
        '    target: a',
        '  - name: c',
        '    rule: reverb',
        '    target: ghost',
        '  - name: d',
        '    rule: reverb',
        '    asset: tone',
        '    target: a',
      ]),
    );
    const messages = loadProject(root).diagnostics.map((d) => d.message);
    expect(messages).toContain('target dependency cycle: a → b → a');
    expect(messages).toContain('target "c" references unknown target "ghost"');
    expect(messages).toContain('target "d" sources exactly one of asset or target');
  });
});
