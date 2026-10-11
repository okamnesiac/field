import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { compileSession } from '../graph/live.js';
import { removeTempProject } from '../testing/temp.js';
import { AudiodClient, daemonBinary } from './client.js';
import type { ArmTrack } from './protocol.js';

// Host monitoring (live-supercollider.md §12): an armed audio input that
// a session's input window reads, so the track it records on is heard
// through its effects. The null clock's input 1 is a sawtooth that
// reaches full scale every second, and its input 2 a constant 0.25.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A track with nothing on it, under a main of one bar: the shape an input
// window goes on.
function scaffold(root: string): void {
  init({ dir: root, name: 'live-monitor' });
  createSong(root, 'monitor');
  createTrack(root, 'monitor', 'voice');
  writeFileSync(join(root, 'songs/monitor/tracks/voice.yaml'), 'name: voice\ninputs: []\n');
  writeFileSync(join(root, 'songs/monitor/tracks/main.yaml'), 'name: main\ninputs:\n  - track: voice\n');
  writeFileSync(
    join(root, 'songs/monitor/song.yaml'),
    'name: monitor\ntime:\n  tempo:\n    - at: 0\n      bpm: 120\n  meter:\n    - at: 0\n      numerator: 4\n      denominator: 4\nlength: [1]\n',
  );
}

describe.skipIf(!binary || process.platform === 'win32')('host monitoring (live-supercollider.md §12)', () => {
  let root: string;
  let client: AudiodClient | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-live-monitor-'));
  });
  afterEach(async () => {
    if (client !== undefined) {
      try {
        await client.quit();
      } catch {
        // already gone
      }
      client.close();
      client = undefined;
    }
    await removeTempProject(root);
  });

  it('reads an armed input whole, in the steps a loop wrap makes, past its block, and closed', async () => {
    const { stdout } = await execFileAsync(binary!, ['--capture-selftest']);
    expect(stdout.trim()).toBe('{"ok":true}');
  });

  it('plays a monitored input through its track, stopped and playing, until disarm closes it', { timeout: 20_000 }, async () => {
    scaffold(root);
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    expect(client.supports('live-monitor')).toBe(true);
    const armed = await client.armTracks([{ track: '//songs/monitor/track:voice', kind: 'audio', input: 1, monitor: 'capture:monitor/voice' }]);
    expect(armed.armed).toEqual([{ track: '//songs/monitor/track:voice', kind: 'audio', input: 1, monitor: 'capture:monitor/voice' }]);
    expect((await client.status()).inputs).toEqual([{ name: 'capture:monitor/voice', kind: 'capture', read: 0, peak: 0 }]);

    const { session } = await compileSession(root, 'monitor', { inputs: [{ track: 'voice', input: 'capture:monitor/voice' }] });
    await client.session(session);
    // Stopped: the idle path hears the sawtooth over silence.
    await sleep(1200);
    const stopped = (await client.status()).inputs![0]!;
    expect(stopped.read).toBeGreaterThan(24000);
    expect(stopped.peak).toBeGreaterThan(0.9);
    // Playing: the song's own render hears it, block for block.
    await client.play();
    await sleep(1200);
    const playing = (await client.status()).inputs![0]!;
    expect(playing.read).toBeGreaterThan(stopped.read + 24000);
    expect(playing.peak).toBeGreaterThan(0.9);

    // Disarming closes it; the session holding it plays on, reading
    // silence until the song is loaded again without it.
    await client.disarm();
    expect((await client.status()).inputs).toBeUndefined();
    await sleep(200);
    expect((await client.status()).state).toBe('playing');
  });

  it("stops monitoring with the connection that armed it, and keeps another connection's", { timeout: 20_000 }, async () => {
    scaffold(root);
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    const arming = await AudiodClient.connect(root, { spawnIfNeeded: false });
    await arming.armTracks([{ track: '//songs/monitor/track:voice', kind: 'audio', input: 2, monitor: 'capture:monitor/voice' }]);
    expect((await client.status()).inputs?.map((i) => i.name)).toEqual(['capture:monitor/voice']);
    arming.close();
    let inputs = (await client.status()).inputs;
    for (let i = 0; i < 50 && inputs !== undefined; i++) {
      await sleep(20);
      inputs = (await client.status()).inputs;
    }
    expect(inputs).toBeUndefined();
    // The arm itself stays, as it did before monitoring existed.
    expect((await client.status()).record?.state).toBe('armed');
    await client.disarm();
  });

  it('refuses to monitor a MIDI track, one name twice, or a name an input already has', async () => {
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    // What the types forbid, the daemon refuses too.
    await expect(
      client.armTracks([{ track: '//songs/monitor/track:keys', kind: 'midi', monitor: 'capture:monitor/keys' } as ArmTrack]),
    ).rejects.toThrow('//songs/monitor/track:keys records MIDI, which has no input to monitor');
    await expect(
      client.armTracks([
        { track: '//songs/monitor/track:voice', kind: 'audio', input: 1, monitor: 'capture:monitor/voice' },
        { track: '//songs/monitor/track:choir', kind: 'audio', input: 2, monitor: 'capture:monitor/voice' },
      ]),
    ).rejects.toThrow('two tracks are monitored as "capture:monitor/voice"');
    await client.openInput('capture:monitor/voice');
    await expect(
      client.armTracks([{ track: '//songs/monitor/track:voice', kind: 'audio', input: 1, monitor: 'capture:monitor/voice' }]),
    ).rejects.toThrow('input "capture:monitor/voice" is already open');
    await client.closeInput('capture:monitor/voice');
    await client.armTracks([{ track: '//songs/monitor/track:voice', kind: 'audio', input: 1, monitor: 'capture:monitor/voice' }]);
    await expect(client.openInput('capture:monitor/voice')).rejects.toThrow('input "capture:monitor/voice" is already open');
    await client.disarm();
  });
});
