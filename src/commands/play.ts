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
  // Content hash of what path holds — watch's baseline seed. For a
  // committed source this is the *declared* hash: the build trusts the
  // declaration and only verifies bytes when it consumes them as an
  // input, so a caller that hands this file to the outside world has to
  // verify for itself (see `committed`).
  sha256: string;
  // The path names a committed source (an asset, a chosen variant), not
  // a materialized build output.
  committed: boolean;
}

// What `field play` plays: asset targets resolve to their files directly;
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
        committed: true,
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
        committed: true,
      };
    }
    const outcome = outputs.get(label);
    if (!outcome?.outputPath) throw new Error(`no output for ${label}`);
    return {
      label,
      pkg: node.label.pkg,
      path: outcome.outputPath,
      sha256: outcome.sha256,
      committed: false,
    };
  });
}

export interface PlayOptions {
  from?: string | undefined; // bar[.beat[.tick]], musical time — CLI-side only
  device?: string | undefined;
  loop?: boolean | undefined; // replay the queue until interrupted
}

export interface PlayHooks {
  // `path` is the file this pass actually loaded — the requeue path
  // consults currentPath at every load, so the watch display correlates
  // a pass against what it queued, never against a stale snapshot.
  onItem?: (label: string, note: string, path: string) => void;
  // `at` locates the printed position on a per-pass monotonic axis (the
  // beat's tick under a tempo map, the raw sample without one): a value
  // moving backwards is the looping reader wrapping — what the watch
  // display uses to close one pass's block and open the next.
  onPosition?: (line: string, at?: number) => void;
  // The output moved mid-play (default-follow or a vanished device).
  onDevice?: (name: string) => void;
  // A live-watch edit landed (realtime.md chunk 3): ramps sent or the
  // session swapped; `note` says which, for the display.
  onReloaded?: (note: string) => void;
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

