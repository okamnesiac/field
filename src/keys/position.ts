import type { Keymap } from '../schema/keymap.js';
import type { TerminalEvent } from './terminal.js';

// What the helper reports (keyboard-instrument.md §2.5): the character
// each text position types under the active keyboard layout, and the
// positions that are dead keys there.
export interface KeyboardLayout {
  name: string;
  keys: Record<string, string>;
  dead: string[];
}

// What each text position types on a US keyboard, which is how the kitty
// protocol names a base layout key and how a QWERTY layout reads with no
// report at all.
const US_POSITIONS: Record<string, string> = {
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
};
for (const digit of '0123456789') US_POSITIONS[digit] = `Digit${digit}`;
for (const letter of 'abcdefghijklmnopqrstuvwxyz') US_POSITIONS[letter] = `Key${letter.toUpperCase()}`;

const FUNCTIONAL_KEYS: Record<number, string> = { 9: 'Tab', 32: 'Space' };

// Inverts a layout report once, keeping the first position for a
// character two positions type.
export function charactersToPositions(layout: KeyboardLayout): Map<string, string> {
  const positions = new Map<string, string>();
  for (const [position, character] of Object.entries(layout.keys)) {
    if (!positions.has(character)) positions.set(character, position);
  }
  return positions;
}

// The terminal's base layout key wins when it sends one. Otherwise the
// character goes through the helper's report of the keyboard layout, and
// with no report it reads as QWERTY (keyboard-instrument.md §2.3).
export function positionOf(
  event: Extract<TerminalEvent, { kind: 'key' }>,
  layoutPositions?: ReadonlyMap<string, string>,
): string | undefined {
  if (typeof event.key === 'string') return event.key;
  const functional = FUNCTIONAL_KEYS[event.key];
  if (functional !== undefined) return functional;
  if (event.base !== undefined) return US_POSITIONS[String.fromCodePoint(event.base)];
  const character = String.fromCodePoint(event.key);
  return layoutPositions?.get(character) ?? US_POSITIONS[character];
}

// The positions this keymap binds that the keyboard layout makes dead
// keys, which the terminal may hold for composition and never report.
export function unplayablePositions(layout: KeyboardLayout | undefined, keymap: Keymap): string[] {
  if (layout === undefined) return [];
  return layout.dead.filter((position) => keymap.notes.has(position) || keymap.controls.has(position));
}
