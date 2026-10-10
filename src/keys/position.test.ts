import { describe, expect, it } from 'vitest';
import { parseKeymap } from './keymap.js';
import { charactersToPositions, positionOf, unplayablePositions, type KeyboardLayout } from './position.js';

const DVORAK: KeyboardLayout = {
  name: 'Dvorak',
  keys: { KeyA: 'a', KeyS: 'o', KeyD: 'e', KeyF: 'u', KeyQ: "'", KeyZ: ';', KeyO: 'r', Quote: '-' },
  dead: [],
};

const AZERTY: KeyboardLayout = {
  name: 'French',
  keys: { KeyA: 'q', KeyQ: 'a', KeyZ: 'w', KeyW: 'z', Semicolon: 'm', KeyM: ',' },
  dead: [],
};

function press(key: number, base?: number) {
  return { kind: 'key' as const, key, ...(base !== undefined ? { base } : {}), mods: 0, type: 'press' as const };
}

const code = (character: string) => character.codePointAt(0)!;

describe('finding a key event position', () => {
  it('takes the base layout key over the keyboard layout', () => {
    expect(positionOf(press(code('o'), code('s')), charactersToPositions(AZERTY))).toBe('KeyS');
  });

  it('reverses the keyboard layout when there is no base layout key', () => {
    expect(positionOf(press(code('o')), charactersToPositions(DVORAK))).toBe('KeyS');
    expect(positionOf(press(code('q')), charactersToPositions(AZERTY))).toBe('KeyA');
    expect(positionOf(press(code('w')), charactersToPositions(AZERTY))).toBe('KeyZ');
    expect(positionOf(press(code(';')), charactersToPositions(DVORAK))).toBe('KeyZ');
  });

  it('reads a character as its own US position with no layout report', () => {
    expect(positionOf(press(code('o')))).toBe('KeyO');
    expect(positionOf(press(code("'")))).toBe('Quote');
    expect(positionOf(press(code('1')))).toBe('Digit1');
  });

  it('names Space, Tab, and the arrows whatever the layout', () => {
    expect(positionOf(press(32), charactersToPositions(DVORAK))).toBe('Space');
    expect(positionOf(press(9))).toBe('Tab');
    expect(positionOf({ kind: 'key', key: 'ArrowUp', mods: 0, type: 'press' })).toBe('ArrowUp');
  });

  it('applies a new layout report to the next event', () => {
    let positions = charactersToPositions(DVORAK);
    expect(positionOf(press(code('a')), positions)).toBe('KeyA');
    positions = charactersToPositions(AZERTY);
    expect(positionOf(press(code('a')), positions)).toBe('KeyQ');
  });

  it('returns nothing for a key no position types', () => {
    expect(positionOf(press(code('ß')))).toBeUndefined();
  });
});

describe('dead keys', () => {
  it('names the bound positions a keyboard layout makes dead', () => {
    const keymap = parseKeymap('name: t\nnotes: { KeyA: 0, Quote: 17 }\n', 't.yaml');
    const international: KeyboardLayout = { name: 'U.S. International – PC', keys: { KeyA: 'a' }, dead: ['Quote', 'Backquote'] };
    expect(unplayablePositions(international, keymap)).toEqual(['Quote']);
    expect(unplayablePositions(undefined, keymap)).toEqual([]);
  });
});
