import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKeymapDir, loadKeymap, parseKeymap } from './keymap.js';
import { knobList, loadKnobs } from './knobs.js';
import { bendValue, KeysSession, type MidiMessage } from './session.js';
import { MOD_ALT, MOD_CAPS_LOCK, MOD_CTRL, MOD_NUM_LOCK, MOD_SHIFT, MOD_SUPER } from './terminal.js';

const ON = 0x90;
const OFF = 0x80;
const CC = 0xb0;
const BEND = 0xe0;

function musical(): KeysSession {
  return new KeysSession(loadKeymap(join(builtinKeymapDir(), 'musical.yaml')));
}

// A keymap that sets the modulation wheel to fixed values, as Logic's
// Musical Typing does on 3 to 8.
const WHEEL_STEPS = parseKeymap(
  'name: wheel\nnotes: { KeyA: 0 }\ncontrols:\n  Digit3: { cc: 1, value: 0 }\n  Digit5: { cc: 1, value: 51 }\n  Digit6: { cc: 1, value: 76 }\n',
  'wheel.yaml',
);

describe('playing notes', () => {
  it('sends a note-on at press and a note-off at release', () => {
    const session = musical();
    expect(session.press('KeyA')).toEqual([[ON, 60, 100]]);
    expect(session.soundingNotes()).toEqual(['C4']);
    expect(session.release('KeyA')).toEqual([[OFF, 60, 0]]);
    expect(session.soundingNotes()).toEqual([]);
  });

  it('ignores repeats, so a held key holds one note', () => {
    const session = musical();
    expect(session.handleKey('KeyA', 'press', 0)).toHaveLength(1);
    expect(session.handleKey('KeyA', 'repeat', 0)).toEqual([]);
    expect(session.handleKey('KeyA', 'repeat', 0)).toEqual([]);
    expect(session.handleKey('KeyA', 'release', 0)).toEqual([[OFF, 60, 0]]);
  });

  it('releases the note a key started even after a transpose', () => {
    const session = musical();
    session.press('KeyA');
    expect(session.press('KeyX')).toEqual([]);
    expect(session.transpose).toBe(12);
    expect(session.release('KeyA')).toEqual([[OFF, 60, 0]]);
    expect(session.press('KeyA')).toEqual([[ON, 72, 100]]);
  });

  it('plays and releases a chord from one key', () => {
    const session = new KeysSession(parseKeymap('name: c\nnotes: { KeyF: [0, 4, 7] }\n', 'c.yaml'));
    expect(session.press('KeyF')).toEqual([
      [ON, 60, 100],
      [ON, 64, 100],
      [ON, 67, 100],
    ]);
    expect(session.release('KeyF')).toEqual([
      [OFF, 60, 0],
      [OFF, 64, 0],
      [OFF, 67, 0],
    ]);
  });

  it('pairs a shared note with one note-off, whichever key is released first', () => {
    for (const order of [
      ['KeyA', 'KeyK'],
      ['KeyK', 'KeyA'],
    ]) {
      const session = musical();
      expect(session.press('KeyA')).toEqual([[ON, 60, 100]]);
      session.press('KeyZ');
      expect(session.press('KeyK')).toEqual([]);
      expect(session.release(order[0]!)).toEqual([]);
      expect(session.release(order[1]!)).toEqual([[OFF, 60, 0]]);
    }
  });

  it('shares a note between a chord and a single key the same way', () => {
    const session = new KeysSession(parseKeymap('name: c\nnotes: { KeyF: [0, 4, 7], KeyA: 4 }\n', 'c.yaml'));
    session.press('KeyF');
    expect(session.press('KeyA')).toEqual([]);
    expect(session.release('KeyF')).toEqual([
      [OFF, 60, 0],
      [OFF, 67, 0],
    ]);
    expect(session.release('KeyA')).toEqual([[OFF, 64, 0]]);
  });
});

