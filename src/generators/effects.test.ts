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

// Effect rules end to end: chains as sounds-sourcing-sounds, cache
// cascade on parameter edits, cycle and reference diagnostics
// (effects.md §3). All real DSP — no fake runners.

let root: string;

// One file per sound (project-layout.md §1.3, §4).
const writeSounds = (sounds: Record<string, string[]>) => {
  mkdirSync(join(root, 'songs/creek/sounds'), { recursive: true });
  for (const [name, lines] of Object.entries(sounds)) {
    writeFileSync(
      join(root, `songs/creek/sounds/${name}.yaml`),
      [`name: ${name}`, ...lines, ''].join('\n'),
    );
  }
};

const eqLines = (source: string, gain: number, extra: string[] = []) => [
  'type: eq',
  source,
  'bands:',
  '  - type: bell',
  '    frequency: 1000',
  `    gain_db: ${gain}`,
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
    writeSounds({
      'tone-eq': eqLines('source: tone', -6),
      'tone-verb': ['type: reverb', 'source: tone-eq', 'decay: 0.5'],
    });

    expect(queryDeps(root, 'deps(//songs/creek/sound:tone-verb)')).toEqual([
      '//songs/creek/asset:tone',
      '//songs/creek/sound:tone-eq',
      '//songs/creek/sound:tone-verb',
    ]);

    const first = await buildLabels(root, ['//songs/creek/sound:tone-verb']);
    const verb = first.find((o) => o.label.endsWith(':tone-verb'))!;
    expect(readWav(verb.outputPath!).channels[0]!.length).toBe(48000 + 24000); // + tail

    const again = await buildLabels(root, ['//songs/creek/sound:tone-verb']);
    expect(again.every((o) => o.cached)).toBe(true);

    // A parameter edit upstream cascades: eq and reverb rebuild, the
    // asset stays an asset.
    const path = join(root, 'songs/creek/sounds/tone-eq.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('gain_db: -6', 'gain_db: -9'));
    const after = await buildLabels(root, ['//songs/creek/sound:tone-verb']);
    expect(after.filter((o) => !o.cached).map((o) => o.label)).toEqual([
      '//songs/creek/sound:tone-eq',
      '//songs/creek/sound:tone-verb',
    ]);
  });

  it('eq normalize holds level while shaping tone (Fyra semantics)', async () => {
    writeSounds({
      'eq-norm': eqLines('source: tone', 6, ['normalize: true']),
      'eq-raw': eqLines('source: tone', 6, ['normalize: false']),
    });
    const outcomes = await buildLabels(root, ['//songs/creek/sound:all']);
    const norm = rmsOf(outcomes.find((o) => o.label.endsWith(':eq-norm'))!.outputPath!);
    const raw = rmsOf(outcomes.find((o) => o.label.endsWith(':eq-raw'))!.outputPath!);
    // Unnormalized: a bell boost right on the tone ≈ +6 dB of level. The
    // narrow-bell compensation is small but real, and always downward.
    expect(20 * Math.log10(raw / 0.0707)).toBeCloseTo(6, 0);
    expect(norm).toBeLessThan(raw);
  });

  it('limits a hot render to the ceiling', async () => {
    writeSounds({
      'tone-hot': eqLines('source: tone', 24, ['normalize: false']),
      'tone-safe': ['type: limit', 'source: tone-hot', 'ceiling_db: -3'],
    });
    const outcomes = await buildLabels(root, ['//songs/creek/sound:tone-safe']);
    const safe = outcomes.find((o) => o.label.endsWith(':tone-safe'))!;
    const [channel] = readWav(safe.outputPath!).channels;
    const ceiling = Math.pow(10, -3 / 20);
    for (const v of channel!) expect(Math.abs(v)).toBeLessThanOrEqual(ceiling + 1e-6);
  });

  it('normalize accepts a target, closing the rate-fix loop', async () => {
    writeSounds({
      'tone-eq': eqLines('source: tone', -3),
      'tone-eq-441': ['type: normalize', 'source: tone-eq', 'sample_rate: 44100', 'bit_depth: 16'],
    });
    const outcomes = await buildLabels(root, ['//songs/creek/sound:tone-eq-441']);
    const converted = outcomes.find((o) => o.label.endsWith(':tone-eq-441'))!;
    expect(readWav(converted.outputPath!).sampleRate).toBe(44100);
  });

  it('diagnoses cycles, unknown sources, and namespace collisions', () => {
    writeSounds({
      a: ['type: reverb', 'source: b'],
      b: ['type: reverb', 'source: a'],
      c: ['type: reverb', 'source: ghost'],
      tone: ['type: reverb', 'source: a'], // shadows the imported asset
    });
    const messages = loadProject(root).diagnostics.map((d) => d.message);
    expect(messages).toContain('sound dependency cycle: a → b → a');
    expect(messages).toContain('sound "c" source references unknown source "ghost"');
    expect(messages.some((m) => m.includes('collides with an asset of the same name'))).toBe(true);
  });
});