    // --loop with a single target loops in the daemon — gapless, the
    // reader wrapping at end-of-file — and the queue walk runs once,
    // blocking until ctrl-c stops the transport. A multi-target --loop
    // falls back to replaying the queue, which reloads between passes —
    // and so does --from + --loop: the daemon's wrap returns to sample 0,
    // not the locate point, so repeating a *region* audition takes the
    // requeue path, where --from re-applies each pass (#23 review).
    const nativeLoop =
      options.loop === true && items.length === 1 && options.from === undefined;
    if (nativeLoop && !client.supports('loop')) {
      throw new Error(
        `field-audiod ${client.daemonVersion} predates --loop — ` +
          'field transport quit, then play again (it respawns on the new build)',
      );
    }
    do {
      for (const item of items) {
        if (hooks.interrupted?.()) break;
        const loadedPath = item.path;
        // The load answers with the file's length, which is where the
        // readout has to stop: no beat past it ever sounds, whether the
        // stream wraps there or the transport stops there.
        const loaded = await client.load(loadedPath, nativeLoop);
        // At the loaded file's own rate, which the load response reports:
        // a track may render at its own rate (multi-rate.md decision 3),
        // and both the --from locate and the beat readout below have to
        // speak the samples the daemon is actually streaming.
        const ctx: MusicalContext | undefined = musicalContext(
          project,
          songDirOfPkg(item.pkg),
          loaded.sample_rate,
        );
        if (options.from !== undefined) {
          if (!ctx) throw new Error(`--from needs a song's tempo map; ${item.label} has none`);
          await client.locate(parseMusicalPosition(options.from, ctx));
        }

        const status = await client.status();
        const note = status.device
          ? ` (${status.device.name}${status.resampling ? ', resampling' : ''})`
          : '';
        hooks.onItem?.(item.label, note, loadedPath);

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
        const readout = beatScheduler(
          loaded.sample_rate,
          ctx,
          (line, at) => hooks.onPosition?.(line, at),
          loaded.samples,
        );
        try {
          await waitForStop(
            client,
            readout.onSample,
            (name) => hooks.onDevice?.(name),
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
// Exported for its own tests: the interesting behaviour is what it
// declines to schedule, which a daemon-driven test can only observe by
// waiting and hoping — the phantom beat it prevents was timing-dependent
// enough to be recorded as a flake before it was understood (#37).
export function beatScheduler(
  sampleRate: number,
  ctx: MusicalContext | undefined,
  print: (line: string, at: number) => void,
  // The loaded file's length. Beats are scheduled ahead of the audio, so
  // without this the readout announces beats the file never reaches: a
  // loop shorter than a beat leaves beat 2 permanently pending, unfired
  // only because each anchor clears the timer, and an anchor arriving
  // late lets a phantom through (#37 review). Bounding is the honest fix
  // — a beat past the end does not sound, whether the stream wraps there
  // or the transport stops there.
  // The length is not fixed for the session: under --watch the daemon
  // swaps the file at the wrap, and a bound describing the *previous*
  // file is wrong in both directions — too long lets the phantom beat
  // back in, too short suppresses every scheduled print from the stale
  // end onwards (#42 review). setEnd moves it when the swap sounds.
  endSample?: number,
): {
  onSample: (sample: number) => void;
  setEnd: (samples: number) => void;
  cancel: () => void;
} {
  let end = endSample;
  let anchor: { sample: number; at: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastLine = '';
  let lastAt = Number.NEGATIVE_INFINITY;
  const emit = (line: string, at: number) => {
    // A duplicate is the same beat re-announced (the anchor emit and the
    // scheduled print for one beat): same line, `at` not moving
    // backwards. The same line with `at` regressing is a new pass — a
    // sub-beat loop prints "1.1" every wrap and must keep printing, or
    // the readout freezes (#37 review). The regression compares against
    // the last *seen* value, updated even on skips: anchor ticks cycle
    // modulo the loop length, and comparing against the last *emission*
    // starves the moment the cycle lands at-or-above it.
    const duplicate = line === lastLine && at >= lastAt;
    lastAt = at;
    if (duplicate) return;
    lastLine = line;
    print(line, at);
  };
  const barBeat = (tick: number): string => {
    const [bar, beat] = ctx!.meter.format(Math.max(0, tick)).split('.');
    return `${bar}.${beat}`;
  };
  const schedule = () => {
    if (!anchor || !ctx) return;
    const nowSample = anchor.sample + ((Date.now() - anchor.at) / 1000) * sampleRate;
    const beat = nextBeatTick(ctx.meter, ctx.tempo.samplesToTicks(nowSample));
    const beatSample = ctx.tempo.ticksToSamples(beat);
    // The file ends first: nothing to announce. A wrap re-anchors and
    // the readout starts the next pass from its first beat.
    if (end !== undefined && beatSample >= end) return;
    const ms = ((beatSample - nowSample) / sampleRate) * 1000;
    timer = setTimeout(() => {
      emit(barBeat(beat), beat);
      schedule();
    }, Math.max(0, ms));
  };
  return {
    onSample: (sample) => {
      if (!ctx) {
        emit(`0:${String(Math.floor(sample / sampleRate)).padStart(2, '0')}`, sample);
        return;
      }
      const stalled = anchor !== undefined && sample === anchor.sample;
      anchor = { sample, at: Date.now() };
      clearTimeout(timer);
      if (stalled) return; // paused: freeze the readout, resume on movement
      const tick = Math.floor(ctx.tempo.samplesToTicks(sample));
      emit(barBeat(tick), tick);
      schedule();
    },
    // The swap sounded: the new file's length governs from here. Any
    // timer armed against the old bound is re-armed — a longer successor
    // has beats the old bound suppressed, and a shorter one has beats it
    // would have let through.
    setEnd: (samples: number) => {
      end = samples;
      clearTimeout(timer);
      schedule();
    },
    cancel: () => clearTimeout(timer),
  };
}

function waitForStop(
  client: AudiodClient,
  onPosition: (sample: number) => void,
  onDevice?: (name: string) => void,
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
      if (e.event === 'state' && e.state === 'stopped') finish();
    };
    const onClose = () => finish(new Error('field-audiod connection closed'));
    client.on('event', onEvent);
    client.once('close', onClose);
    // Events cover the normal path; the poll covers the race where a
    // zero-length or already-finished file never transitions at all.
    const poll = setInterval(() => {
      client.status().then(
        (s) => {
          if (s.state === 'stopped') finish();
        },
        () => finish(new Error('field-audiod connection closed')),
      );
    }, 500);
  });
}

// Live evaluation (realtime.md decision 8): compile the song's graph into
// a session, load it into the engine, and block. Explicitly experimental
// while chunks 2-3 land; the artifact path stays the default until the
// freeze chunk makes live evaluation always-cheap, and then this is what
// playing a song means.
export async function playLiveSession(
  root: string,
  project: LoadedProject,
  song: string,
  options: { device?: string; watch?: boolean; signal?: AbortSignal } = {},
  hooks: PlayHooks = {},
): Promise<void> {
  const { compileSession } = await import('../graph/live.js');
  const session = await compileSession(root, song);
  const client = await AudiodClient.connect(root);
  try {
    if (!client.supports('session')) {
      throw new Error(
        `field-audiod ${client.daemonVersion} predates live sessions — ` +
          'field transport quit, then play again (it respawns on the new build)',
      );
    }
    if (options.device !== undefined) await client.selectDevice(options.device);
    const loaded = await client.session(session);
    const ctx = musicalContext(project, `songs/${song}`, loaded.sample_rate);
    await client.play();
    hooks.onItem?.(`${song} (live)`, session.loop === true ? 'looping' : '', '');

    // The chunk-3 loop (realtime.md decision 5): recompile on change,
    // ramps for gain edits, a session swap — transport carried — for
    // everything else. The loop-wrap takeover this replaces waited for
    // the wrap; a ramp lands next block and a swap lands as soon as the
    // compile does.
    let watchDone: Promise<void> | undefined;
    if (options.watch === true) {
      const { watchLiveSession } = await import('./watch-live.js');
      watchDone = watchLiveSession(
        root,
        song,
        session,
        { ...(options.signal !== undefined ? { signal: options.signal } : {}) },
        {
          onEdit: async (edit, fresh) => {
            try {
              if (edit.kind === 'ramps') {
                for (const ramp of edit.ramps) {
                  await client.ramp(ramp.track, ramp.input, ramp.gain_db);
                }
                hooks.onReloaded?.(`${edit.ramps.length} level${edit.ramps.length === 1 ? '' : 's'} ramped`);
              } else if (edit.kind === 'swap') {
                await client.session(fresh);
                hooks.onReloaded?.('session swapped');
              }
            } catch (err) {
              hooks.onPosition?.(`watch: ${(err as Error).message}`);
            }
          },
          onError: (err) => hooks.onPosition?.(`watch: ${err.message}`),
        },
      );
    }

    for (;;) {
      if (hooks.interrupted?.() === true) break;
      const status = await client.status();
      if (status.state !== 'playing') break;
      hooks.onPosition?.(formatPosition(status.sample, loaded.sample_rate, ctx), status.sample);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await client.stop().catch(() => {});
    await watchDone?.catch(() => {});
  } finally {
    client.close();
  }
}
