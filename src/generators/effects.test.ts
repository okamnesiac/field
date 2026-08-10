import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { buildLabels, queryDeps } from '../commands/build.js';
import { createSong } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { loadProject } from '../model/project.js';

// Effect contracts end to end: chains as wrapper tracks placing wrapper
// tracks — the shape every effect sound folded into (nested-tracks.md
// §18, decision 12) — cache cascade on insert edits, cycle and reference
// diagnostics. All real DSP — no fake runners.

let root: string;

// One file per track (project-layout.md §1.3, §4): a wrapper is one
// input and an insert chain.
const writeWrappers = (wrappers: Record<string, string[]>) => {
  mkdirSync(join(root, 'songs/creek/tracks'), { recursive: true });
  for (const [name, lines] of Object.entries(wrappers)) {
    writeFileSync(
      join(root, `songs/creek/tracks/${name}.yaml`),
      [`name: ${name}`, ...lines, ''].join('\n'),
    );
  }
};

const eqWrapper = (input: string, gain: number, extra: string[] = []) => [
  'inserts:',
  '  - effect: eq',
  '    bands:',
  '      - type: bell',
  '        frequency: 1000',
  `        gain_db: ${gain}`,
  ...extra.map((line) => `    ${line}`),
  'inputs:',
  `  - ${input}`,
];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'field-effects-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  const src = join(root, '..', `field-effects-src-${Math.random()}.wav`);
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
    writeWrappers({
      'tone-eq': eqWrapper('audio: tone', -6),
      'tone-verb': [
        'inserts:',
        '  - effect: reverb',
        '    decay: 0.5',
        'inputs:',
        '  - track: tone-eq',
      ],
    });

    expect(queryDeps(root, 'deps(//songs/creek/track:tone-verb)')).toEqual([
      '//songs/creek/asset:tone',
      '//songs/creek/track:tone-eq',
      '//songs/creek/track:tone-verb',
    ]);

    const first = await buildLabels(root, ['//songs/creek/track:tone-verb']);
    const verb = first.find((o) => o.label.endsWith(':tone-verb'))!;
    expect(readWav(verb.outputPath!).channels[0]!.length).toBe(48000 + 24000); // + tail

    const again = await buildLabels(root, ['//songs/creek/track:tone-verb']);
    expect(again.every((o) => o.cached)).toBe(true);

    // An insert edit upstream cascades: the eq wrapper and the reverb
    // wrapper rebuild, the asset stays an asset.
    const path = join(root, 'songs/creek/tracks/tone-eq.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('gain_db: -6', 'gain_db: -9'));
    const after = await buildLabels(root, ['//songs/creek/track:tone-verb']);
    expect(after.filter((o) => !o.cached).map((o) => o.label)).toEqual([
      '//songs/creek/track:tone-eq',
      '//songs/creek/track:tone-verb',
    ]);
  });

  it('eq normalize holds level while shaping tone (Fyra semantics)', async () => {
    writeWrappers({
      'eq-norm': eqWrapper('audio: tone', 6, ['normalize: true']),
      'eq-raw': eqWrapper('audio: tone', 6, ['normalize: false']),
    });
    const outcomes = await buildLabels(root, [
      '//songs/creek/track:eq-norm',
      '//songs/creek/track:eq-raw',
    ]);
    const norm = rmsOf(outcomes.find((o) => o.label.endsWith(':eq-norm'))!.outputPath!);
    const raw = rmsOf(outcomes.find((o) => o.label.endsWith(':eq-raw'))!.outputPath!);
    // Unnormalized: a bell boost right on the tone ≈ +6 dB of level. The
    // narrow-bell compensation is small but real, and always downward.
    expect(20 * Math.log10(raw / 0.0707)).toBeCloseTo(6, 0);
    expect(norm).toBeLessThan(raw);
  });

  it('limits a hot render to the ceiling', async () => {
    writeWrappers({
      'tone-hot': eqWrapper('audio: tone', 24, ['normalize: false']),
      'tone-safe': [
        'inserts:',
        '  - effect: limit',
        '    ceiling_db: -3',
        'inputs:',
        '  - track: tone-hot',
      ],
    });
    const outcomes = await buildLabels(root, ['//songs/creek/track:tone-safe']);
    const safe = outcomes.find((o) => o.label.endsWith(':tone-safe'))!;
    const [channel] = readWav(safe.outputPath!).channels;
    const ceiling = Math.pow(10, -3 / 20);
    for (const v of channel!) expect(Math.abs(v)).toBeLessThanOrEqual(ceiling + 1e-6);
  });

  it('diagnoses cycles and unknown references', () => {
    writeWrappers({
      a: ['inputs:', '  - track: b'],
      b: ['inputs:', '  - track: a'],
      c: ['inputs:', '  - audio: ghost'],
    });
    const messages = loadProject(root).diagnostics.map((d) => d.message);
    expect(messages).toContain('track containment cycle: a → b → a');
    expect(messages.some((m) => m.includes('references unknown audio "ghost"'))).toBe(true);
  });
});
