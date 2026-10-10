import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { AudiodClient } from '../audiod/client.js';
import type { CompiledSession } from '../graph/live.js';
import { compileSession } from '../graph/live.js';
import { sha256Text } from '../hash.js';
import { formatDiagnostic, loadProject, type Diagnostic, type LoadedProject } from '../model/project.js';
import {
  applyEdit,
  applyInsertAdd,
  applyInsertEdit,
  applyInsertRemove,
  applyMove,
  applySplit,
  applyStretch,
} from './ui-edits.js';
import type { UiLane, UiSnapshot } from './ui-protocol.js';
import { projectTimeline } from './ui-timeline.js';
import { formatPosition, musicalContext, type MusicalContext } from './transport.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { watchLiveSession } from './watch-live.js';

// `field ui <song>` (ui.md): a local web face over what already exists —
// the project's YAML and the daemon's socket — served from field's own
// process, because that is where every write path and the daemon bridge
// already live. The browser gets static assets and one WebSocket; the
// files stay the source of truth, so a fader gesture ends as `gain_db`
// written through the same comment-preserving Document machinery every
// other editor uses, and the existing watch loop carries it into the
// live session exactly as a hand edit would.
//
// Musical time is projected here, not in the daemon (playback.md §3.6:
// samples cross the socket, music does not) and not re-derived in the
// browser: this process already owns formatPosition and the tempo map,
// and shipping rendered strings beats porting the projection to a second
// runtime. ui.md asked for client-side projection; the plan's amendment
// records this as the settled spelling and why.
//
// Two guards, both because the socket accepts writes (ui.md §4): the
// upgrade checks Origin against this server's own addresses and a
// per-launch token, since binding localhost excludes the network but not
// the other pages a browser is running; and every edit op carries the
// sha256 of the file bytes it was derived from — a stale hash is a
// reject-and-refresh, never a write-through, which is what makes two
// views converge instead of overwriting each other.

const editSchema = z.object({
  type: z.literal('edit'),
  // Which file the placement lives in. Absent means main.yaml, which is
  // what every top-level lane edits and what the first version sent.
  file: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  entry: z.number().int().min(0),
  set: z
    .object({
      gain_db: z.number().optional(),
      pan: z.number().min(-1).max(1).optional(),
      mute: z.boolean().optional(),
    })
    .strict(),
});

// Moving a clip is a delta in session samples, not a new position. The
// delta is what the drag measured, and it is anchor-agnostic: a sample
// is a sample whichever way `at` is spelled, and the entry's own origin
// cancels out — which is also what keeps a track placed in two homes
// unambiguous, since the entry moves by the same amount however many
// windows render it.
const moveSchema = z.object({
  type: z.literal('move'),
  file: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  entry: z.number().int().min(0),
  delta: z.number().int(),
});

const insertAddSchema = z.object({
  type: z.literal('insert-add'),
  file: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  effect: z.enum(['eq', 'limit', 'reverb', 'plate', 'hall']),
});
const insertEditSchema = z.object({
  type: z.literal('insert-edit'),
  file: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  entry: z.number().int().min(0),
  set: z.record(z.string(), z.unknown()),
});
const insertRemoveSchema = z.object({
  type: z.literal('insert-remove'),
  file: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  entry: z.number().int().min(0),
});

// Split carries the cut as an offset from the clip's own window start,
// in session samples — origin-free the way move's delta is, and what
// the client knows directly: playhead minus lane start.
const splitSchema = z.object({
  type: z.literal('split'),
  file: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  entry: z.number().int().min(0),
  offset: z.number().int().min(1),
});

// Stretch carries which edge was dragged and where it landed, in
// session samples from the clip's own window start — one measurement
// covering both edges (ui-edits.ts). The start edge's number is how far
// that edge travelled and may be negative; the end edge's is the
// window's new length, so it is at least one sample.
const stretchSchema = z.object({
  type: z.literal('stretch'),
  file: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  entry: z.number().int().min(0),
  edge: z.enum(['start', 'end']),
  offset: z.number().int(),
});

const upSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('locate'), sample: z.number().int().min(0) }),
  z.object({ type: z.literal('device'), name: z.string() }),
  z.object({ type: z.literal('solo'), track: z.string().nullable() }),
  editSchema,
  moveSchema,
  splitSchema,
  stretchSchema,
  insertAddSchema,
  insertEditSchema,
  insertRemoveSchema,
]);

