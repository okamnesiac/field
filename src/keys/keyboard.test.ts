import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKeymapDir, loadKeymap, parseKeymap } from './keymap.js';
import { keyboardLines } from './keyboard.js';

const musical = loadKeymap(join(builtinKeymapDir(), 'musical.yaml'));
const REVERSE = '\x1b[7m';
const REVERSE_OFF = '\x1b[27m';

describe('the keyboard drawing', () => {
  it('draws musical as keycaps: the home row, and the row above it half a key to the left, with gaps where no note plays', () => {
    expect(keyboardLines(musical, new Set(), 80)).toEqual([
      '  ┌───┬───┐   ┌───┬───┬───┐   ┌───┬───┐   ┌───┐',
      '  │ W │ E │   │ T │ Y │ U │   │ O │ P │   │ ] │',
      '┌─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┘',
      "│ A │ S │ D │ F │ G │ H │ J │ K │ L │ ; │ ' │",
      '└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘',
    ]);
  });

  it('lights each held key in reverse video, on both rows, and nothing else', () => {
    const lines = keyboardLines(musical, new Set(['KeyA', 'KeyW', 'BracketRight', 'KeyZ']), 80)!;
    expect(lines[1]).toBe(`  │${REVERSE} W ${REVERSE_OFF}│ E │   │ T │ Y │ U │   │ O │ P │   │${REVERSE} ] ${REVERSE_OFF}│`);
    expect(lines[3]).toBe(`│${REVERSE} A ${REVERSE_OFF}│ S │ D │ F │ G │ H │ J │ K │ L │ ; │ ' │`);
    expect([lines[0], lines[2], lines[4]].join('')).not.toContain(REVERSE);
  });

  it('draws nothing for a keymap with a note off those two rows, or on a terminal too narrow for it', () => {
    expect(keyboardLines(loadKeymap(join(builtinKeymapDir(), 'tracker.yaml')), new Set(), 200)).toBeUndefined();
    expect(keyboardLines(loadKeymap(join(builtinKeymapDir(), 'fourths.yaml')), new Set(), 200)).toBeUndefined();
    expect(keyboardLines(musical, new Set(), 46)).toBeUndefined();
    expect(keyboardLines(musical, new Set(), 47)).toHaveLength(5);
  });

  it('draws the keys a keymap of your own plays on those rows', () => {
    const three = parseKeymap('name: three\nnotes: { KeyA: 0, KeyW: 1, KeyS: 2 }\n', 'three.yaml');
    expect(keyboardLines(three, new Set(), 80)).toEqual(['  ┌───┐', '  │ W │', '┌─┴─┬─┴─┐', '│ A │ S │', '└───┴───┘']);
  });
});
