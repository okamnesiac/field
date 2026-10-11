import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { buildLabels } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { compileSession } from '../graph/live.js';
import { removeTempProject } from '../testing/temp.js';
import { daemonBinary } from './client.js';
import { insertLatency, type SessionTrack } from './session.js';

// Live inputs (live-supercollider.md chunk 1): a source outside the
// session, carried up from its track through a second instance of each
// chain on the way to main (§9). The golden feeds an input a file with
// --render-live and holds the output to the offline render of the same
// signal through the same chains, late by exactly the input track's
// latency: the limiter's window of 144 samples, plus the one it pushes.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const execFileAsync = promisify(execFile);
const execOrError = async (args: string[], cwd: string): Promise<string> => {
  try {
    await execFileAsync(binary!, args, { cwd });
    return '';
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? String(err);
  }
};

const FRAMES = 24000;

// Loud enough that voice's limiter reduces gain, so the goldens hold the
// overlay's limiters to the offline ones where it matters.
function tone(): [Float32Array, Float32Array] {
  const left = new Float32Array(FRAMES);
  const right = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    left[i] = 1.25 * Math.sin((2 * Math.PI * 220 * i) / 48000);
    right[i] = Math.sin((2 * Math.PI * 330 * i) / 48000);
  }
  return [left, right];
}

const VOICE_INSERTS = [
  'inserts:',
  '  - effect: eq',
  '    normalize: false',
  '    bands:',
  '      - type: bell',
  '        frequency: 900',
  '        gain_db: 3',
  '        bandwidth: 1.5',
  '  - effect: limit',
  '    ceiling_db: -2',
  '    lookahead_ms: 3',
  '    release_ms: 60',
];

const MAIN_INSERTS = ['inserts:', '  - effect: limit', '    ceiling_db: -1', '    lookahead_ms: 5', '    release_ms: 80'];

const SONG = (name: string, length: string) =>
  [
    `name: ${name}`,
    'time:',
    '  tempo:',
    '    - at: 0',
    '      bpm: 120',
    '  meter:',
    '    - at: 0',
    '      numerator: 4',
    '      denominator: 4',
    `length: ${length}`,
    '',
  ].join('\n');

// `opener` plays the tone from a file through voice's chain into main;
// `monitor` has the same chains with nothing on voice, so an input on it
// is the only sound — placed twice in main, which the input must still
// reach once.
async function scaffold(root: string): Promise<void> {
  init({ dir: root, name: 'live-input' });
  createSong(root, 'opener');
  const src = join(tmpdir(), `live-input-tone-${process.pid}.wav`);
  writeWavFloat32(src, 48000, tone());
  await importAsset(root, 'opener', src, 'tone');
  rmSync(src);
  createTrack(root, 'opener', 'voice');
  writeFileSync(
    join(root, 'songs/opener/tracks/voice.yaml'),
    ['name: voice', ...VOICE_INSERTS, 'inputs:', '  - audio: tone', '    anchor: absolute', '    at: 0', ''].join('\n'),
  );
  writeFileSync(
    join(root, 'songs/opener/tracks/main.yaml'),
    ['name: main', ...MAIN_INSERTS, 'inputs:', '  - track: voice', '    anchor: absolute', '    at: 0', ''].join('\n'),
  );
  writeFileSync(join(root, 'songs/opener/song.yaml'), SONG('opener', '[1]'));

  createSong(root, 'monitor');
  createTrack(root, 'monitor', 'voice');
  writeFileSync(join(root, 'songs/monitor/tracks/voice.yaml'), ['name: voice', ...VOICE_INSERTS, 'inputs: []', ''].join('\n'));
  writeFileSync(
    join(root, 'songs/monitor/tracks/main.yaml'),
    [
      'name: main',
      ...MAIN_INSERTS,
      'inputs:',
      '  - track: voice',
      '    anchor: absolute',
      '    at: 0',
      '  - track: voice',
      '    anchor: absolute',
      '    at: 30000',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'songs/monitor/song.yaml'), SONG('monitor', '[1]'));
}

