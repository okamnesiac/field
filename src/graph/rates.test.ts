import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { buildLabels, explainLabel, queryDeps } from '../commands/build.js';
import { loadProject } from '../model/project.js';
import { readWavHeader, writeWavFloat32 } from '../audio/wav.js';

// Multi-rate step 3: `rate:` on tracks, and conversion nodes minted at
// the edges (multi-rate.md decisions 3, 4, 6). The project scaffolds at
// 48 kHz, so 44.1 kHz is the foreign rate throughout.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-rates-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function importTone(name: string, rate: number, seconds = 0.1): Promise<void> {
  const n = Math.round(rate * seconds);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / rate);
  const src = join(root, '..', `field-rates-src-${name}.wav`);
  writeWavFloat32(src, rate, [samples]);
  await importAsset(root, 'creek', src, name, { allowMismatch: true });
  rmSync(src);
}

function writeTrack(name: string, body: string[]): void {
  writeFileSync(
    join(root, `songs/creek/tracks/${name}.yaml`),
    [`name: ${name}`, ...body, ''].join('\n'),
  );
}

describe('rate: on tracks (decision 3)', () => {
  it('accepts a declared rate and bounds it to the supported set', () => {
    writeTrack('bed', ['rate: 44100']);
    expect(loadProject(root).diagnostics).toEqual([]);

    writeTrack('bed', ['rate: 49000']);
    // The refusal names the set, like every other refusal here — a raw
    // "Invalid input" does not say what a rate may be (#112 review).
    const messages = loadProject(root).diagnostics.map((d) => d.message);
    expect(
      messages.some((m) => m.includes('one of 44100, 48000, 88200, 96000, 176400, 192000')),
    ).toBe(true);
  });

  it('refuses rate: on the song output track', () => {
    // The output is the song, and the song's rate is project.yaml's —
    // a field with one correct value should not exist.
    writeTrack('main', ['rate: 44100']);
    expect(loadProject(root).diagnostics.map((d) => d.message).join('\n')).toContain(
      'sample_rate in project.yaml is that choice',
    );
  });

  it('projects musical time at the track rate, not the project rate', async () => {
    // Bar 2 at 120 bpm 4/4 is 2.0 seconds — 96000 samples at the project
    // rate, 88200 at this track's. If the tempo map ignored `rate:`, the
    // clip would land half a bar early in the rendered file.
    await importTone('hit', 44100);
    writeTrack('bed', [
      'rate: 44100',
      'inputs:',
      '  - audio: hit',
      '    at: [2]',
      '    duration: [0, 1]',
    ]);
    const explained = await explainLabel(root, '//songs/creek/track:bed');
    const clips = explained.parameters!['clips'] as { start: number }[];
    expect(clips[0]!.start).toBe(88200);
  });
});

