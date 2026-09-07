import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import type { Take } from '../audiod/protocol.js';
import { loadProject } from '../model/project.js';
import { buildLabels } from './build.js';
import { check } from './check.js';
import { createSong, createTrack } from './create.js';
import { init } from './init.js';
import { chooseTake, landTake, readTransaction, recordNodeFor, trackOrigin } from './land.js';

// Landing without a daemon (recording.md §3, chunk 2): a finalized
// transaction is a directory of files, so the arithmetic that turns the
// daemon's position into a placement on the track — the origin walk,
// the rate changes, the latency — is testable from a manifest written
// by hand. The daemon path is record-daemon.test.ts.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-land-'));
  init({ dir: root, name: 'landing' });
  createSong(root, 'creek'); // 120 bpm 4/4 at 48 kHz: a beat is 24000 samples, a bar 96000
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeTrack(name: string, lines: string[]): void {
  writeFileSync(join(root, 'songs/creek/tracks', `${name}.yaml`), [`name: ${name}`, ...lines, ''].join('\n'));
}

// A transaction the daemon would have left: a mono float32 take whose
// samples count up, so a placement can be checked by value.
function writeTransaction(id: string, take: Partial<Take> & { track: string }, frames = 4800): Take {
  const dir = join(root, '.field', 'recording', id);
  mkdirSync(dir, { recursive: true });
  const samples = Float32Array.from({ length: frames }, (_, i) => (i + 1) / 100000);
  writeWavFloat32(join(dir, 'take.wav'), take.sample_rate ?? 48000, [samples]);
  const manifest: Take = {
    id,
    file: `.field/recording/${id}/take.wav`,
    device: 'Apollo Twin X',
    input: 1,
    sample_rate: 48000,
    timeline_rate: 48000,
    channels: 1,
    bit_depth: 32,
    format: 'float',
    input_latency: 0,
    output_latency: 0,
    started_wall: '2026-09-07T10:00:00.000-04:00',
    daemon: '0.12.0',
    complete: true,
    frames,
    dropped: 0,
    song: 'creek',
    ...take,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'journal.json'), JSON.stringify({ frames, dropped: 0 }));
  return manifest;
}

describe('trackOrigin', () => {
  it('sums the placements down the first path, in seconds', () => {
    createTrack(root, 'creek', 'verse');
    createTrack(root, 'creek', 'vox');
    writeTrack('main', ['inputs:', '  - track: verse', '    at: [5]']); // bar 5 = 8 s
    writeTrack('verse', ['inputs:', '  - track: vox', '    at: [1, 3]']); // beat 3 = 1 s in
    writeTrack('vox', ['inputs:', '  - record:']);
    const project = loadProject(root);
    const song = project.songs[0]!;
    expect(trackOrigin(project, song, 'vox')).toEqual({ seconds: 9, placements: 1 });
    expect(trackOrigin(project, song, 'verse')).toEqual({ seconds: 8, placements: 1 });
    expect(trackOrigin(project, song, 'main')).toEqual({ seconds: 0, placements: 1 });
  });

  it('a track placed twice counts from the earliest, and says how many', () => {
    createTrack(root, 'creek', 'phrase');
    writeTrack('main', [
      'inputs:',
      '  - track: phrase',
      '    at: [9]',
      '  - track: phrase',
      '    at: [5]',
      '  - track: phrase',
      '    anchor: absolute',
      '    at: 480000', // 10 s, the earliest as it happens
    ]);
    writeTrack('phrase', ['inputs:', '  - record:']);
    const project = loadProject(root);
    expect(trackOrigin(project, project.songs[0]!, 'phrase')).toEqual({ seconds: 8, placements: 3 });
  });

  it('a track the song never places keeps its own timeline from zero', () => {
    createTrack(root, 'creek', 'scratch'); // which places it in main — undone below
    writeTrack('main', ['inputs: []']);
    writeTrack('scratch', ['inputs:', '  - record:']);
    const project = loadProject(root);
    expect(trackOrigin(project, project.songs[0]!, 'scratch')).toEqual({ seconds: 0, placements: 0 });
  });
});

describe('recordNodeFor', () => {
  it('names the record node, and refuses a track without an entry or with two', () => {
    createTrack(root, 'creek', 'vox');
    writeTrack('vox', ['inputs:', '  - id: v2', '    record:']);
    let project = loadProject(root);
    expect(recordNodeFor(project, '//songs/creek/track:vox')).toMatchObject({
      trackName: 'vox',
      node: 'vox-v2',
    });
    expect(() => recordNodeFor(project, '//songs/creek/track:main')).toThrow('main has no `record:` entry');
    writeTrack('vox', ['inputs:', '  - id: a', '    record:', '  - id: b', '    record:']);
    project = loadProject(root);
    expect(() => recordNodeFor(project, '//songs/creek/track:vox')).toThrow('carries 2 record entries');
  });
});

