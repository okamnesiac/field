import { renderInsertChain } from '../audio/render-daemon.js';
import { readWavHeader } from '../audio/wav.js';
import type { Clip, Insert, Track, TrackInput } from '../schema/index.js';
import type { TempoMap } from '../time/tempo.js';
import type { Generator } from './types.js';

// stem: the implicit generator behind //songs/<song>/track:<name>
// (mix-assembly.md §3) — a mix file defines a mix, a track file implies
// a stem. The spec is synthesized from the track file, never declared:
// clip windows are projected through the tempo map
// to samples *before* hashing, so the action key sees the resolved placement
// plan. A tempo edit therefore rebuilds exactly the tracks whose musical
// clips moved; reordering clips in YAML or renaming an asset changes
// nothing. Stems render pre-fader (track gain_db/pan are mix parameters)
// and start at timeline sample 0 so the mix can sum by alignment alone.

export interface PlacedClip {
  input: number; // index into spec.sources
  start: number; // stem sample where the clip window begins
  // Window length in samples. Absent means "as long as the input is" —
  // the placement plays its whole source and truncates nothing
  // (nested-tracks.md §1.6: a container never truncates, a placement may,
  // and an omitted duration is the placement declining to). Only a placed
  // track can omit it: a clip's source is committed content whose length
  // validate can read, while a child track's render length is unknowable
  // at plan time — a reverb insert grows a stem past its last clip end.
  // execute() resolves it from the rendered input, after the child is
  // built and before the daemon sees a plan. Staying out of the action
  // key is correct rather than convenient: the child's content hash is
  // already an input, so "the whole of it" re-keys when its length moves.
  duration?: number;
  // Sample of the asset playing at the window start (source_offset − slip,
  // project-core.md §3.2). May be negative or run past the asset's end:
  // out-of-range reads are silence — slipping never errors.
  read_offset: number;
  gain_db: number;
  // Constant-power balance for this placement, -1 left … 1 right.
  // **Omitted when centred**, which is not a micro-optimisation: `clips`
  // reaches the action key, so serializing `pan: 0` on every clip would
  // re-key every stem in every project for a field none of them set. Same
  // rule `inserts` follows (nested-tracks.md §1.13).
  pan?: number;
  fade_in: number; // samples, linear, from the window start
  fade_out: number; // samples, linear, to the window end
}

// What the daemon renders: every window resolved to a length. The two
// types are deliberately distinct — `duration?` is a fact about a *plan*,
// and letting it reach the wire would make the daemon's job conditional
// on something the control plane is supposed to have already decided.
export type RenderedClip = Omit<PlacedClip, 'duration'> & { duration: number };

// Every audio track has a stem, including an empty one — it renders as
// silence, which is what it contains. Clips were the only content until
// tracks could contain tracks, and requiring *some* content was the rule
// until a song's output became a track: `field song create` writes an
// empty `main`, and a label the bare song name resolves to has to exist
// from that moment rather than from the first clip. A midi track still has
// no audio to render.
//
// One predicate, because validate and the graph answering this question
// differently is how a check-clean project fails to build.
export function renderableTrack(track: Track): boolean {
  return track.type === 'audio';
}

// How a placed track is spelled in `sources`. Tracks are not in the
// song's one namespace (project-layout.md §4.3) — a track and a sound may
// share a name — so a bare slug would be ambiguous exactly where wiring
// must not be. The prefix cannot collide with a source ref: bare refs are
// slugs, which have no colon, and the only other spelling is
// //shared/asset:. Nothing here reaches an action key — `sources` is
// wiring, so the spelling is free and only the resulting order matters.
const TRACK_REF_PREFIX = 'track:';
export function trackRef(name: string): string {
  return `${TRACK_REF_PREFIX}${name}`;
}
export function trackRefName(ref: string): string | undefined {
  return ref.startsWith(TRACK_REF_PREFIX) ? ref.slice(TRACK_REF_PREFIX.length) : undefined;
}

