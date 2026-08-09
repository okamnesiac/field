import { SONG_OUTPUT_NAME } from '../labels.js';
import type { LoadedSong } from './project.js';

// What a track's signal is multiplied by on its way to the top
// (nested-tracks.md §5, "effective gain lives in `explain`").
//
// §1.13 is what makes this a question worth asking. One gain, and it
// lives on the edge — so a track's own file carries no level at all, and
// "why is this quiet" cannot be answered by reading it. The answer is
// spread across every placement between here and the root, in files the
// track does not know about. creek's `keys` is the case that motivated
// this: it sits at −4 dB inside `phrase`, two levels below the output,
// annotated "scratch level while auditioning variants" in a file nobody
// opens while listening to the mix.
//
// Deliberately not a `check` warning. Multiplied levels are surprising,
// not wrong, and warnings about non-errors get tuned out (§5). `explain`
// already answers "why is this what it is", and it is where someone goes
// when a number surprises them.

// A pan on the path, attributed to the placement that carries it — which
// is in the *parent's* file, not the panned track's.
export interface PanHop {
  in: string; // the track whose `inputs:` entry carries the pan
  track: string; // the track that entry places
  pan: number;
}

export interface Reach {
  to: string; // the root this path arrives at
  gainDb: number; // the placement gains along the path, summed
  // Non-zero pans, nearest placement first. A list rather than a single
  // composed number, and that is not laziness — see `reaches`.
  pans: PanHop[];
  via: string[]; // tracks between this one and the root, nearest first
  paths: number; // identical paths collapsed into this one
}

// Every path from `trackName` up to a root, where a root is a track
// nothing places. Empty means this track is itself a root.
//
// **Gain composes; pan is listed.** Levels are dB and add, so the sum is
// exact and needs nothing but arithmetic. Pan does not reduce the same
// way: the daemon applies it as a balance (`balanceGains` in
// native/audiod/src/dsp/mixdown.cpp) that attenuates one side and never
// boosts, so two pans compose per channel rather than into a third pan —
// hard left then hard right is not centre, it is silence. Collapsing them
// here would mean a second copy of that law in TypeScript, drifting
// against the one the audio actually goes through, which is exactly what
// #76 avoided by reusing `balanceGains` for placements and faders alike.
// So a path reports the pans it passes through, in order, and lets the
// reader see that there is more than one.
//
// A track placed several times has several paths. Identical ones collapse
// with a count, because three placements of `phrase` at the same level is
// one fact about the level and not three.
export function reaches(song: LoadedSong, trackName: string): Reach[] {
  // Who places whom. The placement lives in the parent's file, so this is
  // the edge list read backwards — the direction the build graph does not
  // go, since a parent depends on its children.
  const parents = new Map<string, { in: string; gainDb: number; pan: number }[]>();
  for (const track of song.tracks) {
    for (const input of track.data.inputs ?? []) {
      const list = parents.get(input.track) ?? [];
      list.push({ in: track.data.name, gainDb: input.gain_db, pan: input.pan });
      parents.set(input.track, list);
    }
  }

  // Memoised because a track placed in two parents that share a
  // grandparent would otherwise walk the shared part twice, and depth is
  // unbounded by design (§5). Containment cycles cannot arrive here:
  // `check` names them (project.ts, "track containment cycle") and
  // `explain` refuses a project with diagnostics.
  const memo = new Map<string, Reach[]>();
  const walk = (name: string): Reach[] => {
    const seen = memo.get(name);
    if (seen) return seen;
    const up = parents.get(name) ?? [];
    if (up.length === 0) {
      // A root: the path ends here, having accumulated nothing.
      const root: Reach[] = [{ to: name, gainDb: 0, pans: [], via: [], paths: 1 }];
      memo.set(name, root);
      return root;
    }
    const found: Reach[] = [];
    for (const edge of up) {
      for (const above of walk(edge.in)) {
        found.push({
          to: above.to,
          gainDb: edge.gainDb + above.gainDb,
          pans:
            edge.pan !== 0
              ? [{ in: edge.in, track: name, pan: edge.pan }, ...above.pans]
              : above.pans,
          // `above.to === edge.in` says the parent is itself the root, so
          // it is the destination rather than a stop along the way.
          via: above.to === edge.in ? [] : [edge.in, ...above.via],
          paths: above.paths,
        });
      }
    }
    const collapsed = collapse(found);
    memo.set(name, collapsed);
    return collapsed;
  };

  if ((parents.get(trackName) ?? []).length === 0) return [];
  return walk(trackName);
}

// Two paths are the same fact when they arrive at the same place having
// done the same thing on the way. Counting them beats listing them: a
// track placed three times at one level says one thing about that level.
function collapse(found: Reach[]): Reach[] {
  const byShape = new Map<string, Reach>();
  for (const reach of found) {
    const shape = [
      reach.to,
      reach.gainDb,
      reach.via.join('>'),
      reach.pans.map((p) => `${p.in}/${p.track}@${p.pan}`).join(','),
    ].join('|');
    const existing = byShape.get(shape);
    if (existing) existing.paths += reach.paths;
    else byShape.set(shape, { ...reach });
  }
  // Sorted so the output does not depend on file order: destination
  // first, then the louder path, then the shorter one.
  return [...byShape.values()].sort(
    (a, b) => a.to.localeCompare(b.to) || b.gainDb - a.gainDb || a.via.length - b.via.length,
  );
}

// One line per destination, for `field explain`. Returns the empty string
// for a track nothing places — the caller says which kind of root it is,
// because "this is the song's output" and "nothing places this" are the
// same graph fact and very different news.
export function formatReach(reach: Reach): string {
  const parts = [`${fmtDb(reach.gainDb)} dB`];
  if (reach.pans.length === 1) parts.push(`pan ${reach.pans[0]!.pan}`);
  // Two pans on one path do not make a third pan (see `reaches`), so they
  // are named where they sit rather than added up.
  else if (reach.pans.length > 1) {
    parts.push(`pan ${reach.pans.map((p) => `${p.pan} in track:${p.in}`).join(', then ')}`);
  }
  const route: string[] = [];
  if (reach.via.length > 0) route.push(`via ${reach.via.map((v) => `track:${v}`).join(' → ')}`);
  if (reach.paths > 1) route.push(`${reach.paths} placements`);
  const where = route.length > 0 ? ` (${route.join(', ')})` : '';
  // The route is the part a reader scans for, so it sits in the same
  // place on every line. The caveat goes after it rather than shouldering
  // it aside — two parenthetical groups back to back read as though the
  // second belonged to the first (#92 review).
  const caveat = reach.pans.length > 1 ? ' — balances compose per channel, not into one pan' : '';
  return `track:${reach.to} ${parts.join(', ')}${where}${caveat}`;
}

// A root track is either the song's output or something nothing consumes.
// The second is legitimate — `field build creek/track:bed` renders a
// track the output never sums — but it is worth saying out loud, because
// a track that reaches no output is also what a typo in an `inputs:`
// entry leaves behind.
export function rootNote(trackName: string): string {
  return trackName === SONG_OUTPUT_NAME
    ? "nothing places this track — it is the song's output"
    : 'nothing places this track — build it directly, or place it to hear it in the mix';
}

// Levels are authored in tenths at most, so one decimal is the whole
// number; `-0` is a rounding artifact nobody means.
function fmtDb(db: number): string {
  const fixed = db.toFixed(1);
  const cleaned = fixed === '-0.0' ? '0.0' : fixed;
  return db > 0 ? `+${cleaned}` : cleaned;
}
