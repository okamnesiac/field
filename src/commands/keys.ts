import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { KeysHelper, SOURCE_NAME } from '../keys/helper.js';
import { loadKeymap, resolveKeymapSource, watchKeymap, type KeymapSource } from '../keys/keymap.js';
import { charactersToPositions, PressedKeys, unplayablePositions, type KeyboardLayout } from '../keys/position.js';
import { printKeymap, signed } from '../keys/print.js';
import { KeysSession, type MidiMessage } from '../keys/session.js';
import { decodeTerminal, ENABLE, isQuit, probeKittyProtocol, RESTORE, type Tty } from '../keys/terminal.js';
import { instrumentPath, VoiceHost, type VoiceHostStatus } from '../keys/voice-host.js';
import { findProjectRoot } from '../model/project.js';
import type { Keymap } from '../schema/keymap.js';

export const UNSUPPORTED_TERMINAL =
  'field keys needs a terminal that reports key releases through the kitty keyboard protocol: ' +
  'Ghostty, iTerm2 3.5 or later, kitty, or WezTerm. This terminal did not answer the protocol probe.';

export interface KeysOptions {
  keymap?: string;
  print?: boolean;
  device?: string;
}

// A bare instrument name resolves on the project's instruments shelf, as a
// supercollider: entry's source does; a path resolves from the project
// root, or from here outside a project (keyboard-instrument.md §2.1).
export function resolveInstrument(spec: string, cwd = process.cwd()): string {
  const root = findProjectRoot(cwd);
  if (root === undefined && !spec.includes('/')) {
    throw new Error(
      `field keys ${spec}: a bare instrument name resolves in a project's shared/instruments/, ` +
        'and this is not inside a Field project; give the program by path instead',
    );
  }
  const path = instrumentPath(spec, root ?? cwd);
  if (!existsSync(path)) {
    const shelf = root !== undefined ? `\n${describeShelf(root)}` : '';
    throw new Error(`field keys ${spec}: no instrument program at ${path}${shelf}`);
  }
  return path;
}

// The programs on a project's instruments shelf, by name, split by whether
// they can play from notes. A program that never reads FIELD_MODE cannot
// answer voice mode, so its text is enough to tell, without starting
// sclang for each one (keys.md "Make an instrument playable"). Each is
// listed by a name field keys resolves: `.scd` is added back only to a
// name with no extension, so pad.v2.scd lists whole.
function shelfInstruments(root: string): { playable: string[]; renderOnly: string[] } {
  const dir = join(root, 'shared', 'instruments');
  const playable: string[] = [];
  const renderOnly: string[] = [];
  if (!existsSync(dir)) return { playable, renderOnly };
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.scd'))
    .map((entry) => entry.name)
    .sort();
  for (const file of files) {
    const stem = file.slice(0, -'.scd'.length);
    const name = extname(stem) === '' ? stem : file;
    (readFileSync(join(dir, file), 'utf8').includes('FIELD_MODE') ? playable : renderOnly).push(name);
  }
  return { playable, renderOnly };
}

function describeShelf(root: string): string {
  const { playable, renderOnly } = shelfInstruments(root);
  if (playable.length + renderOnly.length === 0) return 'shared/instruments/ has no programs yet.';
  const lines = ['In shared/instruments/:', `  plays from notes: ${playable.length > 0 ? playable.join(', ') : 'none'}`];
  if (renderOnly.length > 0) {
    lines.push(`  renders only:     ${renderOnly.join(', ')} (no FIELD_MODE=voice branch; Field's docs/keys.md says how to add one)`);
  }
  return lines.join('\n');
}

export async function keysCommand(instrument: string | undefined, options: KeysOptions): Promise<void> {
  const source = resolveKeymapSource(options.keymap);
  const keymap = loadKeymap(source.path);
  if (options.print === true) {
    process.stdout.write(printKeymap(keymap));
    return;
  }
  const program = instrument !== undefined ? resolveInstrument(instrument) : undefined;
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('field keys reads the keyboard, so it needs a terminal on stdin and stdout');
  }
  await withKittyKeyboard({ stdin, stdout }, (rest) =>
    play({ stdin, stdout }, { source, keymap, program, device: options.device }, rest),
  );
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

