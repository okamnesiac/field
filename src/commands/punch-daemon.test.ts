import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import type { AudiodEvent, Take } from '../audiod/protocol.js';
import { compileSession } from '../graph/live.js';
import { loadProject } from '../model/project.js';
import { createSong, createTrack } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { playLiveSession } from './play.js';
import { passesNote, recordTake } from './record.js';

// Punch-out, the region loop, and loop takes (recording.md §10.4,
// chunk 4). The null clock's sawtooth (player.cpp) is what makes the
// loop handoff provable: consecutive takes must meet on consecutive
// steps of the input clock, or a sample was lost or repeated at the
// wrap.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const NULL_RATE = 48000;
const SAW_STEP = 2 / NULL_RATE;

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

function assertGapless(samples: Float32Array): void {
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]! - samples[i - 1]!;
    if (Math.abs(d - SAW_STEP) >= 1e-6 && Math.abs(d - (SAW_STEP - 2)) >= 1e-6) {
      throw new Error(`discontinuity at sample ${i}: ${samples[i - 1]} → ${samples[i]}`);
    }
  }
}

// Two takes meet on the input clock: the second's first sample is one
// step past the first's last, wrapping at the ramp's top.
function assertContinues(previous: Float32Array, next: Float32Array): void {
  const d = next[0]! - previous[previous.length - 1]!;
  expect(Math.abs(d - SAW_STEP) < 1e-6 || Math.abs(d - (SAW_STEP - 2)) < 1e-6).toBe(true);
}

describe('the loop line', () => {
  it('names the pass, and says how many passes were lost whenever any were', () => {
    expect(passesNote({})).toBe('');
    expect(passesNote({ loop: true, loop_takes: 0, missed: 0 })).toBe('  take 1');
    expect(passesNote({ loop: true, loop_takes: 5 })).toBe('  take 6');
    expect(passesNote({ loop: true, loop_takes: 5, missed: 1 })).toBe('  take 6, 1 pass missed');
    expect(passesNote({ loop: true, loop_takes: 7, missed: 2 })).toBe('  take 8, 2 passes missed');
  });
});

