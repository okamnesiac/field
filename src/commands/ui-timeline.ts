import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readWav } from '../audio/wav.js';
import { placedWindow } from '../generators/stem.js';
import type { LoadedSong } from '../model/project.js';
import { barTicks, MeterMap, TempoMap } from '../time/tempo.js';
import type { UiClip, UiMark, UiTimeline } from './ui-protocol.js';

// The song seen in time: a pure projection from the
// loaded project to lanes with absolute sample windows, plus the bar
// marks the ruler draws.
//
// From the files, not the compiled session, for the plan's reason: the
// session is a build artifact whose shape depends on cache state, so a
// frozen child's clips collapse into one rendered stem and lanes would
// gain and lose their insides as the cache warms. The window is a fact
// about the placement.
//
// The windows come from `placedWindow`, the planner's own function.
// Re-deriving `at`/`duration` here would be a second implementation of
// the arithmetic that decides where audio actually lands, and the two
// would drift silently — the picture disagreeing with the render is the
// one bug this view cannot afford, because the picture is the evidence.

// Bars are not linear in samples: a tempo event may ramp, so a client
// interpolating between two marks draws the grid wrong exactly where the
// music is doing something interesting. Every bar
// gets its own mark, projected through the real map.
function barMarks(tempo: TempoMap, meter: MeterMap, lengthSamples: number): UiMark[] {
  const marks: UiMark[] = [];
  let bar = 1;
  let tick = 0;
  // Walk the meter segments the map already validated, using its own
  // barTicks rather than recomputing a bar's length from numerator and
  // denominator — the same reason the windows come from placedWindow.
  // Bounded rather than while(true): a pathological map should not spin
  // the server even though validation makes one unreachable.
  for (let i = 0; i < 4096; i++) {
    const sample = Math.round(tempo.ticksToSamples(tick));
    if (sample > lengthSamples) break;
    marks.push({ sample, bar });
    let seg = 0;
    while (seg + 1 < meter.events.length && meter.events[seg + 1]!.at <= tick) seg++;
    const length = barTicks(meter.events[seg]!);
    if (length <= 0) break;
    tick += length;
    bar++;
  }
  return marks;
}

// Peak envelope for a lane, in buckets across the whole song.
//
// Deliberately the cheap half of waveforms. Doing them properly means a
// peaks artifact with a build rule, a cache and an invalidation story —
// a project of its own, and still the right answer for long material.
// This computes the envelope on demand from the stem the build already
// materialized and memoises it by that file's identity, which is enough
// for songs of a few minutes and buys the picture its content now.
const peakCache = new Map<string, number[]>();
export function peaksFor(path: string, buckets: number): number[] | undefined {
  if (!existsSync(path)) return undefined;
  // Keyed on the artifact's own identity — size and modification time —
  // rather than on anything about the song. An earlier version keyed on
  // the session's total length, which does not move when a stem's
  // contents change, so every same-length edit (a fader, a mute, an
  // insert: nearly all of them) redrew the previous audio. The build
  // materializes by rename and skips entirely when the bytes already
  // match, so mtime moves exactly when the content does and not
  // otherwise.
  const stat = statSync(path);
  const key = `${path}:${stat.size}:${stat.mtimeMs}`;
  const cached = peakCache.get(key);
  if (cached) return cached;
  let wav;
  try {
    wav = readWav(path);
  } catch {
    return undefined; // an unreadable artifact is a lane without a picture
  }
  const frames = wav.channels[0]?.length ?? 0;
  if (frames === 0) return undefined;
  const out: number[] = new Array(buckets).fill(0);
  const per = frames / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(frames, Math.floor((b + 1) * per));
    let peak = 0;
    // Stride large buckets: a 16-second stem at 48 k is 768 k frames and
    // the envelope only needs the shape, not every sample.
    const step = Math.max(1, Math.floor((to - from) / 512));
    for (const ch of wav.channels) {
      for (let i = from; i < to; i += step) {
        const v = Math.abs(ch[i] ?? 0);
        if (v > peak) peak = v;
      }
    }
    out[b] = Math.min(1, peak);
  }
  peakCache.set(key, out);
  if (peakCache.size > 64) peakCache.delete(peakCache.keys().next().value as string);
  return out;
}

export function projectTimeline(
  root: string,
  song: LoadedSong,
  sessionRate: number,
  lengthSamples: number,
  peakBuckets: number,
): UiTimeline {
  const byName = new Map(song.tracks.map((t) => [t.data.name, t.data]));
  const main = byName.get('main');
  const songTempo = new TempoMap(song.time?.tempo ?? [{ at: 0, bpm: 120 }], sessionRate);
  const songMeter = new MeterMap(song.time?.meter ?? [{ at: 0, numerator: 4, denominator: 4 }]);

  const lanes = (main?.inputs ?? []).map((entry) => {
    const placedName = entry.track;
    const placed = placedName !== undefined ? byName.get(placedName) : undefined;
    // A placed track's contents are in that track's own time
    // (nested-tracks.md §13), so its clips project through its map —
    // falling back to the song's, independently for tempo and meter.
    const localTempo = placed?.time?.tempo
      ? new TempoMap(placed.time.tempo, sessionRate)
      : songTempo;

    // The lane's own window in main's time: where this placement sits.
    const own = placedWindow(entry, songTempo);

    // One block per placement inside the placed track, in absolute
    // samples — the lane's own start plus the child's offset.
    const clips: UiClip[] = (placed?.inputs ?? [])
      .filter((child) => child.receive === undefined && !child.mute)
      .map((child) => {
        const w = placedWindow(child, localTempo);
        return {
          start: own.start + w.start,
          duration: w.duration ?? own.duration ?? Math.max(0, lengthSamples - own.start - w.start),
          // An omitted duration is a real state, not a zero: the source's
          // length is not knowable while planning, and the view says so
          // rather than drawing a guess as though it were measured.
          exact: w.duration !== undefined,
          name: child.track ?? child.audio ?? (child.supercollider ? 'supercollider' : child.generative ? 'generative' : 'input'),
        };
      });

    return {
      entry: (main?.inputs ?? []).indexOf(entry),
      start: own.start,
      duration: own.duration ?? Math.max(0, lengthSamples - own.start),
      clips,
      peaks:
        placedName === undefined
          ? undefined
          : peaksFor(join(root, '.field', 'out', song.dir, 'track', `${placedName}.wav`), peakBuckets),
    };
  });

  return {
    rate: sessionRate,
    length: lengthSamples,
    marks: barMarks(songTempo, songMeter, lengthSamples),
    lanes,
  };
}
