import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWavFloat32 } from '../audio/wav.js';
import { buildLabels } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { compileSession, diffSessions } from '../graph/live.js';
import { watchLiveSession } from '../commands/watch-live.js';
import { AudiodClient, daemonBinary } from './client.js';
import type { Session } from './session.js';

// Chunk 2's definition of correct (realtime.md decision 3 at graph
// level): a non-looping session rendered by the live engine is
// byte-identical to the offline stem the same graph builds. Looping
// playback is deliberately not byte-comparable — the offline fold is a
// post-chain addition, the live wrap is tails ringing through chain
// state — so the golden compares one non-looping pass.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const execFileAsync = promisify(execFile);

// A project exercising the window and chain surface: a placed track
// (twice, with pan and fades), a file clip, a pre-tap cable, and a
// main chain of all three effects within the live limiter's horizon.
async function scaffold(root: string): Promise<void> {
  init({ dir: root, name: 'live-golden' });
  createSong(root, 'opener');

  const tone = join(tmpdir(), `live-tone-${process.pid}.wav`);
  const frames = 24000;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / 48000);
    right[i] = 0.4 * Math.sin((2 * Math.PI * 330 * i) / 48000);
  }
  writeWavFloat32(tone, 48000, [left, right]);
  await importAsset(root, 'opener', tone, 'tone');
  rmSync(tone);

  createTrack(root, 'opener', 'voice');
  writeFileSync(
    join(root, 'songs/opener/tracks/voice.yaml'),
    [
      'name: voice',
      'sends:',
      '  wash:',
      '    gain_db: -12',
      '    tap: pre',
      'inserts:',
      '  - effect: eq',
      '    normalize: false',
      '    bands:',
      '      - type: bell',
      '        frequency: 900',
      '        gain_db: 3',
      '        bandwidth: 1.5',
      // A limiter on a child: its stream lag must not shift the summed
      // timeline (the comp_delay double-compensation Codex caught).
      '  - effect: limit',
      '    ceiling_db: -2',
      '    lookahead_ms: 3',
      '    release_ms: 60',
      'inputs:',
      '  - audio: tone',
      '    anchor: absolute',
      '    at: 0',
      '',
    ].join('\n'),
  );
  createTrack(root, 'opener', 'wash');
  writeFileSync(
    join(root, 'songs/opener/tracks/wash.yaml'),
    [
      'name: wash',
      'inserts:',
      '  - effect: reverb',
      '    mix: 0.5',
      '    decay: 0.4',
      '    predelay_ms: 5',
      '    damping: 0.4',
      'inputs:',
      '  - receive: wash',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'songs/opener/tracks/main.yaml'),
    [
      'name: main',
      'inserts:',
      '  - effect: limit',
      '    ceiling_db: -1',
      '    lookahead_ms: 5',
      '    release_ms: 80',
      'inputs:',
      '  - track: voice',
      '    anchor: absolute',
      '    at: 0',
      '    fade_in: 480',
      '  - track: voice',
      '    anchor: absolute',
      '    at: 30000',
      '    gain_db: -6',
      '    pan: 0.4',
      '    fade_out: 960',
      '  - track: wash',
      '    anchor: absolute',
      '    at: 0',
      '',
    ].join('\n'),
  );
  // A declared extent, unlooped: the one pass the golden compares.
  writeFileSync(
    join(root, 'songs/opener/song.yaml'),
    [
      'name: opener',
      'time:',
      '  tempo:',
      '    - at: 0',
      '      bpm: 120',
      '  meter:',
      '    - at: 0',
      '      numerator: 4',
      '      denominator: 4',
      'length: 72000',
      '',
    ].join('\n'),
  );
}

function wavData(path: string): Buffer {
  const bytes = readFileSync(path);
  const at = bytes.indexOf('data');
  const size = bytes.readUInt32LE(at + 4);
  return bytes.subarray(at + 8, at + 8 + size);
}

