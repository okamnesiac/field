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
import { describeTake, meterLine, recordTake, resolveRecordTarget } from './record.js';
import { transportCommand, transportStatusLines } from './transport.js';

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
    rmSync(root, { recursive: true, force: true });
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
        // block — that block or the one after, never earlier.
        const started = await client.record(24000);
        expect(started.started_at_samples).toBeGreaterThanOrEqual(24000);
        expect(started.started_at_samples).toBeLessThan(24000 + 2 * 512);
        expect(started.transaction).toMatch(/^take-\d{8}-\d{6}(-\d+)?$/);
        expect((await client.status()).state).toBe('playing');

        await sleep(1200);
        const mid = await client.status();
        expect(mid.record?.state).toBe('recording');
        expect(mid.record?.frames).toBeGreaterThan(NULL_RATE);
        expect(mid.record?.input_peak).toBeGreaterThan(0.9); // the sawtooth reaches ±1

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

  it(
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

  it('field record: arms, loads the song as the bed, blocks, and stops on ctrl-c', { timeout: 20_000 }, async () => {
    await importTone('tone', NULL_RATE * 6);
    createTrack(root, 'creek', 'lead-vocal');
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      ['name: main', 'inputs:', '  - audio: tone', '    anchor: absolute', '    at: 0', ''].join('\n'),
    );
    const project = loadProject(root);
    expect(resolveRecordTarget(root, 'creek/track:lead-vocal')).toEqual({
      label: '//songs/creek/track:lead-vocal',
      track: 'lead-vocal',
      song: 'creek',
    });
    expect(() => resolveRecordTarget(root, 'creek/asset:tone')).toThrow('is a asset');
    expect(() => resolveRecordTarget(root, 'creek/track:all')).toThrow('one track');

    const lines: string[] = [];
    const positions: string[] = [];
    let interrupted = false;
    const take = await recordTake(
      root,
      project,
      'creek/track:lead-vocal',
      { input: 1, at: '1.2.1' },
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
    expect(take.complete).toBe(true);
    expect(take.track).toBe('//songs/creek/track:lead-vocal');
    expect(take.song).toBe('creek');
    expect(take.started_at_samples).toBeGreaterThanOrEqual(24000);
    expect(existsSync(join(root, take.file))).toBe(true);
    assertGapless(readWav(join(root, take.file)).channels[0]!);

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
      ['name: main', 'inputs:', '  - audio: tone', '    anchor: absolute', '    at: 0', ''].join('\n'),
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
    const take = await recording; // the take event reached the blocking side
    expect(take.complete).toBe(true);
    expect(take.frames).toBeGreaterThan(0);
  });
});
