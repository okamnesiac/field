import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  decodeTerminal,
  isQuit,
  MOD_CAPS_LOCK,
  MOD_CTRL,
  MOD_SHIFT,
  PROBE,
  probeKittyProtocol,
  type Tty,
} from './terminal.js';

const CSI = '\x1b[';

describe('decoding kitty key events', () => {
  it('reads press, repeat, and release of a letter', () => {
    expect(decodeTerminal(`${CSI}97u${CSI}97;1:2u${CSI}97;1:3u`).events).toEqual([
      { kind: 'key', key: 97, mods: 0, type: 'press' },
      { kind: 'key', key: 97, mods: 0, type: 'repeat' },
      { kind: 'key', key: 97, mods: 0, type: 'release' },
    ]);
  });

  it('reads the base layout key of a Dvorak o', () => {
    expect(decodeTerminal(`${CSI}111::115u`).events).toEqual([
      { kind: 'key', key: 111, base: 115, mods: 0, type: 'press' },
    ]);
  });

  it('reads modifiers alongside a shifted key', () => {
    expect(decodeTerminal(`${CSI}97:65;2u${CSI}97;${1 + MOD_CAPS_LOCK}:3u`).events).toEqual([
      { kind: 'key', key: 97, mods: MOD_SHIFT, type: 'press' },
      { kind: 'key', key: 97, mods: MOD_CAPS_LOCK, type: 'release' },
    ]);
  });

  it('reads Space, Tab, and the arrows', () => {
    expect(decodeTerminal(`${CSI}32u${CSI}9;1:3u${CSI}D${CSI}1;1:3A`).events).toEqual([
      { kind: 'key', key: 32, mods: 0, type: 'press' },
      { kind: 'key', key: 9, mods: 0, type: 'release' },
      { kind: 'key', key: 'ArrowLeft', mods: 0, type: 'press' },
      { kind: 'key', key: 'ArrowUp', mods: 0, type: 'release' },
    ]);
  });

  it('reads focus reports and probe answers', () => {
    expect(decodeTerminal(`${CSI}O${CSI}I${CSI}?15u${CSI}?62;22c`).events).toEqual([
      { kind: 'focus', focused: false },
      { kind: 'focus', focused: true },
      { kind: 'flags', flags: 15 },
      { kind: 'attributes' },
    ]);
  });

  it('carries a sequence split across chunks over to the next one', () => {
    const first = decodeTerminal(`${CSI}97u${CSI}97;1`);
    expect(first.events).toHaveLength(1);
    expect(first.rest).toBe(`${CSI}97;1`);
    expect(decodeTerminal(`${first.rest}:3u`).events).toEqual([
      { kind: 'key', key: 97, mods: 0, type: 'release' },
    ]);
    expect(decodeTerminal('\x1b')).toEqual({ events: [], rest: '\x1b' });
  });

  it('ignores sequences it does not know and plain text', () => {
    expect(decodeTerminal(`${CSI}15~${CSI}200~abc`).events).toEqual([]);
  });

  it('passes a modifier key through as a key no position types', () => {
    // Under flag 8 the left Shift key reports itself as 57441.
    expect(decodeTerminal(`${CSI}57441u`).events).toEqual([{ kind: 'key', key: 57441, mods: 0, type: 'press' }]);
  });
});

describe('quitting', () => {
  it('quits on Escape, on Ctrl-C, and on a raw Ctrl-C byte', () => {
    for (const input of [`${CSI}27u`, `${CSI}99;${1 + MOD_CTRL}u`, '\x03']) {
      const [event] = decodeTerminal(input).events;
      expect(isQuit(event!)).toBe(true);
    }
  });

  it('quits on Ctrl at the c position under a layout with no c', () => {
    // Russian: the key at the US c position types с (U+0441).
    const [russian] = decodeTerminal(`${CSI}1089::99;${1 + MOD_CTRL}u`).events;
    expect(isQuit(russian!)).toBe(true);
  });

  it('does not take Ctrl at the c position for Ctrl-C where that key types ASCII', () => {
    // Dvorak: the key at the US c position types j.
    const [dvorak] = decodeTerminal(`${CSI}106::99;${1 + MOD_CTRL}u`).events;
    expect(isQuit(dvorak!)).toBe(false);
  });

  it('does not quit on a plain c, on a release, or on a repeat', () => {
    for (const input of [`${CSI}99u`, `${CSI}27;1:3u`, `${CSI}99;5:2u`]) {
      const [event] = decodeTerminal(input).events;
      expect(isQuit(event!)).toBe(false);
    }
  });
});

describe('probing for the protocol', () => {
  function fakeTty(): { tty: Tty; written: string[]; reply: (text: string) => void } {
    const stdin = new PassThrough();
    const written: string[] = [];
    const stdout = { write: (text: string) => written.push(text) };
    return {
      tty: { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream },
      written,
      reply: (text) => stdin.write(text),
    };
  }

  it('is supported when the flags answer comes before the attributes answer', async () => {
    const { tty, written, reply } = fakeTty();
    const result = probeKittyProtocol(tty);
    expect(written).toEqual([PROBE]);
    reply(`${CSI}?0u`);
    reply(`${CSI}?62c`);
    expect(await result).toEqual({ supported: true, rest: '' });
  });

  it('is unsupported when only the attributes answer comes', async () => {
    const { tty, reply } = fakeTty();
    const result = probeKittyProtocol(tty);
    reply(`${CSI}?62;22c`);
    expect((await result).supported).toBe(false);
  });

  it('drops complete key events that arrive during the probe, and returns only a cut-off sequence', async () => {
    const { tty, reply } = fakeTty();
    const result = probeKittyProtocol(tty);
    reply(`${CSI}97u${CSI}?15u${CSI}?62c${CSI}115u${CSI}1`);
    expect(await result).toEqual({ supported: true, rest: `${CSI}1` });
  });

  it('is unsupported when the terminal answers nothing', async () => {
    const { tty } = fakeTty();
    expect((await probeKittyProtocol(tty, 30)).supported).toBe(false);
  });
});
