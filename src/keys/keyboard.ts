import { NAMED_ROWS, type Keymap, type RowName } from '../schema/keymap.js';
import { US_LABELS } from './position.js';

const KEY_WIDTH = 4;
// The top row sits half a key left of the home row, so each of its keys
// falls between two home-row keys, as a piano's black keys do.
const ROWS: readonly { name: RowName; offset: number }[] = [
  { name: 'top', offset: -KEY_WIDTH / 2 },
  { name: 'home', offset: 0 },
];

const REVERSE = '\x1b[7m';
const REVERSE_OFF = '\x1b[27m';

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;
const JUNCTIONS: Record<number, string> = {
  [LEFT]: '─',
  [RIGHT]: '─',
  [LEFT | RIGHT]: '─',
  [UP]: '│',
  [DOWN]: '│',
  [UP | DOWN]: '│',
  [DOWN | RIGHT]: '┌',
  [DOWN | LEFT]: '┐',
  [UP | RIGHT]: '└',
  [UP | LEFT]: '┘',
  [LEFT | RIGHT | DOWN]: '┬',
  [LEFT | RIGHT | UP]: '┴',
  [UP | DOWN | RIGHT]: '├',
  [UP | DOWN | LEFT]: '┤',
  [UP | DOWN | LEFT | RIGHT]: '┼',
};

interface Cap {
  position: string;
  x: number; // the column of its left wall
  y: number; // the line of its top wall
}

// The drawing's lines, or undefined when the keymap plays a note off these
// two rows or the drawing is wider than `width`.
export function keyboardLines(keymap: Keymap, held: ReadonlySet<string>, width: number): string[] | undefined {
  const rows = new Set<string>(ROWS.flatMap(({ name }) => NAMED_ROWS[name]));
  if ([...keymap.notes.keys()].some((position) => !rows.has(position))) return undefined;

  const caps: Cap[] = ROWS.flatMap(({ name, offset }, row) =>
    NAMED_ROWS[name].flatMap((position, column) =>
      keymap.notes.has(position) ? [{ position, x: offset + column * KEY_WIDTH, y: row * 2 }] : [],
    ),
  );
  if (caps.length === 0) return undefined;
  const left = Math.min(...caps.map((cap) => cap.x));
  for (const cap of caps) cap.x -= left;
  const columns = Math.max(...caps.map((cap) => cap.x)) + KEY_WIDTH + 1;
  if (columns > width) return undefined;

  const lines = ROWS.length * 2 + 1;
  const edges = Array.from({ length: lines }, () => new Array<number>(columns).fill(0));
  const across = (y: number, x0: number, x1: number): void => {
    for (let x = x0; x <= x1; x++) edges[y]![x]! |= (x > x0 ? LEFT : 0) | (x < x1 ? RIGHT : 0);
  };
  const down = (x: number, y0: number, y1: number): void => {
    for (let y = y0; y <= y1; y++) edges[y]![x]! |= (y > y0 ? UP : 0) | (y < y1 ? DOWN : 0);
  };
  for (const { x, y } of caps) {
    across(y, x, x + KEY_WIDTH);
    across(y + 2, x, x + KEY_WIDTH);
    down(x, y, y + 2);
    down(x + KEY_WIDTH, y, y + 2);
  }

  const text = edges.map((line) => line.map((bits) => JUNCTIONS[bits] ?? ' '));
  for (const { position, x, y } of caps) text[y + 1]![x + 2] = US_LABELS.get(position) ?? '?';
  // A held key's face, the three columns between its walls, in reverse
  // video.
  return text.map((line, y) => {
    const faces = new Set(caps.filter((cap) => cap.y + 1 === y && held.has(cap.position)).map((cap) => cap.x + 1));
    return line
      .map((character, x) => `${faces.has(x) ? REVERSE : ''}${character}${faces.has(x - (KEY_WIDTH - 2)) ? REVERSE_OFF : ''}`)
      .join('')
      .trimEnd();
  });
}