describe.skipIf(!binary)('punch-out and loop takes', () => {
  let root: string;

  beforeEach(async () => {
    process.env['FIELD_AUDIOD_NULL'] = '1';
    root = mkdtempSync(join(tmpdir(), 'field-punch-'));
    init({ dir: root, name: 'punch' });
    createSong(root, 'creek'); // 120 bpm 4/4: a beat is 24000 samples, a bar 96000
    const src = join(root, '..', `field-punch-bed-${Math.random()}.wav`);
    writeWavFloat32(src, NULL_RATE, [new Float32Array(NULL_RATE * 12).fill(0.1)]); // 12 s
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

  it('a region loop wraps the live session between its bounds, and clears', { timeout: 15_000 }, async () => {
    const client = await AudiodClient.connect(root, { nullOutput: true });
    try {
      expect(client.supports('loop-region')).toBe(true);
      expect(client.supports('record-until')).toBe(true);
      const { session } = await compileSession(root, 'creek');
      await client.session(session);
      await expect(client.loop(48000, 24000)).rejects.toThrow('0 <= from < to');
      await expect(client.loop(0, NULL_RATE * 100)).rejects.toThrow('past the session');
      // A half-second region from beat 2: positions stay inside it and
      // come back around.
      await client.loop(24000, 48000);
      let status = await client.status();
      expect(status.loop_from).toBe(24000);
      expect(status.loop_to).toBe(48000);
      expect(status.looping).toBe(true);
      await client.locate(24000);
      await client.play();
      const seen: number[] = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 1600) {
        seen.push((await client.status()).sample);
        await sleep(60);
      }
      expect(seen.every((s) => s >= 24000 && s < 48000)).toBe(true);
      expect(seen.some((s, i) => i > 0 && s < seen[i - 1]!)).toBe(true); // it wrapped
      expect((await client.status()).state).toBe('playing'); // and never finished
      await client.stop();
      await client.loop(); // clears
      status = await client.status();
      expect(status.loop_from).toBeUndefined();
      expect(status.looping).toBe(false);
      // A file bed has no region loop.
      await client.load(join(root, 'songs/creek/audio/bed/bed.wav'));
      await expect(client.loop(0, 1000)).rejects.toThrow('needs a live session');
    } finally {
      client.close();
    }
  });

  it('a punch-out ends the take on the exact sample while the transport rolls on', { timeout: 15_000 }, async () => {
    const client = await AudiodClient.connect(root, { nullOutput: true });
    const events: AudiodEvent[] = [];
    client.on('event', (e: AudiodEvent) => events.push(e));
    try {
      // Against the live session, whose positions are exact; a file
      // bed's transport position leads its output by the resampler's
      // prefetch (a few samples — recording.md §15), which is why the
      // song is the bed every record flow chooses.
      const { session } = await compileSession(root, 'creek');
      await client.session(session);
      await client.arm('//songs/creek/track:main', 1);
      await expect(client.record(48000, undefined, 24000)).rejects.toThrow('until must be after at');
      await expect(client.record(undefined, undefined, 24000)).rejects.toThrow('needs at');
      await client.record(48000, undefined, 72000); // half a second, beat 3 to beat 4
      expect((await client.status()).record?.until).toBe(72000);
      await waitFor(async () => (await client.status()).record?.state === 'armed', 5000, 'the take to end');
      const landed = events.find((e) => e.event === 'take');
      expect(landed?.event).toBe('take');
      const take = (landed as { take: Take }).take;
      expect(take.started_at_samples).toBe(48000);
      expect(take.frames).toBe(24000); // exactly until − at
      expect((await client.status()).state).toBe('playing'); // the mix played on
      const wav = readWav(join(root, take.file)).channels[0]!;
      expect(wav.length).toBe(24000);
      assertGapless(wav);
      await client.stop();
    } finally {
      client.close();
    }
  });

  it('a loop take lands one take per pass, gapless across the wrap', { timeout: 20_000 }, async () => {
    const client = await AudiodClient.connect(root, { nullOutput: true });
    const takes: Take[] = [];
    client.on('event', (e: AudiodEvent) => {
      if (e.event === 'take') takes.push(e.take);
    });
    try {
      await client.load(join(root, 'songs/creek/audio/bed/bed.wav'));
      await client.arm('//songs/creek/track:main', 1);
      await expect(client.record(24000, undefined, 48000, true)).rejects.toThrow('need a live session');
      const { session } = await compileSession(root, 'creek');
      await client.session(session);
      await client.arm('//songs/creek/track:main', 1);
      await expect(client.record(24000, undefined, undefined, true)).rejects.toThrow('needs until');
      // Beat 2 to beat 3, looping: every half second a take.
      await client.record(24000, undefined, 48000, true);
      let status = await client.status();
      expect(status.loop_from).toBe(24000);
      expect(status.loop_to).toBe(48000);
      expect(status.record).toMatchObject({ state: 'recording', loop: true, until: 48000 });
      await waitFor(async () => takes.length >= 3, 6000, 'three passes to land');
      status = await client.status();
      expect(status.record?.loop_takes).toBeGreaterThanOrEqual(3);
      expect(status.record?.missed).toBe(0);
      const partial = (await client.stop()).take!;
      // Every full pass is exactly the region long and starts at its top.
      for (const take of takes.slice(0, 3)) {
        expect(take.started_at_samples).toBe(24000);
        expect(take.frames).toBe(24000);
      }
      // The partial pass the stop ended is a take too, shorter than a pass.
      expect(partial.started_at_samples).toBe(24000);
      expect(partial.frames!).toBeLessThan(24000);
      // Gapless: each take is itself continuous, and consecutive takes
      // meet on consecutive steps of the input clock.
      const wavs = [...takes.slice(0, 3), partial].map((t) => readWav(join(root, t.file)).channels[0]!);
      for (const wav of wavs) assertGapless(wav);
      for (let i = 1; i < wavs.length; i++) assertContinues(wavs[i - 1]!, wavs[i]!);
      // The region was the take's: gone with it.
      expect((await client.status()).loop_from).toBeUndefined();
      expect((await client.status()).record?.state).toBe('armed');
      // No standby was left behind as an empty transaction: every
      // transaction on disk is a finalized take, and the stop's partial
      // one reached the event stream like the rest.
      expect(takes.at(-1)!.id).toBe(partial.id);
      const { recordings } = await client.recordings();
      expect(recordings.every((r) => r.complete)).toBe(true);
      expect(recordings).toHaveLength(takes.length);
    } finally {
      client.close();
    }
  });

  it('field record --until lands the take and stops; --loop lands one per pass until ctrl-c', { timeout: 30_000 }, async () => {
    createTrack(root, 'creek', 'lead-vocal');
    writeFileSync(
      join(root, 'songs/creek/tracks/lead-vocal.yaml'),
      ['name: lead-vocal', 'inputs:', '  - record:', ''].join('\n'),
    );
    const project = loadProject(root);
    await expect(recordTake(root, project, 'creek/track:lead-vocal', { loop: true }, {})).rejects.toThrow(
      '--loop needs --until',
    );
    await expect(recordTake(root, project, 'creek/track:lead-vocal', { until: '2' }, {})).rejects.toThrow(
      '--until needs --at',
    );

    // Punch-out: bar 1 beat 2 to bar 1 beat 4 lands exactly two beats
    // and the command returns on its own.
    const lines: string[] = [];
    const punched = await recordTake(
      root,
      project,
      'creek/track:lead-vocal',
      { input: 1, at: '1.2', until: '1.4' },
      { onStarted: (line) => lines.push(line) },
    );
    expect(lines[0]).toMatch(/^recording take-\S+ from 1\.2\.1 \(0:00\.5\) to 1\.4\.1 \(0:01\.5\)$/);
    expect(punched.takes).toHaveLength(1);
    expect(punched.takes[0]!.take.frames).toBe(48000);
    expect(punched.takes[0]!.landed.row.started_at_samples).toBe(24000);
    let client = await AudiodClient.connect(root, { spawnIfNeeded: false });
    expect((await client.status()).state).toBe('stopped');
    client.close();

    // Loop takes: a half-bar region, three passes, then ctrl-c.
    const landedLines: string[] = [];
    let interrupted = false;
    const looped = await recordTake(
      root,
      project,
      'creek/track:lead-vocal',
      { input: 1, at: '2.1', until: '2.3', loop: true },
      {
        onStarted: (line) => lines.push(line),
        onTake: (landed) => {
          landedLines.push(`${landed.asset} ${landed.row.started_at_samples} ${landed.frames}`);
          if (landedLines.length >= 3) interrupted = true;
        },
        interrupted: () => interrupted,
      },
    );
    expect(lines[1]).toMatch(/to 2\.3\.1 \(0:03\.0\), looping — a take per pass$/);
    expect(looped.missed).toBe(0); // a bar-long region is well past the daemon's tick
    // Three full passes and the partial one ctrl-c ended, all landed, all
    // at the region's top, the last one chosen.
    expect(looped.takes.length).toBeGreaterThanOrEqual(4);
    for (const { landed } of looped.takes) expect(landed.row.started_at_samples).toBe(96000);
    for (const { take } of looped.takes.slice(0, 3)) expect(take.frames).toBe(48000);
    const takesYaml = readFileSync(join(root, 'songs/creek/audio/lead-vocal/takes.yaml'), 'utf8');
    expect(takesYaml).toContain(`chosen: ${looped.takes.at(-1)!.landed.asset}\n`);
    expect(takesYaml.split('  - asset: ')).toHaveLength(looped.takes.length + 2); // + the punch-out take
    client = await AudiodClient.connect(root, { spawnIfNeeded: false });
    const status = await client.status();
    expect(status.state).toBe('stopped');
    expect(status.loop_from).toBeUndefined();
    expect(status.record?.state).toBe('idle');
    client.close();
  });

  it('field play <song> --from --loop is the region loop now, not a refusal', { timeout: 15_000 }, async () => {
    const project = loadProject(root);
    const samples: number[] = [];
    let interrupted = false;
    await playLiveSession(
      root,
      project,
      'creek',
      { from: '1.3', loop: true },
      {
        onPosition: (_line, at) => {
          if (at !== undefined) samples.push(at);
          if (samples.length >= 8) interrupted = true;
        },
        interrupted: () => interrupted,
      },
    );
    // Never before beat 3 (48000), and it came back around at least once
    // in two seconds of a bed that is twelve seconds long.
    expect(samples.every((s) => s >= 48000)).toBe(true);
    const client = await AudiodClient.connect(root, { spawnIfNeeded: false });
    expect((await client.status()).loop_from).toBeUndefined(); // cleared with the play
    client.close();
  });
});
