import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import { compileSession } from '../graph/live.js';
import { loadProject } from '../model/project.js';
import { createSong, createTrack } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { recordTake } from './record.js';

// The metronome in the engine (recording.md §7, chunk 3). The click is a
// schedule the CLI projects and the daemon synthesizes, so two things
// need proving against the real binary: that the ticks land on the
// samples the schedule names — which `--render-live --click` runs through
// the same Click layer offline, where a WAV can be read back — and that a
// pre-rolled take begins on exactly the sample it was asked for.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const execFileAsync = promisify(execFile);
const NULL_RATE = 48000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// Sign changes per second over a window, which is twice the frequency.
function zeroCrossings(samples: Float32Array): number {
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1]! < 0) !== (samples[i]! < 0)) n++;
  }
  return n;
}

describe.skipIf(!binary)('the engine click', () => {
  let root: string;

  beforeEach(async () => {
    process.env['FIELD_AUDIOD_NULL'] = '1';
    root = mkdtempSync(join(tmpdir(), 'field-click-'));
    init({ dir: root, name: 'metronome' });
    createSong(root, 'creek'); // 120 bpm 4/4: a beat is 24000 samples
    const src = join(root, '..', `field-click-tone-${Math.random()}.wav`);
    writeWavFloat32(src, NULL_RATE, [new Float32Array(NULL_RATE * 10)]); // 10 s of silence
    await importAsset(root, 'creek', src, 'bed');
    rmSync(src);
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      ['name: main', 'inputs:', '  - audio: bed', '    anchor: absolute', '    at: 0', ''].join('\n'),
    );
  });

  afterEach(async () => {
    delete process.env['FIELD_AUDIOD_NULL'];
    try {
      const client = await AudiodClient.connect(root, { spawnIfNeeded: false });
      await client.quit();
      client.close();
    } catch {
      // no daemon left behind
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('renders ticks on exactly the scheduled samples, accented on the downbeat', async () => {
    const compiled = await compileSession(root, 'creek');
    const session = { ...compiled.session, length_samples: 96000 }; // one bar
    const sessionPath = join(root, 'session.json');
    writeFileSync(sessionPath, JSON.stringify(session));
    const schedulePath = join(root, 'click.json');
    writeFileSync(
      schedulePath,
      JSON.stringify({
        rate: 48000,
        ticks: [
          { sample: 0, accent: true },
          { sample: 24000, accent: false },
          { sample: 48000, accent: false },
          { sample: 72000, accent: false },
        ],
      }),
    );
    const out = join(root, 'clicked.wav');
    await execFileAsync(binary!, ['--render-live', sessionPath, out, '--click', schedulePath], { cwd: root });

    const wav = readWav(out);
    const left = wav.channels[0]!;
    expect(left.length).toBe(96000); // the click never changes the length
    // Every tick starts on its sample and rings for 15 ms (720 frames);
    // the first sample of a sine is zero, the second is not.
    for (const at of [0, 24000, 48000, 72000]) {
      expect(left[at]).toBe(0);
      expect(Math.abs(left[at + 1]!)).toBeGreaterThan(0.01);
      expect(Math.abs(left[at + 719]!)).toBeGreaterThan(0);
      expect(left[at + 720]).toBe(0);
      expect(left[at - 1] ?? 0).toBe(0);
    }
    // Both channels carry it, and the space between ticks is the bed's silence.
    expect(wav.channels[1]![24001]).toBe(left[24001]);
    expect(left.subarray(1000, 23000).every((s) => s === 0)).toBe(true);
    // G6 on the downbeat, C6 elsewhere: crossings over 15 ms ≈ 2·f·0.015.
    expect(zeroCrossings(left.subarray(0, 720))).toBeCloseTo(2 * 1568 * 0.015, -1);
    expect(zeroCrossings(left.subarray(24000, 24720))).toBeCloseTo(2 * 1046.5 * 0.015, -1);
  });

  it('takes a schedule over the socket, reports it, and clears it with the bed', async () => {
    const client = await AudiodClient.connect(root, { nullOutput: true });
    try {
      expect(client.supports('click')).toBe(true);
      expect(client.supports('record-start')).toBe(true);
      const bed = join(root, 'songs/creek/audio/bed/bed.wav');
      await client.load(bed);
      await client.click({ rate: 48000, ticks: [{ sample: 0, accent: true }, { sample: 24000, accent: false }] });
      expect((await client.status()).click_ticks).toBe(2);
      await client.click({ rate: 48000, ticks: [] });
      expect((await client.status()).click_ticks).toBe(0);
      await client.click({ rate: 48000, ticks: [{ sample: 0, accent: true }] });
      await client.load(bed); // a load is a new bed: the schedule goes with the old one
      expect((await client.status()).click_ticks).toBe(0);
      await expect(
        client.request('click', { ticks: [{ sample: 0, accent: true }] }, (await import('../audiod/protocol.js')).okResponseSchema),
      ).rejects.toThrow('needs a rate');
    } finally {
      client.close();
    }
  });

  it('a pre-rolled take begins on exactly the sample it was asked for', { timeout: 15_000 }, async () => {
    const client = await AudiodClient.connect(root, { nullOutput: true });
    try {
      await client.load(join(root, 'songs/creek/audio/bed/bed.wav'));
      await client.arm('//songs/creek/track:main', 1);
      // Pre-roll from beat 2 into beat 3: half a second of count-in, then
      // the take latches mid-block at 48000, not at the block after it.
      const started = await client.record(48000, 24000);
      expect(started.started_at_samples).toBe(-1);
      const pending = await client.status();
      expect(pending.state).toBe('playing');
      expect(pending.sample).toBeGreaterThanOrEqual(24000);
      expect(pending.record).toMatchObject({ state: 'recording', pending: true, started_at_samples: -1 });
      await waitFor(async () => (await client.status()).record?.pending === false, 5000, 'the take to begin');
      expect((await client.status()).record?.started_at_samples).toBe(48000);
      await sleep(300);
      const take = (await client.stop()).take!;
      expect(take.started_at_samples).toBe(48000);
      expect(take.frames).toBeGreaterThan(0);
      // start after at is refused, and start with no at.
      await expect(client.record(1000, 2000)).rejects.toThrow('start must not be after at');
      await expect(client.record(undefined, 0)).rejects.toThrow('needs at');
    } finally {
      client.close();
    }
  });

  it('field record --count-in pre-rolls a bar and lands the take exactly at --at', { timeout: 20_000 }, async () => {
    createTrack(root, 'creek', 'lead-vocal');
    writeFileSync(
      join(root, 'songs/creek/tracks/lead-vocal.yaml'),
      ['name: lead-vocal', 'inputs:', '  - record:', ''].join('\n'),
    );
    const project = loadProject(root);
    const lines: string[] = [];
    let interrupted = false;
    const { take, landed } = await recordTake(
      root,
      project,
      'creek/track:lead-vocal',
      { input: 1, at: '2.1.1', countIn: 1 },
      {
        onBed: (line) => lines.push(line),
        onArmed: (line) => lines.push(line),
        onCountIn: (line) => lines.push(line),
        onStarted: (line) => {
          lines.push(line);
          interrupted = true; // one status tick after the take begins
        },
        interrupted: () => interrupted,
      },
    );
    expect(lines[0]).toBe('live    creek');
    expect(lines[2]).toBe('count-in 1.1.1 (0:00.0) → 2.1.1 (0:02.0) (1 bar)');
    expect(lines[3]).toMatch(/^recording take-\S+ from 2\.1\.1 \(0:02\.0\)$/);
    // Bar 2 exactly: the callback started the take mid-block at 96000,
    // and lead-vocal is placed at the song's zero, so the row says so too.
    expect(take.started_at_samples).toBe(96000);
    expect(landed.row.started_at_samples).toBe(96000);
    expect(landed.row.musical_position).toEqual([2]);
    // The count-in's click left with the take; the bed is unclicked now.
    const client = await AudiodClient.connect(root, { spawnIfNeeded: false });
    expect((await client.status()).click_ticks).toBe(0);
    client.close();
  });
});
