import { join } from 'node:path';
import { AudiodClient } from '../audiod/client.js';
import { parsePattern } from '../labels.js';
import { formatLabel } from '../labels.js';
import { build, type RuleRunner } from '../graph/build.js';
import { expandPattern } from '../graph/graph.js';
import type { LoadedProject } from '../model/project.js';
import { loadValid } from './build.js';
import {
  formatPosition,
  musicalContext,
  parseMusicalPosition,
  songDirOfPkg,
  type MusicalContext,
} from './transport.js';

export interface Playable {
  label: string;
  pkg: string; // the label's package, for deriving the song's tempo map
  path: string; // absolute path to a playable file
}

// What `bloom play` plays: asset targets resolve to their files directly;
// rule targets are built (cache-aware) and resolve to their materialized
// outputs. This is the audition path until the real-time engine exists —
// playback.md owns transport, mixing, and the daemon.
export async function resolvePlayables(
  root: string,
  patterns: string[],
  runner?: RuleRunner,
): Promise<Playable[]> {
  const { project, graph } = loadValid(root);
  const requested = patterns.flatMap((p) => expandPattern(graph, parsePattern(p)));

  const seen = new Set<string>();
  const nodes = requested.filter((n) => {
    const label = formatLabel(n.label);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });

  const outcomes = await build(project, graph, nodes, runner);
  const outputs = new Map(outcomes.map((o) => [o.label, o]));

  return nodes.map((node) => {
    const label = formatLabel(node.label);
    if (node.kind === 'asset') {
      return { label, pkg: node.label.pkg, path: join(project.root, node.songDir, node.asset.file) };
    }
    const outcome = outputs.get(label);
    if (!outcome?.outputPath) throw new Error(`no output for ${label}`);
    return { label, pkg: node.label.pkg, path: outcome.outputPath };
  });
}

export interface PlayOptions {
  from?: string | undefined; // bar[.beat[.tick]], musical time — CLI-side only
  device?: string | undefined;
}

export interface PlayHooks {
  onItem?: (label: string, note: string) => void;
  onPosition?: (line: string) => void;
  // Wired to SIGINT by the CLI: stop the daemon and end the queue.
  interrupted?: () => boolean;
}

// Blocking daemon playback (playback.md §3.6): load each artifact, stream
// position, wait for the transport to stop, move on. Musical time never
// crosses the socket — --from projects through the song's tempo map here
// and the daemon receives locate(samples).
export async function playThroughDaemon(
  root: string,
  project: LoadedProject,
  items: Playable[],
  options: PlayOptions = {},
  hooks: PlayHooks = {},
): Promise<void> {
  if (options.from !== undefined && items.length > 1) {
    throw new Error(`--from needs a single target (got ${items.length})`);
  }
  const client = await AudiodClient.connect(root);
  try {
    if (options.device !== undefined) await client.selectDevice(options.device);
    const sampleRate = project.manifest?.data.sample_rate ?? 48000;

    for (const item of items) {
      if (hooks.interrupted?.()) break;
      await client.load(item.path);
      const ctx: MusicalContext | undefined = musicalContext(project, songDirOfPkg(item.pkg));
      if (options.from !== undefined) {
        if (!ctx) throw new Error(`--from needs a song's tempo map; ${item.label} has none`);
        await client.locate(parseMusicalPosition(options.from, ctx));
      }

      const status = await client.status();
      const note = status.device
        ? ` (${status.device.name}${status.resampling ? ', resampling' : ''})`
        : '';
      hooks.onItem?.(item.label, note);

      await client.play();
      await waitForStop(client, (sample) =>
        hooks.onPosition?.(formatPosition(sample, sampleRate, ctx)),
      );
      if (hooks.interrupted?.()) break;
    }
  } finally {
    client.close();
  }
}

function waitForStop(client: AudiodClient, onPosition: (sample: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (err?: Error) => {
      clearInterval(poll);
      client.removeListener('event', onEvent);
      if (err) reject(err);
      else resolve();
    };
    const onEvent = (e: { event: string; state?: string; sample?: number }) => {
      if (e.event === 'position' && e.sample !== undefined) onPosition(e.sample);
      if (e.event === 'state' && e.state === 'stopped') finish();
    };
    client.on('event', onEvent);
    client.once('close', () => finish(new Error('bloom-audiod connection closed')));
    // Events cover the normal path; the poll covers the race where a
    // zero-length or already-finished file never transitions at all.
    const poll = setInterval(() => {
      client.status().then(
        (s) => {
          if (s.state === 'stopped') finish();
        },
        () => finish(new Error('bloom-audiod connection closed')),
      );
    }, 500);
  });
}