export interface StemSpec {
  name: string;
  type: 'stem';
  // Wiring: clips index into this source list, matching the graph's dep
  // order. Committed-content sources (assets, shared pins, chosen
  // generate sounds — anything whose hash is known before building) sort
  // by content hash, so renames cannot reach the key; buildable sounds
  // sort by name — their content hashes don't exist until they build,
  // and a sound rename is a real relabel.
  sources: string[];
  clips: PlacedClip[];
  // Inserts bake into the stem (effects.md §5): parameters here mean an
  // insert edit re-renders it. Omitted entirely when the track has none,
  // so insert-less stems keep their pre-inserts action keys.
  inserts?: Insert[];
  // The song's declared extent, present only on the track that is the
  // song's output (labels.ts SONG_OUTPUT_NAME). The mix carried these
  // until a track could be a song's output; the fields, the meaning and
  // the daemon's rule about them are the mix's, unchanged. Omitted
  // otherwise, so every other stem keeps its key.
  length_samples?: number;
  loop?: boolean;
}

// A clip's window on the stem timeline, in samples. Musical clips project
// both edges through the tempo map (the window end is position + duration
// in ticks, so a clip spanning a ramp gets its true sample length); absolute
// clips are already samples.
export function placedWindow(clip: Clip, tempoMap: TempoMap): { start: number; duration: number } {
  if (clip.anchor === 'absolute') {
    return { start: clip.position, duration: clip.duration };
  }
  const start = tempoMap.ticksToSamples(clip.position);
  return { start, duration: tempoMap.ticksToSamples(clip.position + clip.duration) - start };
}

// A placed track's window, projected the same way — the child's origin
// lands at `at`, and a declared duration measures from there so a
// placement spanning a tempo ramp gets its true sample length. An omitted
// duration stays omitted all the way to execute(); see PlacedClip.
export function placedInput(
  input: TrackInput,
  tempoMap: TempoMap,
): { start: number; duration?: number } {
  if (input.anchor === 'absolute') {
    return input.duration === undefined
      ? { start: input.at }
      : { start: input.at, duration: input.duration };
  }
  const start = tempoMap.ticksToSamples(input.at);
  if (input.duration === undefined) return { start };
  return { start, duration: tempoMap.ticksToSamples(input.at + input.duration) - start };
}

// Loop expansion (clip-looping.md §1.6): a looped clip becomes the same
// resolved per-repetition entries equivalent hand-written clips would
// produce — the renderer and the action-key format don't know loops exist.
// Returns entries without input wiring; planTrack fills that in. Exported
// for validate, which runs the same expansion to diagnose exhausted
// sources and fades that outgrow their slots before any graph exists —
// the throw below is a backstop the gate makes unreachable.
export function expandLoop(
  clip: Clip,
  loop: NonNullable<Clip['loop']>,
  tempoMap: TempoMap,
  sourceFrames: number | undefined,
  // Every repetition has a concrete window: a loop tiles a clip, and a
  // clip's own duration is required. Only a placed track leaves one open.
): Omit<RenderedClip, 'input'>[] {
  const { start, duration } = placedWindow(clip, tempoMap);
  const windowEnd = start + duration;
  const readOffset = clip.source_offset - clip.slip;

  // Repetition boundaries on the stem timeline, in samples.
  const bounds: number[] = [];
  if (loop.every !== undefined) {
    // Anchor units, like position/duration: musical loops repeat on the
    // grid straight through tempo ramps.
    for (let at = clip.position; ; at += loop.every) {
      const sample = clip.anchor === 'absolute' ? at : tempoMap.ticksToSamples(at);
      if (sample >= windowEnd) break;
      bounds.push(sample);
    }
  } else {
    // Tile at the source's own length. A target's length is unknown at
    // plan time (validate already demands `every` there); an asset whose
    // content is exhausted by the read offset has nothing to tile.
    const interval = (sourceFrames ?? 0) - readOffset;
    if (interval <= 0) {
      throw new Error(
        `clip "${clip.id}": loop without 'every' needs source content after its read offset`,
      );
    }
    for (let at = start; at < windowEnd; at += interval) bounds.push(at);
  }

  return bounds.map((slotStart, k) => {
    const last = k === bounds.length - 1;
    const slotEnd = last ? windowEnd : bounds[k + 1]!;
    // truncate cuts each repetition at its slot; overlay lets it ring to
    // the window's edge — reads past the source's end are silence, so the
    // voice ends where its content does, and overlapping voices sum like
    // any overlapping clips.
    const repDuration = loop.mode === 'overlay' ? windowEnd - slotStart : slotEnd - slotStart;
    return {
      start: slotStart,
      duration: repDuration,
      read_offset: readOffset,
      gain_db: clip.gain_db,
      // Whole-clip fades keep their meaning (first head, window tail);
      // seams get the loop's click-guard. Overlay voices all end at the
      // window edge, so the window fade covers whatever is cut there.
      fade_in: k === 0 ? clip.fade_in : loop.fade,
      fade_out:
        loop.mode === 'overlay' ? clip.fade_out : last ? clip.fade_out : loop.fade,
    };
  });
}