// Paths of unequal latency into main: voice (a limiter, 145 samples)
// directly, through `crush` (a second limiter, 290 in all) by a post
// send, and through `wash` (a reverb, no latency) by a pre-tap send. The
// overlay aligns them to the longest, so the output is the offline
// render late by 290, with nothing meeting itself offset.
async function splitScaffold(root: string): Promise<void> {
  init({ dir: root, name: 'live-split' });
  const src = join(tmpdir(), `live-split-tone-${process.pid}.wav`);
  writeWavFloat32(src, 48000, tone());
  for (const song of ['split-offline', 'split-live']) {
    createSong(root, song);
    for (const name of ['voice', 'crush', 'wash']) createTrack(root, song, name);
    const voiceInputs =
      song === 'split-offline' ? ['inputs:', '  - audio: tone', '    anchor: absolute', '    at: 0'] : ['inputs: []'];
    if (song === 'split-offline') await importAsset(root, song, src, 'tone');
    writeFileSync(
      join(root, `songs/${song}/tracks/voice.yaml`),
      [
        'name: voice',
        'sends:',
        '  crush:',
        '    gain_db: -6',
        '  wash:',
        '    gain_db: -12',
        '    tap: pre',
        ...VOICE_INSERTS,
        ...voiceInputs,
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(root, `songs/${song}/tracks/crush.yaml`),
      ['name: crush', ...VOICE_INSERTS.slice(0, 1), ...VOICE_INSERTS.slice(8), 'inputs:', '  - receive: crush', ''].join('\n'),
    );
    writeFileSync(
      join(root, `songs/${song}/tracks/wash.yaml`),
      [
        'name: wash',
        'inserts:',
        '  - effect: reverb',
        '    mix: 0.5',
        '    decay: 0.4',
        '    predelay_ms: 5',
        '    damping: 0.4',
        'inputs:',
        '  - receive: wash',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(root, `songs/${song}/tracks/main.yaml`),
      [
        'name: main',
        ...MAIN_INSERTS,
        'inputs:',
        '  - track: voice',
        '    anchor: absolute',
        '    at: 0',
        '  - track: crush',
        '    anchor: absolute',
        '    at: 0',
        '  - track: wash',
        '    anchor: absolute',
        '    at: 0',
        '',
      ].join('\n'),
    );
    writeFileSync(join(root, `songs/${song}/song.yaml`), SONG(song, '[1]'));
  }
  rmSync(src);
}

describe.skipIf(!binary)('live inputs through --render-live (live-supercollider.md chunk 1)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-live-input-'));
  });
  afterEach(async () => {
    await removeTempProject(root);
  });

  it("plays an input through its track's chain and main's, as the offline render of the same signal, late by the track's latency", async () => {
    await scaffold(root);
    const offline = await buildLabels(root, ['//songs/opener/track:main']);
    const stem = readWav(offline.find((o) => o.label.endsWith('track:main'))!.outputPath!).channels;

    const { session } = await compileSession(root, 'monitor', { inputs: [{ track: 'voice', input: 'mic' }] });
    const voice = session.tracks.find((t) => t.name === 'voice')!;
    expect(voice.inputs).toEqual([{ input: 'mic', gain_db: 0 }]);
    const late = voice.chain.reduce((sum, insert) => sum + insertLatency(insert, 48000), 0);
    expect(late).toBe(145);

    writeFileSync(join(root, 'session.json'), JSON.stringify(session));
    writeWavFloat32(join(root, 'mic.wav'), 48000, tone());
    await execFileAsync(binary!, ['--render-live', 'session.json', 'live.wav', '--input', 'mic=mic.wav'], { cwd: root });
    const live = readWav(join(root, 'live.wav')).channels;

    expect(live[0]!.length).toBe(stem[0]!.length);
    for (let c = 0; c < 2; c++) {
      // Nothing before the input track's chain has emitted, then the
      // offline stem sample for sample for as long as the tone lasts:
      // placed twice, heard once. Past the tone the two part on
      // purpose. The stem ends where voice's content does and cuts the
      // eq's ring there; an input has no end, so the overlay rings out.
      expect(live[c]!.subarray(0, late).every((s) => s === 0)).toBe(true);
      let worst = 0;
      for (let i = 0; i < FRAMES; i++) worst = Math.max(worst, Math.abs(live[c]![i + late]! - stem[c]![i]!));
      expect(worst).toBe(0);
    }
  });

  it('aligns every path into a track to the longest, so an input never meets itself offset', async () => {
    await splitScaffold(root);
    const offline = await buildLabels(root, ['//songs/split-offline/track:main']);
    const stem = readWav(offline.find((o) => o.label.endsWith('track:main'))!.outputPath!).channels;

    const { session } = await compileSession(root, 'split-live', { inputs: [{ track: 'voice', input: 'mic' }] });
    const chainLate = (name: string) =>
      session.tracks.find((t) => t.name === name)!.chain.reduce((sum, insert) => sum + insertLatency(insert, 48000), 0);
    const late = chainLate('voice') + chainLate('crush');
    expect(late).toBe(290);

    writeFileSync(join(root, 'session.json'), JSON.stringify(session));
    writeWavFloat32(join(root, 'mic.wav'), 48000, tone());
    await execFileAsync(binary!, ['--render-live', 'session.json', 'live.wav', '--input', 'mic=mic.wav'], { cwd: root });
    const live = readWav(join(root, 'live.wav')).channels;

    for (let c = 0; c < 2; c++) {
      expect(live[c]!.subarray(0, late).every((s) => s === 0)).toBe(true);
      let worst = 0;
      for (let i = 0; i < FRAMES; i++) worst = Math.max(worst, Math.abs(live[c]![i + late]! - stem[c]![i]!));
      expect(worst).toBe(0);
    }
  });

  it('refuses a session whose input nothing feeds', async () => {
    await scaffold(root);
    const { session } = await compileSession(root, 'monitor', { inputs: [{ track: 'voice', input: 'mic' }] });
    writeFileSync(join(root, 'session.json'), JSON.stringify(session));
    expect(await execOrError(['--render-live', 'session.json', 'live.wav'], root)).toContain(
      'session names input "mic", which nothing feeds',
    );
  });
});