describe('landTake', () => {
  it('lands the bytes, the ledger row, and the take row on the track timeline; chooses it', async () => {
    createTrack(root, 'creek', 'vox');
    // vox sits at bar 5 of the song (8 s = 384000 samples), so a take the
    // daemon started at song sample 432000 (9 s) begins one second into
    // the track; the device's 142 + 128 samples of latency pull it back.
    writeTrack('main', ['inputs:', '  - track: vox', '    at: [5]']);
    writeTrack('vox', ['inputs:', '  - record:']);
    const manifest = writeTransaction('take-20260907-100000', {
      track: '//songs/creek/track:vox',
      started_at_samples: 432000,
      input_latency: 142,
      output_latency: 128,
    });

    const landed = await landTake(root, manifest, { monitoring: 'apollo-direct', consolePreset: 'vocal' });
    expect(landed).toMatchObject({
      song: 'creek',
      track: 'vox',
      node: 'vox',
      asset: 'take-20260907-100000',
      file: 'audio/vox/take-20260907-100000.wav',
      placedAt: 48000 - 270,
      placements: 1,
      frames: 4800,
      sampleRate: 48000,
    });
    expect(landed.row).toEqual({
      asset: 'take-20260907-100000',
      started_at_samples: 48000,
      musical_position: [5, 3], // bar 5, beat 3 on the song's map
      latency: 270,
      device: 'Apollo Twin X',
      input: 1,
      monitoring: 'apollo-direct',
      console_preset: 'vocal',
      recorded_at: '2026-09-07T10:00:00.000-04:00',
    });
    expect(existsSync(join(root, '.field/recording/take-20260907-100000'))).toBe(false);
    expect(readFileSync(join(root, 'songs/creek/audio/vox/takes.yaml'), 'utf8')).toBe(
      [
        'record: vox',
        'chosen: take-20260907-100000',
        'takes:',
        '  - asset: take-20260907-100000',
        '    started_at_samples: 48000',
        '    musical_position: [5, 3]',
        '    latency: 270',
        '    device: Apollo Twin X',
        '    input: 1',
        '    monitoring: apollo-direct',
        '    console_preset: vocal',
        '    recorded_at: 2026-09-07T10:00:00.000-04:00',
        '',
      ].join('\n'),
    );
    const ledger = readFileSync(join(root, 'songs/creek/assets.yaml'), 'utf8');
    expect(ledger).toContain('  - name: take-20260907-100000\n    file: audio/vox/take-20260907-100000.wav\n');
    expect(ledger).toContain('    sample_rate: 48000\n    bit_depth: 32\n    channels: 1\n    frames: 4800\n');
    expect((await check(root)).diagnostics).toEqual([]);

    // The stem places it: silence to 48000 − 270, then the take's
    // samples counting up from 1/100000.
    const built = (await buildLabels(root, ['creek/track:vox'])).find(
      (o) => o.label === '//songs/creek/track:vox',
    )!;
    const stem = readWav(built.outputPath!).channels[0]!;
    expect(stem.length).toBe(48000 - 270 + 4800);
    expect(stem.subarray(0, 48000 - 270).every((s) => s === 0)).toBe(true);
    expect(stem[48000 - 270]).toBeCloseTo(1 / 100000, 9);
    expect(stem[48000 - 270 + 4799]).toBeCloseTo(4800 / 100000, 7);

    // Landing the same transaction again is refused by name.
    writeTransaction('take-20260907-100000', { track: '//songs/creek/track:vox' });
    await expect(landTake(root, manifest)).rejects.toThrow('already a name in creek');
  });

  it('a take that started before the track reads into itself by the difference', async () => {
    createTrack(root, 'creek', 'vox');
    writeTrack('main', ['inputs:', '  - track: vox', '    anchor: absolute', '    at: 1000']);
    writeTrack('vox', ['inputs:', '  - record:']);
    const manifest = writeTransaction('take-20260907-100100', {
      track: '//songs/creek/track:vox',
      started_at_samples: 400, // 600 samples before vox's origin
    });
    const landed = await landTake(root, manifest);
    expect(landed.row.started_at_samples).toBe(-600);
    expect(landed.placedAt).toBe(-600);
    const built = (await buildLabels(root, ['creek/track:vox'])).find(
      (o) => o.label === '//songs/creek/track:vox',
    )!;
    const stem = readWav(built.outputPath!).channels[0]!;
    expect(stem.length).toBe(4800 - 600);
    expect(stem[0]).toBeCloseTo(601 / 100000, 9); // the take's 601st sample is the track's first
  });

  it('counts started_at_samples from the record entry\'s own at, as the graph reads it', async () => {
    // main places vox at song zero; the entry sits at bar 3 (192000
    // samples). A take that began at bed sample 0 sounds at bar 1 — it
    // was sung there — so the row counts back from the window: −192000.
    // Reading the row the graph's way puts the clip at track sample 0,
    // which is what minjudd's finding on #167 caught the writer and the
    // reader disagreeing about (a bare entry hid it: window start 0).
    createTrack(root, 'creek', 'vox');
    writeTrack('main', ['inputs:', '  - track: vox']);
    writeTrack('vox', ['inputs:', '  - record:', '    at: [3]']);
    const first = writeTransaction('take-20260907-120000', {
      track: '//songs/creek/track:vox',
      started_at_samples: 0,
    });
    const landedFirst = await landTake(root, first);
    expect(landedFirst.row.started_at_samples).toBe(-192000);
    expect(landedFirst.row.musical_position).toEqual([1]);
    expect(landedFirst.placedAt).toBe(0);
    let stem = readWav(
      (await buildLabels(root, ['creek/track:vox'])).find((o) => o.label === '//songs/creek/track:vox')!
        .outputPath!,
    ).channels[0]!;
    expect(stem.length).toBe(4800);
    expect(stem[0]).toBeCloseTo(1 / 100000, 9);

    // And one sung at bar 3.2 (bed sample 216000): 24000 past the
    // entry's window, placed at 216000 on the track.
    const second = writeTransaction('take-20260907-120100', {
      track: '//songs/creek/track:vox',
      started_at_samples: 216000,
    });
    const landedSecond = await landTake(root, second);
    expect(landedSecond.row.started_at_samples).toBe(24000);
    expect(landedSecond.row.musical_position).toEqual([3, 2]);
    expect(landedSecond.placedAt).toBe(216000);
    stem = readWav(
      (await buildLabels(root, ['creek/track:vox'])).find((o) => o.label === '//songs/creek/track:vox')!
        .outputPath!,
    ).channels[0]!;
    expect(stem.length).toBe(216000 + 4800);
    expect(stem.subarray(0, 216000).every((s) => s === 0)).toBe(true);
    expect(stem[216000]).toBeCloseTo(1 / 100000, 9);
  });

  it('converts the daemon\'s rates into the track\'s', async () => {
    createTrack(root, 'creek', 'vox');
    writeTrack('main', ['inputs:', '  - track: vox']);
    writeTrack('vox', ['rate: 96000', 'inputs:', '  - record:']);
    // The bed ran at 48 kHz and the device at 44.1 kHz; the track is at 96.
    const manifest = writeTransaction('take-20260907-100200', {
      track: '//songs/creek/track:vox',
      started_at_samples: 24000, // 0.5 s of song
      timeline_rate: 48000,
      sample_rate: 44100,
      input_latency: 441, // 10 ms
      output_latency: 0,
    });
    const landed = await landTake(root, manifest);
    expect(landed.row.started_at_samples).toBe(48000); // 0.5 s at 96 kHz
    expect(landed.row.latency).toBe(960); // 10 ms at 96 kHz
    expect(landed.row.musical_position).toEqual([1, 2]);
  });

  it('refuses an incomplete transaction, and a project that does not check', async () => {
    createTrack(root, 'creek', 'vox');
    writeTrack('vox', ['inputs:', '  - record:']);
    const manifest = writeTransaction('take-20260907-100300', {
      track: '//songs/creek/track:vox',
      complete: false,
      frames: undefined,
    });
    await expect(landTake(root, manifest)).rejects.toThrow('not complete');
    expect(() => readTransaction(root, 'take-20260907-100300')).toThrow('not complete');
    expect(() => readTransaction(root, 'take-nope')).toThrow('no recording transaction');
    writeTrack('vox', ['inputs:', '  - record:', '    loop:', '      every: [1]']);
    const complete = writeTransaction('take-20260907-100400', { track: '//songs/creek/track:vox' });
    await expect(landTake(root, complete)).rejects.toThrow('project has errors');
  });
});

