import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { daemonBinary } from '../audiod/client.js';
import type { Insert } from '../schema/index.js';
import type { RenderedClip } from '../generators/stem.js';

const execFileAsync = promisify(execFile);

// Rendering an insert chain by spawning the daemon
// (render-pipeline.md decision 6): `field-audiod --render <plan.json>`,
// which reads one file, writes one file, and exits before any socket,
// device or message loop exists.
//
// A subprocess rather than a command on the running daemon, so a build
// action never contends with whatever is being listened to and two
// `field build` runs stay independent. The plan is the schema's own
// insert objects verbatim — `src/schema/effects.ts` is the wire format,
// so there is no translation layer here to drift from it.
//
// Musical time does not appear: decision 7 keeps bars, beats and clip
// placement in the control plane, and this boundary carries file paths.

// The version the daemon must agree to. Bump whenever the plan's meaning
// changes — a new effect, a new band type, a field whose units move — and
// the C++ constant in native/audiod/src/render.cpp moves with it.
//
// It exists because `daemonBinary()` reuses whatever build is already
// there, so a control plane newer than the binary is ordinary rather than
// exotic. Without it an older daemon accepts a plan it only partly
// understands and renders something plausible, which then caches under an
// action key claiming to be the declared chain. Separate from the
// socket's PROTOCOL_VERSION: different conversations, independent
// lifetimes.
export const RENDER_PLAN_VERSION = 6;

export class RenderUnavailableError extends Error {}

// The four shapes the daemon renders, discriminated on `op` exactly as
// the rules are. Each carries the schema's own objects verbatim — inserts,
// placed clips, faders — so `src/schema/` and `stem.ts`'s `RenderedClip`
// stay the wire format and there is no translation layer to drift.
//
// Musical time is absent by construction (decision 7): clips arrive as
// sample offsets the control plane already resolved, which is what keeps
// the daemon's one-sentence description true while it renders. A window
// length is resolved the same way and for the same reason: `PlacedClip`
// may leave one open, `RenderedClip` may not.

export interface EffectsPlan {
  op: 'effects';
  input: string;
  output: string;
  inserts: readonly Insert[];
}

export interface StemPlan {
  op: 'stem';
  output: string;
  sample_rate: number;
  inputs: readonly string[];
  clips: readonly RenderedClip[];
  inserts?: readonly Insert[];
  length_samples?: number;
  loop?: boolean;
}

// Nothing in the control plane produces one of these any more: `mixes/`
// retired with the output track (nested-tracks.md §7 chunk 2). The daemon
// still speaks the op, so the shape stays until that half is removed —
// deleting the type while the binary answers to `op: "mix"` would leave a
// wire format nothing describes.
interface Fader {
  gain_db: number;
  pan: number;
}

export interface MixPlan {
  op: 'mix';
  output: string;
  sample_rate: number;
  inputs: readonly string[];
  faders: readonly Fader[];
  gain_db: number;
  master?: readonly Insert[];
  length_samples?: number;
  loop?: boolean;
}

// normalize is the odd one out: it converts rather than processes, so it
// carries no chain and takes its rate from the plan instead of from the
// input file. Both are enforced in the validator rather than only here
// (render-pipeline.md decision 9).
export interface NormalizePlan {
  op: 'normalize';
  input: string;
  output: string;
  sample_rate: number;
  bit_depth: 16 | 24 | 32;
}

export type RenderPlan = EffectsPlan | StemPlan | MixPlan | NormalizePlan;

// Resolved per call rather than cached: the binary can be built partway
// through a session, and a stale "missing" answer would outlive it.
function requireBinary(): string {
  const binary = daemonBinary();
  if (binary === undefined) {
    throw new RenderUnavailableError(
      'field-audiod is not built — run `pnpm build:native`. Effects render in the daemon ' +
        'since render-pipeline.md chunk 2.',
    );
  }
  return binary;
}

export async function renderInsertChain(plan: RenderPlan): Promise<void> {
  const binary = requireBinary();
  const dir = mkdtempSync(join(tmpdir(), 'field-render-'));
  const planPath = join(dir, 'plan.json');
  try {
    writeFileSync(planPath, JSON.stringify({ version: RENDER_PLAN_VERSION, ...plan }));
    await execFileAsync(binary, ['--render', planPath]);
  } catch (error) {
    // The daemon writes the reason to stderr and exits non-zero; surface
    // that rather than the exec wrapper's "Command failed", which names
    // the binary and hides the cause.
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr && stderr.length > 0 ? stderr : String(error));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