describe('compiling a session with inputs (live-supercollider.md chunk 1)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-live-input-'));
  });
  afterEach(async () => {
    await removeTempProject(root);
  });

  // keys under keys-bus with an eq, and pad, a sibling fed by a file,
  // all under main; every stem built, so each would freeze.
  async function busScaffold(): Promise<void> {
    init({ dir: root, name: 'live-bus' });
    createSong(root, 'creek');
    const src = join(tmpdir(), `live-bus-tone-${process.pid}.wav`);
    writeWavFloat32(src, 48000, tone());
    await importAsset(root, 'creek', src, 'tone');
    rmSync(src);
    for (const name of ['keys', 'keys-bus', 'pad', 'stray']) createTrack(root, 'creek', name);
    writeFileSync(join(root, 'songs/creek/tracks/keys.yaml'), 'name: keys\ninputs: []\n');
    writeFileSync(
      join(root, 'songs/creek/tracks/keys-bus.yaml'),
      [
        'name: keys-bus',
        'inserts:',
        '  - effect: eq',
        '    normalize: false',
        '    bands:',
        '      - type: lowpass',
        '        frequency: 700',
        '        gain_db: 0',
        '        bandwidth: 1',
        'inputs:',
        '  - track: keys',
        '',
      ].join('\n'),
    );
    writeFileSync(join(root, 'songs/creek/tracks/pad.yaml'), 'name: pad\ninputs:\n  - audio: tone\n    anchor: absolute\n    at: 0\n');
    writeFileSync(join(root, 'songs/creek/tracks/stray.yaml'), 'name: stray\ninputs: []\n');
    writeFileSync(join(root, 'songs/creek/tracks/main.yaml'), 'name: main\ninputs:\n  - track: keys-bus\n  - track: pad\n');
    await buildLabels(root, ['//songs/creek/track:keys-bus', '//songs/creek/track:pad']);
  }

  const byName = (tracks: SessionTrack[], name: string) => tracks.find((t) => t.name === name);

  it('keeps the input and every track above it live, and freezes a sibling fed by a file', async () => {
    await busScaffold();
    const frozen = await compileSession(root, 'creek');
    expect(byName(frozen.session.tracks, 'keys-bus')!.inputs[0]).toHaveProperty('file');
    expect(byName(frozen.session.tracks, 'keys')).toBeUndefined();

    const { session, dirty } = await compileSession(root, 'creek', { inputs: [{ track: 'keys', input: 'keys-voice' }] });
    const bus = byName(session.tracks, 'keys-bus')!;
    expect(bus.chain.map((i) => i.effect)).toEqual(['eq']);
    expect(bus.inputs).toEqual([expect.objectContaining({ track: 'keys' })]);
    expect(byName(session.tracks, 'keys')!.inputs).toEqual([{ input: 'keys-voice', gain_db: 0 }]);
    // The sibling is still served from its stem.
    const pad = byName(session.tracks, 'pad')!;
    expect(pad.chain).toEqual([]);
    expect(pad.inputs[0]).toHaveProperty('file');
    expect(dirty.some((label) => /track:(keys|keys-bus)$/.test(label))).toBe(false);
  });

  it('refuses an input that names no track, sits under nothing, or is named twice', async () => {
    await busScaffold();
    await expect(compileSession(root, 'creek', { inputs: [{ track: 'organ', input: 'mic' }] })).rejects.toThrow(
      'input "mic" names "organ", which is not a track in song "creek"',
    );
    await expect(compileSession(root, 'creek', { inputs: [{ track: 'stray', input: 'mic' }] })).rejects.toThrow(
      '"stray" is not under main, so input "mic" would not be heard',
    );
    await expect(
      compileSession(root, 'creek', {
        inputs: [
          { track: 'keys', input: 'mic' },
          { track: 'pad', input: 'mic' },
        ],
      }),
    ).rejects.toThrow('input "mic" is named twice');
  });
});
