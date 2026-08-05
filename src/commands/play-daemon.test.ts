import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWavFloat32 } from '../audio/wav.js';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import { loadProject, type LoadedProject } from '../model/project.js';
import { createSong } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { playThroughDaemon, resolvePlayables } from './play.js';
import { transportCommand, transportLocate, transportStatusLines } from './transport.js';

// End-to-end daemon playback in null-output mode: real project, real
// builds where needed, real daemon pulling the transport at real-time
// pace — so files here are kept short.
const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

describe.skipIf(!binary)('bloom play through the daemon', () => {
  let root: string;
  let project: LoadedProject;

  async function importTone(name: string, samples: number): Promise<void> {
    const src = join(root, '..', `bloom-play-${name}-${Math.random()}.wav`);
    writeWavFloat32(src, 48000, [new Float32Array(samples).fill(0.1)]);
    await importAsset(root, 'creek', src, name);
    rmSync(src);
  }

  beforeEach(async () => {
    process.env['BLOOM_AUDIOD_NULL'] = '1';
    root = mkdtempSync(join(tmpdir(), 'bloom-playd-'));
    init({ dir: root, name: 'test-album' });
    createSong(root, 'creek'); // 120 bpm 4/4: one beat = 24000 samples
    await importTone('blip', 12000); // 0.25 s
    project = loadProject(root);
  });

  afterEach(async () => {
    delete process.env['BLOOM_AUDIOD_NULL'];
    try {
      const client = await AudiodClient.connect(root, { spawnIfNeeded: false });
      await client.quit();
      client.close();
    } catch {
      // no daemon left behind
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('plays a queue in order, streaming positions', async () => {
    await importTone('blop', 12000);
    const items = await resolvePlayables(root, ['//songs/creek/assets:all']);
    expect(items.map((i) => i.label)).toEqual([
      '//songs/creek/assets:blip',
      '//songs/creek/assets:blop',
    ]);

    const played: string[] = [];
    const positions: string[] = [];
    await playThroughDaemon(root, project, items, {}, {
      onItem: (label) => played.push(label),
      onPosition: (line) => positions.push(line),
    });
    expect(played).toEqual(items.map((i) => i.label));
    expect(positions.length).toBeGreaterThan(0);
    expect(positions[0]).toMatch(/^\d+\.\d+\.\d+ \(/); // musical time, derived CLI-side
  });

  it('--from projects musical time to a locate before playing', async () => {
    await importTone('tone', 36000); // 0.75 s
    const items = await resolvePlayables(root, ['//songs/creek/assets:tone']);

    const samples: number[] = [];
    const client = await AudiodClient.connect(root, { nullOutput: true });
    client.on('event', (e: { event: string; sample?: number }) => {
      if (e.event === 'position' && e.sample !== undefined) samples.push(e.sample);
    });
    // Beat 2 of bar 1 = 24000 samples: only the last 12000 samples play.
    await playThroughDaemon(root, project, items, { from: '1.2.1' }, {});
    client.close();
    expect(samples.length).toBeGreaterThan(0);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(24000);
  });

  // 20 s: each item costs a few round-trips plus the daemon's 250 ms
  // heartbeat noticing end-of-stream, and there are twelve of them.
  it('a long queue leaks no listeners (#13 review P3)', { timeout: 20_000 }, async () => {
    for (let i = 0; i < 11; i++) await importTone(`t${i}`, 2400); // 50 ms each
    const items = await resolvePlayables(root, ['//songs/creek/assets:all']);
    expect(items.length).toBe(12); // blip + 11

    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      const played: string[] = [];
      await playThroughDaemon(root, project, items, {}, {
        onItem: (label) => played.push(label),
      });
      expect(played).toHaveLength(12);
      await new Promise((r) => setImmediate(r)); // warnings are emitted async
      expect(warnings).not.toContain('MaxListenersExceededWarning');
    } finally {
      process.removeListener('warning', onWarning);
    }
  });

  it('an interrupt between load and play never starts the transport (#13 review)', async () => {
    await importTone('blop', 480000); // long enough that a leak would be obvious
    const items = await resolvePlayables(root, ['//songs/creek/assets:all']);

    // onItem fires after load, before play — exactly the window Bugbot
    // flagged: a ctrl-c here must not let play() restart the transport.
    let interrupted = false;
    const played: string[] = [];
    const positions: string[] = [];
    await playThroughDaemon(root, project, items, {}, {
      onItem: (label) => {
        played.push(label);
        interrupted = true;
      },
      onPosition: (line) => positions.push(line),
      interrupted: () => interrupted,
    });

    expect(played).toHaveLength(1); // the queue ended at the interrupt
    expect(positions).toHaveLength(0); // and playback never started
    const client = await AudiodClient.connect(root, { spawnIfNeeded: false });
    expect((await client.status()).state).toBe('stopped');
    client.close();
  });

  it('rejects --from with more than one target', async () => {
    await importTone('blop', 12000);
    const items = await resolvePlayables(root, ['//songs/creek/assets:all']);
    await expect(playThroughDaemon(root, project, items, { from: '1.2.1' }, {})).rejects.toThrow(
      '--from needs a single target',
    );
  });

  it('is steerable from a second connection: status, locate, stop', async () => {
    await importTone('long', 480000); // 10 s — the queue outlives the test body
    const items = await resolvePlayables(root, ['//songs/creek/assets:long']);
    const playing = playThroughDaemon(root, project, items, {}, {});

    // Wait until the transport reports playing.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = async () => {
        try {
          const lines = await transportStatusLines(root, project);
          if (lines[0]?.startsWith('playing')) return resolve();
        } catch {
          // daemon still starting
        }
        if (Date.now() > deadline) reject(new Error('never started playing'));
        else setTimeout(poll, 100);
      };
      void poll();
    });

    const lines = await transportStatusLines(root, project);
    expect(lines[0]).toMatch(/^playing {2}\d+\.\d+\.\d+ \(/);
    expect(lines[1]).toContain('songs/creek/audio/long.wav');

    // Bar 3 at 120 bpm = 8 beats = 192000 samples.
    expect(await transportLocate(root, project, '3.1.1')).toBe('3.1.1 (0:04.0)');

    await transportCommand(root, 'stop');
    await playing; // the blocking play sees 'stopped' and returns
  });

  it('transport without a daemon is a clear error', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'bloom-notransport-'));
    try {
      init({ dir: bare, name: 'bare' });
      await expect(transportStatusLines(bare, loadProject(bare))).rejects.toThrow(
        'bloom-audiod is not running',
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