describe.skipIf(!binary)('live session (realtime.md chunk 2)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-live-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('renders a non-looping session byte-identically to the offline stem', async () => {
    await scaffold(root);
    const offline = await buildLabels(root, ['//songs/opener/track:main']);
    const artifact = offline.find((o) => o.label.endsWith('track:main'))!.outputPath!;

    const { session } = await compileSession(root, 'opener');
    const sessionPath = join(root, 'session.json');
    writeFileSync(sessionPath, JSON.stringify(session));
    const livePath = join(root, 'live.wav');
    await execFileAsync(binary!, ['--render-live', sessionPath, livePath], { cwd: root });

    const live = wavData(livePath);
    const stem = wavData(artifact);
    expect(live.length).toBe(stem.length);
    expect(live.equals(stem)).toBe(true);
  });

  it('loads, plays, ramps, and locates a session over the socket', async () => {
    await scaffold(root);
    const { session } = await compileSession(root, 'opener');

    const client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    try {
      expect(client.supports('session')).toBe(true);
      expect(client.supports('swap')).toBe(true);
      const loaded = await client.session(session);
      // 72000 ticks at 120 bpm resolve through the tempo map: 75 beats
      // of half a second at 48 kHz.
      expect(loaded.samples).toBe(1_800_000);
      expect(loaded.sample_rate).toBe(48000);

      await client.play();
      await new Promise((r) => setTimeout(r, 300));
      const playing = await client.status();
      expect(playing.state).toBe('playing');
      expect(playing.live).toBe(true);
      expect(playing.sample).toBeGreaterThan(0);

      await client.ramp('main', 0, -9, 10);
      await client.locate(0);
      await client.stop();
      const stopped = await client.status();
      expect(stopped.state).toBe('stopped');
      expect(stopped.sample).toBe(0);
    } finally {
      try {
        await client.quit();
      } catch {
        // already gone
      }
      client.close();
    }
  });

  it('classifies edits: gain moves ramp, structure swaps', async () => {
    await scaffold(root);
    const { session: before } = await compileSession(root, 'opener');

    const mainPath = join(root, 'songs/opener/tracks/main.yaml');
    const mainYaml = readFileSync(mainPath, 'utf8');
    writeFileSync(mainPath, mainYaml.replace('gain_db: -6', 'gain_db: -12'));
    const { session: gained } = await compileSession(root, 'opener');
    const rampEdit = diffSessions(before, gained);
    expect(rampEdit).toEqual({
      kind: 'ramps',
      ramps: [{ track: 'main', input: 2, gain_db: -12 }],
    });

    writeFileSync(mainPath, mainYaml.replace('at: 30000', 'at: 36000'));
    const { session: moved } = await compileSession(root, 'opener');
    expect(diffSessions(before, moved)).toEqual({ kind: 'swap' });
    writeFileSync(mainPath, mainYaml);

    // An edited chain is structural even when the edited field is
    // spelled gain_db — an eq band's gain is not the mixer surface
    // (minjudd's finding: a name-keyed mask classified this `same` and
    // the edit never reached the daemon in either direction).
    const voicePath = join(root, 'songs/opener/tracks/voice.yaml');
    const voiceYaml = readFileSync(voicePath, 'utf8');
    writeFileSync(voicePath, voiceYaml.replace('gain_db: 3', 'gain_db: 6'));
    const { session: chained } = await compileSession(root, 'opener');
    expect(diffSessions(before, chained)).toEqual({ kind: 'swap' });

    // A window gain on a non-output track swaps too: children bake
    // their gains into buffers pre-rendered at load, so a ramp there
    // would report success and change nothing (Codex's finding).
    writeFileSync(voicePath, voiceYaml.replace('    at: 0', '    at: 0\n    gain_db: -3'));
    const { session: childGained } = await compileSession(root, 'opener');
    expect(diffSessions(before, childGained)).toEqual({ kind: 'swap' });

    expect(diffSessions(before, before)).toEqual({ kind: 'same' });
  });

  it('a session swap carries the transport (realtime.md chunk 3)', async () => {
    await scaffold(root);
    const { session } = await compileSession(root, 'opener');
    const client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    try {
      await client.session(session);
      await client.play();
      await new Promise((r) => setTimeout(r, 300));
      const before = await client.status();
      expect(before.state).toBe('playing');

      // A structural edit recompiles and swaps; the play never stops
      // and the position carries — the loop-wrap wait this chunk
      // retires. The edit is real (a moved placement, minjudd's
      // finding): a copy of the playing session would pass these
      // assertions even if loadSession ignored its argument.
      const mainPath = join(root, 'songs/opener/tracks/main.yaml');
      writeFileSync(
        mainPath,
        readFileSync(mainPath, 'utf8').replace('at: 30000', 'at: 36000'),
      );
      const { session: swapped } = await compileSession(root, 'opener');
      expect(diffSessions(session, swapped)).toEqual({ kind: 'swap' });
      await client.session(swapped);
      const after = await client.status();
      expect(after.state).toBe('playing');
      expect(after.sample).toBeGreaterThanOrEqual(before.sample);
      // Strictly-greater (a stopped transport satisfies >=, minjudd's
      // finding) — but only once the callback lands a block after the
      // swap, so poll briefly instead of racing its cadence.
      let later = after;
      for (let i = 0; i < 40 && later.sample <= before.sample; i++) {
        await new Promise((r) => setTimeout(r, 50));
        later = await client.status();
      }
      expect(later.state).toBe('playing');
      expect(later.sample).toBeGreaterThan(before.sample);
      await client.stop();
    } finally {
      try {
        await client.quit();
      } catch {
        // already gone
      }
      client.close();
    }
  });

  it('the authored loop is the fold; the transport loop is the flag; the extent is finite', async () => {
    await scaffold(root);
    const songPath = join(root, 'songs/opener/song.yaml');
    const songYaml = readFileSync(songPath, 'utf8');

    // `loop: true` in song.yaml shapes the render — the fold, one
    // seamless pass (clip-looping.md) — and never reaches the
    // transport; repetition is the --loop flag (Codex's finding: a
    // bare play of a declared-loop song repeated forever).
    writeFileSync(songPath, songYaml.replace('length: 72000', 'length: 72000\nloop: true'));
    const declared = await compileSession(root, 'opener');
    expect(declared.session.loop).toBeUndefined();
    expect(declared.session.length_samples).toBe(1_800_000);
    const forced = await compileSession(root, 'opener', { loop: true });
    expect(forced.session.loop).toBe(true);

    // No declared extent: the session bounds itself at the output's
    // natural length — content end plus chain growth, where the
    // artifact ends — instead of playing silence forever (Codex's
    // finding).
    writeFileSync(songPath, songYaml.replace('length: 72000\n', ''));
    const natural = await compileSession(root, 'opener');
    expect(natural.session.length_samples).toBeGreaterThanOrEqual(54000);
  });

  it('the cache is the freeze (realtime.md chunk 4)', async () => {
    await scaffold(root);
    // Cold cache: nothing freezes. The output can never freeze and
    // voice feeds a pre-tap cable; wash is the one candidate, dirty.
    const cold = await compileSession(root, 'opener');
    expect(cold.dirty).toEqual(['//songs/opener/track:wash']);
    expect(cold.session.tracks.find((t) => t.name === 'wash')!.chain.length).toBeGreaterThan(0);

    // One build later the same compile serves wash as its cached stem —
    // one file window at unity, no chain — and reports nothing dirty.
    await buildLabels(root, ['//songs/opener/track:main']);
    const warm = await compileSession(root, 'opener');
    expect(warm.dirty).toEqual([]);
    const wash = warm.session.tracks.find((t) => t.name === 'wash')!;
    expect(wash.chain).toEqual([]);
    expect(wash.inputs).toHaveLength(1);
    expect(wash.inputs[0]).toMatchObject({ start: 0, read_offset: 0, gain_db: 0 });
    expect('file' in wash.inputs[0]!).toBe(true);
    // A pre-tapped sender stays live even when clean: its stem is
    // post-chain, and the cable reads the pre ring.
    expect(warm.session.tracks.find((t) => t.name === 'voice')!.chain.length).toBeGreaterThan(0);
    // Freeze and thaw are structural, so the watch swaps them.
    expect(diffSessions(cold.session, warm.session)).toEqual({ kind: 'swap' });

    // The decision-4 golden: the frozen session renders byte-identically
    // to the offline artifact — the swap between cached and live is
    // inaudible because there is no difference to hear.
    const offline = await buildLabels(root, ['//songs/opener/track:main']);
    const artifact = offline.find((o) => o.label.endsWith('track:main'))!.outputPath!;
    const sessionPath = join(root, 'frozen-session.json');
    writeFileSync(sessionPath, JSON.stringify(warm.session));
    const livePath = join(root, 'frozen-live.wav');
    await execFileAsync(binary!, ['--render-live', sessionPath, livePath], { cwd: root });
    expect(wavData(livePath).equals(wavData(artifact))).toBe(true);
  });

  it('the watch rebuilds dirty stems behind the play and freezes them', async () => {
    await scaffold(root);
    const baseline = await compileSession(root, 'opener');
    expect(baseline.dirty).toEqual(['//songs/opener/track:wash']);

    const abort = new AbortController();
    const froze: string[][] = [];
    const swaps: Session[] = [];
    const done = watchLiveSession(
      root,
      'opener',
      baseline,
      { debounceMs: 50, signal: abort.signal },
      {
        onEdit: (edit, session) => {
          if (edit.kind === 'swap') swaps.push(session);
        },
        onFroze: (labels) => froze.push(labels),
      },
    );
    // The refreeze starts with the watch: wash's stem builds in the
    // background, and the compile that follows swaps the frozen form in.
    const deadline = Date.now() + 30_000;
    while ((froze.length === 0 || swaps.length === 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    abort.abort();
    await done;
    expect(froze).toEqual([['//songs/opener/track:wash']]);
    const last = swaps.at(-1)!;
    expect(last.tracks.find((t) => t.name === 'wash')!.chain).toEqual([]);
    expect(last.tracks.find((t) => t.name === 'voice')!.chain.length).toBeGreaterThan(0);
  });
});
