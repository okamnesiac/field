import { isNode, isSeq, parseDocument } from 'yaml';
import { z } from 'zod';
import { placedWindow } from '../generators/stem.js';
import {
  eqBandSchema,
  eqParams,
  hallParams,
  limitParams,
  plateParams,
  reverbParams,
  trackOrder,
} from '../schema/index.js';
import type { InputEntry } from '../schema/index.js';
import type { MeterMap, TempoMap } from '../time/tempo.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

// The socket's file edits, as pure text → text functions. `field ui` is
// the most write-capable thing in the CLI — five ops that change bytes
// in files the author also edits by hand — and every defect this
// surface has produced was the same shape: a write that was *almost*
// what a person would have typed, invisible to a typecheck and to a
// build. Pure functions over document text are the form a test can
// hold to that standard: write, read back, compare bytes (#163
// review). ui.ts keeps what genuinely needs the server — resolution,
// stale-hash guards, the daemon — and calls down into here.

export type EditOutcome =
  | { ok: true; text: string }
  | { ok: false; message: string; refresh?: boolean };

// One placement edit: set or clear gain_db / pan / mute on an input
// entry. Defaults stay implicit: writing `mute: false` or `pan: 0` onto
// an entry that never spelled them would churn the file.
export function applyEdit(raw: string, entry: number, set: Record<string, unknown>): EditOutcome {
  const doc = parseDocument(raw);
  for (const [key, value] of Object.entries(set)) {
    const isDefault = (key === 'mute' && value === false) || (key !== 'mute' && value === 0);
    if (isDefault) doc.deleteIn(['inputs', entry, key]);
    else doc.setIn(['inputs', entry, key], value);
  }
  canonicalizeDocument(doc, trackOrder);
  return { ok: true, text: stringifyDocument(doc) };
}

// Move a placement by a delta in session samples. The delta is
// anchor-agnostic — a sample is a sample whichever way `at` is spelled,
// and the entry's own origin cancels out. The parsed entry and the
// owner's maps come from the caller, which is the model layer's load:
// arrays already rewritten to ticks, the shape placedWindow takes.
export function applyMove(
  raw: string,
  entry: number,
  parsed: InputEntry,
  delta: number,
  tempo: TempoMap,
  meter: MeterMap,
): EditOutcome {
  const doc = parseDocument(raw);
  const w = placedWindow(parsed, tempo);
  const local = Math.max(0, w.start + delta);
  const at = parsed.anchor === 'absolute' ? Math.round(local) : Math.round(tempo.samplesToTicks(local));
  // What the author wrote stays theirs across the move. An `at:`
  // spelled as a musical array is written back as one — through the
  // owner's meter map, positionTicks's own inverse — because a drag
  // that flattens `at: [5]` to `at: 7680` is the one edit in this
  // view that does not read like something a person typed. And the
  // line's comment is carried across the node swap by hand: replacing
  // a sequence with a fresh node discards the comment attached to the
  // old one, where scalar-over-scalar keeps it, which is why edit
  // never had this problem (#163 review).
  const oldNode = doc.getIn(['inputs', entry, 'at'], true);
  const comment = isNode(oldNode) ? oldNode.comment : undefined;
  if (isSeq(oldNode) && parsed.anchor !== 'absolute') {
    const [bar, beat, tick] = meter.position(at);
    // The shortest array that means it, as a person would write it —
    // through createNode, because setIn stores a raw JS array as-is:
    // unwrapped, it dodges the canonicalizer's flow flag (isSeq is
    // false on an Array) and stringifies block-style.
    const spelled = tick > 1 ? [bar, beat, tick] : beat > 1 ? [bar, beat] : [bar];
    doc.setIn(['inputs', entry, 'at'], doc.createNode(spelled));
  } else if (at === 0) {
    // Defaults stay implicit, as in edit: a clip dragged back to zero
    // loses its `at:` rather than gaining `at: 0`.
    doc.deleteIn(['inputs', entry, 'at']);
  } else {
    doc.setIn(['inputs', entry, 'at'], at);
  }
  if (comment != null) {
    const fresh = doc.getIn(['inputs', entry, 'at'], true);
    if (isNode(fresh)) fresh.comment = comment;
  }
  canonicalizeDocument(doc, trackOrder);
  return { ok: true, text: stringifyDocument(doc) };
}