export function planTrack(
  track: Track,
  tempoMap: TempoMap,
  // Content hashes for committed sources, keyed by the exact ref string
  // clips carry (bare name or //shared/asset: label); a ref absent here
  // is a buildable sound. Wiring order is content-hash order for the
  // committed ones (name tiebreak for determinism), so renaming cannot
  // permute the input list or the clip indices — names never reach the
  // action key at all (#9 review) — and name order for buildable sounds.
  sha256BySource: Map<string, string>,
  framesBySource: Map<string, number> = new Map(),
  // Set only for a song's output track; see StemSpec.
  extent: { lengthSamples?: number | undefined; loop?: boolean | undefined } = {},
): StemSpec {
  // Clips and placed tracks share one source list, because they are one
  // thing wearing two spellings (nested-tracks.md §1.11: a clip is a
  // placement, and a placement is a stem at a time). A placed track is
  // never in sha256BySource — its bytes do not exist until it renders —
  // so it sorts with the buildable sounds, by name, for the same reason
  // they do.
  const refs = [
    ...new Set([...track.clips.map((c) => c.source), ...track.inputs.map((i) => trackRef(i.track))]),
  ];
  const committed = refs
    .filter((r) => sha256BySource.has(r))
    .sort((a, b) => {
      const ha = sha256BySource.get(a)!;
      const hb = sha256BySource.get(b)!;
      return ha < hb ? -1 : ha > hb ? 1 : a < b ? -1 : 1;
    });
  const buildable = refs.filter((r) => !sha256BySource.has(r)).sort();
  const sources = [...committed, ...buildable];
  const inputIndex = new Map(sources.map((ref, i): [string, number] => [ref, i]));
  const placements = track.inputs.map((input): PlacedClip => {
    const { start, duration } = placedInput(input, tempoMap);
    return {
      input: inputIndex.get(trackRef(input.track))!,
      start,
      ...(duration !== undefined ? { duration } : {}),
      // A placement reads its child from the child's own origin. Slip is
      // a clip's way of moving content under a fixed window; a placement
      // moves the window instead, which is what `at` is.
      read_offset: 0,
      gain_db: input.gain_db,
      ...(input.pan !== 0 ? { pan: input.pan } : {}),
      fade_in: input.fade_in,
      fade_out: input.fade_out,
    };
  });
  const clips = track.clips.flatMap((clip): PlacedClip[] => {
    const input = inputIndex.get(clip.source)!;
    const loop = clip.loop?.enabled ? clip.loop : undefined;
    if (loop) {
      const frames = framesBySource.get(clip.source);
      return expandLoop(clip, loop, tempoMap, frames).map((rep) => ({ input, ...rep }));
    }
    const { start, duration } = placedWindow(clip, tempoMap);
    return [
      {
        input,
        start,
        duration,
        read_offset: clip.source_offset - clip.slip,
        gain_db: clip.gain_db,
        fade_in: clip.fade_in,
        fade_out: clip.fade_out,
      },
    ];
  });
  // Canonical order: summing is commutative, so the action key must not
  // depend on YAML clip order — nor on whether a placement was written
  // among the clips or after them, which is why the two lists sort as
  // one. An absent duration sorts as -1: no real window is shorter, and
  // the comparator's job is to be total and stable, not meaningful.
  const placed = [...clips, ...placements];
  placed.sort(
    (a, b) =>
      a.start - b.start ||
      a.input - b.input ||
      a.read_offset - b.read_offset ||
      (a.duration ?? -1) - (b.duration ?? -1) ||
      a.gain_db - b.gain_db ||
      (a.pan ?? 0) - (b.pan ?? 0) ||
      a.fade_in - b.fade_in ||
      a.fade_out - b.fade_out,
  );
  return {
    name: track.name,
    type: 'stem',
    sources,
    clips: placed,
    ...(track.inserts.length > 0 ? { inserts: track.inserts } : {}),
    ...(extent.lengthSamples !== undefined ? { length_samples: extent.lengthSamples } : {}),
    // `loop` only travels with a length to fold onto — the daemon refuses
    // the pair otherwise, and planMix has always paired them this way.
    ...(extent.loop === true && extent.lengthSamples !== undefined ? { loop: true } : {}),
  };
}

