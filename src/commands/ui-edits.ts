import { type Document, isNode, isSeq, parseDocument } from 'yaml';
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

// `at`, written the way the author spelled it. A musical array stays an
// array — re-spelled through the owner's meter map, positionTicks's own
// inverse — because an edit that flattens `at: [5]` to `at: 7680` is the
// one write in this surface that does not read like something a person
// typed. A scalar stays ticks, zero deletes the key (defaults stay
// implicit, as in edit), and the line's comment is carried across the
// node swap by hand: replacing a sequence with a fresh node discards the
// comment attached to the old one, where scalar-over-scalar keeps it,
// which is why edit never had this problem (#163 review).
function setAt(doc: Document, meter: MeterMap, index: number, at: number, musical: boolean): void {
  const oldNode = doc.getIn(['inputs', index, 'at'], true);
  const comment = isNode(oldNode) ? oldNode.comment : undefined;
  if (isSeq(oldNode) && musical) {
    const [bar, beat, tick] = meter.position(at);
    // The shortest array that means it, as a person would write it —
    // through createNode, because setIn stores a raw JS array as-is:
    // unwrapped, it dodges the canonicalizer's flow flag (isSeq is
    // false on an Array) and stringifies block-style.
    const spelled = tick > 1 ? [bar, beat, tick] : beat > 1 ? [bar, beat] : [bar];
    doc.setIn(['inputs', index, 'at'], doc.createNode(spelled));
  } else if (at === 0) {
    doc.deleteIn(['inputs', index, 'at']);
  } else {
    doc.setIn(['inputs', index, 'at'], at);
  }
  if (comment != null) {
    const fresh = doc.getIn(['inputs', index, 'at'], true);
    if (isNode(fresh)) fresh.comment = comment;
  }
}

// A duration keeps its spelling and its comment the same way, with one
// wrinkle worth naming: `at` is an ordinal position while duration is a
// cardinal span, and a span's musical spelling depends on where it
// starts, since a meter change inside it changes what a bar is worth. So
// a span is re-spelled through span() from its own anchor. The spelling
// is read once and handed back as a writer, because a split writes both
// halves out of the original entry's node. An open window has no
// duration node to read, so the new key follows the entry's `at`, the
// way setAt reads it: `at: [5]` gets `duration: [2]`, not 7680 beside it,
// and an entry with no `at` at all claims no musical spelling, so it
// gets ticks.
function durationSpeller(doc: Document, meter: MeterMap, source: number, musical: boolean) {
  const oldDur = doc.getIn(['inputs', source, 'duration'], true);
  const comment = isNode(oldDur) ? oldDur.comment : undefined;
  const spelledLike = oldDur === undefined ? doc.getIn(['inputs', source, 'at'], true) : oldDur;
  const wasSeq = isSeq(spelledLike) && musical;
  return (index: number, from: number, span: number): void => {
    if (wasSeq) {
      const [bars, beats, rest] = meter.span(from, span);
      const spelled = rest > 0 ? [bars, beats, rest] : beats > 0 ? [bars, beats] : [bars];
      doc.setIn(['inputs', index, 'duration'], doc.createNode(spelled));
    } else {
      doc.setIn(['inputs', index, 'duration'], span);
    }
    if (comment != null) {
      const fresh = doc.getIn(['inputs', index, 'duration'], true);
      if (isNode(fresh)) fresh.comment = comment;
    }
  };
}

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
  // What the author wrote stays theirs across the move: setAt spells
  // the line the way the line was already spelled, and a clip dragged
  // back to zero loses its `at:` rather than gaining `at: 0`.
  setAt(doc, meter, entry, at, parsed.anchor !== 'absolute');
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

  // Both halves keep the spelling and comment of the duration they were
  // cut from, each re-spelled from its own anchor.
  const setDuration = durationSpeller(doc, meter, entry, musical);

  // First half: duration becomes the cut, the fade_out belongs to the
  // second half now, and an id stays with the first — ids are unique.
  setDuration(entry, parsed.at, cut);
  doc.deleteIn(['inputs', entry, 'fade_out']);

  // Second half: starts at the cut, spelled the way the author spelled
  // `at` (the same rule as move, comment carried the same way), reads
  // the source from where the first half stopped, keeps what remains
  // of the duration, and drops what the first half kept.
  setAt(doc, meter, entry + 1, parsed.at + cut, musical);
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