describe('modifiers', () => {
  it('plays a key pressed with Shift or a lock bit as without it', () => {
    const session = musical();
    expect(session.press('KeyA', MOD_SHIFT)).toEqual([[ON, 60, 100]]);
    expect(session.press('KeyS', MOD_CAPS_LOCK | MOD_NUM_LOCK)).toEqual([[ON, 62, 100]]);
  });

  it('ignores a key pressed with Ctrl, Alt, or Cmd', () => {
    const session = musical();
    for (const mod of [MOD_CTRL, MOD_ALT, MOD_SUPER]) expect(session.press('KeyA', mod)).toEqual([]);
    expect(session.release('KeyA')).toEqual([]);
  });

  it('ends a note on a release that carries Ctrl', () => {
    const session = musical();
    session.press('KeyA');
    expect(session.handleKey('KeyA', 'release', MOD_CTRL)).toEqual([[OFF, 60, 0]]);
  });
});

describe('controls', () => {
  it('bends while held and returns to center on release', () => {
    const session = musical();
    expect(session.press('Period')).toEqual([[BEND, 0x7f, 0x7f]]);
    expect(session.release('Period')).toEqual([[BEND, 0, 64]]);
    expect(session.press('Comma')).toEqual([[BEND, 0, 0]]);
    expect([bendValue(1), bendValue(0), bendValue(-1), bendValue(0.5)]).toEqual([16383, 8192, 0, 12288]);
  });

  it('sets a controller in set mode', () => {
    const session = new KeysSession(WHEEL_STEPS);
    expect(session.press('Digit5')).toEqual([[CC, 1, 51]]);
    expect(session.release('Digit5')).toEqual([]);
    expect(session.press('Digit3')).toEqual([[CC, 1, 0]]);
  });

  it('remembers the bend while its key is held', () => {
    const session = musical();
    session.press('Comma');
    expect(session.bend).toBe(-1);
    session.release('Comma');
    expect(session.bend).toBe(0);
    session.press('Period');
    expect(session.bend).toBe(1);
    session.releaseAll();
    expect(session.bend).toBe(0);
  });

  it('remembers the modulation wheel it last set', () => {
    const session = new KeysSession(WHEEL_STEPS);
    expect(session.mod).toBe(0);
    expect(session.press('Digit6')).toEqual([[CC, 1, 76]]);
    session.release('Digit6');
    expect(session.mod).toBe(76);
    session.press('Digit3');
    expect(session.mod).toBe(0);
    const held = new KeysSession(parseKeymap('name: held\nnotes: { KeyA: 0 }\ncontrols:\n  KeyM: { cc: 1, value: 90, mode: hold }\n', 'held.yaml'));
    held.press('KeyM');
    expect(held.mod).toBe(90);
    held.release('KeyM');
    expect(held.mod).toBe(0);
  });

  it('holds a controller in hold mode', () => {
    const session = musical();
    expect(session.press('Tab')).toEqual([[CC, 64, 127]]);
    expect(session.release('Tab')).toEqual([[CC, 64, 0]]);
  });

  it('alternates a controller in toggle mode', () => {
    const session = new KeysSession(
      parseKeymap('name: t\nnotes: { KeyA: 0 }\ncontrols: { Space: { cc: 64, mode: toggle } }\n', 't.yaml'),
    );
    expect(session.press('Space')).toEqual([[CC, 64, 127]]);
    expect(session.release('Space')).toEqual([]);
    expect(session.press('Space')).toEqual([[CC, 64, 0]]);
  });

  it('turns a toggled controller off at quit, at panic, and on reload', () => {
    const keymap = parseKeymap(
      'name: t\nnotes: { KeyA: 0 }\ncontrols: { Space: { cc: 64, mode: toggle }, Backquote: panic }\n',
      't.yaml',
    );
    const atQuit = new KeysSession(keymap);
    atQuit.press('Space');
    expect(atQuit.quit()).toEqual([
      [CC, 64, 0],
      [CC, 123, 0],
    ]);

    const atPanic = new KeysSession(keymap);
    atPanic.press('Space');
    expect(atPanic.press('Backquote')).toEqual([
      [CC, 64, 0],
      [CC, 123, 0],
    ]);
    expect(atPanic.quit()).toEqual([[CC, 123, 0]]);

    const atReload = new KeysSession(keymap);
    atReload.press('Space');
    expect(atReload.setKeymap(keymap)).toEqual([[CC, 64, 0]]);
    expect(atReload.press('Space')).toEqual([[CC, 64, 127]]);
  });

  it('changes velocity within 1 to 127', () => {
    const session = musical();
    session.press('KeyV');
    session.press('KeyV');
    expect(session.velocity).toBe(127);
    expect(session.press('KeyA')).toEqual([[ON, 60, 127]]);
    for (let i = 0; i < 10; i++) session.press('KeyC');
    expect(session.velocity).toBe(1);
  });

  it('refuses a transpose that would move a note outside MIDI range', () => {
    const session = musical();
    for (let i = 0; i < 4; i++) session.press('KeyX');
    expect(session.transpose).toBe(48);
    session.press('KeyX');
    expect(session.transpose).toBe(48);
    expect(session.message).toMatch(/transpose \+60 would move a note outside MIDI's range/);
    for (let i = 0; i < 10; i++) session.press('KeyZ');
    expect(session.transpose).toBe(-60);
  });

  it('panics: every note off, then All Notes Off', () => {
    const session = new KeysSession(
      parseKeymap('name: p\nnotes: { KeyA: 0, KeyS: 2 }\ncontrols: { Backquote: panic }\n', 'p.yaml'),
    );
    session.press('KeyA');
    session.press('KeyS');
    expect(session.press('Backquote')).toEqual([
      [OFF, 60, 0],
      [OFF, 62, 0],
      [CC, 123, 0],
    ]);
    expect(session.release('KeyA')).toEqual([]);
  });
});

describe('releasing everything', () => {
  it('releases held notes and held controls on focus-out', () => {
    const session = musical();
    session.press('KeyA');
    session.press('Tab');
    session.press('Period');
    expect(session.releaseAll()).toEqual([
      [OFF, 60, 0],
      [CC, 64, 0],
      [BEND, 0, 64],
    ]);
    expect(session.release('KeyA')).toEqual([]);
  });

  it('quits with note-offs, then All Notes Off', () => {
    const session = musical();
    session.press('KeyA');
    session.press('KeyS');
    session.press('KeyD');
    expect(session.quit()).toEqual([
      [OFF, 60, 0],
      [OFF, 62, 0],
      [OFF, 64, 0],
      [CC, 123, 0],
    ]);
  });
});

describe('reloading the keymap', () => {
  it('finishes sounding notes on their old channel and plays the new keymap next', () => {
    const session = new KeysSession(parseKeymap('name: a\nnotes: { KeyA: 0 }\n', 'a.yaml'));
    session.press('KeyA');
    session.setKeymap(parseKeymap('name: a\nchannel: 2\nnotes: { KeyA: 2 }\n', 'a.yaml'));
    expect(session.release('KeyA')).toEqual([[OFF, 60, 0]]);
    expect(session.press('KeyA')).toEqual([[0x91, 62, 100]]);
  });

  it('resets a transpose the reloaded keymap cannot hold', () => {
    const session = musical();
    for (let i = 0; i < 4; i++) session.press('KeyX');
    session.setKeymap(parseKeymap('name: high\nbase: 100\nnotes: { KeyA: 0 }\n', 'high.yaml'));
    expect(session.transpose).toBe(0);
    expect(session.message).toMatch(/transpose reset/);
  });
});

describe('knobs', () => {
  const juno = loadKnobs(join(import.meta.dirname, '..', '..', 'examples', 'bloom', 'shared', 'instruments', 'juno.knobs.yaml'));
  const withJuno = (): KeysSession => new KeysSession(loadKeymap(join(builtinKeymapDir(), 'musical.yaml')), knobList([{ name: 'juno', knobs: juno }]));
  const label = (session: KeysSession): string => session.knobs[session.chosen]!.label;

  it('chooses with knob, wrapping both ways, and sends nothing', () => {
    const session = withJuno();
    expect(label(session)).toBe('mod');
    expect(session.press('ArrowLeft')).toEqual([]);
    expect(label(session)).toBe('release');
    session.release('ArrowLeft');
    session.press('ArrowRight');
    expect(label(session)).toBe('mod');
    const far = new KeysSession(parseKeymap('name: f\nnotes: { KeyA: 0 }\ncontrols: { KeyB: { knob: 7 } }\n', 'f.yaml'), session.knobs);
    far.press('KeyB');
    expect(label(far)).toBe('res');
  });

  it('turns the chosen knob from its default, on the keymap’s channel, and stops at 0 and 127', () => {
    const session = withJuno();
    session.press('ArrowRight');
    // cutoff's default, 2000 Hz, is controller value 82.
    expect(session.press('ArrowUp', 0, 0)).toEqual([[CC, 74, 83]]);
    session.release('ArrowUp');
    expect(session.press('ArrowDown', 0, 0)).toEqual([[CC, 74, 82]]);
    session.release('ArrowDown');
    expect(session.knobValue(juno[0]!)).toBeCloseTo(50 * 300 ** (82 / 127));
    const onTwo = new KeysSession(parseKeymap('name: t\nchannel: 2\nnotes: { KeyA: 0 }\ncontrols: { KeyB: { turn: 200 }, KeyN: { turn: -200 } }\n', 't.yaml'));
    expect(onTwo.press('KeyB')).toEqual([[0xb1, 1, 127]]);
    onTwo.release('KeyB');
    expect(onTwo.press('KeyB')).toEqual([]);
    onTwo.release('KeyB');
    expect(onTwo.press('KeyN')).toEqual([[0xb1, 1, 0]]);
    onTwo.release('KeyN');
    expect(onTwo.press('KeyN')).toEqual([]);
  });

  it('turns faster the longer a turn key is held, one control change a tick', () => {
    const session = musical();
    expect(session.press('ArrowUp', 0, 1000)).toEqual([[CC, 1, 1]]);
    expect(session.ticking()).toBe(true);
    expect(session.tick(1040)).toEqual([]);
    expect(session.tick(1299)).toEqual([]);
    expect(session.tick(1300)).toEqual([[CC, 1, 2]]);
    expect(session.tick(1999)).toEqual([[CC, 1, 3]]);
    expect(session.tick(2000)).toEqual([[CC, 1, 5]]);
    expect(session.tick(2499)).toEqual([[CC, 1, 7]]);
    expect(session.tick(2500)).toEqual([[CC, 1, 11]]);
    expect(session.release('ArrowUp')).toEqual([]);
    expect(session.ticking()).toBe(false);
    expect(session.tick(2540)).toEqual([]);
  });

  it('takes about 2.3 seconds to cross a range, ticked every 40 ms', () => {
    const session = musical();
    session.press('ArrowUp', 0, 0);
    let now = 0;
    while (session.mod < 127) {
      now += 40;
      session.tick(now);
    }
    expect(now).toBeGreaterThan(2200);
    expect(now).toBeLessThan(2400);
  });

  it('turns with the second turn key pressed, and stops on focus-out, panic, and quit', () => {
    const session = musical();
    session.press('ArrowUp', 0, 0);
    expect(session.press('ArrowDown', 0, 100)).toEqual([[CC, 1, 0]]);
    expect(session.release('ArrowUp')).toEqual([]);
    expect(session.ticking()).toBe(true);
    session.releaseAll();
    expect(session.ticking()).toBe(false);
    const panicking = new KeysSession(parseKeymap('name: p\nnotes: { KeyA: 0 }\ncontrols: { KeyB: { turn: 1 }, KeyN: panic }\n', 'p.yaml'));
    panicking.press('KeyB', 0, 0);
    panicking.press('KeyN');
    expect(panicking.ticking()).toBe(false);
    panicking.press('KeyB', 0, 0);
    panicking.quit();
    expect(panicking.ticking()).toBe(false);
  });

  it('moves mod from a cc 1 key as well as by turning it', () => {
    const session = new KeysSession(
      parseKeymap('name: w\nnotes: { KeyA: 0 }\ncontrols: { Digit6: { cc: 1, value: 76 }, ArrowUp: { turn: 1 } }\n', 'w.yaml'),
    );
    session.press('Digit6');
    expect(session.knobValue(session.knobs[0]!.knob)).toBe(76);
    expect(session.press('ArrowUp')).toEqual([[CC, 1, 77]]);
  });

  it('keeps values by controller and the choice by name when the knob list changes', () => {
    const session = withJuno();
    session.press('ArrowRight');
    session.release('ArrowRight');
    session.press('ArrowRight');
    session.release('ArrowRight');
    session.press('ArrowUp');
    session.release('ArrowUp');
    expect(label(session)).toBe('res');
    session.setKnobs(knobList([{ name: 'juno', knobs: [juno[1]!, juno[0]!] }]));
    expect(label(session)).toBe('res');
    expect(session.chosen).toBe(1);
    expect(session.controllers.get(71)).toBe(41);
    session.setKnobs(knobList([{ name: 'juno', knobs: [juno[0]!] }]));
    expect(session.chosen).toBe(1);
    expect(label(session)).toBe('cutoff');
  });

  it('binds the knobs only in a keymap with a knob action', () => {
    expect(musical().bindsKnobs()).toBe(true);
    expect(new KeysSession(loadKeymap(join(builtinKeymapDir(), 'tracker.yaml'))).bindsKnobs()).toBe(false);
    expect(new KeysSession(parseKeymap('name: t\nnotes: { KeyA: 0 }\ncontrols: { Digit1: { type: 1 } }\n', 't.yaml')).bindsKnobs()).toBe(true);
  });
});

describe('typing a knob\'s value', () => {
  const juno = loadKnobs(join(import.meta.dirname, '..', '..', 'examples', 'bloom', 'shared', 'instruments', 'juno.knobs.yaml'));
  const onCutoff = (): KeysSession => {
    const session = new KeysSession(loadKeymap(join(builtinKeymapDir(), 'musical.yaml')), knobList([{ name: 'juno', knobs: juno }]));
    session.press('ArrowRight');
    session.release('ArrowRight');
    return session;
  };
  const type = (session: KeysSession, keys: string[], now = 0): MidiMessage[] =>
    keys.flatMap((key) => {
      const sent = session.press(key, 0, now);
      session.release(key);
      return sent;
    });

  it('opens an entry on the first typing key and sends nothing until it completes', () => {
    const session = onCutoff();
    expect(type(session, ['Digit8', 'Digit0', 'Digit0'])).toEqual([]);
    expect(session.entry).toEqual({ label: 'cutoff', text: '800' });
    expect(session.ticking()).toBe(false);
  });

  it('types the decimal point on Period only while an entry is open, and bends otherwise', () => {
    const session = onCutoff();
    expect(session.press('Period')).toEqual([[BEND, 0x7f, 0x7f]]);
    session.release('Period');
    type(session, ['Digit0']);
    expect(session.press('Period')).toEqual([]);
    expect(session.bend).toBe(0);
    session.release('Period');
    expect(session.entry?.text).toBe('0.');
  });

  it('ends a bend Period began on its release, even after an entry opened', () => {
    const session = onCutoff();
    session.press('Period');
    type(session, ['Digit1']);
    expect(session.release('Period')).toEqual([[BEND, 0, 64]]);
    expect(session.entry?.text).toBe('1');
  });

  it('ignores a second decimal point and a minus sign after the first character, and cannot open on a point', () => {
    const session = onCutoff();
    session.press('Period');
    session.release('Period');
    expect(session.entry).toBeUndefined();
    type(session, ['Minus', 'Digit1', 'Period', 'Digit5', 'Period', 'Minus', 'Digit2']);
    expect(session.entry?.text).toBe('-1.52');
  });

  it('deletes on Backspace and closes an empty entry', () => {
    const session = onCutoff();
    type(session, ['Digit1', 'Digit2', 'Backspace', 'Digit5']);
    expect(session.entry?.text).toBe('15');
    type(session, ['Backspace', 'Backspace']);
    expect(session.entry).toBeUndefined();
    expect(type(session, ['Backspace', 'Enter'])).toEqual([]);
  });

  it('cancels on Escape, and says Ctrl-C quits when no entry is open', () => {
    const session = onCutoff();
    type(session, ['Digit1', 'Digit2', 'Escape']);
    expect(session.entry).toBeUndefined();
    expect(session.message).toBeUndefined();
    expect(session.controllers.has(74)).toBe(false);
    type(session, ['Escape']);
    expect(session.message).toBe('Ctrl-C quits');
  });

  it('lets a note play while an entry is open', () => {
    const session = onCutoff();
    type(session, ['Digit8']);
    expect(session.press('KeyA')).toEqual([[ON, 60, 100]]);
    expect(session.entry?.text).toBe('8');
  });

  it('glides a completed value to its nearest controller value, one control change a tick', () => {
    const session = onCutoff();
    type(session, ['Digit9', 'Digit9', 'Digit9', 'Digit9', 'Digit9', 'Enter']);
    let now = 0;
    while (session.ticking()) session.tick((now += 40));
    expect(session.controllers.get(74)).toBe(127);
    expect(type(session, ['Digit8', 'Digit0', 'Digit0', 'Enter'], now)).toEqual([]);
    const sent: MidiMessage[][] = [];
    while (session.ticking()) sent.push(session.tick((now += 40)));
    expect(sent).toHaveLength(13);
    expect(sent.every((tick) => tick.length === 1)).toBe(true);
    expect(sent.at(-1)).toEqual([[CC, 74, 62]]);
  });

  it('sets a value at once with glide 0', () => {
    const session = new KeysSession(
      parseKeymap('name: g\nnotes: { KeyA: 0 }\ncontrols: { Digit6: { type: 6 }, Digit4: { type: 4 } }\n', 'g.yaml'),
    );
    expect(type(session, ['Digit6', 'Digit4', 'Enter'])).toEqual([[CC, 1, 64]]);
    expect(session.ticking()).toBe(false);
  });

  it('completes before a knob action: a move glides on, and a turn stops the glide it started', () => {
    const session = onCutoff();
    type(session, ['Digit3', 'Digit0', 'Digit0']);
    expect(session.press('ArrowRight', 0, 0)).toEqual([]);
    session.release('ArrowRight');
    expect(session.knobs[session.chosen]!.label).toBe('res');
    expect(session.ticking()).toBe(true);
    let now = 0;
    while (session.ticking()) session.tick((now += 40));
    expect(session.controllers.get(74)).toBe(nearestTo300);
    session.press('ArrowLeft');
    session.release('ArrowLeft');
    type(session, ['Digit1', 'Digit5', 'Digit0', 'Digit0', 'Digit0', 'Enter'], now);
    session.tick(now + 120);
    const stoppedAt = session.controllers.get(74)!;
    type(session, ['Digit8']);
    expect(session.press('ArrowUp', 0, now + 130)).toEqual([[CC, 74, stoppedAt + 1]]);
    session.release('ArrowUp');
    expect(session.ticking()).toBe(false);
  });

  it('stops every glide on panic and on a keymap reload, which also closes the entry', () => {
    const panicking = new KeysSession(
      parseKeymap('name: p\nglide: 1\nnotes: { KeyA: 0 }\ncontrols: { Digit9: { type: 9 }, KeyN: panic }\n', 'p.yaml'),
    );
    type(panicking, ['Digit9', 'Digit9', 'Enter']);
    expect(panicking.ticking()).toBe(true);
    panicking.press('KeyN');
    expect(panicking.ticking()).toBe(false);
    const reloaded = onCutoff();
    type(reloaded, ['Digit9', 'Digit9', 'Enter', 'Digit5']);
    reloaded.setKeymap(loadKeymap(join(builtinKeymapDir(), 'musical.yaml')));
    expect(reloaded.ticking()).toBe(false);
    expect(reloaded.entry).toBeUndefined();
  });

  it('closes an entry whose knob a knob file reload removes, without completing it', () => {
    const session = onCutoff();
    type(session, ['Digit8']);
    session.setKnobs(knobList([{ name: 'juno', knobs: juno.slice(1) }]));
    expect(session.entry).toBeUndefined();
    expect(session.controllers.has(74)).toBe(false);
  });
});

// cutoff's controller value nearest 300 Hz, which maps to 301 Hz.
const nearestTo300 = 40;

describe('what a take starts from', () => {
  it('lists each controller sent below 120, by channel, the least recently sent first', () => {
    const session = new KeysSession(
      parseKeymap(
        'name: s\nnotes: { KeyA: 0 }\ncontrols: { KeyB: { cc: 74, value: 10 }, KeyN: { cc: 1, value: 64 }, KeyM: { cc: 74, value: 20 }, KeyQ: panic }\n',
        's.yaml',
      ),
    );
    session.press('KeyB');
    session.press('KeyN');
    session.press('KeyM');
    session.press('KeyQ');
    expect(session.sentControllers()).toEqual([
      { channel: 1, cc: 1, value: 64 },
      { channel: 1, cc: 74, value: 20 },
    ]);
  });
});
