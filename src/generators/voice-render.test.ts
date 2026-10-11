import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, readWavHeader } from '../audio/wav.js';
import type { MidiTake } from '../audiod/protocol.js';
import { buildLabels, explainLabel } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { landMidiTake } from '../commands/land.js';
import type { GeneratorRunner } from '../graph/build.js';
import { withTakes } from '../graph/graph.js';
import { genRef } from '../labels.js';
import { loadProject } from '../model/project.js';
import { TempoMap } from '../time/tempo.js';
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
  writeFileSync(join(root, 'songs/creek/tracks/keys.yaml'), 'name: keys\ninputs:\n  - record:\n      instrument: pad\n');
  await landMidiTake(root, midiTransaction());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Half a second of take at 48 kHz: an A held for a quarter second, then
// a C still held when the take stopped.
const HELD = [
  { at: 0, midi: [144, 69, 100] },
  { at: 12000, midi: [128, 69, 0] },
  { at: 12000, midi: [144, 72, 80] },
];

function midiTransaction(id = 'take-20261010-120000', placed: Partial<MidiTake> = {}, lines = HELD): MidiTake {
  const dir = join(root, '.field', 'recording', id);
  mkdirSync(dir, { recursive: true });
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
    ...placed,
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
      'sc/voice-load.scd',
      'sc/voicer.scd',
    ]);
  });

  it('places the render where the take was played, less the output latency', async () => {
    // Half a second into the track, with 128 samples of output latency:
    // the render starts 128 samples earlier, where the player heard it.
    await landMidiTake(root, midiTransaction('take-20261010-120100', { started_at_samples: 24000, output_latency: 128 }));
    const song = loadProject(root).songs.find((s) => s.name === 'creek')!;
    const track = song.tracks.find((t) => t.data.name === 'keys')!.data;
    const placed = withTakes(track, song, new TempoMap(song.time!.tempo, 48000), 48000, () => 48000);
    expect(placed.inputs).toEqual([
      expect.objectContaining({ audio: genRef('keys'), anchor: 'absolute', at: 24000 - 128, source_offset: 0 }),
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

  it('passes a take\'s mod wheel to a voice that has the control', { timeout: 120_000 }, async () => {
    // A voice whose level is the mod wheel: silent at 0, sounding at 1.
    writeFileSync(
      join(root, 'shared/instruments/pad.scd'),
      VOICE.replace('|freq = 440, amp = 0.5, gate = 1, out = 0|', '|freq = 440, amp = 0.5, gate = 1, out = 0, mod = 0|').replace(
        '* amp * 0.2 * env',
        '* amp * 0.2 * mod * env',
      ),
    );
    const peak = async (): Promise<number> => {
      const wav = readWav(built(await buildLabels(root, [GEN]), GEN).outputPath!);
      return wav.channels[0]!.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
    };
    expect(await peak()).toBe(0); // the take beforeEach landed sends no CC 1
    await landMidiTake(
      root,
      midiTransaction('take-20261010-120300', {}, [
        { at: 0, midi: [176, 1, 127] },
        { at: 100, midi: [144, 69, 100] },
        { at: 12000, midi: [128, 69, 0] },
      ]),
    );
    expect(await peak()).toBeGreaterThan(0.05);
  });

  it('loads the instrument without the render variables, as voice mode is live', { timeout: 120_000 }, async () => {
    const strict = VOICE.replace(
      '(\n',
      '(\nif ("FIELD_OUTPUT FIELD_SEED FIELD_DURATION FIELD_SAMPLE_RATE FIELD_CHANNELS".split($ ).any { |name| name.getenv.notNil }) { Error("a render variable is set in voice mode").throw };\n',
    );
    expect(strict).not.toBe(VOICE);
    writeFileSync(join(root, 'shared/instruments/pad.scd'), strict);
    const outcome = built(await buildLabels(root, [GEN]), GEN);
    expect(existsSync(outcome.outputPath!)).toBe(true);
  });
});