// Split one placement into two at an offset within its window, given
// in session samples — origin-free the same way move's delta is. The
// first half keeps the front (and its fade_in); the second starts at
// the cut with `source_offset` advanced by the same distance, so the
// source keeps reading where the first half stopped, and it keeps the
// fade_out. Everything else — gain, pan, mute, slip, per-field comments
// and spellings — is carried by cloning the entry node itself, which
// is what makes the result read as two entries a person wrote rather
// than one entry and a robot's paraphrase.
//
// The caller enforces what needs the model or the ledger: a positive
// offset inside the window, no `loop:` (a loop tiles its window — the
// two halves of a tiling are not two tilings), and a same-rate source,
// because `source_offset` addresses the source's samples and a
// cross-rate advance computed in session samples would land the second
// half in the wrong place quietly.
export function applySplit(
  raw: string,
  entry: number,
  parsed: InputEntry,
  offset: number,
  tempo: TempoMap,
  meter: MeterMap,
): EditOutcome {
  const doc = parseDocument(raw);
  const node = doc.getIn(['inputs', entry], true);
  if (!isNode(node) || !('clone' in node)) {
    return { ok: false, message: `no input ${entry} — refreshed`, refresh: true };
  }
  const w = placedWindow(parsed, tempo);

  // The cut in the entry's own unit: span ticks for a musical anchor,
  // samples for an absolute one.
  const musical = parsed.anchor !== 'absolute';
  const cut = musical
    ? Math.round(tempo.samplesToTicks(w.start + offset)) - parsed.at
    : Math.round(offset);
  if (cut <= 0) return { ok: false, message: 'the cut lands before the clip starts' };
  if (parsed.duration !== undefined && cut >= parsed.duration) {
    return { ok: false, message: 'the cut lands past the clip ends' };
  }

  // Two entries from one node: the clone carries every field, comment
  // and spelling the original had, and each half then edits only what
  // the cut changes.
  const second = (node as { clone(): typeof node }).clone();
  const inputs = doc.getIn(['inputs']) as { items: unknown[] };
  inputs.items.splice(entry + 1, 0, second);

  // Durations keep the author's spelling and comment, the same rule as
  // `at` below — with one wrinkle worth naming: `at` is an ordinal
  // position while duration is a cardinal span, and a span's musical
  // spelling depends on where it starts, since a meter change inside
  // it changes what a bar is worth. So each half re-spells through
  // span() from its own anchor.
  const oldDur = doc.getIn(['inputs', entry, 'duration'], true);
  const durComment = isNode(oldDur) ? oldDur.comment : undefined;
  const durWasSeq = isSeq(oldDur) && musical;
  const setDuration = (index: number, from: number, ticks: number) => {
    if (durWasSeq) {
      const [bars, beats, rest] = meter.span(from, ticks);
      const spelled = rest > 0 ? [bars, beats, rest] : beats > 0 ? [bars, beats] : [bars];
      doc.setIn(['inputs', index, 'duration'], doc.createNode(spelled));
    } else {
      doc.setIn(['inputs', index, 'duration'], ticks);
    }
    if (durComment != null) {
      const fresh = doc.getIn(['inputs', index, 'duration'], true);
      if (isNode(fresh)) fresh.comment = durComment;
    }
  };

  // First half: duration becomes the cut, the fade_out belongs to the
  // second half now, and an id stays with the first — ids are unique.
  setDuration(entry, parsed.at, cut);
  doc.deleteIn(['inputs', entry, 'fade_out']);

  // Second half: starts at the cut, spelled the way the author spelled
  // `at` (the same rule as move, comment carried the same way), reads
  // the source from where the first half stopped, keeps what remains
  // of the duration, and drops what the first half kept.
  const atValue = parsed.at + cut;
  const oldAt = doc.getIn(['inputs', entry + 1, 'at'], true);
  const atComment = isNode(oldAt) ? oldAt.comment : undefined;
  if (isSeq(oldAt) && musical) {
    const [bar, beat, tick] = meter.position(atValue);
    const spelled = tick > 1 ? [bar, beat, tick] : beat > 1 ? [bar, beat] : [bar];
    doc.setIn(['inputs', entry + 1, 'at'], doc.createNode(spelled));
    if (atComment != null) {
      const fresh = doc.getIn(['inputs', entry + 1, 'at'], true);
      if (isNode(fresh)) fresh.comment = atComment;
    }
  } else {
    doc.setIn(['inputs', entry + 1, 'at'], atValue);
  }
  doc.setIn(['inputs', entry + 1, 'source_offset'], parsed.source_offset + Math.round(offset));
  if (parsed.duration === undefined) {
    // An open window stays open: the second half plays to the source's
    // end, which is still "the whole of what remains" after the
    // source_offset advance.
    doc.deleteIn(['inputs', entry + 1, 'duration']);
  } else {
    setDuration(entry + 1, parsed.at + cut, parsed.duration - cut);
  }
  doc.deleteIn(['inputs', entry + 1, 'fade_in']);
  doc.deleteIn(['inputs', entry + 1, 'id']);

  canonicalizeDocument(doc, trackOrder);
  return { ok: true, text: stringifyDocument(doc) };
}

