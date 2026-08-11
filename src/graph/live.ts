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

import { join, relative } from 'node:path';
import { wavFrameCount } from '../audio/wav.js';
import { SESSION_VERSION, type Session, type SessionInsert, type SessionTrack } from '../audiod/session.js';
import { buildLabels } from '../commands/build.js';
import { formatLabel } from '../labels.js';
import { loadProject } from '../model/project.js';
import type { Insert } from '../schema/index.js';
import { buildGraph, type Graph } from './graph.js';

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

export async function compileSession(root: string, songName: string): Promise<Session> {
  const project = loadProject(root);
  const errors = project.diagnostics.filter((d) => d.severity !== 'warning');
  if (errors.length > 0) throw new Error('project has errors (field check)');
  const song = project.songs.find((s) => s.name === songName);
  if (!song) throw new Error(`no such song "${songName}"`);
  const graph: Graph = buildGraph(project);

  // The song's track nodes, keyed by name; their deps aligned to sources.
  const shapes = new Map<string, TrackShape>();
  for (const track of song.tracks) {
    const key = `//${song.dir}/track:${track.data.name}`;
    const node = graph.nodes.get(key);
    if (node === undefined || node.kind !== 'rule') throw new Error(`no stem node for ${key}`);
    shapes.set(track.data.name, {
      name: track.data.name,
      rate: node.sampleRate,
      spec: node.spec as unknown as StemLike,
      deps: node.deps.map((d) => formatLabel(d)),
    });
  }

  // Build every non-track dependency (sources, gen artifacts, converts) —
  // the files the live engine streams. Track and tap refs stay unbuilt:
  // they are what the engine evaluates.
  const isLive = (label: string) => /\/(track|tap):/.test(label);
  const toBuild = [
    ...new Set([...shapes.values()].flatMap((s) => s.deps.filter((d) => !isLive(d)))),
  ];
  const pathByLabel = new Map<string, string>();
  if (toBuild.length > 0) {
    for (const outcome of await buildLabels(root, toBuild)) {
      if (outcome.outputPath !== undefined)
        pathByLabel.set(outcome.label, relative(root, outcome.outputPath));
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
        const path = pathByLabel.get(dep);
        if (path === undefined) throw new Error(`unbuilt source ${dep} for "${name}"`);
        const frames = wavFrameCount(join(root, path));
        const duration = clip.duration ?? Math.max(0, frames - clip.read_offset);
        contentEnd = Math.max(contentEnd, clip.start + duration);
        inputs.push({ file: path, ...base, duration });
      }
    }

    // Delay compensation at this summing point (realtime.md chunk 2):
    // every input arrives as late as the latest.
    for (const { index, ownLatency } of pending) {
      const window = inputs[index]!;
      if ('comp_delay' in window) window.comp_delay = maxInputLatency - ownLatency;
    }

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

  for (const name of shapes.keys()) compile(name, []);

  const output = shapes.get('main');
  if (!output) throw new Error(`song "${songName}" has no track named "main"`);
  return {
    version: SESSION_VERSION,
    rate: output.rate,
    ...(output.spec.length_samples !== undefined
      ? { length_samples: output.spec.length_samples }
      : {}),
    ...(output.spec.loop !== undefined ? { loop: output.spec.loop } : {}),
    output: 'main',
    tracks: [...compiled.values()],
  };
}
