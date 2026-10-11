import { AudiodClient } from '../audiod/client.js';
import { compileSession } from '../graph/live.js';
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
  // Closes every input and loads the song again without them, so the
  // daemon is not left reading rings nobody writes.
  close(): Promise<void>;
}

// Why the voice plays dry instead, said on the instrument's line.
export interface Unrouted {
  reason: string;
}

export async function routeArmed(
  armed: ArmedInstrument[],
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Routing | Unrouted | undefined> {
  const tracks = armed.filter((a) => a.track !== undefined);
  if (tracks.length === 0) return undefined;
  const songs = [...new Set(tracks.map((a) => a.track!.split('/')[0]!))];
  if (songs.length > 1) return { reason: `the tracks are in ${songs.join(' and ')}, and one session plays one song` };
  if (process.platform === 'win32') return { reason: 'live inputs need POSIX shared memory, which Windows does not have yet' };
  const fieldOut = fieldOutPluginDir(env);
  if (fieldOut === undefined) return { reason: 'FieldOut is not built: run pnpm build:native' };

  const client = await AudiodClient.connect(root);
  const opened: string[] = [];
  const closeAll = async (): Promise<void> => {
    for (const name of opened) await client.closeInput(name).catch(() => {});
  };
  try {
    if (!client.supports('live-input')) {
      client.close();
      return { reason: `field-audiod ${client.daemonVersion} predates live inputs: run field transport quit, then play again` };
    }
    const song = songs[0]!;
    const rings: (number | null)[] = [];
    const inputs: { track: string; input: string }[] = [];
    for (const entry of armed) {
      if (entry.track === undefined) {
        rings.push(null);
        continue;
      }
      const name = `keys:${entry.track}`;
      const { ring } = await client.openInput(name);
      opened.push(name);
      rings.push(ring);
      inputs.push({ track: entry.track.split('/')[1]!, input: name });
    }
    const { session } = await compileSession(root, song, { inputs });
    await client.session(session);
    return {
      programs: armed.map((a) => a.program),
      rings,
      fieldOut,
      close: async () => {
        try {
          await closeAll();
          // The song as it was, without the inputs; a song that no longer
          // compiles keeps the session it has, which reads silence.
          const { session: plain } = await compileSession(root, song);
          await client.session(plain);
        } catch {
          // the daemon or the project went away; nothing is left to restore
        } finally {
          client.close();
        }
      },
    };
  } catch (err) {
    await closeAll();
    client.close();
    return { reason: (err as Error).message.split('\n')[0]! };
  }
}
