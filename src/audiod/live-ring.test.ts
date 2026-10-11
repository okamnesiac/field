import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { compileSession } from '../graph/live.js';
import { nrtScore, oscBundle, oscMessage, synthDefFile } from '../keys/synthdef.js';
import { removeTempProject } from '../testing/temp.js';
import { AudiodClient, daemonBinary } from './client.js';

// The ring between FieldOut and the daemon (live-supercollider.md
// chunk 2): the daemon's own check of its reader against the writer
// FieldOut runs, the input ops, a session reading an open ring, and,
// where scsynth and the built plugin are here, FieldOut itself writing
// into a ring the daemon made.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const execFileAsync = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fieldOutDir = join(repo, 'native/sc-fieldout/build/plugins');
const fieldOutBuilt = ['FieldOut.scx', 'FieldOut.so'].some((name) => existsSync(join(fieldOutDir, name)));
const scsynth = [
  {
    bin: '/Applications/SuperCollider.app/Contents/Resources/scsynth',
    plugins: '/Applications/SuperCollider.app/Contents/Resources/plugins',
  },
  { bin: '/usr/bin/scsynth', plugins: '/usr/lib/SuperCollider/plugins' },
  { bin: '/usr/local/bin/scsynth', plugins: '/usr/local/lib/SuperCollider/plugins' },
].find((c) => existsSync(c.bin) && existsSync(c.plugins));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A song whose voice has nothing on it, under a main of one bar: the
// shape an input window goes on.
function scaffold(root: string): void {
  init({ dir: root, name: 'live-ring' });
  createSong(root, 'monitor');
  createTrack(root, 'monitor', 'voice');
  writeFileSync(join(root, 'songs/monitor/tracks/voice.yaml'), 'name: voice\ninputs: []\n');
  writeFileSync(join(root, 'songs/monitor/tracks/main.yaml'), 'name: main\ninputs:\n  - track: voice\n');
  writeFileSync(
    join(root, 'songs/monitor/song.yaml'),
    'name: monitor\ntime:\n  tempo:\n    - at: 0\n      bpm: 120\n  meter:\n    - at: 0\n      numerator: 4\n      denominator: 4\nlength: [1]\n',
  );
}

describe.skipIf(!binary || process.platform === 'win32')('the live input ring (live-supercollider.md chunk 2)', () => {
  let root: string;
  let client: AudiodClient | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-live-ring-'));
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

  it("holds the reader to the writer FieldOut runs: steady, through a gap, against a fast writer, and with nothing reading", async () => {
    const { stdout } = await execFileAsync(binary!, ['--ring-selftest']);
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  });

  it('opens and closes an input, reports it in status, and refuses what it cannot do', async () => {
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    expect(client.supports('live-input')).toBe(true);
    const opened = await client.openInput('mic');
    expect(opened).toMatchObject({ name: 'mic', capacity: 8192, channels: 2, sample_rate: 48000 });
    expect(opened.ring).toBeGreaterThan(0);
    expect(opened.ring).toBeLessThan(2 ** 24);
    await expect(client.openInput('mic')).rejects.toThrow('input "mic" is already open');
    await expect(client.openInput('')).rejects.toThrow('input needs a name');
    expect((await client.status()).inputs).toEqual([
      { name: 'mic', ring: opened.ring, written: 0, read: 0, dropped: 0, underruns: 0, skipped: 0 },
    ]);
    await client.closeInput('mic');
    expect((await client.status()).inputs).toBeUndefined();
    await expect(client.closeInput('mic')).rejects.toThrow('no input named "mic"');
  });

  it('loads a session whose input window names an open input, and refuses one that names none', async () => {
    scaffold(root);
    const { session } = await compileSession(root, 'monitor', { inputs: [{ track: 'voice', input: 'mic' }] });
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    await expect(client.session(session)).rejects.toThrow('session names input "mic", which nothing feeds');
    await client.openInput('mic');
    await client.session(session);
    await client.play();
    await sleep(300);
    const playing = await client.status();
    expect(playing.state).toBe('playing');
    // Nothing writes the ring, so the reader waits to fill and never
    // runs dry.
    expect(playing.inputs).toEqual([expect.objectContaining({ name: 'mic', read: 0, underruns: 0 })]);
    // The session still holds the ring, so closing it frees only the name.
    await client.closeInput('mic');
    expect((await client.status()).state).toBe('playing');
  });

  it.skipIf(!scsynth || !fieldOutBuilt)(
    'FieldOut writes into the ring the daemon made, and a playing session reads it',
    { timeout: 30_000 },
    async () => {
      scaffold(root);
      client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
      const { ring, capacity } = await client.openInput('mic');

      // A second of a sine at 440 Hz into FieldOut, in scsynth's
      // non-realtime mode: nothing reads while it renders, so the ring
      // fills and the rest counts as dropped.
      const def = synthDefFile({
        name: 'field-ring-test',
        params: [{ name: 'ring', value: 0 }],
        ugens: [
          { name: 'Control', rate: 'control', inputs: [], outputs: ['control'] },
          { name: 'SinOsc', rate: 'audio', inputs: [{ constant: 440 }, { constant: 0 }], outputs: ['audio'] },
          { name: 'BinaryOpUGen', rate: 'audio', special: 2, inputs: [{ ugen: 1 }, { constant: 0.25 }], outputs: ['audio'] },
          { name: 'FieldOut', rate: 'audio', inputs: [{ ugen: 0 }, { ugen: 2 }, { ugen: 2 }], outputs: [] },
        ],
      });
      writeFileSync(
        join(root, 'score.osc'),
        nrtScore([
          oscBundle(0, [
            oscMessage('/d_recv', def),
            oscMessage('/s_new', 'field-ring-test', 1000, 0, 0, 'ring', { float: ring }),
          ]),
          // Freed before the score ends: at shutdown scsynth unloads its
          // plugins before it frees the synths still running, so a
          // FieldOut left running would call a destructor that is gone.
          oscBundle(1, [oscMessage('/n_free', 1000), oscMessage('/c_set', 0, 0)]),
        ]),
      );
      const { stdout } = await execFileAsync(
        scsynth!.bin,
        ['-N', 'score.osc', '_', 'out.aiff', '48000', 'AIFF', 'int16', '-o', '2', '-U', `${scsynth!.plugins}:${fieldOutDir}`],
        { cwd: root },
      );
      expect(stdout).not.toContain('FieldOut: ring');
      const filled = (await client.status()).inputs![0]!;
      expect(filled).toMatchObject({ written: capacity, dropped: 48000 - capacity, read: 0 });

      // Played, the session's input window reads it. The ring filled and
      // FieldOut dropped what did not fit, so what it holds is the past:
      // the reader skips all of it and starts at the present.
      const { session } = await compileSession(root, 'monitor', { inputs: [{ track: 'voice', input: 'mic' }] });
      await client.session(session);
      await client.play();
      let read = filled;
      for (let i = 0; i < 40 && read.read < capacity; i++) {
        await sleep(100);
        read = (await client.status()).inputs![0]!;
      }
      expect(read.read).toBe(capacity);
      expect(read.skipped).toBe(capacity);
      expect(read.underruns).toBe(0);
    },
  );
});