// Insert parameter validation: the same zod objects the track schema is
// built from, partial per effect, so this module can never produce a
// value the engine would refuse.
const effectParamSchemas = {
  eq: z.strictObject(eqParams).partial(),
  limit: z.strictObject(limitParams).partial(),
  reverb: z.strictObject(reverbParams).partial(),
  plate: z.strictObject(plateParams).partial(),
  hall: z.strictObject(hallParams).partial(),
};
export type EffectName = keyof typeof effectParamSchemas;

// Defaults, resolved once through the same schemas — never restated as
// literals, because a rule kept in step by hand is a rule that drifts
// (socketPath.ts says it; #163 review caught this module's band
// defaults doing it). A value set back to its default is deleted
// rather than written, and the asymmetry is why derivation matters: a
// literal gone stale doesn't just churn, it drops a key whose meaning
// then silently changes on the next load.
const effectDefaults: Record<EffectName, Record<string, unknown>> = {
  eq: z.strictObject(eqParams).omit({ bands: true }).parse({}),
  limit: z.strictObject(limitParams).parse({}),
  reverb: z.strictObject(reverbParams).parse({}),
  plate: z.strictObject(plateParams).parse({}),
  hall: z.strictObject(hallParams).parse({}),
};
const bandDefaults = eqBandSchema.omit({ type: true, frequency: true }).parse({});

// Append an insert in its minimal spelling: parameters stay implicit at
// their defaults, as a person would write it. The eq arrives as the
// Fyra channel layout — the fixed homes a hand reaches for — flat, so
// adding it changes nothing until a band moves.
export function applyInsertAdd(raw: string, effect: EffectName): EditOutcome {
  const doc = parseDocument(raw);
  const fresh =
    effect === 'eq'
      ? {
          effect: 'eq',
          bands: [
            { type: 'lowshelf', frequency: 90 },
            { type: 'bell', frequency: 220 },
            { type: 'bell', frequency: 500 },
            { type: 'bell', frequency: 1200 },
            { type: 'bell', frequency: 3200 },
            { type: 'highshelf', frequency: 8000 },
          ],
        }
      : { effect };
  if (doc.getIn(['inserts']) === undefined) doc.setIn(['inserts'], doc.createNode([fresh]));
  else doc.addIn(['inserts'], doc.createNode(fresh));
  canonicalizeDocument(doc, trackOrder);
  return { ok: true, text: stringifyDocument(doc) };
}

// Edit one insert's parameters. The effect is read from the document
// itself; a hosted plugin's parameters belong to its own editor window
// (plugin-hosting.md §5 chunk 3), not to this module.
export function applyInsertEdit(raw: string, entry: number, set: Record<string, unknown>): EditOutcome {
  const doc = parseDocument(raw);
  if (doc.getIn(['inserts', entry]) === undefined) {
    return { ok: false, message: `no insert ${entry} — refreshed`, refresh: true };
  }
  const effect = doc.getIn(['inserts', entry, 'effect']);
  if (typeof effect !== 'string' || !(effect in effectParamSchemas)) {
    return { ok: false, message: 'plugin inserts are read-only here' };
  }
  const parsed = effectParamSchemas[effect as EffectName].safeParse(set);
  if (!parsed.success) {
    return { ok: false, message: `bad ${effect} parameters` };
  }
  const defaults = effectDefaults[effect as EffectName];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key === 'bands' && Array.isArray(value)) {
      // Bands re-spelled minimally: per-band defaults stay implicit,
      // so an untouched band keeps the two fields its author wrote.
      const minimal = value.map((b) => {
        const band: Record<string, unknown> = { type: b.type, frequency: b.frequency };
        if (b.gain_db !== undefined && b.gain_db !== bandDefaults.gain_db) band['gain_db'] = b.gain_db;
        if (b.bandwidth !== undefined && b.bandwidth !== bandDefaults.bandwidth) {
          band['bandwidth'] = b.bandwidth;
        }
        return band;
      });
      doc.setIn(['inserts', entry, 'bands'], doc.createNode(minimal));
    } else if (JSON.stringify(value) === JSON.stringify(defaults[key])) {
      doc.deleteIn(['inserts', entry, key]);
    } else {
      doc.setIn(['inserts', entry, key], value);
    }
  }
  canonicalizeDocument(doc, trackOrder);
  return { ok: true, text: stringifyDocument(doc) };
}

// Remove an insert. An emptied chain loses its key: `inserts: []` is
// not something a person leaves behind.
export function applyInsertRemove(raw: string, entry: number): EditOutcome {
  const doc = parseDocument(raw);
  if (doc.getIn(['inserts', entry]) === undefined) {
    return { ok: false, message: `no insert ${entry} — refreshed`, refresh: true };
  }
  doc.deleteIn(['inserts', entry]);
  const chain = doc.getIn(['inserts']);
  if (chain !== undefined && typeof chain === 'object' && (chain as { items?: unknown[] }).items?.length === 0) {
    doc.deleteIn(['inserts']);
  }
  canonicalizeDocument(doc, trackOrder);
  return { ok: true, text: stringifyDocument(doc) };
}
