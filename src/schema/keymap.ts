import { z } from 'zod';

// A keymap (keyboard-instrument.md §2.4): what each physical key plays in
// `field keys`. Positions are W3C KeyboardEvent.code values, named after
// the key a US keyboard has in that place, so a keymap plays the same
// under any keyboard layout (§2.3).

export const NAMED_ROWS = {
  bottom: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
  home: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'],
  top: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'],
  number: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'],
} as const;

export type RowName = keyof typeof NAMED_ROWS;

// The keys that type a character, whose position a terminal can only
// report through the character or its base layout key.
export const TEXT_POSITIONS: readonly string[] = [
  'Backquote',
  ...NAMED_ROWS.number,
  ...NAMED_ROWS.top,
  'Backslash',
  ...NAMED_ROWS.home,
  'IntlBackslash',
  ...NAMED_ROWS.bottom,
];

export const FUNCTIONAL_POSITIONS: readonly string[] = [
  'Space',
  'Tab',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
];

export const BINDABLE_POSITIONS: ReadonlySet<string> = new Set([...TEXT_POSITIONS, ...FUNCTIONAL_POSITIONS]);

const midiNote = z.number().int().min(0).max(127);
const offset = z.number().int();

const ccAction = z
  .object({
    cc: z.number().int().min(0).max(127),
    value: z.number().int().min(0).max(127).default(127),
    mode: z.enum(['set', 'hold', 'toggle']).default('set'),
  })
  .strict();

const action = z.union([
  z.object({ transpose: z.number().int() }).strict(),
  z.object({ velocity: z.number().int() }).strict(),
  z.object({ bend: z.number().min(-1).max(1) }).strict(),
  ccAction,
  z.literal('panic'),
]);

export type KeymapAction = z.infer<typeof action>;

const gridRow = z.union([z.enum(['bottom', 'home', 'top', 'number']), z.array(z.string().nullable()).min(1)]);

const grid = z
  .object({
    rows: z.array(gridRow).min(1),
    column: z.number().int(),
    row: z.number().int(),
  })
  .strict();

export type KeymapGrid = z.infer<typeof grid>;

export const keymapSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    base: midiNote.default(60),
    velocity: z.number().int().min(1).max(127).default(100),
    channel: z.number().int().min(1).max(16).default(1),
    notes: z.record(z.string(), z.union([offset, z.array(offset).min(1)])).optional(),
    grid: grid.optional(),
    controls: z.record(z.string(), action).optional(),
  })
  .strict()
  .superRefine((keymap, ctx) => {
    const checkPosition = (position: string, path: (string | number)[]): void => {
      if (position === 'Escape') {
        ctx.addIssue({ code: 'custom', path, message: 'Escape is reserved: it always quits' });
      } else if (!BINDABLE_POSITIONS.has(position)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `${position} is not a position a keymap can bind (positions are KeyboardEvent.code values, such as KeyA or Semicolon)`,
        });
      }
    };

    for (const position of Object.keys(keymap.notes ?? {})) checkPosition(position, ['notes', position]);
    for (const position of Object.keys(keymap.controls ?? {})) checkPosition(position, ['controls', position]);

    const gridPositions = new Set<string>();
    keymap.grid?.rows.forEach((row, rowIndex) => {
      if (typeof row === 'string') return;
      row.forEach((position, column) => {
        if (position === null) return;
        const path = ['grid', 'rows', rowIndex, column];
        checkPosition(position, path);
        if (gridPositions.has(position)) {
          ctx.addIssue({ code: 'custom', path, message: `${position} appears twice in the grid` });
        }
        gridPositions.add(position);
      });
    });

    for (const position of Object.keys(keymap.notes ?? {})) {
      if (keymap.controls?.[position] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['controls', position],
          message: `${position} is both a note and a control; a position is one or the other`,
        });
      }
    }

    const notes = expandNotes(keymap);
    if (notes.size === 0) {
      ctx.addIssue({ code: 'custom', message: 'a keymap must play at least one note (give notes or a grid)' });
    }
    for (const [position, offsets] of notes) {
      for (const o of offsets) {
        const note = keymap.base + o;
        if (note < 0 || note > 127) {
          ctx.addIssue({
            code: 'custom',
            path: keymap.notes?.[position] !== undefined ? ['notes', position] : ['grid'],
            message: `${position} plays MIDI note ${note} at base ${keymap.base}, outside 0 to 127`,
          });
        }
      }
    }
  });

export type KeymapFile = z.infer<typeof keymapSchema>;

// What a position plays once the grid is laid down, `notes` overrides it,
// and `controls` takes its positions back from both.
export function expandNotes(keymap: Pick<KeymapFile, 'grid' | 'notes' | 'controls'>): Map<string, number[]> {
  const notes = new Map<string, number[]>();
  keymap.grid?.rows.forEach((row, rowIndex) => {
    const positions: readonly (string | null)[] = typeof row === 'string' ? NAMED_ROWS[row] : row;
    positions.forEach((position, column) => {
      if (position !== null) notes.set(position, [column * keymap.grid!.column + rowIndex * keymap.grid!.row]);
    });
  });
  for (const [position, binding] of Object.entries(keymap.notes ?? {})) {
    notes.set(position, typeof binding === 'number' ? [binding] : binding);
  }
  for (const position of Object.keys(keymap.controls ?? {})) notes.delete(position);
  return notes;
}

export interface Keymap {
  name: string;
  description?: string;
  base: number;
  velocity: number;
  channel: number;
  notes: ReadonlyMap<string, readonly number[]>;
  controls: ReadonlyMap<string, KeymapAction>;
}

export function toKeymap(file: KeymapFile): Keymap {
  return {
    name: file.name,
    ...(file.description !== undefined ? { description: file.description } : {}),
    base: file.base,
    velocity: file.velocity,
    channel: file.channel,
    notes: expandNotes(file),
    controls: new Map(Object.entries(file.controls ?? {})),
  };
}
