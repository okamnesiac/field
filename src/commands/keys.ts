import { basename } from 'node:path';
import { KeysHelper, SOURCE_NAME } from '../keys/helper.js';
import { loadKeymap, resolveKeymapSource, watchKeymap, type KeymapSource } from '../keys/keymap.js';
import { charactersToPositions, PressedKeys, unplayablePositions, type KeyboardLayout } from '../keys/position.js';
import { printKeymap, signed } from '../keys/print.js';
import { KeysSession, type MidiMessage } from '../keys/session.js';
import { decodeTerminal, ENABLE, isQuit, probeKittyProtocol, RESTORE, type Tty } from '../keys/terminal.js';
import { routeArmed, type Routing, type Unrouted } from '../keys/routing.js';
import { resolveKeysTargets, type ArmedInstrument } from '../keys/targets.js';
import { findProjectRoot } from '../model/project.js';
import { VoiceHost, type VoiceHostStatus } from '../keys/voice-host.js';
import { watchText } from '../keys/watch.js';
import type { Keymap } from '../schema/keymap.js';

export const UNSUPPORTED_TERMINAL =
  'field keys needs a terminal that reports key releases through the kitty keyboard protocol: ' +
  'Ghostty, iTerm2 3.5 or later, kitty, or WezTerm. This terminal did not answer the protocol probe.';

export interface KeysOptions {
  keymap?: string;
  print?: boolean;
  device?: string;
}

export async function keysCommand(targets: string[], options: KeysOptions): Promise<void> {
  const source = resolveKeymapSource(options.keymap);
  const keymap = loadKeymap(source.path);
  if (options.print === true) {
    process.stdout.write(printKeymap(keymap));
    return;
  }
  const armed = resolveKeysTargets(targets);
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('field keys reads the keyboard, so it needs a terminal on stdin and stdout');
  }
  const root = findProjectRoot(process.cwd());
  await withKittyKeyboard({ stdin, stdout }, (rest) =>
    play({ stdin, stdout }, { source, keymap, armed, device: options.device, root }, rest),
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
  armed: ArmedInstrument[];
  device: string | undefined;
  root: string | undefined;
}

export type InstrumentState = {
  name: string; // what is armed, as the line names it
  dry: string[]; // tracks whose effects the voices do not pass through yet
  // Why the voices do not pass through them (live-supercollider.md
  // chunk 3), when routing them was not possible.
  dryReason?: string;
  status: Extract<VoiceHostStatus, { state: 'live' | 'restarting' }> | { state: 'starting' };
  // What the last save of the program did (keyboard-instrument.md §14).
  reload?: { loaded: true } | { failed: string };
};

async function play(tty: Tty, options: PlayOptions, carried: string): Promise<void> {
  // Armed tracks play through their effects when the daemon can take
  // their voices (live-supercollider.md chunk 3): each track then gets a
  // voice of its own, writing into its own input. Otherwise each program
  // plays once, straight to the device, and the line says why.
  const routed =
    options.root !== undefined
      ? await routeArmed(options.armed, options.root, options.device !== undefined ? { device: options.device } : {})
      : undefined;
  const routing = routed !== undefined && 'programs' in routed ? routed : undefined;
  try {
    await playRouted(tty, options, carried, routed, routing);
  } finally {
    // However the session ends, a throw included, its inputs close; a
    // process killed outright has the daemon close them with its
    // connection.
    await routing?.close();
  }
}

