import { AudiodClient } from '../audiod/client.js';
import { anyTakeSchema, type AnyTake, type AudiodEvent, type RecordingEntry } from '../audiod/protocol.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import { expandPattern } from '../graph/graph.js';
import { formatLabel, parsePattern } from '../labels.js';
import type { LoadedProject } from '../model/project.js';
import { loadValid } from './build.js';
import { landAnyTake, readTransaction, recordNodeFor, type LandedTake, type LandOptions } from './land.js';
import {
  formatPosition,
  musicalContext,
  parseMusicalPosition,
  playedRate,
  songDirOfPath,
  songDirOfPkg,
  type MusicalContext,
} from './transport.js';

// `field record` (recording.md §6): arm an input on the daemon that
// plays, take against whatever it is playing, and block until ctrl-c —
// which stops and finalizes, matching `field play`'s muscle memory — or
// until the take ends from elsewhere (`field transport stop`, the bed
// running out). The daemon writes the take into `.field/recording/<id>/`
// and this command lands it (land.ts): bytes into `audio/<node>/`, the
// ledger row, the `takes.yaml` row, chosen.
//
// Musical time stays CLI-side (playback.md §3.6): `--at` projects
// through the bed's tempo map here and the daemon receives a sample.

export interface RecordOptions extends LandOptions {
  input?: number | undefined; // 1-based channel on the input device
  device?: string | undefined; // the input device; default: the system's
  at?: string | undefined; // bar[.beat[.tick]] on the loaded song
  click?: boolean | undefined; // the metronome through the take (recording.md §7)
  countIn?: number | undefined; // bars of pre-roll before `at`, clicking; needs `at`
  until?: string | undefined; // bar[.beat[.tick]] where the take ends (§10.4); needs `at`
  loop?: boolean | undefined; // loop [at, until), a take per pass; needs `until`
}

export interface RecordHooks {
  // The input side opened: device, input, rate, latencies.
  onArmed?: (line: string) => void;
  // Nothing was loaded, so the target's song was compiled and loaded as
  // the bed.
  onBed?: (line: string) => void;
  // A count-in began: the transport is rolling toward the take.
  onCountIn?: (line: string) => void;
  // The take began, at this position.
  onStarted?: (line: string) => void;
  // A take landed — under a loop, one per pass as it finalizes; the
  // caller says what a landed take looks like.
  onTake?: (landed: LandedTake) => void;
  // A status tick while recording: position, meter, elapsed.
  onPosition?: (line: string) => void;
  // Wired to SIGINT by the CLI: stop the take and the transport.
  interrupted?: () => boolean;
}

export interface RecordTarget {
  label: string; // //songs/creek/track:lead-vocal
  track: string; // lead-vocal
  song: string; // creek
}

// The record target is a track, named the way every label is named.
// Resolved through the graph so a typo is an error here rather than a
// manifest naming a track that does not exist. Whether the track can
// take a recording — it carries a `record:` entry — is recordNodeFor's
// question, asked before the daemon is touched.
export function resolveRecordTarget(root: string, target: string): RecordTarget {
  const pattern = parsePattern(target);
  if (pattern.kind !== 'label') {
    throw new Error(`record needs one track (creek/track:lead-vocal), got the pattern "${target}"`);
  }
  const { graph } = loadValid(root);
  const nodes = expandPattern(graph, pattern);
  const node = nodes[0];
  if (nodes.length !== 1 || node === undefined) {
    throw new Error(`record needs one track (creek/track:lead-vocal); "${target}" named ${nodes.length}`);
  }
  const songDir = songDirOfPkg(node.label.pkg);
  if (node.kind !== 'rule' || !node.label.pkg.endsWith('/track') || songDir === undefined) {
    throw new Error(
      `record needs a track (creek/track:lead-vocal); ${formatLabel(node.label)} is a ${node.kind}`,
    );
  }
  return { label: formatLabel(node.label), track: node.label.name, song: songDir.slice('songs/'.length) };
}

