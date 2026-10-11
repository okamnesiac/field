import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKeymapDir, loadKeymap, parseKeymap } from './keymap.js';
import { noteName, printKeymap } from './print.js';

describe('printing a keymap', () => {
  it('names notes in scientific pitch notation', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(0)).toBe('C-1');
    expect(noteName(127)).toBe('G9');
  });

  it('draws musical as a keyboard', () => {
    const keymap = loadKeymap(join(builtinKeymapDir(), 'musical.yaml'));
    expect(printKeymap(keymap)).toBe(
      [
        "musical: Field's take on Logic Pro's Musical Typing. White keys on the home row, black keys above, the arrows choose and turn knobs, and the number row types a knob's value.",
        '',
        '·     1     2     3     4     5     6     7     8     9     0     -     ·',
        '   cc64  ·     C#4   D#4   ·     F#4   G#4   A#4   ·     C#5   D#5   ·     ·     ·',
        '          C4    D4    E4    F4    G4    A4    B4    C5    D5    E5    F5',
        '             T-12  T+12  V-20  V+20  ·     ·     ·     B-1   B+1   ·',
        '',
        '← K-1   → K+1   ↑ R+1   ↓ R-1',
        '',
        'KeyZ        transpose -12',
        'KeyX        transpose +12',
        'KeyC        velocity -20',
        'KeyV        velocity +20',
        'Comma       pitch bend -1 while held',
        'Period      pitch bend +1 while held',
        'Tab         cc 64 = 127 while held',
        'ArrowLeft   choose the knob 1 to the left',
        'ArrowRight  choose the knob 1 to the right',
        'ArrowUp     turn the chosen knob 1 step up, faster while held',
        'ArrowDown   turn the chosen knob 1 step down, faster while held',
        "Digit1      type 1 into the chosen knob's value",
        "Digit2      type 2 into the chosen knob's value",
        "Digit3      type 3 into the chosen knob's value",
        "Digit4      type 4 into the chosen knob's value",
        "Digit5      type 5 into the chosen knob's value",
        "Digit6      type 6 into the chosen knob's value",
        "Digit7      type 7 into the chosen knob's value",
        "Digit8      type 8 into the chosen knob's value",
        "Digit9      type 9 into the chosen knob's value",
        "Digit0      type 0 into the chosen knob's value",
        "Minus       type - into the chosen knob's value",
        '',
        'Notes are in scientific pitch notation: MIDI note 60 is C4. Channel 1, velocity 100.',
        '',
      ].join('\n'),
    );
  });

  it('marks chords, draws the ISO key and the extra keys only when bound', () => {
    const keymap = parseKeymap(
      'name: extras\nbase: 48\nnotes: { KeyF: [0, 4, 7], IntlBackslash: 1 }\ncontrols: { Space: { cc: 64, mode: toggle }, ArrowUp: panic }\n',
      'extras.yaml',
    );
    const lines = printKeymap(keymap).split('\n');
    expect(lines[5]).toBe('       C#3   ·     ·     ·     ·     ·     ·     ·     ·     ·     ·');
    expect(lines[4]).toContain('C3+');
    expect(lines).toContain('Space cc64   ↑ !!');
    expect(lines).toContain('KeyF     chord C3 E3 G3');
    expect(lines).toContain('Space    cc 64 = 127, toggled');
    expect(lines).toContain('ArrowUp  panic: release every note and send All Notes Off');
  });
});