// Envelope resolution: one peak per bucket across the whole song. 1200
// is finer than any lane is wide on a normal screen, so zooming in
// stays smooth without shipping a second resolution.
const WAVE_BUCKETS = 1200;

// The file a request path names inside the client's build output, or
// undefined when it would land outside it. The prefix compared ends in a
// separator, so a sibling such as `ui/dist-evil` is outside: a bare
// `startsWith(distDir)` admits any directory whose name merely begins
// with `dist` (#163 review).
export function staticFile(distDir: string, pathname: string): string | undefined {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = normalize(join(distDir, rel));
  return file.startsWith(normalize(distDir) + sep) ? file : undefined;
}

export interface UiOptions {
  port?: number;
  open?: boolean;
  browser?: boolean; // open a tab instead of the app window
}

export async function runUi(root: string, songName: string, options: UiOptions = {}): Promise<void> {
  const token = randomBytes(16).toString('hex');
  let soloed: string | null = null;
  let ctx: MusicalContext | undefined;

  // The session first. A song that cannot compile fails here rather than
  // half-opening — but the message has to survive the trip: whoever
  // launched a window may never look at the terminal it came from, and
  // "nothing happened" is the worst possible rendering of "creek's takes
  // have not been generated yet". So the reason is restated as the
  // window's own failure, pointing at the command that fixes it.
  let compiled: CompiledSession;
  try {
    compiled = await compileSession(root, songName);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `field ui cannot open "${songName}" — the song does not compile yet:\n\n${detail}\n\n` +
        `Fix that, then run field ui ${songName} again. ` +
        `(field play ${songName} fails the same way, for the same reason.)`,
    );
  }
  const client = await AudiodClient.connect(root);
  if (!client.supports('session') || !client.supports('swap')) {
    throw new Error(
      `field-audiod ${client.daemonVersion} predates live sessions — field transport quit, then retry`,
    );
  }
  const loaded = await client.session(compiled.session);
  ctx = musicalContext(loadProject(root), `songs/${songName}`, loaded.sample_rate);

  const mainFile = () => {
    const project = loadProject(root);
    const song = project.songs.find((s) => s.name === songName);
    const main = song?.tracks.find((t) => t.data.name === 'main');
    if (!song || !main) throw new Error(`song "${songName}" lost its main track`);
    return { project, song, main };
  };

  const snapshot = async (): Promise<UiSnapshot> => {
    const { song, main } = mainFile();
    const byName = new Map(song.tracks.map((t) => [t.data.name, t.data]));
    const lanes: UiLane[] = main.data.inputs.map((entry, i) => {
      const kind = entry.track !== undefined ? 'track' : entry.audio !== undefined ? 'audio' : 'other';
      const placed = entry.track !== undefined ? byName.get(entry.track) : undefined;
      return {
        entry: i,
        kind,
        name: entry.track ?? entry.audio ?? entry.receive ?? `input ${i + 1}`,
        gain_db: entry.gain_db,
        pan: entry.pan,
        mute: entry.mute,
        canSolo: kind === 'track',
        empty: placed !== undefined && placed.inputs.length === 0,
        inserts: placed?.inserts.map((ins) => ('effect' in ins ? String(ins.effect) : 'plugin')) ?? [],
      };
    });
    const raw = readFileSync(join(root, main.path), 'utf8');
    const status = await client.status();
    return {
      type: 'snapshot' as const,
      song: songName,
      lanes,
      file: { path: main.path, sha256: sha256Text(raw) },
      soloed,
      devices: await client.devices(),
      status: {
        ...status,
        musical: formatPosition(status.sample, loaded.sample_rate, ctx),
      },
      // The view runs the playhead between the daemon's 250 ms events;
      // these are the same arrays this process builds its own TempoMap
      // from, so the two projections cannot drift apart.
      // song.time is already the loaded schema type, and assigning it
      // straight into UiClock is what makes the boundary real: a tempo
      // or meter schema change that outgrows the protocol becomes a
      // compile error here rather than a shape the view cannot read.
      // A song without a tempo map has no bars to spell, and the
      // server-rendered sample readout stands.
      clock: song.time
        ? { sampleRate: loaded.sample_rate, tempo: song.time.tempo, meter: song.time.meter }
        : undefined,
      // The song in time. Envelopes are memoised inside the projection,
      // keyed on each artifact's own size and mtime.
      timeline: projectTimeline(
        root,
        song,
        loaded.sample_rate,
        status.samples > 0 ? status.samples : loaded.samples,
        WAVE_BUCKETS,
      ),
    };
  };

  const sockets = new Set<WebSocket>();
  const broadcast = (message: unknown) => {
    const line = JSON.stringify(message);
    for (const socket of sockets) socket.send(line);
  };

  // The view re-renders on every snapshot, so a snapshot that says
  // nothing new is a visible flicker for no information. The watch loop
  // legitimately recompiles several times per edit — the freeze pass
  // alone recompiles after building dirty stems — and on a synced folder
  // the filesystem produces events nobody asked for. One click was
  // landing as up to eight identical renders, with the stale ones
  // flipping the button back before correcting. Only differences ship.
  //
  // Serialized rather than field-compared because the snapshot IS the
  // wire format: if two of them serialize identically the view cannot
  // tell them apart, which is exactly the test worth applying.
  let lastSent: string | undefined;
  let pending: Promise<void> | undefined;
  const pushSnapshot = async (): Promise<void> => {
    // One at a time: two overlapping snapshots can read the file in one
    // order and arrive in the other, which is how a just-cleared mute
    // came back for a frame.
    const run = async () => {
      try {
        const snap = await snapshot();
        // Compare everything except the playhead. Position and its
        // musical spelling advance on their own the whole time a song is
        // playing, so including them means no two snapshots ever match
        // and the dedupe never fires precisely when the flicker is worst.
        // The view gets position from `position` events regardless —
        // that is the channel built for a value that changes constantly.
        const { sample: _s, musical: _m, ...stable } = snap.status;
        const key = JSON.stringify({ ...snap, status: stable });
        if (key === lastSent) return;
        lastSent = key;
        const line = JSON.stringify(snap);
        for (const socket of sockets) socket.send(line);
      } catch (err) {
        broadcast({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    };
    pending = (pending ?? Promise.resolve()).then(run, run);
    return pending;
  };

  client.on('event', (event: { event: string; sample?: number }) => {
    broadcast({
      type: 'event',
      event,
      ...(event.event === 'position' && typeof event.sample === 'number'
        ? { musical: formatPosition(event.sample, loaded.sample_rate, ctx) }
        : {}),
    });
  });

  // The recompile every op that changes the session shares. While a solo
  // is held, every file edit is a swap of the soloed compile: a ramp
  // addresses (track, input index) in the *daemon's* session, and the
  // soloed session's indexes are not the un-soloed compile's, so ramping
  // across that boundary would move the wrong fader.
  const swapSession = async () => {
    compiled = await compileSession(root, songName, soloed !== null ? { solo: soloed } : {});
    const swapped = await client.session(compiled.session);
    ctx = musicalContext(loadProject(root), `songs/${songName}`, swapped.sample_rate);
  };

  const watchAbort = new AbortController();
  const watchDone = watchLiveSession(
    root,
    songName,
    compiled,
    { signal: watchAbort.signal },
    {
      onEdit: async (edit, fresh) => {
        if (soloed !== null) {
          await swapSession();
        } else if (edit.kind === 'ramps') {
          for (const ramp of edit.ramps) await client.ramp(ramp.track, ramp.input, ramp.gain_db);
        } else {
          const swapped = await client.session(fresh);
          compiled = { ...compiled, session: fresh };
          ctx = musicalContext(loadProject(root), `songs/${songName}`, swapped.sample_rate);
        }
        await pushSnapshot();
      },
      // A red project reaches the view through onError: watch-live folds
      // diagnostics into the compile failure it reports.
      onError: (err: Error) => broadcast({ type: 'error', message: err.message }),
    },
  );

  // Shared by edit and move: the placement a message names, resolved to
  // its owner file and parsed document with the stale guard enforced. A
  // null return means the socket was already answered.
  const resolvePlacement = async (
    socket: WebSocket,
    msg: { file?: string | undefined; sha256: string; entry: number },
  ) => {
    const { project, song, main } = mainFile();
    // Resolved against the song's own track paths, never joined: a
    // client-supplied path reaching join(root, …) is a traversal, and
    // this socket accepts writes.
    const owner =
      msg.file === undefined ? main : song.tracks.find((t) => t.path === msg.file);
    if (owner === undefined) {
      socket.send(JSON.stringify({ type: 'error', message: `no such track file: ${msg.file}` }));
      return null;
    }
    const absolute = join(root, owner.path);
    const raw = readFileSync(absolute, 'utf8');
    if (sha256Text(raw) !== msg.sha256) {
      // Stale base: the file moved underneath this view. Refresh rather
      // than write through — placement ids are optional and duplicates
      // legal, so re-anchoring by name is not always possible (ui.md §4).
      socket.send(JSON.stringify({ type: 'error', message: 'file changed underneath — refreshed' }));
      await pushSnapshot();
      return null;
    }
    const doc = parseDocument(raw);
    if (doc.getIn(['inputs', msg.entry], true) === undefined) {
      socket.send(JSON.stringify({ type: 'error', message: `no input ${msg.entry} — refreshed` }));
      await pushSnapshot();
      return null;
    }
    return { project, song, owner, absolute, raw };
  };

  // A placement resolved far enough to edit: what resolvePlacement
  // hands back, named so the helpers below can take it whole.
  type Resolved = NonNullable<Awaited<ReturnType<typeof resolvePlacement>>>;

  // Every write this view makes goes through here. The edit functions
  // keep one file in the spelling a person would type, but only the
  // loader knows the rules that span files: no displacement on a
  // receiver's path, one render name per generator entry, fades inside
  // their window. So the edited text is loaded as it would be, and a
  // write that would add an error is refused with that error rather
  // than turning the song red with only a hand edit to undo it. Errors
  // the project already had do not block.
  const writeChecked = (
    socket: WebSocket,
    project: LoadedProject,
    absolute: string,
    text: string,
  ): boolean => {
    const isError = (d: Diagnostic) => d.severity !== 'warning';
    const before = new Set(project.diagnostics.filter(isError).map(formatDiagnostic));
    const added = loadProject(root, { override: { path: absolute, text } })
      .diagnostics.filter(isError)
      .find((d) => !before.has(formatDiagnostic(d)));
    if (added !== undefined) {
      socket.send(JSON.stringify({ type: 'error', message: `not written: ${added.message}` }));
      return false;
    }
    writeFileSync(absolute, text);
    return true;
  };

  // The owner's own time, falling back to the song's — the same rule the
  // timeline renders by (nested-tracks.md §13), so a clip lands exactly
  // where the drag showed it.
  const localMaps = ({ owner, song }: Pick<Resolved, 'owner' | 'song'>) => ({
    tempo: new TempoMap(
      owner.data.time?.tempo ?? song.time?.tempo ?? [{ at: 0, bpm: 120 }],
      loaded.sample_rate,
    ),
    meter: new MeterMap(
      owner.data.time?.meter ?? song.time?.meter ?? [{ at: 0, numerator: 4, denominator: 4 }],
    ),
  });

  // `source_offset` addresses the source's own samples, and both the
  // split and the front-trim advance it by a distance measured in
  // session samples — the same number only when the source runs at the
  // session rate. So a cross-rate placement is refused rather than
  // edited quietly into the wrong place, which is the one thing this
  // surface must never write. Returns the refusal's wording, naming the
  // gesture, or null when there is nothing to refuse.
  const crossRateRefusal = (
    { song, project }: Pick<Resolved, 'song' | 'project'>,
    entry: { track?: string | undefined; audio?: string | undefined },
    verb: string,
  ): string | null => {
    const placedTrack =
      entry.track !== undefined ? song.tracks.find((t) => t.data.name === entry.track) : undefined;
    if (placedTrack?.data.rate !== undefined && placedTrack.data.rate !== loaded.sample_rate) {
      return `a cross-rate track cannot be ${verb} yet`;
    }
    if (entry.audio !== undefined) {
      const shared = /^\/\/shared\/asset:(.+)$/.exec(entry.audio);
      const ledger = shared
        ? project?.shared?.data.assets.find((a) => a.name === shared[1])
        : song.assets?.data.assets.find((a) => a.name === entry.audio);
      if (ledger?.sample_rate !== undefined && ledger.sample_rate !== loaded.sample_rate) {
        return `a cross-rate clip cannot be ${verb} yet`;
      }
    }
    return null;
  };

  const handleEdit = async (socket: WebSocket, msg: z.infer<typeof editSchema>) => {
    const resolved = await resolvePlacement(socket, msg);
    if (resolved === null) return;
    const { project, absolute, raw } = resolved;
    const result = applyEdit(raw, msg.entry, msg.set);
    if (!result.ok) {
      socket.send(JSON.stringify({ type: 'error', message: result.message }));
      return;
    }
    if (!writeChecked(socket, project, absolute, result.text)) return;
    // No daemon push here: the watch loop owns carrying file edits into
    // the session, for the UI exactly as for a hand edit in an editor.
    //
    // The *view* does not wait for it, though. The file is written, so a
    // snapshot taken now is authoritative, and taking it here is what
    // makes a click feel like it landed — waiting for the watch put a
    // debounce and a recompile between pressing M and seeing it, and let
    // an in-flight recompile answer first with the old value.
    await pushSnapshot();
  };

  const handleMove = async (socket: WebSocket, msg: z.infer<typeof moveSchema>) => {
    const resolved = await resolvePlacement(socket, msg);
    if (resolved === null) return;
    const { owner, absolute, raw } = resolved;
    // The parsed entry, not the YAML node: the model rewrote musical
    // arrays to tick scalars at load, which is the shape applyMove's
    // window arithmetic takes — and the sha guard just proved the
    // parse describes these exact bytes.
    const entry = owner.data.inputs[msg.entry];
    if (entry === undefined) {
      socket.send(JSON.stringify({ type: 'error', message: `no input ${msg.entry} — refreshed` }));
      await pushSnapshot();
      return;
    }
    const { tempo, meter } = localMaps(resolved);
    const result = applyMove(raw, msg.entry, entry, msg.delta, tempo, meter);
    if (!result.ok) {
      socket.send(JSON.stringify({ type: 'error', message: result.message }));
      return;
    }
    if (!writeChecked(socket, resolved.project, absolute, result.text)) return;
    await pushSnapshot();
  };

  const handleSplit = async (socket: WebSocket, msg: z.infer<typeof splitSchema>) => {
    const resolved = await resolvePlacement(socket, msg);
    if (resolved === null) return;
    const { owner, absolute, raw } = resolved;
    const entry = owner.data.inputs[msg.entry];
    if (entry === undefined) {
      socket.send(JSON.stringify({ type: 'error', message: `no input ${msg.entry} — refreshed` }));
      await pushSnapshot();
      return;
    }
    // A loop tiles its window; the two halves of a tiling are not two
    // tilings, so a looped clip does not split.
    if (entry.loop !== undefined) {
      socket.send(JSON.stringify({ type: 'error', message: 'a looped clip cannot be split — remove the loop first' }));
      return;
    }
    const refusal = crossRateRefusal(resolved, entry, 'split');
    if (refusal !== null) {
      socket.send(JSON.stringify({ type: 'error', message: refusal }));
      return;
    }
    const { tempo, meter } = localMaps(resolved);
    const result = applySplit(raw, msg.entry, entry, msg.offset, tempo, meter);
    if (!result.ok) {
      socket.send(JSON.stringify({ type: 'error', message: result.message }));
      if (result.refresh) await pushSnapshot();
      return;
    }
    if (!writeChecked(socket, resolved.project, absolute, result.text)) return;
    await pushSnapshot();
  };

  const handleStretch = async (socket: WebSocket, msg: z.infer<typeof stretchSchema>) => {
    const resolved = await resolvePlacement(socket, msg);
    if (resolved === null) return;
    const { owner, absolute, raw } = resolved;
    const entry = owner.data.inputs[msg.entry];
    if (entry === undefined) {
      socket.send(JSON.stringify({ type: 'error', message: `no input ${msg.entry} — refreshed` }));
      await pushSnapshot();
      return;
    }
    // Only the front edge touches the source, so only it inherits
    // split's two refusals. The end edge is window arithmetic and
    // nothing else, which is why it is offered on every clip: dragging
    // the end of a looped placement is how its window grows another
    // repetition — the gesture, not a hazard.
    if (msg.edge === 'start') {
      if (entry.loop !== undefined) {
        socket.send(
          JSON.stringify({
            type: 'error',
            message: 'a looped clip cannot be trimmed at the front — remove the loop first',
          }),
        );
        return;
      }
      const refusal = crossRateRefusal(resolved, entry, 'trimmed');
      if (refusal !== null) {
        socket.send(JSON.stringify({ type: 'error', message: refusal }));
        return;
      }
    }
    const { tempo, meter } = localMaps(resolved);
    const result = applyStretch(raw, msg.entry, entry, msg.edge, msg.offset, tempo, meter);
    if (!result.ok) {
      socket.send(JSON.stringify({ type: 'error', message: result.message }));
      if (result.refresh) await pushSnapshot();
      return;
    }
    if (!writeChecked(socket, resolved.project, absolute, result.text)) return;
    await pushSnapshot();
  };

  // Insert ops: the same resolution discipline as placements, against
  // the placed track's own file. The chain lives on the track, so the
  // stale guard is the track file's hash — a lane carries it as
  // trackSha256 precisely so these ops can hold it.
  const resolveTrackFile = async (
    socket: WebSocket,
    msg: { file: string; sha256: string },
  ) => {
    const { project, song } = mainFile();
    const owner = song.tracks.find((t) => t.path === msg.file);
    if (owner === undefined) {
      socket.send(JSON.stringify({ type: 'error', message: `no such track file: ${msg.file}` }));
      return null;
    }
    const absolute = join(root, owner.path);
    const raw = readFileSync(absolute, 'utf8');
    if (sha256Text(raw) !== msg.sha256) {
      socket.send(JSON.stringify({ type: 'error', message: 'file changed underneath — refreshed' }));
      await pushSnapshot();
      return null;
    }
    return { project, song, owner, absolute, raw };
  };

  // The shared tail of every insert op: run the pure edit against the
  // resolved file, report failure, or write and push.
  const runInsertOp = async (
    socket: WebSocket,
    { project, absolute }: { project: LoadedProject; absolute: string },
    result: ReturnType<typeof applyInsertRemove>,
  ) => {
    if (!result.ok) {
      socket.send(JSON.stringify({ type: 'error', message: result.message }));
      if (result.refresh) await pushSnapshot();
      return;
    }
    if (!writeChecked(socket, project, absolute, result.text)) return;
    await pushSnapshot();
  };

  const handleInsertAdd = async (socket: WebSocket, msg: z.infer<typeof insertAddSchema>) => {
    const resolved = await resolveTrackFile(socket, msg);
    if (resolved === null) return;
    await runInsertOp(socket, resolved, applyInsertAdd(resolved.raw, msg.effect));
  };

  const handleInsertEdit = async (socket: WebSocket, msg: z.infer<typeof insertEditSchema>) => {
    const resolved = await resolveTrackFile(socket, msg);
    if (resolved === null) return;
    await runInsertOp(socket, resolved, applyInsertEdit(resolved.raw, msg.entry, msg.set));
  };

  const handleInsertRemove = async (socket: WebSocket, msg: z.infer<typeof insertRemoveSchema>) => {
    const resolved = await resolveTrackFile(socket, msg);
    if (resolved === null) return;
    await runInsertOp(socket, resolved, applyInsertRemove(resolved.raw, msg.entry));
  };

  const handle = async (socket: WebSocket, raw: string) => {
    const parsed = upSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      socket.send(JSON.stringify({ type: 'error', message: 'bad request' }));
      return;
    }
    const msg = parsed.data;
    try {
      if (msg.type === 'play') await client.play();
      else if (msg.type === 'pause') await client.pause();
      else if (msg.type === 'stop') await client.stop();
      else if (msg.type === 'locate') {
        await client.locate(msg.sample);
        // Locate moves exactly the field the dedupe ignores, so the
        // comparison would suppress the one update that matters — and
        // while paused the daemon broadcasts no position events at all,
        // so nothing else would move the playhead. Clearing the
        // last-sent key forces this one through.
        lastSent = undefined;
        await pushSnapshot();
      }
      else if (msg.type === 'device') {
        await client.selectDevice(msg.name);
        await pushSnapshot();
      } else if (msg.type === 'solo') {
        soloed = msg.track;
        await swapSession();
        await pushSnapshot();
      } else if (msg.type === 'edit') {
        await handleEdit(socket, msg);
      } else if (msg.type === 'move') {
        await handleMove(socket, msg);
      } else if (msg.type === 'split') {
        await handleSplit(socket, msg);
      } else if (msg.type === 'stretch') {
        await handleStretch(socket, msg);
      } else if (msg.type === 'insert-add') {
        await handleInsertAdd(socket, msg);
      } else if (msg.type === 'insert-edit') {
        await handleInsertEdit(socket, msg);
      } else if (msg.type === 'insert-remove') {
        await handleInsertRemove(socket, msg);
      }
    } catch (err) {
      socket.send(
        JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
    }
  };

  // Static assets: the client's build output, shipped with the package.
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const distDir = join(packageRoot, 'ui', 'dist');
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
  };
  const serveStatic = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const file = staticFile(distDir, url.pathname);
    if (file === undefined || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  };

  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error('the UI is not built — run `pnpm --dir ui build` (or `pnpm build:ui`)');
  }

  const http = createServer(serveStatic);
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    const address = http.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const originOk =
      origin === undefined ||
      origin === `http://127.0.0.1:${port}` ||
      origin === `http://localhost:${port}`;
    if (!originOk || url.pathname !== '/ws' || url.searchParams.get('t') !== token) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('message', (data) => void handle(ws, String(data)));
      ws.on('close', () => sockets.delete(ws));
      // Through the same chain the broadcasts use, or a window can open
      // on a stale value: this read starts before an edit, an edit's
      // broadcast reaches the freshly added socket first, and then this
      // one resolves and overwrites it with the older state — the same
      // frame-of-wrong-state the chain exists to prevent, arriving
      // through the door instead of mid-session. Sent directly rather
      // than via pushSnapshot because a new socket must be told the
      // current state even when it matches what everyone else was last
      // told, which is exactly what the dedupe suppresses. lastSent is
      // deliberately not touched here: this send informs one socket, and
      // claiming it for all of them would suppress the next broadcast
      // the others still need.
      pending = (pending ?? Promise.resolve()).then(
        async () => {
          try {
            ws.send(JSON.stringify(await snapshot()));
          } catch (err) {
            // Same discipline as pushSnapshot's run: a rejection escaping
            // here would poison `pending` itself, and with nothing else
            // chaining onto it Node's default takes an unhandled
            // rejection as fatal — ending the session, and the window
            // with it, over one failed read. Telling the window instead
            // costs nothing and says what happened.
            try {
              const message = err instanceof Error ? err.message : String(err);
              ws.send(JSON.stringify({ type: 'error', message }));
            } catch {
              // The socket is gone; there is nobody left to tell.
            }
          }
        },
        () => {},
      );
    });
  });

  await new Promise<void>((resolve) => http.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  process.stdout.write(`field ui: ${url}\n`);
  // The shell is the front door (ui.md §6, settling §5's open question):
  // a window of its own rather than a tab in whatever browser happens to
  // be default — it owns its lifetime, and it can mirror the page's
  // console to this terminal, which is the only reason the first blank
  // window was diagnosable at all. --browser opts back out, and a
  // missing Electron falls back rather than failing; the printed URL
  // always works. The dependency's weight is recorded in
  // project-core.md §5.
  const { spawn } = await import('node:child_process');
  let shell: ReturnType<typeof spawn> | undefined;
  const openInBrowser = () => {
    const opener =
      process.platform === 'darwin'
        ? { cmd: 'open', args: [url] }
        : process.platform === 'win32'
          ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
          : { cmd: 'xdg-open', args: [url] };
    const child = spawn(opener.cmd, opener.args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  };
  if (options.open !== false) {
    if (options.browser === true) {
      openInBrowser();
    } else {
      const electron = join(packageRoot, 'ui', 'node_modules', 'electron', 'cli.js');
      const shellEntry = join(packageRoot, 'ui', 'shell.cjs');
      if (existsSync(electron) && existsSync(shellEntry)) {
        // stderr inherited on purpose: the shell mirrors the page's
        // console here, which is the only place a blank window can
        // explain itself.
        shell = spawn(process.execPath, [electron, shellEntry, url], {
          stdio: ['ignore', 'ignore', 'inherit'],
        });
        shell.on('error', () => {
          process.stderr.write('field ui: could not start the app shell; opening a browser\n');
          openInBrowser();
        });
      } else {
        process.stderr.write(
          'field ui: the app shell is not installed (pnpm --dir ui install); opening a browser\n',
        );
        openInBrowser();
      }
    }
  }

  // The session ends on ctrl-c, or when the window closes — the shell
  // window IS the app, so outliving it would leave a server nobody can
  // reach. A browser tab has no such signal and keeps the ctrl-c
  // contract the printed URL implies.
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
    shell?.once('exit', () => resolve());
  });
  if (shell !== undefined && shell.exitCode === null) shell.kill();
  watchAbort.abort();
  http.close();
  client.close();
  await watchDone.catch(() => {});
}