describe('conversion at the edge (decision 4)', () => {
  it('mints a resample node between a mismatched source and its stem', async () => {
    await importTone('pad', 44100);
    writeTrack('bed', ['inputs:', '  - audio: pad', '    anchor: absolute', '    at: 0']);
    expect(queryDeps(root, 'deps(//songs/creek/track:bed)')).toEqual([
      '//songs/creek/asset:pad',
      '//songs/creek/convert:pad-48000',
      '//songs/creek/track:bed',
    ]);
  });

  it('explains the conversion as an ordinary rule', async () => {
    await importTone('pad', 44100);
    writeTrack('bed', ['inputs:', '  - audio: pad', '    anchor: absolute', '    at: 0']);
    const explained = await explainLabel(root, '//songs/creek/convert:pad-48000');
    expect(explained.rule).toBe('resample');
    expect(explained.parameters).toEqual({ sample_rate: 48000 });
    expect(explained.inputs[0]!.label).toBe('//songs/creek/asset:pad');
  });

  it('shares one node across every placement at that rate', async () => {
    await importTone('pad', 44100);
    writeTrack('bed', ['inputs:', '  - audio: pad', '    anchor: absolute', '    at: 0']);
    writeTrack('bloom', ['inputs:', '  - audio: pad', '    anchor: absolute', '    at: 480']);
    const bed = queryDeps(root, 'deps(//songs/creek/track:bed)');
    const bloom = queryDeps(root, 'deps(//songs/creek/track:bloom)');
    expect(bed).toContain('//songs/creek/convert:pad-48000');
    expect(bloom).toContain('//songs/creek/convert:pad-48000');
  });

  it('a placed track at its own rate converts at the parent edge, kind in the name', async () => {
    // track: refs keep their kind in the conversion's name, so a track
    // and a sound legally sharing a name cannot mint one node for two
    // sources.
    writeTrack('texture', ['rate: 44100']);
    writeTrack('bed', ['inputs:', '  - track: texture', '    anchor: absolute', '    at: 0']);
    expect(queryDeps(root, 'deps(//songs/creek/track:bed)')).toEqual([
      '//songs/creek/track:texture',
      '//songs/creek/convert:track-texture-48000',
      '//songs/creek/track:bed',
    ]);
  });

  it('a placed project-rate track converts when a rate: track consumes it', async () => {
    // The wrapper renders once at the project rate — the shape every
    // effect sound folded into (decision 12) — and the 44.1 kHz consumer
    // pays the conversion at its own edge rather than re-rendering it.
    await importTone('pad', 48000);
    writeTrack('pad-eq', [
      'inserts:',
      '  - effect: eq',
      '    bands:',
      '      - type: lowpass',
      '        frequency: 700',
      'inputs:',
      '  - audio: pad',
    ]);
    writeTrack('bed', [
      'rate: 44100',
      'inputs:',
      '  - track: pad-eq',
      '    anchor: absolute',
      '    at: 0',
    ]);
    expect(queryDeps(root, 'deps(//songs/creek/track:bed)')).toEqual([
      '//songs/creek/asset:pad',
      '//songs/creek/track:pad-eq',
      '//songs/creek/convert:track-pad-eq-44100',
      '//songs/creek/track:bed',
    ]);
  });

  it('reads the rate from the file when the ledger predates the facts', async () => {
    // A flat ledger row without WAV facts is still valid (multi-rate.md
    // decision 5 records all-or-none); the edge then answers from the
    // header itself. Killing the header fallback leaves this stem
    // unconverted and the build refuses at execute.
    await importTone('pad', 44100);
    const ledger = join(root, 'songs/creek/assets.yaml');
    const { readFileSync } = await import('node:fs');
    const stripped = readFileSync(ledger, 'utf8')
      .split('\n')
      .filter((l) => !/^\s+(sample_rate|bit_depth|channels|frames):/.test(l))
      .join('\n');
    writeFileSync(ledger, stripped);
    writeTrack('bed', ['inputs:', '  - audio: pad', '    anchor: absolute', '    at: 0']);
    expect(queryDeps(root, 'deps(//songs/creek/track:bed)')).toContain(
      '//songs/creek/convert:pad-48000',
    );
  });

  it('renders through the conversion, and caches it', async () => {
    await importTone('pad', 44100, 0.05);
    writeTrack('bed', [
      'inputs:',
      '  - audio: pad',
      '    anchor: absolute',
      '    at: 0',
      '    duration: 4800',
    ]);
    const outcomes = await buildLabels(root, ['//songs/creek/track:bed']);
    const stem = outcomes.find((o) => o.label === '//songs/creek/track:bed')!;
    expect(readWavHeader(stem.outputPath!).sampleRate).toBe(48000);
    const convert = outcomes.find((o) => o.label === '//songs/creek/convert:pad-48000')!;
    expect(readWavHeader(convert.outputPath!).sampleRate).toBe(48000);
    expect(readWavHeader(convert.outputPath!).format).toBe(3); // float through the edge

    const again = await buildLabels(root, ['//songs/creek/track:bed']);
    expect(again.every((o) => o.cached)).toBe(true);
  });

  it('a rate: edit re-keys the track', async () => {
    await importTone('pad', 44100);
    writeTrack('bed', [
      'rate: 44100',
      'inputs:',
      '  - audio: pad',
      '    anchor: absolute',
      '    at: 0',
    ]);
    const at441 = await explainLabel(root, '//songs/creek/track:bed');
    // At the source's own rate there is nothing to convert.
    expect(queryDeps(root, 'deps(//songs/creek/track:bed)')).toEqual([
      '//songs/creek/asset:pad',
      '//songs/creek/track:bed',
    ]);

    writeTrack('bed', ['inputs:', '  - audio: pad', '    anchor: absolute', '    at: 0']);
    const at480 = await explainLabel(root, '//songs/creek/track:bed');
    expect(at480.actionKey).not.toBe(at441.actionKey);
  });

  it('scales the read offset to the rate the clip actually reads', async () => {
    // `source_offset` addresses the *source* in samples (project-core.md
    // §3.2), but a converted clip reads the resampled file at the track
    // rate — one second into a 44.1 kHz asset is sample 44100 of the
    // original and sample 48000 of what the stem consumes. Unscaled, the
    // clip starts at the wrong moment without failing anything (#112
    // review, Bugbot).
    await importTone('pad', 44100, 2);
    writeTrack('bed', [
      'inputs:',
      '  - audio: pad',
      '    anchor: absolute',
      '    at: 0',
      '    duration: 4800',
      '    source_offset: 44100',
      '    slip: -2205', // same axis as source_offset, so it scales with it
    ]);
    const explained = await explainLabel(root, '//songs/creek/track:bed');
    const clips = explained.parameters!['clips'] as { read_offset: number }[];
    // (44100 − −2205) × 48000/44100 = 46305 × 48000/44100 = 50400.
    expect(clips[0]!.read_offset).toBe(50400);
  });

  it('scales a looping clip\'s read offset the same way', async () => {
    await importTone('pad', 44100, 2);
    writeTrack('bed', [
      'inputs:',
      '  - audio: pad',
      '    anchor: absolute',
      '    at: 0',
      '    duration: 9600',
      '    source_offset: 22050',
      '    loop:',
      '      enabled: true',
      '      every: 4800',
    ]);
    const explained = await explainLabel(root, '//songs/creek/track:bed');
    const clips = explained.parameters!['clips'] as { read_offset: number }[];
    expect(clips.length).toBeGreaterThan(1);
    for (const clip of clips) expect(clip.read_offset).toBe(24000); // 22050 × 48000/44100
  });

  it('demands loop.every across a rate boundary', async () => {
    // Tiling at "the source's length" would tile at the wrong one: the
    // conversion changes it, and the converted count exists only after
    // the conversion renders.
    await importTone('pad', 44100);
    writeTrack('bed', [
      'inputs:',
      '  - audio: pad',
      '    anchor: absolute',
      '    at: 0',
      '    duration: 9600',
      '    loop:',
      '      enabled: true',
    ]);
    expect(loadProject(root).diagnostics.map((d) => d.message).join('\n')).toContain(
      'set loop.every: the edge conversion changes its length',
    );
  });
});

