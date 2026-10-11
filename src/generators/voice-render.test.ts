import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWavHeader } from '../audio/wav.js';
import type { MidiTake } from '../audiod/protocol.js';
import { buildLabels, explainLabel } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { landMidiTake } from '../commands/land.js';
import type { GeneratorRunner } from '../graph/build.js';
import { RELEASE_TAIL_SECONDS } from './voice-render.js';

// A recorded MIDI take in the build (keyboard-instrument.md §12.3): the
// graph mints a voice-render node for the record entry, keyed on the
// notes file, the instrument, and Field's own harness, and the track
// places its render where the take was played.

let root: string;
const GEN = '//songs/creek/gen:keys';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'field-voice-render-'));
  init({ dir: root, name: 'voices' });
  createSong(root, 'creek');
  createTrack(root, 'creek', 'keys');
  writeFileSync(join(root, 'shared/instruments/pad.scd'), VOICE);
  writeFileSync(join(root, 'songs/creek/tracks/keys.yaml'), 'name: keys\ninputs:\n  - record: { instrument: pad }\n');
  await landMidiTake(root, midiTransaction());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Half a second of take at 48 kHz: an A held for a quarter second, then
// a C still held when the take stopped.
function midiTransaction(): MidiTake {
  const id = 'take-20261010-120000';
  const dir = join(root, '.field', 'recording', id);
  mkdirSync(dir, { recursive: true });
  const lines = [
    { at: 0, midi: [144, 69, 100] },
    { at: 12000, midi: [128, 69, 0] },
    { at: 12000, midi: [144, 72, 80] },
  ];
  writeFileSync(join(dir, 'take.midi.ndjson'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const take: MidiTake = {
    id,
    file: `.field/recording/${id}/take.midi.ndjson`,
    track: '//songs/creek/track:keys',
    kind: 'midi',
    sources: ['Field Keys'],
    sample_rate: 48000,
    output_latency: 0,
    started_at_samples: 0,
    started_wall: '2026-10-10T12:00:00.000-04:00',
    daemon: '0.14.0',
    complete: true,
    frames: 24000,
    events: lines.length,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(take));
  return take;
}

// A voice under the contract field keys plays (keyboard-instrument.md
// §4): a SynthDef with freq, amp, gate, and out that frees itself when
// the gate closes.
const VOICE = `(
SynthDef(\\fieldTestVoice, { |freq = 440, amp = 0.5, gate = 1, out = 0|
	var env = EnvGen.kr(Env.asr(0.01, 1, 0.05), gate, doneAction: 2);
	Out.ar(out, (SinOsc.ar(freq) * amp * 0.2 * env) ! 2);
});
)
`;

describe('voice-render in the graph', () => {
  it('mints a render node keyed on the notes, the instrument, and the harness', async () => {
    const e = await explainLabel(root, GEN);
    expect(e.rule).toBe('voice-render');
    expect(e.inputs.map((i) => i.label)).toEqual([
      '//songs/creek/asset:take-20261010-120000',
      'shared/instruments/pad.scd',
      'sc/voice-render.scd',
      'sc/voicer.scd',
    ]);
  });

  it('renders once, caches, and re-renders when the instrument changes', async () => {
    let runs = 0;
    const runner: GeneratorRunner = async (_node, inputPaths, outputPath) => {
      runs++;
      copyFileSync(inputPaths[0]!, outputPath);
    };
    await buildLabels(root, [GEN], runner);
    await buildLabels(root, [GEN], runner);
    expect(runs).toBe(1);
    writeFileSync(join(root, 'shared/instruments/pad.scd'), VOICE.replace('0.05', '0.1'));
    await buildLabels(root, [GEN], runner);
    expect(runs).toBe(2);
  });
});

// buildLabels reports every node it walked, dependencies first.
const built = <T extends { label: string }>(outcomes: T[], label: string): T => outcomes.find((o) => o.label === label)!;

const sclangPresent =
  existsSync('/Applications/SuperCollider.app/Contents/MacOS/sclang') ||
  (process.env['PATH'] ?? '').split(':').some((p) => p !== '' && existsSync(join(p, 'sclang')));

describe.skipIf(!sclangPresent)('voice-render through real sclang', () => {
  it('renders the take with its release tail, the same bytes every time', { timeout: 120_000 }, async () => {
    const first = built(await buildLabels(root, [GEN]), GEN);
    const header = readWavHeader(first.outputPath!);
    expect(header.channels).toBe(2);
    // scsynth writes whole control blocks in NRT, so a render runs up to
    // one block (64 samples) past its duration, as every sc-render does.
    const frames = 24000 + RELEASE_TAIL_SECONDS * 48000;
    expect(header.frames).toBeGreaterThanOrEqual(frames);
    expect(header.frames).toBeLessThanOrEqual(frames + 64);
    expect(readFileSync(first.outputPath!).subarray(44).some((b) => b !== 0)).toBe(true);

    rmSync(join(root, '.field/cache'), { recursive: true, force: true });
    const again = built(await buildLabels(root, [GEN]), GEN);
    expect(again.cached).toBe(false);
    expect(again.sha256).toBe(first.sha256);

    // The track builds over the render, where the take was played.
    const track = built(await buildLabels(root, ['//songs/creek/track:keys']), '//songs/creek/track:keys');
    expect(existsSync(track.outputPath!)).toBe(true);
  });
});
