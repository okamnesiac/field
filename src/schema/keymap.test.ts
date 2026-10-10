import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { builtinKeymapDir } from '../keys/keymap.js';
import { keymapSchema, toKeymap } from './keymap.js';

// The tracker and fourths keymaps ship in chunk 3 (keyboard-instrument.md
// §6); carrying them here proves the format expresses both before then.
const TRACKER = `
name: tracker
description: Two piano octaves on the bottom and top rows, black keys on the row above each.
base: 48
notes:
  KeyZ: 0
  KeyS: 1
  KeyX: 2
  KeyD: 3
  KeyC: 4
  KeyV: 5
  KeyG: 6
  KeyB: 7
  KeyH: 8
  KeyN: 9
  KeyJ: 10
  KeyM: 11
  Comma: 12
  KeyL: 13
  Period: 14
  Semicolon: 15
  Slash: 16
  KeyQ: 12
  Digit2: 13
  KeyW: 14
  Digit3: 15
  KeyE: 16
  KeyR: 17
  Digit5: 18
  KeyT: 19
  Digit6: 20
  KeyY: 21
  Digit7: 22
  KeyU: 23
  KeyI: 24
  Digit9: 25
  KeyO: 26
  Digit0: 27
  KeyP: 28
  BracketLeft: 29
  Equal: 30
  BracketRight: 31
controls:
  ArrowLeft: { transpose: -12 }
  ArrowRight: { transpose: 12 }
  ArrowDown: { velocity: -20 }
  ArrowUp: { velocity: 20 }
  Space: { cc: 64, value: 127, mode: hold }
`;

const FOURTHS = `
name: fourths
description: One semitone per key, each row a fourth above the row below.
base: 48
grid: { rows: [bottom, home, top, number], column: 1, row: 5 }
controls:
  ArrowLeft: { transpose: -12 }
  ArrowRight: { transpose: 12 }
  ArrowDown: { velocity: -20 }
  ArrowUp: { velocity: 20 }
  Space: { cc: 64, value: 127, mode: hold }
`;

function parse(text: string) {
  return keymapSchema.safeParse(parseDocument(text).toJS());
}

function keymap(text: string) {
  const result = parse(text);
  if (!result.success) throw new Error(result.error.issues.map((i) => i.message).join('; '));
  return toKeymap(result.data);
}

function messages(text: string): string[] {
  const result = parse(text);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

function notesPlayed(map: ReturnType<typeof keymap>): Set<number> {
  return new Set([...map.notes.values()].flat().map((o) => map.base + o));
}

describe('keymap schema', () => {
  it('accepts musical-typing with its 18 notes and the defaults', () => {
    const map = keymap(readFileSync(join(builtinKeymapDir(), 'musical-typing.yaml'), 'utf8'));
    expect(map.notes.get('KeyA')).toEqual([0]);
    expect(map.notes.get('Quote')).toEqual([17]);
    expect(notesPlayed(map).size).toBe(18);
    expect(map.velocity).toBe(100);
    expect(map.channel).toBe(1);
    expect(map.controls.get('Tab')).toEqual({ cc: 64, value: 127, mode: 'hold' });
    expect(map.controls.get('KeyZ')).toEqual({ transpose: -12 });
  });

  it('accepts the tracker fixture with 32 notes', () => {
    const map = keymap(TRACKER);
    expect(notesPlayed(map).size).toBe(32);
    expect(map.base + map.notes.get('KeyZ')![0]!).toBe(48);
    expect(map.base + map.notes.get('KeyQ')![0]!).toBe(60);
    expect(map.base + map.notes.get('KeyI')![0]!).toBe(72);
  });

  it('expands the fourths grid', () => {
    const map = keymap(FOURTHS);
    const at = (p: string) => map.base + map.notes.get(p)![0]!;
    expect(at('KeyZ')).toBe(48);
    expect(at('KeyA')).toBe(53);
    expect(at('KeyQ')).toBe(58);
    expect(at('Digit1')).toBe(63);
    expect([at('KeyZ'), at('KeyB'), at('KeyD')]).toEqual([48, 52, 55]);
    expect([at('KeyX'), at('KeyN'), at('KeyF')]).toEqual([49, 53, 56]);
    expect(notesPlayed(map).size).toBe(27);
  });

  it('lets notes override the grid and controls take positions back from it', () => {
    const map = keymap(`
name: mixed
grid: { rows: [bottom], column: 2, row: 0 }
notes: { KeyX: 9 }
controls: { KeyZ: { transpose: 12 } }
`);
    expect(map.notes.get('KeyX')).toEqual([9]);
    expect(map.notes.has('KeyZ')).toBe(false);
    expect(map.notes.get('KeyC')).toEqual([4]);
  });

  it('skips a column where a grid row lists null', () => {
    const map = keymap(`
name: aligned
grid: { rows: [[KeyZ, KeyX], [null, KeyS]], column: 1, row: 5 }
`);
    expect(map.notes.get('KeyX')).toEqual([1]);
    expect(map.notes.get('KeyS')).toEqual([6]);
  });

  it('plays a list of offsets as a chord', () => {
    const map = keymap('name: chords\nnotes: { KeyF: [0, 4, 7] }\n');
    expect(map.notes.get('KeyF')).toEqual([0, 4, 7]);
  });

  it('rejects an unknown position by name', () => {
    expect(messages('name: bad\nnotes: { KeyAA: 0 }\n').join('\n')).toMatch(/KeyAA is not a position a keymap can bind/);
    expect(messages('name: bad\ngrid: { rows: [[KeyA, Enter]], column: 1, row: 5 }\n').join('\n')).toMatch(
      /Enter is not a position/,
    );
  });

  it('rejects a position that is both a note and a control', () => {
    expect(messages('name: bad\nnotes: { KeyA: 0 }\ncontrols: { KeyA: { transpose: 12 } }\n').join('\n')).toMatch(
      /KeyA is both a note and a control/,
    );
  });

  it('keeps Escape reserved', () => {
    expect(messages('name: bad\nnotes: { KeyA: 0 }\ncontrols: { Escape: panic }\n').join('\n')).toMatch(
      /Escape is reserved/,
    );
  });

  it('rejects a note outside 0 to 127', () => {
    expect(messages('name: bad\nbase: 120\nnotes: { KeyA: 0, KeyS: 8 }\n').join('\n')).toMatch(
      /KeyS plays MIDI note 128 at base 120/,
    );
    expect(messages('name: bad\nbase: 0\ngrid: { rows: [bottom], column: -1, row: 0 }\n').join('\n')).toMatch(
      /plays MIDI note -1/,
    );
  });

  it('rejects a keymap that plays nothing', () => {
    expect(messages('name: silent\ncontrols: { KeyZ: panic }\n').join('\n')).toMatch(/at least one note/);
  });

  it('rejects unknown fields rather than ignoring them', () => {
    expect(parse('name: typo\nnote: { KeyA: 0 }\n').success).toBe(false);
    expect(parse('name: typo\nnotes: { KeyA: 0 }\ncontrols: { KeyZ: { transpose: 12, by: 1 } }\n').success).toBe(false);
  });

  it('defaults a cc action to value 127 in set mode', () => {
    const map = keymap('name: cc\nnotes: { KeyA: 0 }\ncontrols: { Space: { cc: 64, mode: toggle } }\n');
    expect(map.controls.get('Space')).toEqual({ cc: 64, value: 127, mode: 'toggle' });
  });
});
