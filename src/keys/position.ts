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

// Enter, Backspace, and Escape act only on a typed value or say how to
// quit, so no keymap binds them (instrument-knobs.md §2.7).
const FUNCTIONAL_KEYS: Record<number, string> = { 9: 'Tab', 13: 'Enter', 27: 'Escape', 32: 'Space', 127: 'Backspace' };

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

// A release takes the position its press resolved to, not one resolved
// afresh: an input source switched while a key is held, or a release
// reported without the base layout key its press carried, would otherwise
// resolve elsewhere and leave the note sounding.
export class PressedKeys {
  private readonly positions = new Map<number | string, string>();

  resolve(
    event: Extract<TerminalEvent, { kind: 'key' }>,
    layoutPositions?: ReadonlyMap<string, string>,
  ): string | undefined {
    const remembered = this.positions.get(event.key);
    if (event.type === 'release') {
      this.positions.delete(event.key);
      return remembered ?? positionOf(event, layoutPositions);
    }
    if (remembered !== undefined) return remembered;
    const position = positionOf(event, layoutPositions);
    if (position !== undefined) this.positions.set(event.key, position);
    return position;
  }

  clear(): void {
    this.positions.clear();
  }
}

// The positions this keymap binds that the keyboard layout makes dead
// keys, which the terminal may hold for composition and never report.
export function unplayablePositions(layout: KeyboardLayout | undefined, keymap: Keymap): string[] {
  if (layout === undefined) return [];
  return layout.dead.filter((position) => keymap.notes.has(position) || keymap.controls.has(position));
}