interface PlayOptions {
  source: KeymapSource;
  keymap: Keymap;
  program: string | undefined;
  device: string | undefined;
}

type InstrumentState = { name: string; status: VoiceHostStatus | { state: 'starting' } };

async function play(tty: Tty, options: PlayOptions, carried: string): Promise<void> {
  const { source, program } = options;
  const session = new KeysSession(options.keymap);
  let layout: KeyboardLayout | undefined;
  let layoutPositions: ReadonlyMap<string, string> | undefined;
  let reloadError: string | undefined;
  const instrument: InstrumentState | undefined =
    program !== undefined ? { name: basename(program, '.scd'), status: { state: 'starting' } } : undefined;

  // An instrument has a line of its own above the status line: its state
  // changes a few times a session, the status line with every key. That
  // line is drawn once, then redrawn in place only when its text changes.
  let instrumentLine: string | undefined;
  const draw = (): void => {
    // A terminal that reports no size reports 0 columns.
    const width = Math.max(20, (tty.stdout.columns || 80) - 1);
    let above = '';
    if (instrument !== undefined) {
      const line = instrumentText(instrument).slice(0, width);
      if (instrumentLine === undefined) above = `\r\x1b[K${line}\n`;
      else if (line !== instrumentLine) above = `\x1b[1A\r\x1b[K${line}\n`;
      instrumentLine = line;
    }
    tty.stdout.write(`${above}\r\x1b[K${statusText(session, layout, reloadError, width)}`);
  };

  let stop!: (error?: Error) => void;
  const stopped = new Promise<Error | undefined>((resolve) => {
    stop = resolve;
  });

  // Before the helper starts, because its first keyboard layout report
  // draws the status line.
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

  // The host starts after the helper, so `Field Keys` exists when sclang
  // connects its MIDI inputs; the keyboard plays while it boots.
  const device = options.device ?? helper.defaultOutput;
  const host =
    program !== undefined
      ? await VoiceHost.start({
          instrument: program,
          ...(device !== undefined ? { device } : {}),
          onStatus: (status) => {
            if (status.state === 'voice') return;
            instrument!.status = status;
            draw();
          },
          onExit: (reason) => stop(new Error(`the voice host stopped: ${reason}`)),
        })
      : undefined;
  host?.ready.catch((err: Error) => stop(new Error(`the voice host did not start: ${err.message}`)));

  const stopWatching =
    source.kind === 'file'
      ? watchKeymap(source.path, (result) => {
          if ('error' in result) {
            reloadError = result.error.problems[0];
          } else {
            reloadError = undefined;
            send(session.setKeymap(result.keymap));
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
  // A host still booting closes too: quitting never waits for it.
  await host?.close();
  await helper.close();
  tty.stdout.write('\n');
  if (error !== undefined) throw error;
}

function instrumentText({ name, status }: InstrumentState): string {
  if (status.state === 'live') return `${name} live at ${status.sampleRate} Hz on ${status.device}`;
  if (status.state === 'restarting') return `${name} restarting for a new sample rate`;
  return `${name} starting`;
}

// The sounding notes come last, so playing changes only the end of the
// line and nothing after the notes moves as you play. A line wider than
// the terminal gives up the text before the notes, and the notes only
// when they alone are wider than it.
export function statusText(
  session: KeysSession,
  layout: KeyboardLayout | undefined,
  reloadError: string | undefined,
  width: number,
): string {
  const parts = [SOURCE_NAME, session.keymap.name, `transpose ${signed(session.transpose)}`, `velocity ${session.velocity}`];
  const unplayable = unplayablePositions(layout, session.keymap);
  if (unplayable.length > 0) parts.push(`${unplayable.join(', ')} cannot play on ${layout!.name}`);
  if (reloadError !== undefined) parts.push(`keymap not reloaded: ${reloadError}`);
  if (session.message !== undefined) parts.push(session.message);
  const sounding = session.soundingNotes();
  const notes = sounding.length > 0 ? sounding.join(' ') : '–';
  const head = parts.join(' · ');
  const separator = ' · ';
  if (head.length + separator.length + notes.length <= width) return `${head}${separator}${notes}`;
  const room = width - separator.length - notes.length - 1; // 1 for the ellipsis
  return room > 0 ? `${head.slice(0, room)}…${separator}${notes}` : notes.slice(0, width);
}
