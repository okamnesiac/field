import { z } from 'zod';
import { SLUG_PATTERN } from '../ids.js';
import { RESERVED_LABEL_NAME, sharedAssetName, trackRefName } from '../labels.js';

// Shared building blocks for the per-file schemas (index.ts is the
// barrel). Zod schemas are the single source of truth for the canonical
// project format (project-core.md §1); JSON Schema is generated from them
// to keep the format language-neutral (§5).

export const slug = z.string().regex(SLUG_PATTERN, 'must be a lowercase-slug');

// For anything addressable as //pkg:name — assets, targets, tracks — the
// grammar's reserved word is not a legal name.
export const labelName = slug.refine((n) => n !== RESERVED_LABEL_NAME, {
  message: `"${RESERVED_LABEL_NAME}" is reserved by the label grammar`,
});

// A source reference (project-layout.md §4.3): a bare slug resolves in
// the song's one namespace (assets and sounds together — names are
// identity, project-core.md §6), and the full //shared/asset:<name>
// label crosses into the shared scope — the only cross-scope reference
// there is (§1.5: where a file lives declares who may see it, and a
// song sees exactly itself plus shared/). Existence checks live in the
// model layer; the schema admits exactly the two spellings.
export const sourceRef = z.string().superRefine((ref, ctx) => {
  if (SLUG_PATTERN.test(sharedAssetName(ref) ?? ref)) return;
  // The old plural spelling sitting in a project file is the flag-day
  // case, and the one a person actually hits — the pattern hint in
  // graph.ts only catches a mistyped *command*. Name the substitution
  // rather than the grammar (#41 review).
  const stale = /^\/\/shared\/assets:(.+)$/.exec(ref);
  ctx.addIssue({
    code: 'custom',
    message:
      stale !== null
        ? `packages are singular: //shared/assets: is now //shared/asset: (try //shared/asset:${stale[1]!})`
        : 'must be a name in the song or //shared/asset:<name>',
  });
});

// A clip's source admits one spelling more than a sound's: `track:<name>`
// plays a track in this song (nested-tracks.md §1.11 — a clip is a
// placement, and a placement is a stem at a time). The prefix, not a bare
// slug, because tracks are deliberately outside the song's one namespace
// (project-layout.md §4.3): a track and a sound may legally share a name
// today, and a bare slug that meant either would be a search path, which
// the one-spelling rule forbids (project-core.md §3.4). It is the same
// spelling the track's label already uses (//songs/<song>/track:<name>).
export const clipSourceRef = z.string().superRefine((ref, ctx) => {
  const placed = trackRefName(ref);
  if (placed !== undefined) {
    if (SLUG_PATTERN.test(placed) && placed !== RESERVED_LABEL_NAME) return;
    ctx.addIssue({ code: 'custom', message: 'track: must name a track by its lowercase-slug' });
    return;
  }
  const parsed = sourceRef.safeParse(ref);
  for (const issue of parsed.error?.issues ?? []) {
    ctx.addIssue({
      code: 'custom',
      message: issue.message.replace(
        'must be a name in the song or',
        'must be a name in the song, track:<name>, or',
      ),
    });
  }
});

export const ticks = z.number().int().min(0);
export const samples = z.number().int().min(0);

// Musical time arrays (musical-time.md §1): scalar numbers are ticks
// (samples on absolute clips); arrays are musical. Positions are ordinal
// and 1-indexed — [9, 2] is bar 9, beat 2 — and spans are cardinal counts
// where zero is legal — [0, 2] is two beats. The schema validates shape
// only: legal beat and tick ranges depend on the meter map (tempo.yaml),
// so resolution and range diagnostics live in the model layer
// (model/project.ts), which rewrites arrays to tick scalars at load — the
// build graph never sees an array, and either spelling of a time produces
// the same action key.
const musicalPosition = z.array(z.number().int().min(1)).min(1).max(3);
const musicalSpan = z.array(z.number().int().min(0)).min(1).max(3);
export const timePosition = z.union([ticks, musicalPosition]);
export const timeSpan = z.union([z.number().int().positive(), musicalSpan]);

export const sampleRate = z.union([
  z.literal(44100),
  z.literal(48000),
  z.literal(88200),
  z.literal(96000),
  z.literal(176400),
  z.literal(192000),
]);