describe('chooseTake', () => {
  it('moves chosen between landed takes, and refuses names it does not have', async () => {
    createTrack(root, 'creek', 'vox');
    writeTrack('vox', ['inputs:', '  - record:']);
    const first = writeTransaction('take-20260907-110000', { track: '//songs/creek/track:vox' });
    await landTake(root, first);
    const second = writeTransaction('take-20260907-110100', { track: '//songs/creek/track:vox' });
    await landTake(root, second);
    let takes = readFileSync(join(root, 'songs/creek/audio/vox/takes.yaml'), 'utf8');
    expect(takes).toContain('chosen: take-20260907-110100\n'); // the new take is chosen
    expect(await chooseTake(root, 'creek', 'vox', 'take-20260907-110000')).toEqual({
      previous: 'take-20260907-110100',
    });
    takes = readFileSync(join(root, 'songs/creek/audio/vox/takes.yaml'), 'utf8');
    expect(takes).toContain('chosen: take-20260907-110000\n');
    expect(takes.split('  - asset: ')).toHaveLength(3); // both rows still there
    await expect(chooseTake(root, 'creek', 'vox', 'take-20260907-999999')).rejects.toThrow(
      'no take "take-20260907-999999" in audio/vox/',
    );
    await expect(chooseTake(root, 'creek', 'main', 'take-20260907-110000')).rejects.toThrow(
      'no record entry "main"',
    );
    expect((await check(root)).diagnostics).toEqual([]);
  });
});