export const stemGenerator: Generator<StemSpec> = {
  version: 1,
  wiringFields: ['sources'],

  sources(spec) {
    // Clip sources: a clip on a buildable sound pulls its whole
    // definition into the stem's subgraph (mix-assembly.md §5).
    return spec.sources;
  },

  validate() {
    // Synthesized specs are never declared in YAML; clip references and
    // fade fit are validated on the track file itself (model/project.ts).
  },

  async execute(spec, inputPaths, outputPath, ctx) {
    // Rates and channel counts are checked here, from headers alone, and
    // the daemon does the summing (render-pipeline.md chunk 3). The split
    // is deliberate: these two messages are user-facing diagnostics, and
    // diagnostics belong in the control plane with all the others rather
    // than duplicated into C++ where they would drift.
    const frames = spec.sources.map((name, i) => {
      const header = readWavHeader(inputPaths[i]!);
      if (header.sampleRate !== ctx.sampleRate) {
        throw new Error(
          `input "${name}" is ${header.sampleRate} Hz but the project is ${ctx.sampleRate} Hz — ` +
            `Field never resamples implicitly; render or convert it at the project rate ` +
            `(add a normalize sound at ${ctx.sampleRate}, or re-import at that rate)`,
        );
      }
      if (header.channels > 2) {
        throw new Error(`input "${name}" has ${header.channels} channels; mono or stereo only`);
      }
      return header.frames;
    });

    // Where a plan-time length was unknowable, the rendered input answers
    // it: the build walks dependencies first, so a placed track's stem is
    // already on disk here. This is the only place the two lengths can be
    // reconciled — earlier the child does not exist, later the daemon has
    // no notion of "as long as the input is".
    const clips = spec.clips.map((clip): RenderedClip => ({
      ...clip,
      duration: clip.duration ?? Math.max(0, frames[clip.input]! - clip.read_offset),
    }));

    await renderInsertChain({
      op: 'stem',
      output: outputPath,
      sample_rate: ctx.sampleRate,
      inputs: inputPaths,
      clips,
      ...(spec.inserts !== undefined ? { inserts: spec.inserts } : {}),
      ...(spec.length_samples !== undefined ? { length_samples: spec.length_samples } : {}),
      ...(spec.loop !== undefined ? { loop: spec.loop } : {}),
    });
  }
};
