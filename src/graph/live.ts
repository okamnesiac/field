// Compile the graph into a live session (realtime.md §3, chunk 2).
//
// The graph's track nodes already carry each track's full StemSpec —
// resolved clips at the track's rate, sources as ordered refs matching
// node.deps — so the compiler transforms those specs instead of
// re-planning. Sources classify three ways by their dep label: a
// `track:` ref becomes a `track` window (the child's live output ring
// read at a delay — a post-tap cable arrival is mechanically the same
// thing and compiles to the same shape); a `tap:` ref becomes a
// `receive` window reading the sender's pre-chain ring; everything else
// is a `file` window naming the built or committed path, which is why
// the compiler builds every non-track dependency first.
//
// Latency is compiler arithmetic, never engine arithmetic (playback.md
// §3.6's division of labour): the limiter's live horizon is one attack
// ramp (60 dB — session.ts records the choice), eq and reverb are zero,
// a cross-rate edge adds the streaming resampler's taps/2 group delay,
// and each summing input carries comp_delay = maxSibling − own so
// unequal paths arrive aligned. The engine only applies offsets.
//
// Durations resolve analytically, bottom-up: a file window from its WAV
// header (execute()'s own rule, frames − read_offset), a track window
// from the child's computed live length — content end plus each
// reverb's predelay and tail, truncated to the declared extent on the
// song's output. A window whose start − read_offset is negative would
// need future child samples; live taps only ever delay, so that is a
// compile error.
//
// The cache is the freeze (realtime.md decision 4, chunk 4): before
// compiling, every non-output, non-pre-tapped track asks the build
// cache — explain(), which executes nothing — whether its stem action
// is cached. A cached track compiles to one file window over its stem;
// the rest evaluate live and are reported as `dirty`, so the watch loop
// can rebuild their stems behind the play and freeze them on the next
// compile — a swap that is inaudible because live and offline are
// bit-identical (decision 3). CPU scales with what is being edited,
// not with the session.

import { join, relative } from 'node:path';
import { wavFrameCount } from '../audio/wav.js';
import { SESSION_VERSION, type Session, type SessionInsert, type SessionTrack } from '../audiod/session.js';
import { buildLabels } from '../commands/build.js';
import { formatLabel } from '../labels.js';
import { loadProject } from '../model/project.js';
import type { Insert } from '../schema/index.js';
import { explain, type Explanation } from './build.js';
import { buildGraph, type Graph, type GraphNode } from './graph.js';

const RESAMPLER_TAPS = 128; // dsp/resample.cpp's design point

interface TrackShape {
  name: string;
  rate: number;
  spec: StemLike;
  deps: string[]; // formatted labels, aligned with spec.sources
}

// The slice of StemSpec the compiler reads; kept structural so this
// module does not import the generator internals.
interface StemLike {
  sources: string[];
  clips: {
    input: number;
    start: number;
    duration?: number;
    read_offset: number;
    gain_db: number;
    pan?: number;
    fade_in: number;
    fade_out: number;
  }[];
  inserts?: Insert[];
  length_samples?: number;
  loop?: boolean;
}

function liveInsert(insert: Insert): SessionInsert {
  if (insert.effect === 'limit') return { ...insert, horizon_db: 60 };
  return insert as SessionInsert;
}

// One attack ramp of pending window: the live horizon's latency.
function chainLatency(chain: SessionInsert[], rate: number): number {
  let latency = 0;
  for (const insert of chain) {
    if (insert.effect === 'limit') {
      const window = Math.max(1, Math.round((insert.lookahead_ms / 1000) * rate));
      latency += Math.ceil((insert.horizon_db / 60) * window);
    }
  }
  return latency;
}

// How much a chain grows its input: each reverb appends predelay + T60.
function chainGrowth(chain: SessionInsert[], rate: number): number {
  let growth = 0;
  for (const insert of chain) {
    if (insert.effect === 'reverb') {
      growth +=
        Math.round((insert.predelay_ms / 1000) * rate) + Math.round(insert.decay * rate);
    }
  }
  return growth;
}

export interface CompiledSession {
  session: Session;
  // Freeze candidates that missed the cache this compile — reachable
  // tracks evaluating live that one stem build away from being served
  // as cached files. Never the output track (always live: its windows
  // are the ramp surface, and a looping wrap is a performance where the
  // artifact is a fold) and never a pre-tap sender (a stem is
  // post-chain; the cable needs the pre ring), so a watch loop that
  // rebuilds exactly this list converges instead of chasing tracks
  // that can never freeze.
  dirty: string[];
}

