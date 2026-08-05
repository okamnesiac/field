import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWavFloat32 } from '../audio/wav.js';
import { AudiodClient, daemonBinary } from './client.js';
import type { AudiodEvent } from './protocol.js';

// Protocol tests against the real daemon in null-output mode: the null
// clock pulls the transport at real-time pace, so spawn, handshake, load,
// transport, position events, end-of-stream, and idle lifecycle all behave
// exactly as against a device — CI needs no audio hardware, only the built
// binary (pnpm build:native).
const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

describe('event schema', () => {
  it('parses device events (the hardware-follow path emits them)', async () => {
    const { eventSchema } = await import('./protocol.js');
    const parsed = eventSchema.parse({ event: 'device', name: 'Volt 176', sample_rate: 48000 });
    expect(parsed).toEqual({ event: 'device', name: 'Volt 176', sample_rate: 48000 });
  });
});

describe.skipIf(!binary)('bloom-audiod protocol', () => {
  let root: string;
  let client: AudiodClient;

  beforeEach(async () => {
    // No .bloom/ pre-created: a project that has never built must still
    // spawn the daemon (#12 review P3) — the client owns the mkdir.
    root = mkdtempSync(join(tmpdir(), 'bloom-audiod-'));
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
  });

  afterEach(async () => {
    if (client) {
      try {
        await client.quit();
      } catch {
        // already gone
      }
      client.close();
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('handshakes, lists devices in null mode, and reports empty status', async () => {
    expect(client.daemonVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const devices = await client.devices();
    expect(devices.null_output).toBe(true);
    expect(devices.devices).toEqual([]);

    const status = await client.status();
    expect(status.state).toBe('stopped');
    expect(status.path).toBeNull();
    expect(status.samples).toBe(0);
  });

  it('loads, plays to the end, and emits state and position events', async () => {
    const wav = join(root, 'tone.wav');
    // Half a second at the null clock's 48 kHz.
    writeWavFloat32(wav, 48000, [new Float32Array(24000), new Float32Array(24000)]);

    const loaded = await client.load(wav);
    expect(loaded).toMatchObject({ samples: 24000, sample_rate: 48000, channels: 2 });

    const events: AudiodEvent[] = [];
    client.on('event', (e: AudiodEvent) => events.push(e));

    await client.play();
    const playing = await client.status();
    expect(playing.state).toBe('playing');
    expect(playing.resampling).toBe(false);

    // Natural end: the daemon stops itself and broadcasts the transition.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (events.some((e) => e.event === 'state' && e.state === 'stopped')) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
    expect(events.some((e) => e.event === 'state' && e.state === 'playing')).toBe(true);
    expect(events.some((e) => e.event === 'position' && e.sample > 0)).toBe(true);

    const done = await client.status();
    expect(done.state).toBe('stopped');
    expect(done.sample).toBe(0); // stop rewinds
  });

  it('pauses, locates by sample, and rejects out-of-range locates', async () => {
    const wav = join(root, 'tone.wav');
    writeWavFloat32(wav, 48000, [new Float32Array(480000)]); // 10 s mono
    await client.load(wav);

    await client.play();
    await client.pause();
    expect((await client.status()).state).toBe('paused');

    await client.locate(240000);
    const located = await client.status();
    expect(located.sample).toBe(240000);

    await expect(client.locate(480001)).rejects.toThrow('out of range');
    await expect(client.locate(-1)).rejects.toThrow('out of range');
  });

  it('serves a second client against the same daemon', async () => {
    const wav = join(root, 'tone.wav');
    writeWavFloat32(wav, 48000, [new Float32Array(480000)]);
    await client.load(wav);
    await client.play();

    // The "bloom transport from another terminal" scenario (§3.6).
    const second = await AudiodClient.connect(root, { spawnIfNeeded: false });
    const status = await second.status();
    expect(status.state).toBe('playing');
    await second.pause();
    expect((await client.status()).state).toBe('paused');
    second.close();
  });

  it('shuts down cleanly under concurrent requests (#12 review P2)', async () => {
    // The reviewer's probe: one client hammers status while another sends
    // quit. A request landing in the shutdown window must resolve or
    // reject — never hang — and the daemon must actually exit.
    const second = await AudiodClient.connect(root, { spawnIfNeeded: false });
    const hammer = (async () => {
      for (let i = 0; i < 500; i++) {
        try {
          await client.status();
        } catch {
          return; // connection closed by shutdown: fine
        }
      }
    })();
    await second.quit();
    second.close();
    await hammer; // a hang here fails the test by timeout

    // The daemon is gone: nobody answers the socket anymore.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = async () => {
        try {
          const probe = await AudiodClient.connect(root, { spawnIfNeeded: false });
          probe.close();
          if (Date.now() > deadline) reject(new Error('daemon still answering after quit'));
          else setTimeout(poll, 100);
        } catch {
          resolve();
        }
      };
      void poll();
    });
  });

  it('survives a stampede of concurrent first connections (#12 review)', async () => {
    // Several CLIs racing to spawn the daemon on a fresh project: the
    // flock decides a single winner, losers exit, and every client ends
    // up served by the survivor.
    const fresh = mkdtempSync(join(tmpdir(), 'bloom-audiod-race-'));
    try {
      const clients = await Promise.all(
        Array.from({ length: 6 }, () =>
          AudiodClient.connect(fresh, { nullOutput: true, idleSeconds: 60 }),
        ),
      );
      const statuses = await Promise.all(clients.map((c) => c.status()));
      expect(statuses.every((s) => s.state === 'stopped')).toBe(true);
      await clients[0]!.quit();
      for (const c of clients) c.close();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('refuses to load garbage and reports unknown ops', async () => {
    await expect(client.load(join(root, 'missing.wav'))).rejects.toThrow('cannot read');
    await expect(
      client.request('dance', {}, (await import('./protocol.js')).okResponseSchema),
    ).rejects.toThrow('unknown op');
    await expect(client.play()).rejects.toThrow('nothing loaded');
  });
});
