import type { InputEntry, Track } from '../schema/index.js';
import type { TempoMap } from '../time/tempo.js';
import { expandLoop, placedWindow } from '../generators/stem.js';
import type { LoadedFile } from './project.js';

// The cable model (nested-tracks.md §19): a label links exactly one
// `sends:` entry to exactly one `- receive:` entry, and everything a
// cable means is derived from where its two ends sit in the containment
// graph. This module owns that derivation — the 1:1 and dangling checks,
// the zero-displacement rule on the receive's path, the combined-graph
// cycle check, and the arrival walk — so `check` and the build graph
// cannot answer "when does this signal arrive" differently.
//
// Arrivals are derived, not invented (§19 decision 5): walk up from the
// receiving track to the cable's common ancestor — zero displacement by
// decision 4, so the walk up contributes nothing — then down from the
// ancestor to the sender, accumulating each placement's displacement.
// The walk runs once per containment path of the receiver, and the
// arrival sets must agree: they bake into a render that exists once
// however often the track is placed (§13).

export interface Cable {
  label: string;
  sender: string; // track name
  receiver: string;
  gainDb: number;
  tap: 'pre' | 'post';
  // Where the sender's signal lands on the receiver's timeline:
  // receiver-rate samples, ascending. Duplicates are real — two
  // identical placements of the sender arrive twice and sum twice.
  arrivals: number[];
}

// A track's clock, as validate resolved it: its effective rate and its
// tempo map at that rate. `tempo` is undefined where the map failed to
// parse — every walk through such a track is skipped, because its error
// is already reported and deriving against a guessed map would invent
// numbers on top of it.
export interface TrackClock {
  rate: number;
  tempo: TempoMap | undefined;
}

type Push = (file: string, message: string, severity?: 'warning') => void;

interface Edge {
  parent: string;
  child: string;
  entry: InputEntry;
  index: number; // position in the parent's inputs, for diagnostics
  file: string; // the parent's file — where the placement lives
}

// Musical time that never resolved (a broken meter map, a diagnosed
// entry) is still an array here; the types say number because validate
// promises to have resolved everything, and this is the pass that runs
// while that promise is still being kept.
const unresolved = (v: unknown): boolean => Array.isArray(v);

// How validate names an entry in a diagnostic, reproduced so a cable
// message points at the same spelling the entry's other messages use.
function entryName(entry: InputEntry, index: number): string {
  if (entry.id !== undefined) return `input "${entry.id}"`;
  const target =
    entry.track ??
    entry.audio ??
    (entry.supercollider ? 'supercollider' : entry.generative ? 'generative' : '?');
  return `input ${index + 1} ("${target}")`;
}

