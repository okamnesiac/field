import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKeymapDir, loadKeymap, parseKeymap } from './keymap.js';
import { bendValue, KeysSession } from './session.js';
import { MOD_ALT, MOD_CAPS_LOCK, MOD_CTRL, MOD_NUM_LOCK, MOD_SHIFT, MOD_SUPER } from './terminal.js';

const ON = 0x90;
const OFF = 0x80;
const CC = 0xb0;
const BEND = 0xe0;

function musicalTyping(): KeysSession {
  return new KeysSession(loadKeymap(join(builtinKeymapDir(), 'musical-typing.yaml')));
}

describe('playing notes', () => {
  it('sends a note-on at press and a note-off at release', () => {
    const session = musicalTyping();
    expect(session.press('KeyA')).toEqual([[ON, 60, 100]]);
    expect(session.soundingNotes()).toEqual(['C4']);
    expect(session.release('KeyA')).toEqual([[OFF, 60, 0]]);
    expect(session.soundingNotes()).toEqual([]);
  });

  it('ignores repeats, so a held key holds one note', () => {
    const session = musicalTyping();
    expect(session.handleKey('KeyA', 'press', 0)).toHaveLength(1);
    expect(session.handleKey('KeyA', 'repeat', 0)).toEqual([]);
    expect(session.handleKey('KeyA', 'repeat', 0)).toEqual([]);
    expect(session.handleKey('KeyA', 'release', 0)).toEqual([[OFF, 60, 0]]);
  });

  it('releases the note a key started even after a transpose', () => {
    const session = musicalTyping();
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
      const session = musicalTyping();
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
    const session = musicalTyping();
    expect(session.press('KeyA', MOD_SHIFT)).toEqual([[ON, 60, 100]]);
    expect(session.press('KeyS', MOD_CAPS_LOCK | MOD_NUM_LOCK)).toEqual([[ON, 62, 100]]);
  });

  it('ignores a key pressed with Ctrl, Alt, or Cmd', () => {
    const session = musicalTyping();
    for (const mod of [MOD_CTRL, MOD_ALT, MOD_SUPER]) expect(session.press('KeyA', mod)).toEqual([]);
    expect(session.release('KeyA')).toEqual([]);
  });

  it('ends a note on a release that carries Ctrl', () => {
    const session = musicalTyping();
    session.press('KeyA');
    expect(session.handleKey('KeyA', 'release', MOD_CTRL)).toEqual([[OFF, 60, 0]]);
  });
});

describe('controls', () => {
  it('bends while held and returns to center on release', () => {
    const session = musicalTyping();
    expect(session.press('Digit2')).toEqual([[BEND, 0x7f, 0x7f]]);
    expect(session.release('Digit2')).toEqual([[BEND, 0, 64]]);
    expect(session.press('Digit1')).toEqual([[BEND, 0, 0]]);
    expect([bendValue(1), bendValue(0), bendValue(-1), bendValue(0.5)]).toEqual([16383, 8192, 0, 12288]);
  });

  it('sets a controller in set mode', () => {
    const session = musicalTyping();
    expect(session.press('Digit5')).toEqual([[CC, 1, 51]]);
    expect(session.release('Digit5')).toEqual([]);
    expect(session.press('Digit3')).toEqual([[CC, 1, 0]]);
  });

  it('remembers the modulation wheel it last set', () => {
    const session = musicalTyping();
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
    const session = musicalTyping();
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
    const session = musicalTyping();
    session.press('KeyV');
    session.press('KeyV');
    expect(session.velocity).toBe(127);
    expect(session.press('KeyA')).toEqual([[ON, 60, 127]]);
    for (let i = 0; i < 10; i++) session.press('KeyC');
    expect(session.velocity).toBe(1);
  });

  it('refuses a transpose that would move a note outside MIDI range', () => {
    const session = musicalTyping();
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
    const session = musicalTyping();
    session.press('KeyA');
    session.press('Tab');
    session.press('Digit2');
    expect(session.releaseAll()).toEqual([
      [OFF, 60, 0],
      [CC, 64, 0],
      [BEND, 0, 64],
    ]);
    expect(session.release('KeyA')).toEqual([]);
  });

  it('quits with note-offs, then All Notes Off', () => {
    const session = musicalTyping();
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
    const session = musicalTyping();
    for (let i = 0; i < 4; i++) session.press('KeyX');
    session.setKeymap(parseKeymap('name: high\nbase: 100\nnotes: { KeyA: 0 }\n', 'high.yaml'));
    expect(session.transpose).toBe(0);
    expect(session.message).toMatch(/transpose reset/);
  });
});
