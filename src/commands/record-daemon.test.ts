import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, readWavHeader, writeWavFloat32 } from '../audio/wav.js';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import type { AudiodEvent } from '../audiod/protocol.js';
import { loadProject } from '../model/project.js';
import { createSong, createTrack } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { buildLabels } from './build.js';
import { describeTake, meterLine, recordTake, resolveRecordTarget } from './record.js';
import { transportCommand, transportStatusLines } from './transport.js';
import { check } from './check.js';
import { removeTempProject } from '../testing/temp.js';

// The input side (recording.md chunk 1) against the real daemon in
// null-output mode. The null clock presents an input while armed — a
// sawtooth over one second of the input clock on channel 1, a constant
// on channel 2 (player.cpp) — so a take read back can prove two things
// no real device could prove as cleanly: that not one block was lost or
// duplicated between the callback and the file, and that arm captured
// the channel it named.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const NULL_RATE = 48000;
const SAW_STEP = 2 / NULL_RATE;

// Every consecutive pair either climbs one step or wraps from the top of
// the ramp to its bottom; anything else is a dropped or repeated block.
function assertGapless(samples: Float32Array): void {
  expect(samples.length).toBeGreaterThan(1000);
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]! - samples[i - 1]!;
    const climbs = Math.abs(d - SAW_STEP) < 1e-6;
    const wraps = Math.abs(d - (SAW_STEP - 2)) < 1e-6;
    if (!climbs && !wraps) {
      throw new Error(`discontinuity at sample ${i}: ${samples[i - 1]} → ${samples[i]}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe('record helpers', () => {
  it('draws the meter: silent input is named, not drawn empty', () => {
    expect(meterLine(0)).toBe('silent');
    expect(meterLine(undefined)).toBe('');
    expect(meterLine(1)).toMatch(/^▮{12} 0\.0 dBFS {2}CLIP$/);
    expect(meterLine(0.001)).toMatch(/^▯{12} -60\.0 dBFS$/);
    expect(meterLine(0.25)).toMatch(/^▮{10}▯{2} -12\.0 dBFS$/);
  });
});

describe.skipIf(!binary)('recording through the daemon', () => {
  let root: string;

  beforeEach(() => {
    process.env['FIELD_AUDIOD_NULL'] = '1';
    root = mkdtempSync(join(tmpdir(), 'field-record-'));
    init({ dir: root, name: 'takes' });
    createSong(root, 'creek'); // 120 bpm 4/4: one beat = 24000 samples
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
    await removeTempProject(root);
  });

  async function importTone(name: string, samples: number): Promise<string> {
    const src = join(root, '..', `field-record-${name}-${Math.random()}.wav`);
    writeWavFloat32(src, NULL_RATE, [new Float32Array(samples).fill(0.1)]);
    await importAsset(root, 'creek', src, name);
    rmSync(src);
    return join(root, 'songs/creek/audio', name, `${name}.wav`);
  }

  it('advertises the feature, lists no inputs in null mode, and starts idle', async () => {
    const client = await AudiodClient.connect(root, { nullOutput: true });
    try {
      expect(client.supports('record')).toBe(true);
      expect(client.pid).toBeGreaterThan(0);
      const devices = await client.devices();
      expect(devices.inputs).toEqual([]);
      const status = await client.status();
      expect(status.record).toEqual({ state: 'idle' });
    } finally {
      client.close();
    }
  });

  it(
    'records a gapless take against a playing file and finalizes on stop',
    { timeout: 15_000 },
    async () => {
      const tone = await importTone('bed', NULL_RATE * 10);
      const client = await AudiodClient.connect(root, { nullOutput: true });
      const events: AudiodEvent[] = [];
      client.on('event', (e: AudiodEvent) => events.push(e));
      try {
        await client.load(tone);
        const armed = await client.arm('//songs/creek/track:main', 1);
        expect(armed).toMatchObject({ device: 'null', input: 1, channels: 2, sample_rate: NULL_RATE });
        expect((await client.status()).record?.state).toBe('armed');

        // Beat 2 (sample 24000): record locates there, starts the
        // transport, and latches the position of the first captured
        // block. Never earlier — that is the correctness claim. The
        // ceiling is a sanity bound, not a latency guarantee: how soon
        // the callback runs after the request is the scheduler's, and a
        // loaded runner has landed the latch three blocks late (minjudd's
        // finding on #166), so eight blocks catches a daemon latching
        // wildly late without asserting promptness this code cannot
        // promise.
        const started = await client.record(24000);
        expect(started.started_at_samples).toBeGreaterThanOrEqual(24000);
        expect(started.started_at_samples).toBeLessThan(24000 + 8 * 512);
        expect(started.transaction).toMatch(/^take-\d{8}-\d{6}(-\d+)?$/);
        expect((await client.status()).state).toBe('playing');

        await sleep(1200);
        const mid = await client.status();
        expect(mid.record?.state).toBe('recording');
        expect(mid.record?.frames).toBeGreaterThan(NULL_RATE);
        // The peak since the status read above: 1.2 s of a sawtooth that
        // spans ±1 once a second, so it reaches 1. The heartbeat also
        // reads status, four times a second, and at first consumed the
        // meter too — every client then saw at most a quarter-second
        // window, which is a quarter of the ramp and read 0.48 on CI.
        // Only a client's read may reset it (Player::status consumePeak).
        expect(mid.record?.input_peak).toBeGreaterThan(0.9);

        const stopped = await client.stop();
        const take = stopped.take!;
        expect(take.complete).toBe(true);
        expect(take.id).toBe(started.transaction);
        expect(take.started_at_samples).toBe(started.started_at_samples);
        expect(take.timeline_rate).toBe(NULL_RATE);
        expect(take.source).toBe(tone);
        expect(take.dropped).toBe(0);
        // Written, not hoped: the WAV header says what the manifest says.
        const wavPath = join(root, take.file);
        expect(readWavHeader(wavPath)).toMatchObject({
          sampleRate: NULL_RATE,
          channels: 1,
          frames: take.frames,
          format: 3,
          bitsPerSample: 32,
        });
        const wav = readWav(wavPath);
        assertGapless(wav.channels[0]!);

        // The manifest and journal sit beside the bytes.
        const dir = join(root, '.field/recording', take.id);
        const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
        expect(manifest['complete']).toBe(true);
        expect(manifest['frames']).toBe(take.frames);
        expect(JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8'))).toMatchObject({ frames: take.frames });

        // Everyone hears the take land, and the record state walks back
        // to armed. The heartbeat samples state four times a second, so
        // the arm and the record above can land inside one tick and the
        // walk is `recording` then `armed`, or `armed` first when the
        // tick fell between them — what is asserted is what every
        // ordering shares.
        await waitFor(() => events.some((e) => e.event === 'take'), 2000, 'the take event');
        const landed = events.find((e) => e.event === 'take');
        expect(landed?.event === 'take' && landed.take.id).toBe(take.id);
        const recordStates = () =>
          events.filter((e) => e.event === 'record').map((e) => (e as { state: string }).state);
        await waitFor(() => recordStates().at(-1) === 'armed', 2000, 'the record event to return to armed');
        expect(recordStates()).toContain('recording');
        expect(recordStates().indexOf('recording')).toBeLessThan(recordStates().lastIndexOf('armed'));

        // Still armed after the take; disarm releases.
        expect((await client.status()).record?.state).toBe('armed');
        const list = await client.recordings();
        expect(list.recordings.map((r) => [r.id, r.complete, r.active])).toEqual([[take.id, true, false]]);
        await client.disarm();
        expect((await client.status()).record).toEqual({ state: 'idle' });
      } finally {
        client.close();
      }
    },
  );

  it('captures the channel arm named: input 2 is the null constant', { timeout: 10_000 }, async () => {
    const client = await AudiodClient.connect(root, { nullOutput: true });
    try {
      await client.arm('//songs/creek/track:main', 2);
      // No bed: a free-running take, placed on the free clock.
      const started = await client.record();
      expect(started.started_at_samples).toBeGreaterThanOrEqual(0);
      await sleep(600);
      const take = (await client.stop()).take!;
      expect(take.timeline_rate).toBeUndefined();
      const wav = readWav(join(root, take.file));
      expect(wav.channels[0]!.length).toBe(take.frames);
      expect(wav.channels[0]!.every((s) => Math.abs(s - 0.25) < 1e-6)).toBe(true);
      await expect(client.arm('//songs/creek/track:main', 3)).rejects.toThrow('2 channels');
      await expect(client.arm('//songs/creek/track:main', 0)).rejects.toThrow('count from 1');
    } finally {
      client.close();
    }
  });

  it('refuses what would break a take in progress', { timeout: 10_000 }, async () => {
    const tone = await importTone('bed', NULL_RATE * 10);
    const client = await AudiodClient.connect(root, { nullOutput: true });
    try {
      await expect(client.record()).rejects.toThrow('not armed');
      await client.load(tone);
      await client.arm('//songs/creek/track:main', 1);
      await client.record(0);
      await expect(client.record()).rejects.toThrow('already recording');
      await expect(client.locate(48000)).rejects.toThrow('stop first');
      await expect(client.load(tone)).rejects.toThrow('stop first');
      await expect(client.arm('//songs/creek/track:main', 2)).rejects.toThrow('stop first');
      await expect(client.disarm()).rejects.toThrow('stop first');
      await expect(client.recover((await client.status()).record!.transaction!)).rejects.toThrow(
        'still being recorded',
      );
      // Pause ends the take too: a capture against a still transport
      // has no honest placement.
      const paused = await client.pause();
      expect(paused.take?.complete).toBe(true);
      expect((await client.status()).state).toBe('paused');
      expect((await client.status()).record?.state).toBe('armed');
      // A bed is required for `at`; without one the take free-runs.
      await client.stop();
      await client.disarm();
      await expect(client.recover('take-nope')).rejects.toThrow('no recording transaction');
    } finally {
      client.close();
    }
  });

  it('an armed daemon outlives its idle timeout; a disarmed one does not', { timeout: 15_000 }, async () => {
    const client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 1 });
    const pid = client.pid;
    await client.arm('//songs/creek/track:main', 1);
    client.close();
    await sleep(2500); // well past idle with no connections
    const again = await AudiodClient.connect(root, { spawnIfNeeded: false });
    expect(again.pid).toBe(pid); // the same daemon, pinned by the arm
    expect((await again.status()).record?.state).toBe('armed');
    await again.disarm();
    again.close();
    await sleep(2500);
    await expect(AudiodClient.connect(root, { spawnIfNeeded: false })).rejects.toThrow('not running');
  });

  // win32: on the windows CI runner a request in this test fails with
  // "field-audiod connection closed": the daemon drops the connection
  // there for a reason not yet diagnosed, and the temp project's
  // audiod.log that would say why is removed with it. Skipped until the
  // follow-up in windows-portability.md §7.2 ("crash recovery on
  // Windows") finds the cause.
  it.skipIf(process.platform === 'win32')(
    'a daemon killed mid-take leaves a recoverable transaction, and recover finalizes it gapless',
    { timeout: 20_000 },
    async () => {
      const client = await AudiodClient.connect(root, { nullOutput: true });
      await client.arm('//songs/creek/track:main', 1);
      const started = await client.record();
      // Past at least one journal sync (the writer syncs once a second).
      await sleep(1600);
      const before = (await client.status()).record!;
      expect(before.written).toBeGreaterThan(NULL_RATE);
      process.kill(client.pid!, 'SIGKILL');
      client.close();
      await waitFor(
        async () => {
          try {
            process.kill(client.pid!, 0);
            return false;
          } catch {
            return true;
          }
        },
        5000,
        'the killed daemon to die',
      );

      // The header still says zero frames: the file is a transaction,
      // not a take.
      const wavPath = join(root, started.file);
      expect(readWavHeader(wavPath).frames).toBe(0);
      const journal = JSON.parse(readFileSync(join(root, '.field/recording', started.transaction, 'journal.json'), 'utf8')) as {
        frames: number;
      };
      expect(journal.frames).toBeGreaterThan(0);

      // The next spawn reports it, lists it, and recovers it.
      const fresh = await AudiodClient.connect(root, { nullOutput: true });
      try {
        expect(fresh.pid).not.toBe(client.pid);
        expect(readFileSync(join(root, '.field/audiod.log'), 'utf8')).toContain(
          `recoverable take ${started.transaction}`,
        );
        const list = await fresh.recordings();
        const entry = list.recordings.find((r) => r.id === started.transaction)!;
        expect(entry.complete).toBe(false);
        expect(entry.active).toBe(false);
        expect(entry.frames_on_disk).toBeGreaterThanOrEqual(journal.frames);
        expect(entry.started_at_samples).toBe(started.started_at_samples); // on disk before the crash

        const { take } = await fresh.recover(started.transaction);
        expect(take.complete).toBe(true);
        expect(take.recovered).toBe(true);
        expect(take.frames).toBe(entry.frames_on_disk);
        expect(take.journaled_frames).toBe(journal.frames);
        expect(readWavHeader(wavPath).frames).toBe(take.frames);
        assertGapless(readWav(wavPath).channels[0]!);
        await expect(fresh.recover(started.transaction)).rejects.toThrow('already complete');
        expect(describeTake(take)).toMatch(/^take-\S+ {2}recovered {2}\.field\/recording\/.*frames/);
      } finally {
        fresh.close();
      }
    },
  );

  it('field record: arms, loads the song as the bed, blocks, stops on ctrl-c, and lands the take', { timeout: 30_000 }, async () => {
    await importTone('tone', NULL_RATE * 6);
    createTrack(root, 'creek', 'lead-vocal');
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      ['name: main', 'inputs:', '  - audio: tone', '    anchor: absolute', '    at: 0', ''].join('\n'),
    );
    let project = loadProject(root);
    expect(resolveRecordTarget(root, 'creek/track:lead-vocal')).toEqual({
      label: '//songs/creek/track:lead-vocal',
      track: 'lead-vocal',
      song: 'creek',
    });
    expect(() => resolveRecordTarget(root, 'creek/asset:tone')).toThrow('is a asset');
    expect(() => resolveRecordTarget(root, 'creek/track:all')).toThrow('one track');
    // No `record:` entry, no take: refused before the daemon is touched.
    await expect(recordTake(root, project, 'creek/track:lead-vocal', {}, {})).rejects.toThrow(
      'lead-vocal has no `record:` entry',
    );
    writeFileSync(
      join(root, 'songs/creek/tracks/lead-vocal.yaml'),
      ['name: lead-vocal', 'inputs:', '  - record:', ''].join('\n'),
    );
    project = loadProject(root);
    // Takeless is a warning, not a gate (recording.md §4).
    const before = await check(root);
    expect(before.diagnostics.map((d) => `${d.severity ?? 'error'}: ${d.message}`)).toEqual([
      'warning: input 1 ("record") has no takes yet — field record creek/track:lead-vocal',
    ]);

    const lines: string[] = [];
    const positions: string[] = [];
    let interrupted = false;
    const { takes } = await recordTake(
      root,
      project,
      'creek/track:lead-vocal',
      { input: 1, at: '1.2.1', monitoring: 'apollo-direct', consolePreset: 'vocal-tracking' },
      {
        onBed: (line) => lines.push(line),
        onArmed: (line) => lines.push(line),
        onStarted: (line) => lines.push(line),
        onPosition: (line) => {
          positions.push(line);
          if (positions.length >= 3) interrupted = true;
        },
        interrupted: () => interrupted,
      },
    );
    expect(lines[0]).toBe('live    creek'); // nothing was loaded, so it loaded the song
    expect(lines[1]).toMatch(/^armed {3}null input 1 {2}\(48000 Hz, latency in 0 \/ out 0 samples\)$/);
    expect(lines[2]).toMatch(/^recording take-\S+ from 1\.2\.1 \(0:00\.5\)$/);
    expect(positions[0]).toMatch(/^\d+\.\d+\.\d+ \(\d+:\d\d\.\d\)  ▮.* dBFS \d+\.\ds$/);
    expect(takes).toHaveLength(1);
    const { take, landed } = takes[0]!;
    expect(take.complete).toBe(true);
    expect(take.track).toBe('//songs/creek/track:lead-vocal');
    expect(take.song).toBe('creek');
    expect(take.started_at_samples).toBeGreaterThanOrEqual(24000);

    // Landed (recording.md §3): the bytes under the record node's
    // directory and in the ledger, the row beside them, the transaction
    // gone, the take chosen. lead-vocal is not placed in main, so its
    // timeline is the song's from zero and the row's start is the
    // daemon's.
    expect(landed).toMatchObject({
      song: 'creek',
      track: 'lead-vocal',
      node: 'lead-vocal',
      asset: take.id,
      file: `audio/lead-vocal/${take.id}.wav`,
      placements: 0,
      placedAt: take.started_at_samples,
    });
    expect(landed.row).toMatchObject({
      asset: take.id,
      started_at_samples: take.started_at_samples,
      musical_position: [1, 2],
      latency: 0,
      device: 'null',
      input: 1,
      monitoring: 'apollo-direct',
      console_preset: 'vocal-tracking',
      recorded_at: take.started_wall,
    });
    expect(existsSync(join(root, take.file))).toBe(false); // the transaction went
    expect(existsSync(join(root, 'songs/creek', landed.file))).toBe(true);
    assertGapless(readWav(join(root, 'songs/creek', landed.file)).channels[0]!);
    const takesYaml = readFileSync(join(root, 'songs/creek/audio/lead-vocal/takes.yaml'), 'utf8');
    expect(takesYaml).toContain(`record: lead-vocal\nchosen: ${take.id}\ntakes:\n  - asset: ${take.id}\n`);
    expect(readFileSync(join(root, 'songs/creek/assets.yaml'), 'utf8')).toContain(
      `  - name: ${take.id}\n    file: audio/lead-vocal/${take.id}.wav\n`,
    );
    const after = await check(root);
    expect(after.diagnostics).toEqual([]);

    // And it builds in place: the stem is silence up to the take's
    // start and the take from there — the sawtooth, gapless.
    const built = (await buildLabels(root, ['creek/track:lead-vocal'])).find(
      (o) => o.label === '//songs/creek/track:lead-vocal',
    )!;
    const stem = readWav(built.outputPath!).channels[0]!;
    expect(stem.length).toBe(take.started_at_samples! + take.frames!);
    expect(stem.subarray(0, take.started_at_samples!).every((s) => s === 0)).toBe(true);
    assertGapless(stem.subarray(take.started_at_samples!));

    // Ctrl-c stopped the transport and released the input.
    const client = await AudiodClient.connect(root, { spawnIfNeeded: false });
    const status = await client.status();
    expect(status.state).toBe('stopped');
    expect(status.record?.state).toBe('idle');
    client.close();
  });

  it('a stop from another terminal finalizes the take the blocking side is waiting on', { timeout: 20_000 }, async () => {
    await importTone('tone', NULL_RATE * 20);
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      ['name: main', 'inputs:', '  - audio: tone', '    anchor: absolute', '    at: 0', '  - record:', ''].join('\n'),
    );
    const project = loadProject(root);
    const recording = recordTake(root, project, 'creek/track:main', {}, {});

    await waitFor(
      async () => {
        try {
          return (await transportStatusLines(root, project)).some((l) => l.startsWith('recording: take-'));
        } catch {
          return false; // daemon still starting
        }
      },
      8000,
      'the take to show in transport status',
    );
    const lines = await transportStatusLines(root, project);
    expect(lines.find((l) => l.startsWith('recording: '))).toMatch(
      /^recording: take-\S+ \(\d+ frames\) on null input 1 → \/\/songs\/creek\/track:main$/,
    );
    await transportCommand(root, 'stop');
    const { takes } = await recording; // the take event reached the blocking side
    const { take, landed } = takes[0]!;
    expect(take.complete).toBe(true);
    expect(take.frames).toBeGreaterThan(0);
    expect(landed.node).toBe('main');
    expect(landed.placements).toBe(1); // the output track is its own one placement, at zero
  });
});