export function checkCables(
  tracks: LoadedFile<Track>[],
  clocks: Map<string, TrackClock>,
  push: Push,
): Cable[] {
  interface SendEnd {
    track: string;
    file: string;
    gainDb: number;
    tap: 'pre' | 'post';
  }
  interface ReceiveEnd {
    track: string;
    file: string;
  }
  const sendsByLabel = new Map<string, SendEnd[]>();
  const receivesByLabel = new Map<string, ReceiveEnd[]>();
  const parentEdges = new Map<string, Edge[]>();
  const childEdges = new Map<string, Edge[]>();
  const trackNames = new Set(tracks.map((t) => t.data.name));

  for (const file of tracks) {
    const name = file.data.name;
    for (const [label, send] of Object.entries(file.data.sends)) {
      const list = sendsByLabel.get(label) ?? [];
      list.push({ track: name, file: file.path, gainDb: send.gain_db, tap: send.tap });
      sendsByLabel.set(label, list);
    }
    file.data.inputs.forEach((entry, index) => {
      if (entry.receive !== undefined) {
        const list = receivesByLabel.get(entry.receive) ?? [];
        list.push({ track: name, file: file.path });
        receivesByLabel.set(entry.receive, list);
      } else if (
        entry.track !== undefined &&
        entry.track !== name &&
        trackNames.has(entry.track)
      ) {
        const edge: Edge = { parent: name, child: entry.track, entry, index, file: file.path };
        parentEdges.set(entry.track, [...(parentEdges.get(entry.track) ?? []), edge]);
        childEdges.set(name, [...(childEdges.get(name) ?? []), edge]);
      }
    });
  }

  // One cable: one send, one receive (§19 decision 3). Duplicates error
  // on the later claimant naming the first, the way generator names do;
  // a label with one end warns — wiring incrementally is normal, so half
  // a cable reports without stopping the mix.
  for (const [label, ends] of sendsByLabel) {
    for (const end of ends.slice(1)) {
      push(
        end.file,
        `send "${label}" is also declared in ${ends[0]!.file} — one cable links one send ` +
          `to one receive (nested-tracks.md §19)`,
      );
    }
    if (!receivesByLabel.has(label)) {
      push(
        ends[0]!.file,
        `send "${label}" has no receive — it carries nothing until a track declares ` +
          `\`- receive: ${label}\``,
        'warning',
      );
    }
  }
  for (const [label, ends] of receivesByLabel) {
    for (const end of ends.slice(1)) {
      push(
        end.file,
        `receive "${label}" is also declared in ${ends[0]!.file} — one cable links one send ` +
          `to one receive (nested-tracks.md §19)`,
      );
    }
    if (!sendsByLabel.has(label)) {
      push(
        ends[0]!.file,
        `receive "${label}" has no send — it carries nothing until a track declares the ` +
          `label under sends:`,
        'warning',
      );
    }
  }

  // Containment descendants, self included, cycle-safe (a containment
  // cycle is validate's own diagnostic; this walk just must not hang on
  // one).
  const descendantsMemo = new Map<string, Set<string>>();
  const descendants = (name: string): Set<string> => {
    const seen = descendantsMemo.get(name);
    if (seen) return seen;
    const out = new Set<string>([name]);
    descendantsMemo.set(name, out); // pre-set so a cycle terminates
    for (const edge of childEdges.get(name) ?? []) {
      for (const d of descendants(edge.child)) out.add(d);
    }
    return out;
  };

  // Every acyclic containment path from a track up to a root, as edge
  // lists ordered from the track upward. A root yields the one empty
  // path — the track standing for itself.
  const pathsUp = (name: string): Edge[][] => {
    const out: Edge[][] = [];
    const walk = (n: string, path: Edge[], onPath: Set<string>): void => {
      const ups = parentEdges.get(n) ?? [];
      if (ups.length === 0) {
        out.push([...path]);
        return;
      }
      for (const edge of ups) {
        if (onPath.has(edge.parent)) continue;
        onPath.add(edge.parent);
        path.push(edge);
        walk(edge.parent, path, onPath);
        path.pop();
        onPath.delete(edge.parent);
      }
    };
    walk(name, [], new Set([name]));
    return out;
  };

  // Every acyclic containment path from an ancestor down to a track, as
  // edge lists ordered from the ancestor downward.
  const pathsDown = (from: string, to: string): Edge[][] => {
    const out: Edge[][] = [];
    const walk = (n: string, path: Edge[], onPath: Set<string>): void => {
      if (n === to) {
        out.push([...path]);
        return;
      }
      for (const edge of childEdges.get(n) ?? []) {
        if (onPath.has(edge.child)) continue;
        onPath.add(edge.child);
        path.push(edge);
        walk(edge.child, path, onPath);
        path.pop();
        onPath.delete(edge.child);
      }
    };
    walk(from, [], new Set([from]));
    return out;
  };

  // A placement's displacement of its child's local zero, in the
  // parent's samples — one number per instance, because a looped
  // placement places its child once per repetition. Undefined means the
  // clock is unusable here (a broken map, unresolved musical time): the
  // cable's derivation is skipped, its cause already reported.
  const instanceDisplacements = (edge: Edge): number[] | undefined => {
    const parent = clocks.get(edge.parent);
    const child = clocks.get(edge.child);
    if (parent?.tempo === undefined || child === undefined) return undefined;
    const entry = edge.entry;
    if ([entry.at, entry.duration, entry.loop?.every].some(unresolved)) return undefined;
    // `source_offset` and `slip` address the source's samples; the
    // parent's clip reads the edge-converted file, so the offset scales
    // by the rate ratio exactly as planTrack's readOffsetFor does.
    const scale = parent.rate / child.rate;
    const readOffset = Math.round((entry.source_offset - entry.slip) * scale);
    if (entry.loop?.enabled) {
      if (entry.loop.every === undefined) return undefined; // check demands `every` on track loops
      try {
        return expandLoop(entry, entry.loop, parent.tempo, undefined, readOffset).map(
          (rep) => rep.start - rep.read_offset,
        );
      } catch {
        return undefined; // its own diagnostic already names the entry
      }
    }
    return [placedWindow(entry, parent.tempo).start - readOffset];
  };

  // The fields that displace a placement — §19 decision 4's four
  // spellings of the time base. `duration` and fades window and shape
  // without moving anything, so they stay legal on a receive's path.
  const displacingFields = (entry: InputEntry): string[] => {
    const fields: string[] = [];
    if (entry.at !== 0) fields.push('at');
    if (entry.slip !== 0) fields.push('slip');
    if (entry.source_offset !== 0) fields.push('source_offset');
    if (entry.loop?.enabled) fields.push('loop');
    return fields;
  };

  // Complete cables, before cycle and arrival checks. Labels with a
  // duplicated end stop here: which two ends they join is exactly what
  // the error says nobody decided.
  const complete: { label: string; send: SendEnd; receive: ReceiveEnd }[] = [];
  for (const [label, sends] of sendsByLabel) {
    const receives = receivesByLabel.get(label);
    if (sends.length === 1 && receives?.length === 1) {
      complete.push({ label, send: sends[0]!, receive: receives[0]! });
    }
  }

  // Cycles are checked on the combined graph (§19 decision 8):
  // containment edges plus cable edges, both read as "depends on". The
  // locally decidable case — the receive inside the sender's own
  // subtree — gets §1.7's own message rather than a generic cycle
  // report; anything else that loops is a chain of cables and
  // placements, named hop by hop.
  const cableDeps = new Map<string, string[]>();
  for (const { send, receive } of complete) {
    cableDeps.set(receive.track, [...(cableDeps.get(receive.track) ?? []), send.track]);
  }
  const cyclic = new Set<string>();
  for (const { label, send, receive } of complete) {
    if (descendants(send.track).has(receive.track)) {
      push(
        send.file,
        `a send cannot reach into itself — "${receive.track}" is inside "${send.track}", ` +
          `so its output already flows up through the track sending to it ` +
          `(nested-tracks.md §1.7)`,
      );
      cyclic.add(label);
      continue;
    }
    // Does the sender depend, through any mix of containment and
    // cables, on the receiver? Then this cable closes a loop.
    const path = findPath(send.track, receive.track, childEdges, cableDeps);
    if (path !== undefined) {
      push(
        receive.file,
        `send cycle: ${[receive.track, ...path].join(' → ')} ` +
          `(the cable "${label}" closes the loop)`,
      );
      cyclic.add(label);
    }
  }

  const cables: Cable[] = [];
  const displacedDiagnosed = new Set<string>();
  for (const { label, send, receive } of complete) {
    if (cyclic.has(label)) continue;
    const receiverRate = clocks.get(receive.track)?.rate;
    if (receiverRate === undefined) continue;

    interface PathArrivals {
      chain: string; // root-down node names, for the divergence message
      arrivals: number[] | undefined; // undefined: clock unusable, skip cable
    }
    const results: PathArrivals[] = [];
    let pathError = false;
    for (const up of pathsUp(receive.track)) {
      const nodesUp = [receive.track, ...up.map((e) => e.parent)];
      const chain = [...nodesUp].reverse().join(' → ');
      // The cable's ancestor on this path: the first track, walking up,
      // whose subtree holds the sender. Above it, placements shift both
      // ends together and cannot matter.
      const ancestorIndex = nodesUp.findIndex((n) => descendants(n).has(send.track));
      if (ancestorIndex === -1) {
        // This path never meets the sender. An empty arrival set is a
        // real answer — it diverges against any path that does hear it,
        // which is exactly the bed-without-the-vocal case.
        results.push({ chain, arrivals: [] });
        continue;
      }
      const ancestor = nodesUp[ancestorIndex]!;
      // Zero displacement from the receiver up to the ancestor
      // (decision 4): every placement on the way is a single unshifted
      // pass, or the receive has no derivable clock.
      for (const edge of up.slice(0, ancestorIndex)) {
        if ([edge.entry.at, edge.entry.duration, edge.entry.loop?.every].some(unresolved)) {
          results.push({ chain, arrivals: undefined });
          pathError = true; // the unresolved time already has its diagnostic
          break;
        }
        const fields = displacingFields(edge.entry);
        if (fields.length > 0) {
          const key = `${label}|${edge.file}|${edge.index}`;
          if (!displacedDiagnosed.has(key)) {
            displacedDiagnosed.add(key);
            push(
              edge.file,
              `${entryName(edge.entry, edge.index)} carries ${fields.join(', ')} on the path ` +
                `from "${receive.track}" up to "${ancestor}" — a receive is legal only where ` +
                `that path is a single unshifted pass (nested-tracks.md §19)`,
            );
          }
          pathError = true;
        }
      }
      if (pathError) break;
      // Walk down from the ancestor to the sender, one arrival per
      // placement instance per path — the sender's multiplicity is the
      // point (§19 decision 5). Displacements convert straight into
      // receiver-rate samples: the receiver's clock is the ancestor's,
      // that being what zero displacement means.
      let arrivals: number[] | undefined = [];
      for (const down of pathsDown(ancestor, send.track)) {
        let totals: number[] = [0];
        for (const edge of down) {
          const instances = instanceDisplacements(edge);
          const parentRate = clocks.get(edge.parent)?.rate;
          if (instances === undefined || parentRate === undefined) {
            arrivals = undefined;
            break;
          }
          const factor = receiverRate / parentRate;
          totals = totals.flatMap((t) => instances.map((d) => t + d * factor));
        }
        if (arrivals === undefined) break;
        arrivals.push(...totals);
      }
      results.push({
        chain,
        arrivals: arrivals?.map((a) => Math.round(a)).sort((a, b) => a - b),
      });
    }
    if (pathError || results.some((r) => r.arrivals === undefined)) continue;
    if (results.every((r) => r.arrivals!.length === 0)) {
      push(
        receive.file,
        `cable "${label}" joins "${send.track}" to "${receive.track}" but no track contains ` +
          `both, so the signal never arrives — place the receiving track where the sender ` +
          `is reachable (nested-tracks.md §19)`,
      );
      continue;
    }
    const spell = (arrivals: number[]) => `[${arrivals.join(', ')}]`;
    const first = results[0]!;
    const divergent = results.find(
      (r) => spell(r.arrivals!) !== spell(first.arrivals!),
    );
    if (divergent !== undefined) {
      push(
        receive.file,
        `receive "${label}" hears different arrivals through its containment paths — via ` +
          `${first.chain} it hears ${spell(first.arrivals!)} but via ${divergent.chain} ` +
          `${spell(divergent.arrivals!)} (receiver-rate samples); a track renders once ` +
          `however often it is placed (§13), so every path must agree ` +
          `(nested-tracks.md §19)`,
      );
      continue;
    }
    cables.push({
      label,
      sender: send.track,
      receiver: receive.track,
      gainDb: send.gainDb,
      tap: send.tap,
      arrivals: first.arrivals!,
    });
  }
  return cables;
}

// A dependency path from `from` to `to` over containment and cable
// edges, as the tracks visited after `from` — or undefined when none
// exists. Used to name a send cycle hop by hop.
function findPath(
  from: string,
  to: string,
  childEdges: Map<string, Edge[]>,
  cableDeps: Map<string, string[]>,
): string[] | undefined {
  const seen = new Set<string>([from]);
  const walk = (n: string, path: string[]): string[] | undefined => {
    if (n === to) return path;
    const next = [
      ...(childEdges.get(n) ?? []).map((e) => e.child),
      ...(cableDeps.get(n) ?? []),
    ];
    for (const dep of next) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const found = walk(dep, [...path, dep]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(from, [from]);
}
