// The terminal side of `field keys` (keyboard-instrument.md §2.2): the
// kitty keyboard protocol, which reports press, repeat, and release
// events for a program that asks, and focus reports so a lost release
// cannot leave a note stuck.

const CSI = '\x1b[';

// Flags 1, 2, 4, and 8: disambiguate, report event types, report
// alternate keys (the base layout key), and report every key as an
// escape code, which is what gives letter keys release events.
export const KITTY_FLAGS = 1 | 2 | 4 | 8;

export const PROBE = `${CSI}?u${CSI}c`;
export const ENABLE = `${CSI}>${KITTY_FLAGS}u${CSI}?1004h`;
export const RESTORE = `${CSI}<u${CSI}?1004l`;

export const MOD_SHIFT = 1;
export const MOD_ALT = 2;
export const MOD_CTRL = 4;
export const MOD_SUPER = 8;
export const MOD_HYPER = 16;
export const MOD_META = 32;
export const MOD_CAPS_LOCK = 64;
export const MOD_NUM_LOCK = 128;

export type KeyEventType = 'press' | 'repeat' | 'release';

export type TerminalEvent =
  | {
      kind: 'key';
      // The key's Unicode code point in the active keyboard layout,
      // unshifted, or a name for a key that types nothing.
      key: number | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
      base?: number;
      mods: number;
      type: KeyEventType;
    }
  | { kind: 'focus'; focused: boolean }
  | { kind: 'flags'; flags: number }
  | { kind: 'attributes' }
  | { kind: 'interrupt' };

const ARROWS = { A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft' } as const;
const EVENT_TYPES: Record<string, KeyEventType> = { '1': 'press', '2': 'repeat', '3': 'release' };

function modifiersField(field: string | undefined): { mods: number; type: KeyEventType } {
  const [mods, type] = (field ?? '').split(':');
  // The protocol encodes modifiers as one plus their bits.
  const encoded = mods === undefined || mods === '' ? 1 : Number(mods);
  return { mods: Math.max(0, encoded - 1), type: EVENT_TYPES[type ?? ''] ?? 'press' };
}

function decodeSequence(params: string, final: string): TerminalEvent | undefined {
  if (final === 'u') {
    if (params.startsWith('?')) return { kind: 'flags', flags: Number(params.slice(1)) || 0 };
    const [keyField, modField] = params.split(';');
    const [code, , base] = (keyField ?? '').split(':');
    const key = Number(code);
    if (!Number.isInteger(key) || key <= 0) return undefined;
    const { mods, type } = modifiersField(modField);
    const event: TerminalEvent = { kind: 'key', key, mods, type };
    if (base !== undefined && base !== '') event.base = Number(base);
    return event;
  }
  if (final === 'c' && params.startsWith('?')) return { kind: 'attributes' };
  if ((final === 'I' || final === 'O') && params === '') return { kind: 'focus', focused: final === 'I' };
  if (final in ARROWS) {
    const { mods, type } = modifiersField(params.split(';')[1]);
    return { kind: 'key', key: ARROWS[final as keyof typeof ARROWS], mods, type };
  }
  return undefined;
}

// Decodes what stdin delivered so far. An escape sequence cut off at the
// end of the input comes back as `rest`, to be prefixed to the next
// chunk. Under the protocol every key arrives as an escape sequence, so
// plain bytes are ignored, except Ctrl-C, which raw mode delivers as a
// byte before the protocol is on or if the terminal drops it.
export function decodeTerminal(input: string): { events: TerminalEvent[]; rest: string } {
  const events: TerminalEvent[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === '\x1b') {
      if (i + 1 >= input.length) return { events, rest: input.slice(i) };
      if (input[i + 1] !== '[') {
        i += 2;
        continue;
      }
      let j = i + 2;
      while (j < input.length && /[0-9;:?<>=]/.test(input[j]!)) j++;
      if (j >= input.length) return { events, rest: input.slice(i) };
      const event = decodeSequence(input.slice(i + 2, j), input[j]!);
      if (event !== undefined) events.push(event);
      i = j + 1;
    } else {
      if (input[i] === '\x03') events.push({ kind: 'interrupt' });
      i++;
    }
  }
  return { events, rest: '' };
}

const QUIT_KEYS = { escape: 27, c: 99 };

// Escape always quits, and so does Ctrl-C, so no keymap can trap you
// (keyboard-instrument.md §2.4).
export function isQuit(event: TerminalEvent): boolean {
  if (event.kind === 'interrupt') return true;
  if (event.kind !== 'key' || event.type !== 'press') return false;
  if (event.key === QUIT_KEYS.escape) return true;
  return event.key === QUIT_KEYS.c && (event.mods & MOD_CTRL) !== 0;
}

export interface Tty {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

// Asks the terminal for its protocol flags, then its primary device
// attributes, which every terminal answers. A terminal with the protocol
// answers the first before the second (keyboard-instrument.md §2.2).
// Any key events that arrive meanwhile are returned unconsumed.
export function probeKittyProtocol(tty: Tty, timeoutMs = 2000): Promise<{ supported: boolean; rest: string }> {
  return new Promise((resolve) => {
    let buffered = '';
    let supported = false;
    const finish = (result: boolean): void => {
      clearTimeout(timer);
      tty.stdin.removeListener('data', onData);
      resolve({ supported: result, rest: buffered });
    };
    const onData = (chunk: Buffer): void => {
      const { events, rest } = decodeTerminal(buffered + chunk.toString('utf8'));
      buffered = rest;
      for (const event of events) {
        if (event.kind === 'flags') supported = true;
        if (event.kind === 'attributes') return finish(supported);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    tty.stdin.on('data', onData);
    tty.stdout.write(PROBE);
  });
}