// The V1 meter (recording.md §12): the peak since the last status read,
// as a bar over the last 60 dB and the number beside it. Exact zero is
// a silent input, which on macOS is what a denied microphone permission
// looks like — so it is named rather than drawn as an empty bar.
export function meterLine(peak: number | undefined): string {
  if (peak === undefined) return '';
  if (peak <= 0) return 'silent';
  const db = 20 * Math.log10(peak);
  const cells = 12;
  const lit = Math.max(0, Math.min(cells, Math.round(((db + 60) / 60) * cells)));
  return `${'▮'.repeat(lit)}${'▯'.repeat(cells - lit)} ${db.toFixed(1)} dBFS${peak >= 1 ? '  CLIP' : ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RecordedTakes {
  takes: { take: AnyTake; landed: LandedTake }[]; // in the order they landed
  // Loop passes that began with no transaction ready and were skipped
  // (recording.md §15.4) — the daemon counts them so the set of takes is
  // never silently smaller than the set of passes.
  missed: number;
}

// The loop's progress on the live line: which pass this is, and how
// many passes were lost, whenever any were. A lost pass is the one fact
// a performer looping a short region cannot hear, so it is never
// folded into the count of what arrived (minjudd's finding on #170).
export function passesNote(record: {
  loop?: boolean | undefined;
  loop_takes?: number | undefined;
  missed?: number | undefined;
}): string {
  if (record.loop !== true) return '';
  const missed = record.missed ?? 0;
  return `  take ${(record.loop_takes ?? 0) + 1}${missed > 0 ? `, ${missed} pass${missed === 1 ? '' : 'es'} missed` : ''}`;
}

export async function recordTake(
  root: string,
  project: LoadedProject,
  target: string,
  options: RecordOptions = {},
  hooks: RecordHooks = {},
): Promise<RecordedTakes> {
  const resolved = resolveRecordTarget(root, target);
  // Before arming: a track with nowhere to attach a take is an error to
  // give before the performance, not after it (recording.md §4).
  const node = recordNodeFor(project, resolved.label);
  // A record entry with an instrument records MIDI (keyboard-instrument.md
  // §12.2), which has no input channel or device to choose, and whose
  // takes stay audio-only under a loop.
  const kind = node.entry.record?.instrument !== undefined ? 'midi' : 'audio';
  if (kind === 'midi' && (options.input !== undefined || options.device !== undefined || options.loop === true)) {
    throw new Error(
      `${node.trackName} records MIDI for ${node.entry.record!.instrument}: --input, --device, and --loop are for audio takes`,
    );
  }
  if (options.loop === true && options.until === undefined) {
    throw new Error('--loop needs --until — the region is --at to --until, a take per pass');
  }
  if (options.until !== undefined && options.at === undefined) {
    throw new Error('--until needs --at (where the take begins)');
  }
  // Each take lands as it arrives — under a loop, while the next one is
  // already recording — so the flow is one landing per manifest.
  const takes: RecordedTakes['takes'] = [];
  const { missed } = await captureTakes(root, project, resolved, kind, options, hooks, async (take) => {
    const landed = await landAnyTake(root, take, options);
    takes.push({ take, landed });
    hooks.onTake?.(landed);
  });
  if (takes.length === 0) throw new Error('no take was recorded');
  return { takes, missed };
}

// The daemon half: arm, take, finalize. Calls `land` with each finalized
// manifest, in order; landing is the caller's business.
async function captureTakes(
  root: string,
  project: LoadedProject,
  resolved: RecordTarget,
  kind: 'audio' | 'midi',
  options: RecordOptions,
  hooks: RecordHooks,
  land: (take: AnyTake) => Promise<void>,
): Promise<{ missed: number }> {
  const client = await AudiodClient.connect(root);
  try {
    if (!client.supports('record')) {
      throw new Error(
        `field-audiod ${client.daemonVersion} predates recording — ` +
          'field transport quit, then record again (it respawns on the new build)',
      );
    }

    // The bed: whatever the daemon is already playing (the mix looping
    // from another terminal), else the target's song, compiled and
    // loaded here so one terminal is enough.
    let status = await client.status();
    if (status.live !== true && status.path === null) {
      const { compileSession } = await import('../graph/live.js');
      const compiled = await compileSession(root, resolved.song);
      await client.session(compiled.session);
      hooks.onBed?.(`live    ${resolved.song}`);
      status = await client.status();
    }
    // Both projections below speak the bed's rate, which is what the
    // daemon's positions count in (multi-rate.md decision 3).
    const rate =
      status.live === true
        ? (status.sample_rate ?? DEFAULT_SAMPLE_RATE)
        : status.path !== null
          ? playedRate(project, status.path)
          : DEFAULT_SAMPLE_RATE;
    const ctx: MusicalContext | undefined =
      status.live === true
        ? status.song
          ? musicalContext(project, `songs/${status.song}`, rate)
          : undefined
        : status.path !== null
          ? musicalContext(project, songDirOfPath(root, status.path), rate)
          : undefined;

    // Before arming: a flag that cannot be honoured is an error to give
    // before the input is opened, not after.
    if (options.countIn !== undefined && (options.at === undefined || ctx === undefined)) {
      throw new Error('--count-in needs --at (the position to count into) on a song with a tempo map');
    }
    let armedRate: number;
    if (kind === 'midi') {
      if (!client.supports('record-midi')) {
        throw new Error(
          `field-audiod ${client.daemonVersion} predates MIDI recording — field transport quit, then record again`,
        );
      }
      const armed = await client.armMidi(resolved.label);
      armedRate = armed.sample_rate;
      hooks.onArmed?.(
        `armed   MIDI from ${armed.sources.join(', ')}  (${armed.sample_rate} Hz, latency out ${armed.output_latency} samples)`,
      );
    } else {
      const armed = await client.arm(resolved.label, options.input ?? 1, options.device);
      armedRate = armed.sample_rate;
      hooks.onArmed?.(
        `armed   ${armed.device} input ${armed.input}  (${armed.sample_rate} Hz, ` +
          `latency in ${armed.input_latency} / out ${armed.output_latency} samples)`,
      );
    }

    let at: number | undefined;
    if (options.at !== undefined) {
      if (ctx === undefined) throw new Error('--at is musical time and the loaded bed has no tempo map');
      at = parseMusicalPosition(options.at, ctx);
    }
    // Punch-out and loop takes (recording.md §10.4): the take ends on
    // `until` exactly; with --loop the live session loops the region and
    // every pass lands a take.
    let until: number | undefined;
    if (options.until !== undefined) {
      if (ctx === undefined) throw new Error('--until is musical time and the loaded bed has no tempo map');
      if (!client.supports('record-until')) {
        throw new Error(
          `field-audiod ${client.daemonVersion} predates punch-out — field transport quit, then record again`,
        );
      }
      until = parseMusicalPosition(options.until, ctx);
      if (at === undefined || until <= at) throw new Error('--until must be after --at');
      if (options.loop === true && status.live !== true) {
        throw new Error('--loop takes need a live song as the bed (field play <song>); a file bed loops only whole');
      }
    }
    // The metronome and the count-in (recording.md §7): a schedule the
    // daemon synthesizes against the clock the capture uses. --click
    // covers the whole bed; --count-in alone clicks only the bars before
    // the take, and pre-rolls the transport from there so the take
    // begins exactly at --at.
    let start: number | undefined;
    if (options.countIn !== undefined) {
      if (at === undefined || ctx === undefined) {
        throw new Error('--count-in needs --at (the position to count into) on a song with a tempo map');
      }
      if (!client.supports('record-start')) {
        throw new Error(
          `field-audiod ${client.daemonVersion} predates count-in — field transport quit, then record again`,
        );
      }
      const { countInStart } = await import('./click.js');
      start = ctx.tempo.ticksToSamples(countInStart(ctx, ctx.meter.parse(options.at!), options.countIn));
    }
    let clicking = false;
    if (options.click === true || start !== undefined) {
      if (ctx === undefined) throw new Error('--click needs a song with a tempo map');
      if (!client.supports('click')) {
        throw new Error(
          `field-audiod ${client.daemonVersion} predates the engine click — field transport quit, then record again`,
        );
      }
      const { clickSchedule, countInSchedule } = await import('./click.js');
      await client.click(
        options.click === true
          ? clickSchedule(ctx, status.samples, rate)
          : countInSchedule(ctx, start!, at!, rate),
      );
      clicking = true;
    }

    // Every finalized take reaches this terminal as a `take` event — the
    // one this terminal's stop ends comes back in the response too — and
    // each lands as it arrives, in order, one at a time.
    const seen = new Set<string>();
    let queue: Promise<void> = Promise.resolve();
    let landedAny = false;
    const landOnce = (take: AnyTake): void => {
      if (seen.has(take.id)) return;
      seen.add(take.id);
      queue = queue.then(async () => {
        await land(take);
        landedAny = true;
      });
    };
    const onEvent = (e: AudiodEvent) => {
      if (e.event === 'take') landOnce(e.take);
    };
    client.on('event', onEvent);
    let transaction: string | undefined;
    let missed = 0; // the daemon's count, as last seen while the loop ran
    try {
      const started = await client.record(at, start, until, options.loop === true);
      transaction = started.transaction;
      try {
        await followTake(started);
      } catch (err) {
        // The daemon died under the take: the socket error is the raw
        // symptom, and the thing to say is that the bytes are still
        // there and how to finalize them.
        throw new Error(
          `field-audiod stopped answering mid-take (${(err as Error).message}); ` +
            `the take is recoverable — field record --list, then field record --recover ${started.transaction}`,
        );
      }
      await queue;
    } finally {
      client.removeListener('event', onEvent);
      // Release the input whatever happened; the microphone is not ours
      // between takes — and the click, which belongs to this take, not
      // to whatever plays the bed next.
      if (clicking) await client.click({ rate, ticks: [] }).catch(() => {});
      await client.disarm().catch(() => {});
    }
    if (!landedAny) {
      throw new Error(`the take ended but its manifest never arrived (${transaction ?? 'no transaction'})`);
    }
    return { missed };

    async function followTake(started: { transaction: string; started_at_samples: number }): Promise<void> {
      // A pre-rolled take reports -1 until the callback reaches its
      // position; the recording line waits for that, and the count-in
      // shows as its own line meanwhile.
      let announced = started.started_at_samples >= 0;
      if (announced) {
        const to = until !== undefined ? ` to ${formatPosition(until, rate, ctx)}` : '';
        const looping = options.loop === true ? ', looping — a take per pass' : '';
        hooks.onStarted?.(`recording ${started.transaction} from ${formatPosition(started.started_at_samples, rate, ctx)}${to}${looping}`);
      } else if (start !== undefined) {
        hooks.onCountIn?.(
          `count-in ${formatPosition(start, rate, ctx)} → ${formatPosition(at!, rate, ctx)} (${options.countIn} bar${options.countIn === 1 ? '' : 's'})`,
        );
      } else if (at !== undefined) {
        // The bed is rolling toward --at from wherever it was: a punch-in.
        hooks.onCountIn?.(`waiting for ${formatPosition(at, rate, ctx)}`);
      }
      let endedItself = false;
      for (;;) {
        if (hooks.interrupted?.() === true) {
          const stopped = await client.stop();
          if (stopped.take !== undefined) landOnce(stopped.take);
          break;
        }
        const s = await client.status();
        if (s.record?.state !== 'recording') {
          // Ended without this terminal: a remote stop, the bed running
          // out, or a punch-out — the transport is still rolling after
          // one of those, and ctrl-c's muscle memory says it stops here.
          endedItself = true;
          break;
        }
        if (!announced && s.record.pending !== true && s.record.started_at_samples !== undefined && s.record.started_at_samples >= 0) {
          announced = true;
          hooks.onStarted?.(`recording ${started.transaction} from ${formatPosition(s.record.started_at_samples, rate, ctx)}`);
        }
        const elapsed = s.record.frames !== undefined ? ` ${(s.record.frames / armedRate).toFixed(1)}s` : '';
        missed = s.record.missed ?? missed;
        // A MIDI take has no level to meter; what it has is the events it
        // has caught.
        const level =
          s.record.kind === 'midi'
            ? `${s.record.events ?? 0} event${s.record.events === 1 ? '' : 's'}`
            : meterLine(s.record.input_peak);
        hooks.onPosition?.(`${formatPosition(s.sample, rate, ctx)}  ${level}${elapsed}${passesNote(s.record)}`);
        await sleep(250);
      }
      if (endedItself) await client.stop().catch(() => {});
      // A remote stop's `take` event can trail the status tick that
      // showed the state change; the recordings list is the fallback.
      for (let i = 0; i < 20 && seen.size === 0; i++) await sleep(50);
      if (seen.size === 0) {
        const { recordings } = await client.recordings();
        const entry = recordings.find((r) => r.id === started.transaction && r.complete);
        if (entry !== undefined) landOnce(anyTakeSchema.parse(entry));
      }
    }
  } finally {
    client.close();
  }
}

// `field record --list`: every transaction under .field/recording/, so a
// take a dead daemon left behind is visible rather than a surprise.
export async function listRecordings(root: string): Promise<RecordingEntry[]> {
  const client = await AudiodClient.connect(root);
  try {
    if (!client.supports('record')) {
      throw new Error(`field-audiod ${client.daemonVersion} predates recording — field transport quit, then try again`);
    }
    return (await client.recordings()).recordings;
  } finally {
    client.close();
  }
}

// `field record --recover <id>`: patch the header a crash left unpatched,
// then land the take like any other.
export async function recoverRecording(
  root: string,
  id: string,
  options: LandOptions = {},
): Promise<{ take: AnyTake; landed: LandedTake }> {
  const client = await AudiodClient.connect(root);
  let take: AnyTake;
  try {
    if (!client.supports('record')) {
      throw new Error(`field-audiod ${client.daemonVersion} predates recording — field transport quit, then try again`);
    }
    take = (await client.recover(id)).take;
  } finally {
    client.close();
  }
  return { take, landed: await landAnyTake(root, take, options) };
}

// `field record --land <id>`: a transaction the daemon finalized but
// nothing landed — the CLI died between the two, or the take was made
// before its track carried a `record:` entry.
export async function landRecording(
  root: string,
  id: string,
  options: LandOptions = {},
): Promise<{ take: AnyTake; landed: LandedTake }> {
  const take = readTransaction(root, id);
  return { take, landed: await landAnyTake(root, take, options) };
}

// One line per transaction for --list and for the report after a take.
export function describeTake(take: AnyTake | RecordingEntry, sampleRate?: number): string {
  const rate = take.sample_rate ?? sampleRate ?? DEFAULT_SAMPLE_RATE;
  // A MIDI take writes lines, not frames, so it counts those, and its
  // length is known once it is complete.
  const midi = 'kind' in take && take.kind === 'midi';
  const frames = take.frames ?? (midi ? undefined : (take as RecordingEntry).frames_on_disk);
  const events = midi ? (take.events ?? ('events_on_disk' in take ? take.events_on_disk : undefined)) : undefined;
  const parts = [
    ...(events !== undefined ? [`${events} event${events === 1 ? '' : 's'}`] : []),
    ...(frames !== undefined ? [`${frames} frames, ${(frames / rate).toFixed(1)} s`] : []),
  ];
  const seconds = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const placed =
    take.started_at_samples !== undefined && take.started_at_samples >= 0
      ? `, started at sample ${take.started_at_samples}`
      : '';
  const state = take.complete ? ('recovered' in take && take.recovered === true ? 'recovered' : 'complete') : 'incomplete';
  const active = 'active' in take && take.active ? ', recording now' : '';
  return `${take.id}  ${state}${active}  ${take.file}${seconds}${placed}`;
}
