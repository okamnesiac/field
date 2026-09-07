import { AudiodClient } from '../audiod/client.js';
import { takeSchema, type AudiodEvent, type RecordingEntry, type Take } from '../audiod/protocol.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import { expandPattern } from '../graph/graph.js';
import { formatLabel, parsePattern } from '../labels.js';
import type { LoadedProject } from '../model/project.js';
import { loadValid } from './build.js';
import {
  formatPosition,
  musicalContext,
  parseMusicalPosition,
  playedRate,
  songDirOfPath,
  songDirOfPkg,
  type MusicalContext,
} from './transport.js';

// `field record` (recording.md §6, chunk 1): arm an input on the daemon
// that plays, take against whatever it is playing, and block until
// ctrl-c — which stops and finalizes, matching `field play`'s muscle
// memory — or until the take ends from elsewhere (`field transport
// stop`, the bed running out). The daemon writes the take into
// `.field/recording/<id>/`; landing it in the project — `audio/<name>/`,
// the ledger row, `takes.yaml` — is chunk 2, so this command ends by
// saying where the bytes are.
//
// Musical time stays CLI-side (playback.md §3.6): `--at` projects
// through the bed's tempo map here and the daemon receives a sample.

export interface RecordOptions {
  input?: number | undefined; // 1-based channel on the input device
  device?: string | undefined; // the input device; default: the system's
  at?: string | undefined; // bar[.beat[.tick]] on the loaded song
}

export interface RecordHooks {
  // The input side opened: device, input, rate, latencies.
  onArmed?: (line: string) => void;
  // Nothing was loaded, so the target's song was compiled and loaded as
  // the bed.
  onBed?: (line: string) => void;
  // The take began, at this position.
  onStarted?: (line: string) => void;
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
// manifest naming a track that does not exist; chunk 2 adds the
// requirement that the track carry a `record:` entry.
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

export async function recordTake(
  root: string,
  project: LoadedProject,
  target: string,
  options: RecordOptions = {},
  hooks: RecordHooks = {},
): Promise<Take> {
  const resolved = resolveRecordTarget(root, target);
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

    const armed = await client.arm(resolved.label, options.input ?? 1, options.device);
    hooks.onArmed?.(
      `armed   ${armed.device} input ${armed.input}  (${armed.sample_rate} Hz, ` +
        `latency in ${armed.input_latency} / out ${armed.output_latency} samples)`,
    );

    let at: number | undefined;
    if (options.at !== undefined) {
      if (ctx === undefined) throw new Error('--at is musical time and the loaded bed has no tempo map');
      at = parseMusicalPosition(options.at, ctx);
    }

    // A take that ends from elsewhere reaches this terminal as the `take`
    // event; the stop this terminal sends gets it in the response.
    let landed: Take | undefined;
    const onEvent = (e: AudiodEvent) => {
      if (e.event === 'take') landed = e.take;
    };
    client.on('event', onEvent);
    let transaction: string | undefined;
    try {
      const started = await client.record(at);
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
    } finally {
      client.removeListener('event', onEvent);
      // Release the input whatever happened; the microphone is not ours
      // between takes.
      await client.disarm().catch(() => {});
    }
    if (landed === undefined) {
      throw new Error(`the take ended but its manifest never arrived (${transaction ?? 'no transaction'})`);
    }
    return landed;

    async function followTake(started: { transaction: string; started_at_samples: number }): Promise<void> {
      const from =
        started.started_at_samples >= 0 ? ` from ${formatPosition(started.started_at_samples, rate, ctx)}` : '';
      hooks.onStarted?.(`recording ${started.transaction}${from}`);
      for (;;) {
        if (hooks.interrupted?.() === true) {
          const stopped = await client.stop();
          landed = stopped.take ?? landed;
          break;
        }
        const s = await client.status();
        if (s.record?.state !== 'recording') break; // ended from elsewhere
        const elapsed = s.record.frames !== undefined ? ` ${(s.record.frames / armed.sample_rate).toFixed(1)}s` : '';
        hooks.onPosition?.(`${formatPosition(s.sample, rate, ctx)}  ${meterLine(s.record.input_peak)}${elapsed}`);
        await sleep(250);
      }
      // A remote stop's `take` event can trail the status tick that
      // showed the state change; the recordings list is the fallback.
      for (let i = 0; i < 20 && landed === undefined; i++) await sleep(50);
      if (landed === undefined) {
        const { recordings } = await client.recordings();
        const entry = recordings.find((r) => r.id === started.transaction && r.complete);
        if (entry !== undefined) landed = takeSchema.parse(entry);
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

// `field record --recover <id>`: patch the header a crash left unpatched.
export async function recoverRecording(root: string, id: string): Promise<Take> {
  const client = await AudiodClient.connect(root);
  try {
    if (!client.supports('record')) {
      throw new Error(`field-audiod ${client.daemonVersion} predates recording — field transport quit, then try again`);
    }
    return (await client.recover(id)).take;
  } finally {
    client.close();
  }
}

// One line per transaction for --list and for the report after a take.
export function describeTake(take: Take | RecordingEntry, sampleRate?: number): string {
  const rate = take.sample_rate ?? sampleRate ?? DEFAULT_SAMPLE_RATE;
  const frames = 'frames' in take && take.frames !== undefined ? take.frames : (take as RecordingEntry).frames_on_disk;
  const seconds = frames !== undefined ? ` (${frames} frames, ${(frames / rate).toFixed(1)} s)` : '';
  const placed =
    take.started_at_samples !== undefined && take.started_at_samples >= 0
      ? `, started at sample ${take.started_at_samples}`
      : '';
  const state = take.complete ? ('recovered' in take && take.recovered === true ? 'recovered' : 'complete') : 'incomplete';
  const active = 'active' in take && take.active ? ', recording now' : '';
  return `${take.id}  ${state}${active}  ${take.file}${seconds}${placed}`;
}
