import { join } from 'node:path';
import { AudiodClient } from '../audiod/client.js';
import { parsePattern } from '../labels.js';
import { formatLabel } from '../labels.js';
import { build, type GeneratorRunner } from '../graph/build.js';
import { expandPattern } from '../graph/graph.js';
import type { LoadedProject } from '../model/project.js';
import { loadValid } from './build.js';
import { beatTicks } from '../time/tempo.js';
import {
  musicalContext,
  parseMusicalPosition,
  songDirOfPkg,
  type MusicalContext,
} from './transport.js';

export interface Playable {
  label: string;
  pkg: string; // the label's package, for deriving the song's tempo map
  path: string; // absolute path to a playable file
  sha256: string; // content hash of what path holds — watch's baseline seed
}

// What `bloom play` plays: asset targets resolve to their files directly;
// rule targets are built (cache-aware) and resolve to their materialized
// outputs. This is the audition path until the real-time engine exists —
// playback.md owns transport, mixing, and the daemon.
export async function resolvePlayables(
  root: string,
  patterns: string[],
  runner?: GeneratorRunner,
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
      return {
        label,
        pkg: node.label.pkg,
        path: join(project.root, node.scopeDir, node.asset.file),
        sha256: node.asset.sha256,
      };
    }
    if (node.kind === 'generation') {
      // Variants audition straight from the committed file, pre-promotion
      // (project-layout.md §1.4).
      return {
        label,
        pkg: node.label.pkg,
        path: join(project.root, node.songDir, node.file),
        sha256: node.sha256,
      };
    }
    const outcome = outputs.get(label);
    if (!outcome?.outputPath) throw new Error(`no output for ${label}`);
    return { label, pkg: node.label.pkg, path: outcome.outputPath, sha256: outcome.sha256 };
  });
}

export interface PlayOptions {
  from?: string | undefined; // bar[.beat[.tick]], musical time — CLI-side only
  device?: string | undefined;
  loop?: boolean | undefined; // replay the queue until interrupted
  // Watch mode's freshest artifact for the (single) looped item: consulted
  // at every load, so a requeue-path loop (--from) picks up a swap on its
  // next pass (watch.md §2). The native loop loads once and swaps through
  // the daemon's reload op instead.
  currentPath?: (() => string | undefined) | undefined;
}

export interface PlayHooks {
  onItem?: (label: string, note: string) => void;
  onPosition?: (line: string) => void;
  // The output moved mid-play (default-follow or a vanished device).
  onDevice?: (name: string) => void;
  // A queued reload took over at the loop wrap (daemon >= 0.4) — fires
  // when the swap actually sounds, not when it was requested.
  onReloaded?: (path: string) => void;
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

    // --loop with a single target loops in the daemon — gapless, the
    // reader wrapping at end-of-file — and the queue walk runs once,
    // blocking until ctrl-c stops the transport. A multi-target --loop
    // falls back to replaying the queue, which reloads between passes —
    // and so does --from + --loop: the daemon's wrap returns to sample 0,
    // not the locate point, so repeating a *region* audition takes the
    // requeue path, where --from re-applies each pass (#23 review).
    const nativeLoop =
      options.loop === true && items.length === 1 && options.from === undefined;
    if (nativeLoop) {
      const [major = 0, minor = 0] = client.daemonVersion.split('.').map(Number);
      if (major === 0 && minor < 3) {
        throw new Error(
          `bloom-audiod ${client.daemonVersion} predates --loop — ` +
            'bloom transport quit, then play again (it respawns on the new build)',
        );
      }
    }
    do {
      for (const item of items) {
        if (hooks.interrupted?.()) break;
        await client.load(options.currentPath?.() ?? item.path, nativeLoop);
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

        // Ctrl-c can land while load/status were in flight: the handler's
        // stop() would hit a stopped transport and this play() would undo it
        // — so check on both sides, and after play() stop it ourselves,
        // since the handler's stop may have been processed first.
        if (hooks.interrupted?.()) break;
        await client.play();
        if (hooks.interrupted?.()) {
          await client.stop();
          break;
        }
        // The readout is phase-locked to the beat: heartbeat positions are
        // only anchors (sample ↔ wall clock), and each beat's print is
        // scheduled with a timer at the moment the beat actually sounds,
        // drift-corrected by every fresh anchor. The daemon stays
        // musically ignorant; musical time never crosses the socket.
        const readout = beatScheduler(sampleRate, ctx, (line) => hooks.onPosition?.(line));
        try {
          await waitForStop(
            client,
            readout.onSample,
            (name) => hooks.onDevice?.(name),
            (path) => hooks.onReloaded?.(path),
          );
        } finally {
          readout.cancel();
        }
        if (hooks.interrupted?.()) break;
      }
    } while (options.loop === true && !nativeLoop && !(hooks.interrupted?.() ?? false));
  } finally {
    client.close();
  }
}

