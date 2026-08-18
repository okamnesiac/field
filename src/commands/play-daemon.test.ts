import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWavFloat32 } from '../audio/wav.js';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import { loadProject, type LoadedProject } from '../model/project.js';
import { createSong } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { playThroughDaemon, resolvePlayables } from './play.js';
import { transportCommand, transportLocate, transportStatusLines } from './transport.js';
import { removeTempProject } from '../testing/temp.js';

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

describe.skipIf(!binary)('field play through the daemon', () => {
  let root: string;
  let project: LoadedProject;

  async function importTone(name: string, samples: number): Promise<void> {
    const src = join(root, '..', `field-play-${name}-${Math.random()}.wav`);
    writeWavFloat32(src, 48000, [new Float32Array(samples).fill(0.1)]);
    await importAsset(root, 'creek', src, name);
    rmSync(src);
  }

  beforeEach(async () => {
    process.env['FIELD_AUDIOD_NULL'] = '1';
    root = mkdtempSync(join(tmpdir(), 'field-playd-'));
    init({ dir: root, name: 'test-album' });
    createSong(root, 'creek'); // 120 bpm 4/4: one beat = 24000 samples
    await importTone('blip', 12000); // 0.25 s
    project = loadProject(root);
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

  it('plays a queue in order, streaming positions', async () => {
    await importTone('blop', 12000);
    const items = await resolvePlayables(root, ['//songs/creek/asset:all']);
    expect(items.map((i) => i.label)).toEqual([
      '//songs/creek/asset:blip',
      '//songs/creek/asset:blop',
    ]);

    const played: string[] = [];
    const positions: string[] = [];
    await playThroughDaemon(root, project, items, {}, {
      onItem: (label) => played.push(label),
      onPosition: (line) => positions.push(line),
    });
    expect(played).toEqual(items.map((i) => i.label));
    expect(positions.length).toBeGreaterThan(0);
    expect(positions[0]).toMatch(/^\d+\.\d+$/); // bar.beat, beat-gated, CLI-side
  });

  it(
    '--loop with one target loops in the daemon: positions outlive the file',
    { timeout: 10_000 },
    async () => {
      await importTone('spin', 60000); // 1.25 s = 2.5 beats: beat changes keep coming
      const items = await resolvePlayables(root, ['//songs/creek/asset:spin']);

      // Gapless native loop: one load, one play, and beat-gated position
      // updates keep arriving well past the file's real-time length until
      // ctrl-c. Event-driven, not clock-driven (a fixed window was
      // CI-flaky): the 4th beat change is >1.5 s of streaming — a
      // non-looping 1.25 s file stops mid third beat and can never get
      // there, whether or not the looping reader wraps its position.
      const played: string[] = [];
      const positions: string[] = [];
      let interrupted = false;
      await playThroughDaemon(root, project, items, { loop: true }, {
        onItem: (label) => played.push(label),
        onPosition: (line) => {
          positions.push(line);
          if (positions.length === 4 && !interrupted) {
            interrupted = true;
            void AudiodClient.connect(root, { spawnIfNeeded: false }).then(async (c) => {
              await c.stop();
              c.close();
            });
          }
        },
        interrupted: () => interrupted,
      });
      expect(played).toEqual([items[0]!.label]); // one load — no reload gap
      expect(positions.length).toBeGreaterThanOrEqual(4);
    },
  );

  it('a sub-beat loop keeps the readout alive (#37 review: dedupe on movement, not text)', { timeout: 20_000 }, async () => {
    await importTone('tick', 9600); // 0.2 s: shorter than a beat, so the line never changes
    const items = await resolvePlayables(root, ['//songs/creek/asset:tick']);

    // Every wrap re-announces "1.1" with a smaller `at`; a text-keyed
    // dedupe froze this readout after one line. Event-driven: without
    // the dedupe fix the count stays at 1 and the test times out.
    //
    // "1.1" is now also the *only* line this loop can produce. Beat 2
    // sits 300-500 ms past a 0.2 s file, so the scheduler declines to
    // schedule it at all; before the bound it stayed permanently
    // pending, unfired only because each anchor cleared the timer, and
    // an anchor >50 ms late let a phantom "1.2" through on a loaded
    // runner (#37 review, which recorded this assertion as more than
    // the code then guaranteed — the bound is what earns it).
    const positions: string[] = [];
    const recurrences = () => positions.filter((p) => p === '1.1').length;
    let interrupted = false;
    await playThroughDaemon(root, project, items, { loop: true }, {
      onPosition: (line) => {
        positions.push(line);
        if (recurrences() >= 3 && !interrupted) {
          interrupted = true;
          void AudiodClient.connect(root, { spawnIfNeeded: false }).then(async (c) => {
            await c.stop();
            c.close();
          });
        }
      },
      interrupted: () => interrupted,
    });
    expect(recurrences()).toBeGreaterThanOrEqual(3);
    expect([...new Set(positions)]).toEqual(['1.1']); // no beat the file never reaches
  });

  it('--loop with several targets replays the queue until interrupted', async () => {
    await importTone('blop', 12000);
    const items = await resolvePlayables(root, ['//songs/creek/asset:all']);
    expect(items).toHaveLength(2); // 2+ items: the CLI-requeue path, not native loop

    const played: string[] = [];
    let interrupted = false;
    await playThroughDaemon(root, project, items, { loop: true }, {
      onItem: (label) => {
        played.push(label);
        if (played.length === 3) interrupted = true; // mid second pass
      },
      interrupted: () => interrupted,
    });
    expect(played).toEqual([items[0]!.label, items[1]!.label, items[0]!.label]);
  });

  it('--from + --loop repeats the region: requeue path, never native (#23 review)', async () => {
    await importTone('tone', 36000); // 0.75 s
    const items = await resolvePlayables(root, ['//songs/creek/asset:tone']);

    // The daemon's native wrap returns to sample 0, not the locate point,
    // so a region audition must take the requeue path — every pass locates
    // again and no position ever falls before the region start.
    const samples: number[] = [];
    const client = await AudiodClient.connect(root, { nullOutput: true });
    client.on('event', (e: { event: string; sample?: number }) => {
      if (e.event === 'position' && e.sample !== undefined) samples.push(e.sample);
    });
    const played: string[] = [];
    let interrupted = false;
    await playThroughDaemon(root, project, items, { from: '1.2.1', loop: true }, {
      onItem: (label) => {
        played.push(label);
        if (played.length === 2) interrupted = true; // two region passes
      },
      interrupted: () => interrupted,
    });
    client.close();
    expect(played).toHaveLength(2); // reloaded per pass — the requeue path
    expect(samples.length).toBeGreaterThan(0);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(24000); // never before beat 2
  });

  it('--from projects musical time to a locate before playing', async () => {
    await importTone('tone', 36000); // 0.75 s
    const items = await resolvePlayables(root, ['//songs/creek/asset:tone']);

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
    const items = await resolvePlayables(root, ['//songs/creek/asset:all']);
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
    const items = await resolvePlayables(root, ['//songs/creek/asset:all']);

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
    const items = await resolvePlayables(root, ['//songs/creek/asset:all']);
    await expect(playThroughDaemon(root, project, items, { from: '1.2.1' }, {})).rejects.toThrow(
      '--from needs a single target',
    );
  });

  it('is steerable from a second connection: status, locate, stop', async () => {
    await importTone('long', 480000); // 10 s — the queue outlives the test body
    const items = await resolvePlayables(root, ['//songs/creek/asset:long']);
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
    expect(lines[1]).toContain(['songs', 'creek', 'audio', 'long', 'long.wav'].join(sep));

    // Bar 3 at 120 bpm = 8 beats = 192000 samples.
    expect(await transportLocate(root, project, '3.1.1')).toBe('3.1.1 (0:04.0)');

    await transportCommand(root, 'stop');
    await playing; // the blocking play sees 'stopped' and returns
  });

  it('locates in the played file\'s rate, not the project\'s', { timeout: 10_000 }, async () => {
    // A 44.1 kHz asset in this 48 kHz project: beat 2 at 120 bpm is
    // 0.5 s — sample 22050 of the file the daemon is streaming. Before
    // the fix, --from and transport locate projected through the
    // manifest rate and seeked to 24000, an eighth-note late (#112
    // review, Codex). The formatted answer cannot catch this — parsing
    // and formatting at the same wrong rate cancels — so the assertion
    // is the daemon's own sample position.
    const src = join(root, '..', `field-play-441-${Math.random()}.wav`);
    writeWavFloat32(src, 44100, [new Float32Array(441000).fill(0.1)]); // 10 s
    await importAsset(root, 'creek', src, 'wide', { allowMismatch: true });
    rmSync(src);
    project = loadProject(root);
    const items = await resolvePlayables(root, ['//songs/creek/asset:wide']);
    const playing = playThroughDaemon(root, project, items, {}, {});

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

    await transportCommand(root, 'pause');
    expect(await transportLocate(root, project, '1.2.1')).toBe('1.2.1 (0:00.5)');
    const client = await AudiodClient.connect(root, { spawnIfNeeded: false });
    expect((await client.status()).sample).toBe(22050);
    client.close();

    await transportCommand(root, 'stop');
    await playing;
  });

  it('transport without a daemon is a clear error', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'field-notransport-'));
    try {
      init({ dir: bare, name: 'bare' });
      await expect(transportStatusLines(bare, loadProject(bare))).rejects.toThrow(
        'field-audiod is not running',
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
