import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWavFloat32 } from '../audio/wav.js';
import { buildLabels } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { compileSession } from '../graph/live.js';
import { AudiodClient, daemonBinary } from './client.js';

// Chunk 2's definition of correct (realtime.md decision 3 at graph
// level): a non-looping session rendered by the live engine is
// byte-identical to the offline stem the same graph builds. Looping
// playback is deliberately not byte-comparable — the offline fold is a
// post-chain addition, the live wrap is tails ringing through chain
// state — so the golden compares one non-looping pass.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const execFileAsync = promisify(execFile);

// A project exercising the window and chain surface: a placed track
// (twice, with pan and fades), a file clip, a pre-tap cable, and a
// main chain of all three effects within the live limiter's horizon.
async function scaffold(root: string): Promise<void> {
  init({ dir: root, name: 'live-golden' });
  createSong(root, 'opener');

  const tone = join(tmpdir(), `live-tone-${process.pid}.wav`);
  const frames = 24000;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / 48000);
    right[i] = 0.4 * Math.sin((2 * Math.PI * 330 * i) / 48000);
  }
  writeWavFloat32(tone, 48000, [left, right]);
  await importAsset(root, 'opener', tone, 'tone');
  rmSync(tone);

  createTrack(root, 'opener', 'voice');
  writeFileSync(
    join(root, 'songs/opener/tracks/voice.yaml'),
    [
      'name: voice',
      'sends:',
      '  wash:',
      '    gain_db: -12',
      '    tap: pre',
      'inserts:',
      '  - effect: eq',
      '    normalize: false',
      '    bands:',
      '      - type: bell',
      '        frequency: 900',
      '        gain_db: 3',
      '        bandwidth: 1.5',
      // A limiter on a child: its stream lag must not shift the summed
      // timeline (the comp_delay double-compensation Codex caught).
      '  - effect: limit',
      '    ceiling_db: -2',
      '    lookahead_ms: 3',
      '    release_ms: 60',
      'inputs:',
      '  - audio: tone',
      '    anchor: absolute',
      '    at: 0',
      '',
    ].join('\n'),
  );
  createTrack(root, 'opener', 'wash');
  writeFileSync(
    join(root, 'songs/opener/tracks/wash.yaml'),
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
    join(root, 'songs/opener/tracks/main.yaml'),
    [
      'name: main',
      'inserts:',
      '  - effect: limit',
      '    ceiling_db: -1',
      '    lookahead_ms: 5',
      '    release_ms: 80',
      'inputs:',
      '  - track: voice',
      '    anchor: absolute',
      '    at: 0',
      '    fade_in: 480',
      '  - track: voice',
      '    anchor: absolute',
      '    at: 30000',
      '    gain_db: -6',
      '    pan: 0.4',
      '    fade_out: 960',
      '  - track: wash',
      '    anchor: absolute',
      '    at: 0',
      '',
    ].join('\n'),
  );
  // A declared extent, unlooped: the one pass the golden compares.
  writeFileSync(
    join(root, 'songs/opener/song.yaml'),
    [
      'name: opener',
      'time:',
      '  tempo:',
      '    - at: 0',
      '      bpm: 120',
      '  meter:',
      '    - at: 0',
      '      numerator: 4',
      '      denominator: 4',
      'length: 72000',
      '',
    ].join('\n'),
  );
}

function wavData(path: string): Buffer {
  const bytes = readFileSync(path);
  const at = bytes.indexOf('data');
  const size = bytes.readUInt32LE(at + 4);
  return bytes.subarray(at + 8, at + 8 + size);
}

describe.skipIf(!binary)('live session (realtime.md chunk 2)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-live-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('renders a non-looping session byte-identically to the offline stem', async () => {
    await scaffold(root);
    const offline = await buildLabels(root, ['//songs/opener/track:main']);
    const artifact = offline.find((o) => o.label.endsWith('track:main'))!.outputPath!;

    const session = await compileSession(root, 'opener');
    const sessionPath = join(root, 'session.json');
    writeFileSync(sessionPath, JSON.stringify(session));
    const livePath = join(root, 'live.wav');
    await execFileAsync(binary!, ['--render-live', sessionPath, livePath], { cwd: root });

    const live = wavData(livePath);
    const stem = wavData(artifact);
    expect(live.length).toBe(stem.length);
    expect(live.equals(stem)).toBe(true);
  });

  it('loads, plays, ramps, and locates a session over the socket', async () => {
    await scaffold(root);
    const session = await compileSession(root, 'opener');

    const client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    try {
      expect(client.supports('session')).toBe(true);
      const loaded = await client.session(session);
      // 72000 ticks at 120 bpm resolve through the tempo map: 75 beats
      // of half a second at 48 kHz.
      expect(loaded.samples).toBe(1_800_000);
      expect(loaded.sample_rate).toBe(48000);

      await client.play();
      await new Promise((r) => setTimeout(r, 300));
      const playing = await client.status();
      expect(playing.state).toBe('playing');
      expect(playing.live).toBe(true);
      expect(playing.sample).toBeGreaterThan(0);

      await client.ramp('main', 0, -9, 10);
      await client.locate(0);
      await client.stop();
      const stopped = await client.status();
      expect(stopped.state).toBe('stopped');
      expect(stopped.sample).toBe(0);
    } finally {
      try {
        await client.quit();
      } catch {
        // already gone
      }
      client.close();
    }
  });
});