// The first beat-boundary tick strictly after `tick`, through the meter map.
function nextBeatTick(meter: MusicalContext['meter'], tick: number): number {
  let i = 0;
  while (i + 1 < meter.events.length && meter.events[i + 1]!.at <= tick) i++;
  const ev = meter.events[i]!;
  const step = beatTicks(ev.denominator);
  const next = ev.at + (Math.floor((tick - ev.at) / step) + 1) * step;
  const boundary = meter.events[i + 1]?.at;
  return boundary !== undefined && next > boundary ? boundary : next;
}

// Phase-locked bar.beat readout (1-indexed — musicians count from one, and
// --from and YAML positions agree). Position events serve as anchors; the
// print for each beat fires on a timer at the beat itself. A paused
// transport (anchor not advancing) suspends the timers. Targets without a
// tempo map fall back to whole seconds, printed as anchors arrive.
function beatScheduler(
  sampleRate: number,
  ctx: MusicalContext | undefined,
  print: (line: string) => void,
): { onSample: (sample: number) => void; cancel: () => void } {
  let anchor: { sample: number; at: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastLine = '';
  const emit = (line: string) => {
    if (line !== lastLine) {
      lastLine = line;
      print(line);
    }
  };
  const barBeat = (tick: number): string => {
    const [bar, beat] = ctx!.meter.format(Math.max(0, tick)).split('.');
    return `${bar}.${beat}`;
  };
  const schedule = () => {
    if (!anchor || !ctx) return;
    const nowSample = anchor.sample + ((Date.now() - anchor.at) / 1000) * sampleRate;
    const beat = nextBeatTick(ctx.meter, ctx.tempo.samplesToTicks(nowSample));
    const ms = ((ctx.tempo.ticksToSamples(beat) - nowSample) / sampleRate) * 1000;
    timer = setTimeout(() => {
      emit(barBeat(beat));
      schedule();
    }, Math.max(0, ms));
  };
  return {
    onSample: (sample) => {
      if (!ctx) {
        emit(`0:${String(Math.floor(sample / sampleRate)).padStart(2, '0')}`);
        return;
      }
      const stalled = anchor !== undefined && sample === anchor.sample;
      anchor = { sample, at: Date.now() };
      clearTimeout(timer);
      if (stalled) return; // paused: freeze the readout, resume on movement
      emit(barBeat(Math.floor(ctx.tempo.samplesToTicks(sample))));
      schedule();
    },
    cancel: () => clearTimeout(timer),
  };
}

function waitForStop(
  client: AudiodClient,
  onPosition: (sample: number) => void,
  onDevice?: (name: string) => void,
  onReloaded?: (path: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (err?: Error) => {
      clearInterval(poll);
      client.removeListener('event', onEvent);
      // The close listener too: one leaked per queue item otherwise, and a
      // dozen-item queue trips MaxListenersExceededWarning (#13 review).
      client.removeListener('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onEvent = (e: {
      event: string;
      state?: string;
      sample?: number;
      name?: string;
      path?: string;
    }) => {
      if (e.event === 'position' && e.sample !== undefined) onPosition(e.sample);
      if (e.event === 'device' && e.name !== undefined) onDevice?.(e.name);
      if (e.event === 'reloaded' && e.path !== undefined) onReloaded?.(e.path);
      if (e.event === 'state' && e.state === 'stopped') finish();
    };
    const onClose = () => finish(new Error('bloom-audiod connection closed'));
    client.on('event', onEvent);
    client.once('close', onClose);
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