export async function compileSession(
  root: string,
  songName: string,
  options: { loop?: boolean } = {},
): Promise<CompiledSession> {
  const project = loadProject(root);
  const errors = project.diagnostics.filter((d) => d.severity !== 'warning');
  if (errors.length > 0) throw new Error('project has errors (field check)');
  const song = project.songs.find((s) => s.name === songName);
  if (!song) throw new Error(`no such song "${songName}"`);
  const graph: Graph = buildGraph(project);

  // The song's track nodes, keyed by name; their deps aligned to sources.
  const shapes = new Map<string, TrackShape>();
  const stemNodes = new Map<string, GraphNode>();
  for (const track of song.tracks) {
    const key = `//${song.dir}/track:${track.data.name}`;
    const node = graph.nodes.get(key);
    if (node === undefined || node.kind !== 'rule') throw new Error(`no stem node for ${key}`);
    stemNodes.set(track.data.name, node);
    shapes.set(track.data.name, {
      name: track.data.name,
      rate: node.sampleRate,
      spec: node.spec as unknown as StemLike,
      deps: node.deps.map((d) => formatLabel(d)),
    });
  }
  if (!shapes.has('main')) throw new Error(`song "${songName}" has no track named "main"`);

  // The freeze (realtime.md decision 4): a track whose stem action is
  // already cached is served as that stem — one file window, no chain,
  // no children — because live and offline are sample-identical, so the
  // cached artifact is what live evaluation would have produced anyway.
  // explain() answers "is this cached" without executing anything; a
  // miss means the track evaluates live and lands in `dirty` for the
  // watch loop to rebuild behind the play. Two kinds of track never
  // freeze: the output (see CompiledSession), and any pre-tap sender —
  // conservatively, a sender tapped anywhere in the song, even if the
  // receiver itself froze.
  const preTapped = new Set<string>();
  for (const shape of shapes.values()) {
    for (const dep of shape.deps) {
      const tap = /\/tap:(.+)$/.exec(dep);
      if (tap) preTapped.add(tap[1]!);
    }
  }
  const memo = new Map<string, Explanation>();
  const frozen = new Set<string>();
  const candidates = new Set<string>();
  for (const name of shapes.keys()) {
    if (name === 'main' || preTapped.has(name)) continue;
    candidates.add(name);
    const explanation = await explain(project, graph, stemNodes.get(name)!, memo);
    if (explanation.cached === true && explanation.outputs !== undefined) frozen.add(name);
  }

  // Reach from the output: recursion stops at a frozen track (its
  // subtree is inside the stem), and tracks nothing reaches drop from
  // the session entirely — the engine would otherwise pre-render audio
  // nobody mixes. `dirty` is the reachable candidates that missed.
  const liveReach = new Set<string>();
  const frozenUsed = new Set<string>();
  const visit = (name: string): void => {
    if (frozen.has(name)) {
      frozenUsed.add(name);
      return;
    }
    if (liveReach.has(name) || !shapes.has(name)) return;
    liveReach.add(name);
    for (const dep of shapes.get(name)!.deps) {
      const ref = /\/(track|tap):(.+)$/.exec(dep);
      if (ref) visit(ref[2]!);
    }
  };
  visit('main');
  const dirty = [...liveReach]
    .filter((n) => candidates.has(n) && !frozen.has(n))
    .map((n) => `//${song.dir}/track:${n}`);

  // Build every file the engine will read: the non-track dependencies
  // (sources, gen artifacts, converts) of each live reachable track,
  // plus the frozen stems themselves — those are guaranteed cache hits
  // (explain just said so), so this only materializes.
  const isLive = (label: string) => /\/(track|tap):/.test(label);
  const toBuild = [
    ...new Set([
      ...[...liveReach].flatMap((n) => shapes.get(n)!.deps.filter((d) => !isLive(d))),
      ...[...frozenUsed].map((n) => `//${song.dir}/track:${n}`),
    ]),
  ];
  const fileByLabel = new Map<string, { path: string; sha256: string }>();
  if (toBuild.length > 0) {
    for (const outcome of await buildLabels(root, toBuild)) {
      if (outcome.outputPath !== undefined)
        fileByLabel.set(outcome.label, {
          path: relative(root, outcome.outputPath),
          sha256: outcome.sha256,
        });
    }
  }

  // Bottom-up: live lengths (pre = content end, post = pre + chain
  // growth, the output truncated to its declared extent) and latencies.
  const preLength = new Map<string, number>();
  const postLength = new Map<string, number>();
  const latency = new Map<string, number>();
  const compiled = new Map<string, SessionTrack>();

  const compile = (name: string, stack: string[]): void => {
    if (compiled.has(name)) return;
    if (stack.includes(name)) throw new Error(`placement cycle at "${name}"`); // validate's backstop
    const shape = shapes.get(name);
    if (!shape) throw new Error(`no such track "${name}"`);
    if (frozen.has(name)) {
      // The cached form: the whole subtree as one file window reading
      // the stem, chain empty (the stem is post-chain), latency zero
      // (a stem is final, timeline-aligned from sample 0). The engine
      // needs nothing special — this is ordinary session vocabulary,
      // which is what makes the freeze swap a plain session swap.
      const built = fileByLabel.get(`//${song.dir}/track:${name}`);
      if (built === undefined) throw new Error(`unbuilt frozen stem for "${name}"`);
      const frames = wavFrameCount(join(root, built.path));
      preLength.set(name, frames);
      postLength.set(name, frames);
      latency.set(name, 0);
      compiled.set(name, {
        name,
        rate: shape.rate,
        chain: [],
        inputs: [
          {
            file: built.path,
            sha256: built.sha256,
            start: 0,
            duration: frames,
            read_offset: 0,
            gain_db: 0,
            fade_in: 0,
            fade_out: 0,
          },
        ],
        latency: 0,
      });
      return;
    }
    const chain = (shape.spec.inserts ?? []).map(liveInsert);

    // Resolve every window; recurse into children first.
    let contentEnd = 0;
    let maxInputLatency = 0;
    const inputs: SessionTrack['inputs'] = [];
    const pending: { index: number; ownLatency: number }[] = [];
    for (const clip of shape.spec.clips) {
      const dep = shape.deps[clip.input]!;
      const base = {
        start: clip.start,
        read_offset: clip.read_offset,
        gain_db: clip.gain_db,
        ...(clip.pan !== undefined ? { pan: clip.pan } : {}),
        fade_in: clip.fade_in,
        fade_out: clip.fade_out,
      };
      const tapMatch = /\/(track|tap):(.+)$/.exec(dep);
      if (tapMatch) {
        const child = tapMatch[2]!;
        compile(child, [...stack, name]);
        if (clip.start - clip.read_offset < 0) {
          throw new Error(
            `"${name}" places "${child}" needing samples before its start ` +
              `(start ${clip.start} < read_offset ${clip.read_offset}) — live taps only delay`,
          );
        }
        const childLength =
          tapMatch[1] === 'tap' ? preLength.get(child)! : postLength.get(child)!;
        const duration = clip.duration ?? Math.max(0, childLength - clip.read_offset);
        const childShape = shapes.get(child)!;
        const edgeDelay =
          childShape.rate === shape.rate
            ? 0
            : Math.round(((RESAMPLER_TAPS / 2) * shape.rate) / childShape.rate);
        const ownLatency =
          (tapMatch[1] === 'tap' ? 0 : latency.get(child)!) + edgeDelay;
        maxInputLatency = Math.max(maxInputLatency, ownLatency);
        contentEnd = Math.max(contentEnd, clip.start + duration);
        pending.push({ index: inputs.length, ownLatency });
        inputs.push(
          tapMatch[1] === 'tap'
            ? { receive: child, tap: 'pre', ...base, duration, comp_delay: 0 }
            : { track: child, ...base, duration, comp_delay: 0 },
        );
      } else {
        const built = fileByLabel.get(dep);
        if (built === undefined) throw new Error(`unbuilt source ${dep} for "${name}"`);
        const frames = wavFrameCount(join(root, built.path));
        const duration = clip.duration ?? Math.max(0, frames - clip.read_offset);
        contentEnd = Math.max(contentEnd, clip.start + duration);
        inputs.push({ file: built.path, sha256: built.sha256, ...base, duration });
      }
    }

    // comp_delay stays zero (Codex caught the double-compensation): the
    // engine's buffers are timeline-aligned — a chain's stream lag is
    // availability, not shift, because emitted sample i pairs with input
    // sample i — so subtracting latency again would slide content. The
    // field exists for the day a source's future does not (recording),
    // and the latency arithmetic above still feeds the track's reported
    // latency.
    void pending;

    const pre = contentEnd;
    let post = pre + chainGrowth(chain, shape.rate);
    if (shape.spec.length_samples !== undefined) post = shape.spec.length_samples;
    preLength.set(name, pre);
    postLength.set(name, post);
    latency.set(name, maxInputLatency + chainLatency(chain, shape.rate));

    compiled.set(name, {
      name,
      rate: shape.rate,
      chain,
      inputs,
      latency: latency.get(name)!,
    });
  };

  compile('main', []);

  for (const shape of shapes.values()) {
    const sessionRate = shapes.get('main')?.rate;
    if (sessionRate !== undefined && shape.rate !== sessionRate) {
      throw new Error(
        `track "${shape.name}" renders at ${shape.rate} Hz in a ${sessionRate} Hz session — ` +
          'cross-rate live sessions land with the resampler wiring (realtime.md decision 7); ' +
          'build and play the artifact meanwhile',
      );
    }
  }
  const output = shapes.get('main')!;
  // The session is always bounded: the declared extent when the song
  // has one, the output's natural length — content end plus chain
  // growth, exactly where the artifact ends — when it does not
  // (Codex's finding: an unbounded session played silence forever
  // after the content ran out). The authored `loop:` never reaches
  // the transport — it is a render-shape declaration, the fold
  // (clip-looping.md: "one seamless pass of the infinite
  // performance") — and player repetition is `field play --loop`,
  // which wraps at the same extent the length picks.
  const extent = output.spec.length_samples ?? postLength.get('main')!;
  const session: Session = {
    version: SESSION_VERSION,
    song: songName,
    rate: output.rate,
    ...(extent > 0 ? { length_samples: extent } : {}),
    ...(options.loop === true ? { loop: true } : {}),
    output: 'main',
    tracks: [...compiled.values()],
  };
  return { session, dirty };
}