async function playRouted(
  tty: Tty,
  options: PlayOptions,
  carried: string,
  routed: Routing | Unrouted | undefined,
  routing: Routing | undefined,
): Promise<void> {
  const { source, armed } = options;
  const programs = routing?.programs ?? [...new Set(armed.map((a) => a.program))];
  const session = new KeysSession(options.keymap);
  let layout: KeyboardLayout | undefined;
  let layoutPositions: ReadonlyMap<string, string> | undefined;
  let reloadError: string | undefined;
  const instrument = instrumentState(armed, routing !== undefined, routed !== undefined && 'reason' in routed ? routed.reason : undefined);

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
  // A routed voice is heard on the daemon's device, so it is made there.
  const device = routing !== undefined ? routing.device : (options.device ?? helper.defaultOutput);
  const host =
    programs.length > 0
      ? await VoiceHost.start({
          instruments: programs,
          ...(device !== undefined ? { device } : {}),
          ...(routing !== undefined ? { rings: routing.rings, fieldOut: routing.fieldOut } : {}),
          onStatus: (status) => {
            if (status.state === 'voice') return;
            if (status.state === 'reloaded') instrument!.reload = { loaded: true };
            else if (status.state === 'reload-failed') instrument!.reload = { failed: status.reason };
            else instrument!.status = status;
            draw();
          },
          onExit: (reason) => stop(new Error(`the voice host stopped: ${reason}`)),
        })
      : undefined;
  host?.ready.catch((err: Error) => stop(new Error(`the voice host did not start: ${err.message}`)));

  // Saving a program loads it again, as saving a keymap does
  // (keyboard-instrument.md §14).
  const stopWatchingPrograms = host !== undefined ? programs.map((p) => watchText(p, () => void host.reload())) : [];
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
  stopWatchingPrograms.forEach((stopWatchingProgram) => stopWatchingProgram());
  send(session.quit());
  // A host still booting closes too: quitting never waits for it. The
  // inputs close after it, in play, once nothing writes them.
  await host?.close();
  await helper.close();
  tty.stdout.write('\n');
  if (error !== undefined) throw error;
}

// What the instrument's line starts from: the armed tracks and
// instruments by name, and the tracks whose effects are not heard, which
// is none when the voices pass through them.
export function instrumentState(armed: ArmedInstrument[], heard = false, dryReason?: string): InstrumentState | undefined {
  if (armed.length === 0) return undefined;
  const dry = heard ? [] : [...new Set(armed.flatMap((a) => a.unheardEffects))];
  return {
    name: armed.map(armedName).join(' + '),
    dry,
    ...(dry.length > 0 && dryReason !== undefined ? { dryReason } : {}),
    status: { state: 'starting' },
  };
}

// A save that did not load leads with why, so a narrow terminal keeps the
// error rather than the device; the voice that loaded last still plays.
export function instrumentText({ name, dry, dryReason, status, reload }: InstrumentState): string {
  if (reload !== undefined && 'failed' in reload) return `${name} kept its last voice: ${reload.failed}`;
  const state =
    status.state === 'live'
      ? `${name} live at ${status.sampleRate} Hz on ${status.device}`
      : status.state === 'restarting'
        ? `${name} restarting for a new sample rate`
        : `${name} starting`;
  // The voice plays straight to the device, so a track's inserts are not
  // heard (arming.md §2.1); routing them was not possible, and the reason
  // says why (live-supercollider.md chunk 3).
  const why = dryReason !== undefined ? ` (${dryReason})` : '';
  const unheard = dry.length > 0 ? ` · dry: the effects on ${dry.join(', ')} are not heard${why}` : '';
  return `${state}${reload === undefined ? '' : ' · reloaded'}${unheard}`;
}

// A track names itself and its instrument; an instrument given by program
// names only itself.
function armedName(armed: ArmedInstrument): string {
  const program = basename(armed.program, '.scd');
  return armed.track === undefined ? program : `${armed.track.split('/').pop()} (${program})`;
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
  const bends = session.bends();
  if (bends.length > 0 || session.bend !== 0) parts.push(`bend ${bendText(session.bend, bends)}`);
  if (session.setsMod() || session.mod !== 0) parts.push(`mod ${session.mod}`);
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

// A pitch-bend message carries the bend in steps of 1/8192, about 0.0001,
// so four decimal places show it as finely as it is sent.
const BEND_PLACES = 4;

// Every bend prints with its sign and with the decimal places the finest
// bend in the keymap needs, so bending a held chord does not move the
// notes after it.
function bendText(bend: number, bends: number[]): string {
  const places = Math.max(...[bend, ...bends].map(decimalPlaces));
  return `${bend < 0 ? '-' : '+'}${Math.abs(bend).toFixed(places)}`;
}

function decimalPlaces(x: number): number {
  let places = 0;
  while (places < BEND_PLACES && Number(x.toFixed(places)) !== x) places++;
  return places;
}