// Stretch one edge of a placement's window: the drag that trims a clip
// short or lets it play longer. `offset` is where the dragged edge
// landed, in session samples measured from the clip's own window start —
// origin-free the way move's delta and split's cut are, and one
// definition that covers both edges. The start edge's number is how far
// that edge travelled (negative reaches earlier); the end edge's is the
// window's new length, which is the same measurement from the same
// place.
//
// The end edge is a window edit and nothing else. `duration` moves, what
// the source plays from does not, and a placement that never declared a
// length gains the one the drag drew — trimming an open window is how a
// person says "this much of it", and the alternative was refusing the
// gesture on exactly the clips whose length nobody has pinned yet.
//
// The start edge moves the window and the read together: `at` later by
// the drag, `duration` shorter by it, `source_offset` advanced by it, so
// the content under the surviving part of the window does not slide.
// That is split's second-half arithmetic, and it inherits split's
// constraints — the caller refuses a cross-rate source, because
// `source_offset` addresses the source's own samples, and a looped clip,
// because a loop tiles from its window start and every repetition would
// be re-cut. Neither constraint touches the end edge, which is why the
// caller applies them per edge rather than to the op.
export function applyStretch(
  raw: string,
  entry: number,
  parsed: InputEntry,
  edge: 'start' | 'end',
  offset: number,
  tempo: TempoMap,
  meter: MeterMap,
): EditOutcome {
  const doc = parseDocument(raw);
  if (doc.getIn(['inputs', entry], true) === undefined) {
    return { ok: false, message: `no input ${entry} — refreshed`, refresh: true };
  }
  const musical = parsed.anchor !== 'absolute';
  const w = placedWindow(parsed, tempo);
  // The landing place in the entry's own unit: span ticks for a musical
  // anchor, samples for an absolute one. Both edges convert the same
  // way, since both are measured from the same window start.
  const units = musical
    ? Math.round(tempo.samplesToTicks(w.start + offset)) - parsed.at
    : Math.round(offset);
  const setDuration = durationSpeller(doc, meter, entry, musical);
  // Fades live inside the window, and check refuses an entry whose fades
  // outgrow it (model/project.ts). A trim that shrinks the window under
  // its fades is refused like the arithmetic refusals here, not clamped:
  // rewriting a fade the author set is its own surprise, and the message
  // says what to shorten first.
  const fadesOutgrow = (window: InputEntry): EditOutcome | undefined => {
    const { duration } = placedWindow(window, tempo);
    if (duration === undefined || parsed.fade_in + parsed.fade_out <= duration) return undefined;
    return {
      ok: false,
      message:
        `the fades (${parsed.fade_in} + ${parsed.fade_out} samples) would outgrow ` +
        `the ${duration}-sample clip — shorten them first`,
    };
  };

  if (edge === 'end') {
    if (units < 1) return { ok: false, message: 'a clip cannot end where it starts' };
    const refused = fadesOutgrow({ ...parsed, duration: units });
    if (refused !== undefined) return refused;
    setDuration(entry, parsed.at, units);
    canonicalizeDocument(doc, trackOrder);
    return { ok: true, text: stringifyDocument(doc) };
  }

  // A start edge that lands back where it began writes nothing: the
  // author's bytes are already what the drag asked for.
  if (units === 0) return { ok: true, text: raw };
  const at = parsed.at + units;
  if (at < 0) return { ok: false, message: 'a clip cannot start before the track does' };
  // The read advances by the drag measured in session samples, which is
  // the source's own distance only because the caller proved the rates
  // agree. Backwards past the source's first sample has nothing to
  // reveal, so it is refused rather than clamped — a clamp would leave
  // the window and the content disagreeing about where the edge went.
  const sourceOffset = parsed.source_offset + Math.round(offset);
  if (sourceOffset < 0) {
    return { ok: false, message: 'the source has nothing before its first sample' };
  }
  if (parsed.duration !== undefined) {
    const remaining = parsed.duration - units;
    if (remaining < 1) return { ok: false, message: 'the clip would have no length left' };
    const refused = fadesOutgrow({ ...parsed, at, duration: remaining });
    if (refused !== undefined) return refused;
    setDuration(entry, at, remaining);
  }
  // An open window stays open, exactly as it does across a split: the
  // clip still plays what remains of the source from the advanced
  // offset, which is what "the whole source" now means.
  setAt(doc, meter, entry, at, musical);
  if (sourceOffset === 0) doc.deleteIn(['inputs', entry, 'source_offset']);
  else doc.setIn(['inputs', entry, 'source_offset'], sourceOffset);
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
