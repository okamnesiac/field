import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { daemonBinary } from '../audiod/client.js';
import type { Insert } from '../schema/index.js';

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

export class RenderUnavailableError extends Error {}

export interface RenderPlan {
  input: string;
  output: string;
  inserts: readonly Insert[];
}

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
    writeFileSync(planPath, JSON.stringify(plan));
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
