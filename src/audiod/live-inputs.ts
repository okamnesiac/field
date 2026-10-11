import type { AudiodClient } from './client.js';
import { compileSession, type SessionInput } from '../graph/live.js';

// The inputs a song's input windows read (live-supercollider.md): a
// `field keys` voice's ring, `keys:<song>/<track>` (chunk 3), and an armed
// input a `field record --monitoring host` hears, `capture:<song>/<track>`
// (§12). Every command that loads a song's session compiles in the ones
// open for it, so a reload from `field play`, its watch, `field ui`, or
// `field record` keeps both heard.
const LIVE_INPUT = /^(?:keys|capture):([^/]+)\/(.+)$/;

// The capture input `field record --monitoring host` opens for `track`.
export function captureInputName(song: string, track: string): string {
  return `capture:${song}/${track}`;
}

// The open inputs for `song`, as `compileSession` takes them.
export async function liveInputsFor(client: AudiodClient, song: string): Promise<SessionInput[]> {
  if (!client.supports('live-input')) return [];
  const { inputs } = await client.status();
  return (inputs ?? []).flatMap(({ name }) => {
    const match = LIVE_INPUT.exec(name);
    return match !== null && match[1] === song ? [{ track: match[2]!, input: name }] : [];
  });
}

// Loads `song` again with whatever inputs are open now, and whatever the
// session loaded now was compiled and set with: its loop, its region, and
// its solo. Opening or closing an input changes only the inputs.
export async function reloadWithInputs(client: AudiodClient, root: string, song: string): Promise<void> {
  const status = await client.status();
  const same = status.live === true && status.song === song;
  const { session } = await compileSession(root, song, {
    ...(same && status.looping === true ? { loop: true } : {}),
    ...(same && status.solo !== undefined ? { solo: status.solo } : {}),
    inputs: await liveInputsFor(client, song),
  });
  await client.session(session);
  if (same && status.loop_from !== undefined && status.loop_to !== undefined) {
    await client.loop(status.loop_from, status.loop_to);
  }
}
