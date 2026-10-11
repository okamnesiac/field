import { AudiodClient } from '../audiod/client.js';
import { compileSession, type SessionInput } from '../graph/live.js';
import type { ArmedInstrument } from './targets.js';
import { fieldOutPluginDir } from './voice-host.js';

// Playing through the effects (live-supercollider.md chunk 3): each armed
// track gets an input in the daemon, the song's live session is loaded
// with those inputs, and the voice host writes each track's voice into
// its input's ring through FieldOut. An instrument armed by name, with no
// track, still plays straight to the device.
export interface Routing {
  // One program per armed entry, in order: a track gets its own voice,
  // even when it shares a program with another, because its voice goes to
  // its own ring.
  programs: string[];
  // Each entry's ring, or null for one that plays straight to the device.
  rings: (number | null)[];
  fieldOut: string;
  // The daemon's output device, which the voice host must boot on so the
  // two share a clock; undefined when the daemon names none (null output).
  device: string | undefined;
  // Whether FieldOut is writing every ring this routing opened, within
  // `ms`: FieldOut writes every block, silence included, so a ring that
  // stays empty means scsynth never ran the route.
  flowing(ms?: number): Promise<boolean>;
  // Closes every input this routing opened and loads the song again with
  // whatever inputs others still hold, so the daemon is not left reading
  // rings nobody writes.
  close(): Promise<void>;
}

// Why the voice plays dry instead, said on the instrument's line.
export interface Unrouted {
  reason: string;
}

const KEYS_INPUT = /^keys:([^/]+)\/(.+)$/;

// The open `field keys` inputs for `song`, as `compileSession` takes them:
// every command that loads that song's session compiles them in, so a
// reload from `field play`, its watch, `field ui`, or `field record` keeps
// a routed voice heard.
export async function keysInputsFor(client: AudiodClient, song: string): Promise<SessionInput[]> {
  if (!client.supports('live-input')) return [];
  const { inputs } = await client.status();
  return (inputs ?? []).flatMap(({ name }) => {
    const match = KEYS_INPUT.exec(name);
    return match !== null && match[1] === song ? [{ track: match[2]!, input: name }] : [];
  });
}

export async function routeArmed(
  armed: ArmedInstrument[],
  root: string,
  options: { device?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Routing | Unrouted | undefined> {
  const tracks = armed.filter((a) => a.track !== undefined);
  if (tracks.length === 0) return undefined;
  const songs = [...new Set(tracks.map((a) => a.track!.split('/')[0]!))];
  if (songs.length > 1) return { reason: `the tracks are in ${songs.join(' and ')}, and one session plays one song` };
  if (process.platform === 'win32') return { reason: 'live inputs need POSIX shared memory, which Windows does not have yet' };
  const fieldOut = fieldOutPluginDir(options.env);
  if (fieldOut === undefined) {
    const named = (options.env ?? process.env)['FIELD_FIELDOUT'];
    return {
      reason:
        named !== undefined && named !== ''
          ? `FIELD_FIELDOUT names ${named}, which holds no FieldOut plugin`
          : 'FieldOut is not built: run pnpm build:native',
    };
  }

  let client: AudiodClient;
  try {
    client = await AudiodClient.connect(root);
  } catch (err) {
    return { reason: `field-audiod did not answer: ${(err as Error).message.split('\n')[0]!}` };
  }
  const opened: string[] = [];
  const song = songs[0]!;
  const closeOpened = async (): Promise<void> => {
    for (const name of opened.splice(0)) await client.closeInput(name).catch(() => {});
  };
  // The song with whatever inputs are open now, others' included, and
  // whatever the session loaded now was compiled and set with: its loop,
  // its region, and its solo. A field keys load changes only the inputs.
  const reload = async (): Promise<void> => {
    const status = await client.status();
    const same = status.live === true && status.song === song;
    const { session } = await compileSession(root, song, {
      ...(same && status.looping === true ? { loop: true } : {}),
      ...(same && status.solo !== undefined ? { solo: status.solo } : {}),
      inputs: await keysInputsFor(client, song),
    });
    await client.session(session);
    if (same && status.loop_from !== undefined && status.loop_to !== undefined) {
      await client.loop(status.loop_from, status.loop_to);
    }
  };
  const unrouted = async (reason: string): Promise<Unrouted> => {
    if (opened.length > 0) {
      await closeOpened();
      await reload().catch(() => {});
    }
    client.close();
    return { reason };
  };
  try {
    if (!client.supports('live-input')) {
      return await unrouted(`field-audiod ${client.daemonVersion} predates live inputs: run field transport quit, then play again`);
    }
    // The voice is heard on the daemon's device, so it must be made on
    // that device's clock too.
    const daemonDevice = (await client.status()).device?.name;
    if (options.device !== undefined && daemonDevice !== undefined && options.device !== daemonDevice) {
      return await unrouted(`--device names ${options.device}, but the daemon plays on ${daemonDevice}`);
    }
    const rings: (number | null)[] = [];
    for (const entry of armed) {
      if (entry.track === undefined) {
        rings.push(null);
        continue;
      }
      const name = `keys:${entry.track}`;
      const { ring } = await client.openInput(name);
      opened.push(name);
      rings.push(ring);
    }
    await reload();
    // A device that cannot run at the song's rate makes the daemon
    // convert, and an input is written at the device's rate.
    const status = await client.status();
    if (status.resampling) {
      return await unrouted(`the device does not run at the song's ${status.sample_rate} Hz, so the daemon converts it`);
    }
    return {
      programs: armed.map((a) => a.program),
      rings,
      fieldOut,
      device: daemonDevice,
      flowing: async (ms = 2000) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const written = new Map(((await client.status()).inputs ?? []).map((i) => [i.name, i.written]));
          if (opened.every((name) => (written.get(name) ?? 0) > 0)) return true;
          if (Date.now() > deadline) return false;
          await new Promise((r) => setTimeout(r, 100));
        }
      },
      close: async () => {
        try {
          await closeOpened();
          // The song as it is now: without these inputs, with any others.
          // A song that no longer compiles keeps the session it has.
          await reload();
        } catch {
          // the daemon or the project went away; nothing is left to restore
        } finally {
          client.close();
        }
      },
    };
  } catch (err) {
    return await unrouted((err as Error).message.split('\n')[0]!);
  }
}
