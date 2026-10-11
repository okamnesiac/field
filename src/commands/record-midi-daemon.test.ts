import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import { writeWavFloat32 } from '../audio/wav.js';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import { midiTakeLineSchema, midiTakeSchema, type AudiodEvent, type MidiTakeLine } from '../audiod/protocol.js';

// MIDI takes (keyboard-instrument.md §12.4) against the real daemon in
// null-output mode, with `field-audiod --keys` publishing the source
// they record. The probe for a MIDI service is `--keys` itself, as in
// src/keys/helper-native.test.ts: only a Linux machine without the ALSA
// sequencer may skip, and there the source list is reliably empty, so
// that is where arming with no source is refused.
//
// Arming for MIDI opens every source on the machine, so a controller or
// another test's helper can add messages to a take. The messages these
// tests send are on channel 16, note 7, which nothing else here plays,
// and the assertions about order and timing read those lines.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const NULL_RATE = 48000;
const NOTE_ON = [0x9f, 7, 77];
const NOTE_OFF = [0x8f, 7, 0];
const BLOCK_SLACK = 2048; // the null clock's 512-frame blocks, and scheduling
const TRACK = '//songs/creek/track:keys';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

interface Helper {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stderr: string;
  ended: boolean;
  closed: Promise<void>;
}

function isMine(line: MidiTakeLine): boolean {
  return (line.midi[0]! & 0x0f) === 0x0f && line.midi[1] === 7;
}

function readLines(root: string, file: string): MidiTakeLine[] {
  const text = readFileSync(join(root, file), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => midiTakeLineSchema.parse(JSON.parse(line)));
}