// The edit classifier (realtime.md decision 5): two compiled sessions,
// one verdict. Sessions identical except window gains become ramps — the
// mixer surface, landing next block with no interruption; anything else
// is structural and swaps the whole session, which the daemon does at a
// block boundary while the old one keeps playing through the compile.
export type SessionEdit =
  | { kind: 'same' }
  | { kind: 'ramps'; ramps: { track: string; input: number; gain_db: number }[] }
  | { kind: 'swap' };

export function diffSessions(prev: Session, next: Session): SessionEdit {
  // Only the output track's window gains can ramp: every other track
  // pre-renders at load with its gains baked into the buffers, so a
  // ramp there would report success and change nothing (live.cpp says
  // as much where it lands ramps), and a chain setting that happens to
  // be spelled gain_db — an eq band — is an edited chain, decision 5's
  // structural case. So the mask is by position, not by name: exactly
  // the gains the ramp verb reaches go blank, and any other gain_db
  // stays visible to the comparison and falls through to swap.
  // (Decision 5 lists pan beside gain; rampRequestSchema carries no pan
  // yet, so a pan edit swaps — the safe direction — until the verb
  // grows one.)
  const shapeOf = (s: Session): string =>
    JSON.stringify({
      ...s,
      tracks: s.tracks.map((t) =>
        t.name === s.output
          ? { ...t, inputs: t.inputs.map((i) => ({ ...i, gain_db: 0 })) }
          : t,
      ),
    });
  if (shapeOf(prev) !== shapeOf(next)) return { kind: 'swap' };

  // Same shape guarantees the same output track with the same inputs on
  // both sides; only its gains can differ here.
  const before = prev.tracks.find((t) => t.name === prev.output)!;
  const after = next.tracks.find((t) => t.name === next.output)!;
  const ramps: { track: string; input: number; gain_db: number }[] = [];
  for (let i = 0; i < after.inputs.length; i++) {
    if (before.inputs[i]!.gain_db !== after.inputs[i]!.gain_db) {
      ramps.push({ track: after.name, input: i, gain_db: after.inputs[i]!.gain_db });
    }
  }
  return ramps.length > 0 ? { kind: 'ramps', ramps } : { kind: 'same' };
}
