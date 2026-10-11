import { z } from 'zod';

// A recorded MIDI take (keyboard-instrument.md §12.1): a text list of
// notes, controller changes, and bends, timed in samples from the take's
// start at the rate it was captured at. Pinned in the ledger by hash like
// any take; the build renders it through the record entry's instrument.

const at = z.number().int().min(0);
const channel = z.number().int().min(1).max(16).optional();
const seven = z.number().int().min(0).max(127);

export const notesFileSchema = z.strictObject({
  sample_rate: z.number().int().positive(),
  length: at,
  notes: z
    .array(z.strictObject({ at, length: at, note: seven, velocity: z.number().int().min(1).max(127), channel }))
    .default([]),
  controls: z.array(z.strictObject({ at, cc: seven, value: seven, channel })).default([]),
  bends: z.array(z.strictObject({ at, value: z.number().int().min(0).max(16383), channel })).default([]),
});
export type NotesFile = z.infer<typeof notesFileSchema>;

// What the daemon captures: one MIDI message, `at` samples into the take.
export interface CapturedMessage {
  at: number;
  midi: number[];
}

// Pairs each note-on with the note-off that ends it. A note still held at
// the end lasts to the end; a note-off whose note-on came before the take
// began is dropped; a second note-on for a sounding note ends the first.
export function notesFromMessages(messages: readonly CapturedMessage[], length: number, sampleRate: number): NotesFile {
  const notes: NotesFile['notes'] = [];
  const controls: NotesFile['controls'] = [];
  const bends: NotesFile['bends'] = [];
  const open = new Map<number, { at: number; velocity: number }>();
  const withChannel = <T extends object>(row: T, ch: number): T & { channel?: number } =>
    ch === 1 ? row : { ...row, channel: ch };
  const end = (key: number, at: number): void => {
    const on = open.get(key);
    if (on === undefined) return;
    open.delete(key);
    notes.push(withChannel({ at: on.at, length: Math.max(0, at - on.at), note: key % 128, velocity: on.velocity }, Math.floor(key / 128)));
  };

  for (const { at, midi } of messages) {
    const [status = 0, data1 = 0, data2 = 0] = midi;
    const ch = (status & 0x0f) + 1;
    const kind = status & 0xf0;
    const key = ch * 128 + data1;
    if (kind === 0x90 && data2 > 0) {
      end(key, at);
      open.set(key, { at, velocity: data2 });
    } else if (kind === 0x80 || kind === 0x90) {
      end(key, at);
    } else if (kind === 0xb0) {
      controls.push(withChannel({ at, cc: data1, value: data2 }, ch));
    } else if (kind === 0xe0) {
      bends.push(withChannel({ at, value: data1 | (data2 << 7) }, ch));
    }
  }
  for (const key of [...open.keys()]) end(key, length);

  notes.sort((a, b) => a.at - b.at || a.note - b.note || (a.channel ?? 1) - (b.channel ?? 1));
  return { sample_rate: sampleRate, length, notes, controls, bends };
}

function row(fields: Record<string, number | undefined>): string {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return `{ ${parts.join(', ')} }`;
}

// One row per note, in the file's own fixed key order, so a take reads as
// a table and two takes diff line by line. The bytes are what the ledger
// pins, so this is the only writer.
export function formatNotesFile(file: NotesFile): string {
  const lines = [`sample_rate: ${file.sample_rate}`, `length: ${file.length}`];
  const list = (name: string, rows: string[]): void => {
    if (rows.length === 0) {
      lines.push(`${name}: []`);
      return;
    }
    lines.push(`${name}:`);
    for (const r of rows) lines.push(`  - ${r}`);
  };
  list('notes', file.notes.map((n) => row({ at: n.at, length: n.length, note: n.note, velocity: n.velocity, channel: n.channel })));
  list('controls', file.controls.map((c) => row({ at: c.at, cc: c.cc, value: c.value, channel: c.channel })));
  list('bends', file.bends.map((b) => row({ at: b.at, value: b.value, channel: b.channel })));
  return `${lines.join('\n')}\n`;
}

// The renderer's input (sc/voice-render.scd): every event in time order,
// in seconds, with 0-based MIDI channels. At one instant, note-offs come
// first, then controller changes and bends, then note-ons, so a note
// played again at the moment it ends is a new voice, and a pedal pressed
// at a note's onset already holds it. A note that ends where it starts,
// as a drum pad's on and off can inside one sample, releases right after
// its own on: ranked with the other offs it would come first, and nothing
// would ever release the voice.
export type RenderEvent =
  | [number, 'on', number, number, number]
  | [number, 'off', number, number]
  | [number, 'cc', number, number, number]
  | [number, 'bend', number, number];

export function renderEvents(file: NotesFile): RenderEvent[] {
  const seconds = (samples: number): number => samples / file.sample_rate;
  const [OFF, CONTROL, ON] = [0, 1, 2];
  const timed: { at: number; rank: number; event: RenderEvent }[] = [];
  for (const n of file.notes) {
    const ch = (n.channel ?? 1) - 1;
    timed.push({ at: n.at, rank: ON, event: [seconds(n.at), 'on', ch, n.note, n.velocity] });
    timed.push({ at: n.at + n.length, rank: n.length === 0 ? ON : OFF, event: [seconds(n.at + n.length), 'off', ch, n.note] });
  }
  for (const c of file.controls) {
    timed.push({ at: c.at, rank: CONTROL, event: [seconds(c.at), 'cc', (c.channel ?? 1) - 1, c.cc, c.value] });
  }
  for (const b of file.bends) timed.push({ at: b.at, rank: CONTROL, event: [seconds(b.at), 'bend', (b.channel ?? 1) - 1, b.value] });
  return timed
    .map((t, index) => ({ ...t, index }))
    .sort((a, b) => a.at - b.at || a.rank - b.rank || a.index - b.index)
    .map((t) => t.event);
}
