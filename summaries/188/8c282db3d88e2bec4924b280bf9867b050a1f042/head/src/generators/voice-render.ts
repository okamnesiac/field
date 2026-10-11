import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseDocument } from 'yaml';
import { sha256File } from '../hash.js';
import { notesFileSchema, renderEvents } from '../schema/notes.js';
import { instrumentProgram, runScProgram, scScript } from './supercollider.js';
import type { Generator } from './types.js';

// voice-render: a recorded MIDI take rendered offline through the record
// entry's instrument (keyboard-instrument.md §12.3). The graph mints one
// for a record entry with an instrument whose chosen take is a notes
// file. sc/voice-render.scd loads the instrument's voice and drives it
// with sc/voicer.scd, the voicing the live host plays with, so the take
// renders as it sounded while it was played.
export interface VoiceRenderSpec {
  name: string;
  type: 'voice-render';
  take: string; // the notes file's name in the song's ledger
  instrument: string; // resolves as field keys resolves an instrument
}

// Rendered past the take's end, so the last notes' release is heard. A
// fixed tail rather than one per instrument: the voice contract carries no
// release time.
export const RELEASE_TAIL_SECONDS = 4;

const HARNESS = ['voice-render.scd', 'voice-load.scd', 'voicer.scd'];

export const voiceRenderGenerator: Generator<VoiceRenderSpec> = {
  version: 2, // 2: a zero-length note releases after its own on
  wiringFields: ['take'],

  sources(spec) {
    return [spec.take];
  },

  // The supercollider rule's path checks, on the program the instrument
  // names: normalized, inside the project, and a regular file.
  validate(spec, ctx) {
    const program = instrumentProgram(spec.instrument);
    if (program !== posix.normalize(program) || program.includes('\\')) {
      ctx.push(`instrument path not in normalized form: ${spec.instrument}`);
      return;
    }
    const resolved = ctx.resolveFile('', program); // project-relative
    if (resolved.problem) ctx.push(`instrument ${resolved.problem}`);
  },

  // The instrument and Field's own harness both decide the sound, so
  // editing any of them re-renders the take.
  async extraInputs(root, spec) {
    const program = instrumentProgram(spec.instrument);
    return [
      { label: program, sha256: await sha256File(join(root, program)) },
      ...(await Promise.all(HARNESS.map(async (name) => ({ label: `sc/${name}`, sha256: await sha256File(scScript(name)) })))),
    ];
  },

  async execute(spec, inputPaths, outputPath, ctx) {
    const notes = notesFileSchema.parse(parseDocument(readFileSync(inputPaths[0]!, 'utf8')).toJS());
    const eventsPath = `${outputPath}.events.json`;
    writeFileSync(eventsPath, JSON.stringify({ events: renderEvents(notes) }));
    try {
      await runScProgram(scScript('voice-render.scd'), outputPath, {
        seed: 0,
        duration: notes.length / notes.sample_rate + RELEASE_TAIL_SECONDS,
        channels: 2,
        sampleRate: ctx.sampleRate,
        env: {
          FIELD_MODE: 'voice',
          FIELD_INSTRUMENT: join(ctx.root, instrumentProgram(spec.instrument)),
          FIELD_EVENTS: eventsPath,
        },
      });
    } finally {
      rmSync(eventsPath, { force: true });
    }
    if (!existsSync(outputPath)) {
      throw new Error(`rendering ${spec.take} through ${spec.instrument} wrote no audio`);
    }
  },

  async verifyAfterRun(root, spec, extraInputs) {
    const after = await sha256File(join(root, instrumentProgram(spec.instrument)));
    if (after !== extraInputs[0]!.sha256) {
      throw new Error(`refusing to cache: ${spec.instrument} changed during the render — re-run the build`);
    }
  },
};
