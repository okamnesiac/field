import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { formatNotesFile, notesFileSchema, notesFromMessages, renderEvents } from './notes.js';

describe('pairing captured messages into notes', () => {
  it('pairs each note-on with its note-off, by channel and note', () => {
    const file = notesFromMessages(
      [
        { at: 0, midi: [144, 60, 100] },
        { at: 12000, midi: [145, 60, 90] },
        { at: 24000, midi: [128, 60, 0] },
        { at: 30000, midi: [129, 60, 0] },
      ],
      48000,
      48000,
    );
    expect(file.notes).toEqual([
      { at: 0, length: 24000, note: 60, velocity: 100 },
      { at: 12000, length: 18000, note: 60, velocity: 90, channel: 2 },
    ]);
  });

  it('takes a note-on with velocity 0 as a note-off', () => {
    const file = notesFromMessages([{ at: 0, midi: [144, 62, 80] }, { at: 100, midi: [144, 62, 0] }], 200, 48000);
    expect(file.notes).toEqual([{ at: 0, length: 100, note: 62, velocity: 80 }]);
  });

  it('ends a sounding note when the same note starts again', () => {
    const file = notesFromMessages(
      [
        { at: 0, midi: [144, 60, 100] },
        { at: 500, midi: [144, 60, 70] },
        { at: 900, midi: [128, 60, 0] },
      ],
      1000,
      48000,
    );
    expect(file.notes).toEqual([
      { at: 0, length: 500, note: 60, velocity: 100 },
      { at: 500, length: 400, note: 60, velocity: 70 },
    ]);
  });

  it('lets a note held at the end last to the end, and drops a note-off with no note-on', () => {
    const file = notesFromMessages([{ at: 10, midi: [128, 64, 0] }, { at: 100, midi: [144, 67, 90] }], 1000, 48000);
    expect(file.notes).toEqual([{ at: 100, length: 900, note: 67, velocity: 90 }]);
  });

  it('keeps controller changes and bends, and ignores other messages', () => {
    const file = notesFromMessages(
      [
        { at: 5, midi: [176, 64, 127] },
        { at: 6, midi: [224, 0, 96] },
        { at: 7, midi: [177, 1, 51] },
        { at: 8, midi: [192, 3] },
        { at: 9, midi: [248] },
      ],
      10,
      44100,
    );
    expect(file).toEqual({
      sample_rate: 44100,
      length: 10,
      notes: [],
      controls: [
        { at: 5, cc: 64, value: 127 },
        { at: 7, cc: 1, value: 51, channel: 2 },
      ],
      bends: [{ at: 6, value: 96 << 7 }],
    });
  });
});

describe('the notes file', () => {
  const file = notesFromMessages(
    [
      { at: 0, midi: [144, 60, 100] },
      { at: 12000, midi: [145, 64, 90] },
      { at: 24000, midi: [128, 60, 0] },
      { at: 30000, midi: [176, 64, 127] },
      { at: 50000, midi: [224, 0, 96] },
    ],
    60000,
    48000,
  );

  it('writes one row per note, in a fixed key order', () => {
    expect(formatNotesFile(file)).toBe(
      [
        'sample_rate: 48000',
        'length: 60000',
        'notes:',
        '  - { at: 0, length: 24000, note: 60, velocity: 100 }',
        '  - { at: 12000, length: 48000, note: 64, velocity: 90, channel: 2 }',
        'controls:',
        '  - { at: 30000, cc: 64, value: 127 }',
        'bends:',
        '  - { at: 50000, value: 12288 }',
        '',
      ].join('\n'),
    );
  });

  it('reads back as the file it was written from', () => {
    expect(notesFileSchema.parse(parseDocument(formatNotesFile(file)).toJS())).toEqual(file);
  });

  it('writes an empty take', () => {
    const empty = notesFromMessages([], 480, 48000);
    expect(formatNotesFile(empty)).toBe('sample_rate: 48000\nlength: 480\nnotes: []\ncontrols: []\nbends: []\n');
    expect(notesFileSchema.parse(parseDocument(formatNotesFile(empty)).toJS())).toEqual(empty);
  });
});

describe('render events', () => {
  it('puts every event in time order in seconds, offs before controls before ons at one instant', () => {
    const file = notesFileSchema.parse({
      sample_rate: 48000,
      length: 96000,
      notes: [
        { at: 0, length: 24000, note: 60, velocity: 100 },
        { at: 24000, length: 24000, note: 60, velocity: 90 },
      ],
      controls: [{ at: 24000, cc: 64, value: 127 }],
      bends: [{ at: 48000, value: 8192, channel: 3 }],
    });
    expect(renderEvents(file)).toEqual([
      [0, 'on', 0, 60, 100],
      [0.5, 'off', 0, 60],
      [0.5, 'cc', 0, 64, 127],
      [0.5, 'on', 0, 60, 90],
      [1, 'off', 0, 60],
      [1, 'bend', 2, 8192],
    ]);
  });

  it('releases a zero-length note right after its own on, not before every on at that instant', () => {
    // A pad's on and off inside one sample: the off must follow the on,
    // or the voice it starts is never released.
    const file = notesFromMessages(
      [
        { at: 4800, midi: [144, 36, 120] },
        { at: 4800, midi: [128, 36, 0] },
        { at: 4800, midi: [144, 60, 90] },
      ],
      9600,
      48000,
    );
    expect(file.notes).toEqual([
      { at: 4800, length: 0, note: 36, velocity: 120 },
      { at: 4800, length: 4800, note: 60, velocity: 90 },
    ]);
    expect(renderEvents(file)).toEqual([
      [0.1, 'on', 0, 36, 120],
      [0.1, 'off', 0, 36],
      [0.1, 'on', 0, 60, 90],
      [0.2, 'off', 0, 60],
    ]);
  });
});