describe.skipIf(!binary)('MIDI takes through the daemon', () => {
  let root: string;
  const helpers: Helper[] = [];
  const daemons: number[] = [];
  const source = (what: string) => `Field Keys Capture ${process.pid} ${what}`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-record-midi-'));
  });

  // Every helper and daemon these tests started dies here, whatever the
  // test did, and only those.
  afterEach(async () => {
    const left = helpers.splice(0);
    for (const helper of left) if (!helper.ended) helper.child.kill('SIGKILL');
    await Promise.all(left.map((helper) => helper.closed));
    for (const pid of daemons.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function connect(): Promise<AudiodClient> {
    const client = await AudiodClient.connect(root, { nullOutput: true });
    daemons.push(client.pid!);
    return client;
  }

  // Publishes `name` with `--keys`. Resolves with the helper once it is
  // ready, or with why there is no MIDI service, which only a Linux
  // machine without the ALSA sequencer may say; anywhere else a helper
  // that cannot publish fails the test.
  async function publish(name: string): Promise<{ helper: Helper } | { unavailable: string }> {
    const child = spawn(binary!, ['--keys', name], { stdio: 'pipe' });
    const helper: Helper = {
      child,
      lines: [],
      stderr: '',
      ended: false,
      closed: new Promise((resolve) => child.on('close', () => resolve())),
    };
    child.on('close', () => {
      helper.ended = true;
    });
    child.on('error', (error) => {
      helper.stderr += String(error);
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk) => {
      helper.stderr += String(chunk);
    });
    createInterface({ input: child.stdout }).on('line', (line) => helper.lines.push(line));
    helpers.push(helper);

    // On macOS a keyboard layout report comes first, and can come again.
    let index = 0;
    const deadline = Date.now() + 5000;
    for (;;) {
      if (helper.lines.length > index) {
        const line = JSON.parse(helper.lines[index++]!) as Record<string, unknown>;
        if ('keyboard' in line) continue;
        if ('error' in line && process.platform === 'linux' && !existsSync('/dev/snd/seq')) {
          return {
            unavailable:
              `no MIDI service: this Linux machine has no ALSA sequencer at /dev/snd/seq, ` +
              `and --keys said ${JSON.stringify(line['error'])}`,
          };
        }
        expect(line).toMatchObject({ ready: true, name });
        return { helper };
      }
      if (helper.ended) throw new Error(`--keys exited before it was ready; stderr: ${helper.stderr}`);
      if (Date.now() > deadline) throw new Error(`--keys was not ready in 5 s; stderr: ${helper.stderr}`);
      await sleep(10);
    }
  }

  async function publishOrSkip(ctx: TestContext, name: string): Promise<Helper> {
    const published = await publish(name);
    if ('unavailable' in published) {
      console.warn(`skipping a MIDI take test: ${published.unavailable}`);
      ctx.skip(published.unavailable);
    }
    return (published as { helper: Helper }).helper;
  }

  function send(helper: Helper, bytes: number[]): number {
    helper.child.stdin.write(`${JSON.stringify({ midi: bytes })}\n`);
    return performance.now();
  }

  // A source another process publishes takes a moment to reach this
  // one's list, so arm until it is there.
  async function armListing(client: AudiodClient, name: string) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const armed = await client.armMidi(TRACK);
      if (armed.sources.includes(name)) return armed;
      if (Date.now() > deadline) throw new Error(`${name} never appeared among ${armed.sources.join(', ')}`);
      await sleep(100);
    }
  }

  it('advertises record-midi', async () => {
    const client = await connect();
    try {
      expect(client.supports('record-midi')).toBe(true);
    } finally {
      client.close();
    }
  });

  it(
    'records a source on the sample clock, with no audio fields, and finalizes on stop',
    { timeout: 20_000 },
    async (ctx) => {
      const name = source('take');
      const keys = await publishOrSkip(ctx, name);
      const client = await connect();
      const events: AudiodEvent[] = [];
      client.on('event', (e: AudiodEvent) => events.push(e));
      try {
        const armed = await armListing(client, name);
        expect(armed).toMatchObject({ ok: true, kind: 'midi', sample_rate: NULL_RATE, output_latency: 0 });
        expect((await client.status()).record).toEqual({
          state: 'armed',
          track: TRACK,
          kind: 'midi',
          sources: armed.sources,
          input_peak: 0,
        });

        const recordCalled = performance.now();
        const started = await client.record();
        const recordReturned = performance.now();
        expect(started.file).toBe(`.field/recording/${started.transaction}/take.midi.ndjson`);
        expect(started.started_at_samples).toBeGreaterThanOrEqual(0);

        await sleep(200);
        const onSent = send(keys, NOTE_ON);
        await sleep(500);
        const offSent = send(keys, NOTE_OFF);
        await waitFor(
          () => readLines(root, started.file).filter(isMine).length === 2,
          3000,
          'both messages to reach the file',
        );
        const mid = (await client.status()).record!;
        expect(mid).toMatchObject({ state: 'recording', kind: 'midi', input_peak: 0, pending: false, dropped: 0 });
        expect(mid.events).toBeGreaterThanOrEqual(2);
        expect(mid.frames).toBeGreaterThan(0);
        expect(mid.written).toBeUndefined();

        const stopCalled = performance.now();
        const stopped = await client.stop();
        const stopReturned = performance.now();
        const take = midiTakeSchema.parse(stopped.take);
        expect(take).toMatchObject({
          id: started.transaction,
          file: started.file,
          track: TRACK,
          kind: 'midi',
          sources: armed.sources,
          sample_rate: NULL_RATE,
          output_latency: 0,
          started_at_samples: started.started_at_samples,
          complete: true,
          dropped: 0,
        });
        expect(take.timeline_rate).toBeUndefined(); // no bed: a free-running take
        for (const audio of ['device', 'input', 'channels', 'bit_depth', 'format', 'input_latency']) {
          expect(stopped.take).not.toHaveProperty(audio);
        }
        // Samples from the latch, inside record, to the detach, inside stop.
        const ms = (from: number, to: number) => ((to - from) * NULL_RATE) / 1000;
        expect(take.frames).toBeGreaterThanOrEqual(ms(recordReturned, stopCalled) - BLOCK_SLACK);
        expect(take.frames).toBeLessThanOrEqual(ms(recordCalled, stopReturned) + BLOCK_SLACK);

        const lines = readLines(root, take.file);
        expect(take.events).toBe(lines.length);
        const ats = lines.map((line) => line.at);
        expect(ats).toEqual([...ats].sort((a, b) => a - b));
        expect(ats.every((at) => at < take.frames!)).toBe(true);
        const [on, off] = lines.filter(isMine);
        expect([on!.midi, off!.midi]).toEqual([NOTE_ON, NOTE_OFF]);
        // Each `at` is where the clock was when its message arrived:
        // the note-on lands where it was sent, counted from the take's
        // start, and the gap between the two is the half second slept.
        expect(on!.at).toBeGreaterThanOrEqual(ms(recordReturned, onSent) - BLOCK_SLACK);
        expect(on!.at).toBeLessThanOrEqual(ms(recordCalled, onSent) + BLOCK_SLACK);
        expect(off!.at - on!.at).toBeGreaterThanOrEqual(24000 - BLOCK_SLACK);
        expect(Math.abs(off!.at - on!.at - ms(onSent, offSent))).toBeLessThanOrEqual(BLOCK_SLACK);

        await waitFor(() => events.some((e) => e.event === 'take'), 2000, 'the take event');
        const landed = events.find((e) => e.event === 'take');
        expect(landed?.event === 'take' && landed.take).toEqual(stopped.take);
        const journal = JSON.parse(readFileSync(join(root, '.field/recording', take.id, 'journal.json'), 'utf8'));
        expect(journal).toMatchObject({ frames: take.frames, events: take.events, dropped: 0 });
        const { recordings } = await client.recordings();
        expect(recordings).toEqual([
          expect.objectContaining({
            id: take.id,
            kind: 'midi',
            complete: true,
            active: false,
            frames_on_disk: 0,
            events_on_disk: take.events,
          }),
        ]);

        // An audio arm moves the arm back off MIDI, and disarm releases it.
        await client.arm(TRACK, 1);
        expect((await client.status()).record).toEqual({
          state: 'armed',
          track: TRACK,
          device: 'null',
          input: 1,
          input_peak: expect.any(Number),
        });
        await client.disarm();
        expect((await client.status()).record).toEqual({ state: 'idle' });
      } finally {
        client.close();
      }
    },
  );

  it(
    'ends at until, leaves out what comes after it, and refuses a loop take',
    { timeout: 20_000 },
    async (ctx) => {
      const name = source('until');
      const keys = await publishOrSkip(ctx, name);
      const bed = join(root, 'bed.wav');
      writeWavFloat32(bed, NULL_RATE, [new Float32Array(NULL_RATE * 5)]);
      const client = await connect();
      const events: AudiodEvent[] = [];
      client.on('event', (e: AudiodEvent) => events.push(e));
      try {
        await client.load(bed);
        await armListing(client, name);
        await expect(client.record(0, undefined, 24000, true)).rejects.toThrow('loop takes record audio only');

        const started = await client.record(0, undefined, 24000);
        expect(started.started_at_samples).toBe(0);
        send(keys, NOTE_ON);
        await waitFor(() => events.some((e) => e.event === 'take'), 3000, 'the take to end at until');
        send(keys, NOTE_OFF);
        await sleep(300);
        const landed = events.find((e) => e.event === 'take');
        const take = midiTakeSchema.parse(landed?.event === 'take' ? landed.take : undefined);
        expect(take).toMatchObject({ id: started.transaction, started_at_samples: 0, frames: 24000, timeline_rate: NULL_RATE });
        expect(take.source).toBe(bed);
        const lines = readLines(root, take.file);
        expect(lines.filter(isMine).map((line) => line.midi)).toEqual([NOTE_ON]);
        expect(lines.every((line) => line.at < 24000)).toBe(true);
        expect((await client.status()).state).toBe('playing'); // the bed played on
        await client.stop();
      } finally {
        client.close();
      }
    },
  );

  it(
    'a daemon killed mid-take leaves whole lines, and recover drops a partial last one',
    { timeout: 20_000 },
    async (ctx) => {
      const name = source('recover');
      const keys = await publishOrSkip(ctx, name);
      const client = await connect();
      let file = '';
      try {
        await armListing(client, name);
        const started = await client.record();
        file = started.file;
        send(keys, NOTE_ON);
        // Past at least one journal sync (the writer syncs once a second).
        await sleep(1200);
        send(keys, NOTE_OFF);
        await waitFor(() => readLines(root, file).filter(isMine).length === 2, 3000, 'both messages to reach the file');
        process.kill(client.pid!, 'SIGKILL');
      } finally {
        client.close();
      }
      await waitFor(
        () => {
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

      const id = file.split('/')[2]!;
      const dir = join(root, '.field/recording', id);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      expect(manifest).toMatchObject({ id, kind: 'midi', complete: false });
      expect(manifest['started_at_samples']).toBeGreaterThanOrEqual(0); // on disk before the crash
      const journal = JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8')) as { frames: number; events: number };
      expect(journal.frames).toBeGreaterThan(0);
      const whole = readLines(root, file);
      // What a crash in the middle of a write leaves behind.
      appendFileSync(join(root, file), '{"at":12');

      const fresh = await connect();
      try {
        expect(readFileSync(join(root, '.field/audiod.log'), 'utf8')).toContain(
          `recoverable take ${id} (${whole.length} MIDI messages on disk)`,
        );
        const { recordings } = await fresh.recordings();
        expect(recordings.find((r) => r.id === id)).toMatchObject({
          kind: 'midi',
          complete: false,
          active: false,
          frames_on_disk: 0,
          events_on_disk: whole.length,
        });

        const { take } = await fresh.recover(id);
        const recovered = midiTakeSchema.parse(take);
        expect(recovered).toMatchObject({ id, kind: 'midi', complete: true, recovered: true, events: whole.length });
        expect(recovered.journaled_frames).toBe(journal.frames);
        expect(recovered.journaled_events).toBe(journal.events);
        expect(recovered.frames).toBeGreaterThanOrEqual(Math.max(journal.frames, whole.at(-1)!.at + 1));
        expect(readFileSync(join(root, file), 'utf8').endsWith('}\n')).toBe(true);
        expect(readLines(root, file)).toEqual(whole);
        expect(whole.filter(isMine).map((line) => line.midi)).toEqual([NOTE_ON, NOTE_OFF]);
        await expect(fresh.recover(id)).rejects.toThrow('already complete');
      } finally {
        fresh.close();
      }
    },
  );

  it('refuses to arm for MIDI where there is no MIDI source', { timeout: 20_000 }, async (ctx) => {
    const published = await publish(source('probe'));
    if ('helper' in published) {
      const reason =
        'this machine has a MIDI service, whose sources a test cannot remove; ' +
        'the refusal runs where there is none (Linux without /dev/snd/seq)';
      console.warn(`skipping the no-source case: ${reason}`);
      ctx.skip(reason);
    }
    const client = await connect();
    try {
      await expect(client.armMidi(TRACK)).rejects.toThrow(
        'no MIDI sources to record from: start field keys or connect a controller first',
      );
      expect((await client.status()).record).toEqual({ state: 'idle' });
    } finally {
      client.close();
    }
  });
});
