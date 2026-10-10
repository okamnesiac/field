import { KeysHelper, SOURCE_NAME } from '../keys/helper.js';
import { loadKeymap, resolveKeymapSource, watchKeymap, type KeymapSource } from '../keys/keymap.js';
import { charactersToPositions, PressedKeys, unplayablePositions, type KeyboardLayout } from '../keys/position.js';
import { printKeymap } from '../keys/print.js';
import { KeysSession, type MidiMessage } from '../keys/session.js';
import { decodeTerminal, ENABLE, isQuit, probeKittyProtocol, RESTORE, type Tty } from '../keys/terminal.js';
import type { Keymap } from '../schema/keymap.js';

export const UNSUPPORTED_TERMINAL =
  'field keys needs a terminal that reports key releases through the kitty keyboard protocol: ' +
  'Ghostty, iTerm2 3.5 or later, kitty, or WezTerm. This terminal did not answer the protocol probe.';

export interface KeysOptions {
  keymap?: string;
  print?: boolean;
}

export async function keysCommand(options: KeysOptions): Promise<void> {
  const source = resolveKeymapSource(options.keymap);
  const keymap = loadKeymap(source.path);
  if (options.print === true) {
    process.stdout.write(printKeymap(keymap));
    return;
  }
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('field keys reads the keyboard, so it needs a terminal on stdin and stdout');
  }
  await withKittyKeyboard({ stdin, stdout }, (rest) => play({ stdin, stdout }, source, keymap, rest));
}

// Raw mode and the protocol flags are the terminal's state, not ours, so
// every way out gives them back: a return, a throw, and a crash.
async function withKittyKeyboard(tty: Tty, run: (rest: string) => Promise<void>): Promise<void> {
  let enabled = false;
  const restore = (): void => {
    if (enabled) tty.stdout.write(RESTORE);
    enabled = false;
    if (tty.stdin.isRaw) tty.stdin.setRawMode(false);
    tty.stdin.pause();
  };
  process.once('exit', restore);
  try {
    tty.stdin.setRawMode(true);
    tty.stdin.resume();
    const probe = await probeKittyProtocol(tty);
    if (!probe.supported) throw new Error(UNSUPPORTED_TERMINAL);
    tty.stdout.write(ENABLE);
    enabled = true;
    await run(probe.rest);
  } finally {
    restore();
    process.removeListener('exit', restore);
  }
}

async function play(tty: Tty, source: KeymapSource, initial: Keymap, carried: string): Promise<void> {
  const session = new KeysSession(initial);
  let layout: KeyboardLayout | undefined;
  let layoutPositions: ReadonlyMap<string, string> | undefined;
  let reloadError: string | undefined;

  const draw = (): void => {
    // A terminal that reports no size reports 0 columns.
    const width = Math.max(20, (tty.stdout.columns || 80) - 1);
    tty.stdout.write(`\r\x1b[K${statusText(session, layout, reloadError).slice(0, width)}`);
  };

  let stop!: (error?: Error) => void;
  const stopped = new Promise<Error | undefined>((resolve) => {
    stop = resolve;
  });

  // Before the helper starts, because its first keyboard layout report
  // draws the status line.
  tty.stdout.write(`Playing ${initial.name} as the MIDI source "${SOURCE_NAME}". Esc or Ctrl-C quits.\n`);
  if (source.kind === 'file') tty.stdout.write(`Saving ${source.path} reloads it.\n`);

  const helper = await KeysHelper.start(SOURCE_NAME, {
    onKeyboard: (reported) => {
      layout = reported;
      layoutPositions = charactersToPositions(reported);
      draw();
    },
    onExit: (reason) => stop(new Error(`the MIDI helper stopped: ${reason}`)),
  });
  const send = (messages: MidiMessage[]): void => messages.forEach((m) => helper.send(m));

  const stopWatching =
    source.kind === 'file'
      ? watchKeymap(source.path, (result) => {
          if ('error' in result) {
            reloadError = result.error.problems[0];
          } else {
            reloadError = undefined;
            session.setKeymap(result.keymap);
            session.message ??= `reloaded ${result.keymap.name}`;
          }
          draw();
        })
      : undefined;

  const pressed = new PressedKeys();
  let pending = carried;
  const onData = (chunk: Buffer): void => {
    const { events, rest } = decodeTerminal(pending + chunk.toString('utf8'));
    pending = rest;
    for (const event of events) {
      if (isQuit(event)) return stop();
      if (event.kind === 'focus' && !event.focused) {
        send(session.releaseAll());
        pressed.clear();
      }
      if (event.kind === 'key') {
        const position = pressed.resolve(event, layoutPositions);
        if (position !== undefined) send(session.handleKey(position, event.type, event.mods));
      }
    }
    draw();
  };
  const onSignal = (): void => stop();

  draw();
  tty.stdin.on('data', onData);
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(signal, onSignal);

  const error = await stopped;

  tty.stdin.removeListener('data', onData);
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.removeListener(signal, onSignal);
  stopWatching?.();
  send(session.quit());
  await helper.close();
  tty.stdout.write('\n');
  if (error !== undefined) throw error;
}

function statusText(session: KeysSession, layout: KeyboardLayout | undefined, reloadError: string | undefined): string {
  const transpose = session.transpose > 0 ? `+${session.transpose}` : `${session.transpose}`;
  const notes = session.soundingNotes();
  const parts = [
    SOURCE_NAME,
    session.keymap.name,
    `transpose ${transpose}`,
    `velocity ${session.velocity}`,
    notes.length > 0 ? notes.join(' ') : '–',
  ];
  const unplayable = unplayablePositions(layout, session.keymap);
  if (unplayable.length > 0) parts.push(`${unplayable.join(', ')} cannot play on ${layout!.name}`);
  if (reloadError !== undefined) parts.push(`keymap not reloaded: ${reloadError}`);
  if (session.message !== undefined) parts.push(session.message);
  return parts.join(' · ');
}
