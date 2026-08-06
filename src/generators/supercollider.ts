import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { sha256File } from '../hash.js';
import type { SupercolliderSound } from '../schema/index.js';
import type { Generator } from './types.js';

const execFileAsync = promisify(execFile);

// supercollider: a SuperCollider program defines the sound, rendered
// offline (NRT). The contract (sc-render.md §2): the program is a plain
// .scd run via sclang with BLOOM_OUTPUT / BLOOM_SEED / BLOOM_DURATION /
// BLOOM_SAMPLE_RATE / BLOOM_CHANNELS in the environment; it writes
// BLOOM_OUTPUT and exits. Determinism given the seed is the program's
// job; the program's content hash is a cache input, so editing the code
// invalidates its own renders. `source:` names the program: a bare
// filename resolves on the type's home shelf, shared/instruments/
// (project-layout.md §4.3); a slashed path is project-relative.

const SCLANG_APP_FALLBACK = '/Applications/SuperCollider.app/Contents/MacOS/sclang';

type ExecError = Error & {
  code?: string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
};

// sclang reports compile and runtime errors on *stdout*; Node's exec error
// message carries only stderr. Surface both, or the edit-retry loop this
// exists for is flying blind.
function formatScError(err: ExecError, programPath: string, timeoutMs: number): Error {
  if (err.killed) {
    return new Error(
      `sclang timed out after ${Math.round(timeoutMs / 1000)}s for ${programPath} — ` +
        `did the program call 0.exit?`,
    );
  }
  const stdoutTail = (err.stdout ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-15)
    .join('\n');
  const detail = stdoutTail ? `\n${stdoutTail}` : '';
  return new Error(`sclang failed for ${programPath}: ${err.message}${detail}`);
}

// The home-shelf resolution (§4.3): every bare spelling resolves in its
// natural home, explicit spellings escape — never a search path.
export function programPath(sound: SupercolliderSound): string {
  return sound.source.includes('/') ? sound.source : posix.join('shared/instruments', sound.source);
}

// Run an SC program under the supercollider contract. Used by the rule
// and by `bloom sc render` (direct, uncached iteration).
export async function runScProgram(
  programPath: string,
  outputPath: string,
  params: {
    seed: number;
    duration: number;
    channels: number;
    sampleRate: number;
    timeoutMs?: number;
  },
): Promise<void> {
  const env = {
    ...process.env,
    BLOOM_OUTPUT: outputPath,
    BLOOM_SEED: String(params.seed),
    BLOOM_DURATION: String(params.duration),
    BLOOM_SAMPLE_RATE: String(params.sampleRate),
    BLOOM_CHANNELS: String(params.channels),
  };
  // The ceiling scales with the render: NRT is usually faster than realtime,
  // but the schema admits hour-long renders, and the ceiling exists to catch
  // hangs, not to race legitimate work.
  const timeout = params.timeoutMs ?? Math.max(180_000, 60_000 + params.duration * 10_000);
  const options = { env, timeout };
  const override = process.env['BLOOM_SCLANG'];
  try {
    await execFileAsync(override ?? 'sclang', [programPath], options);
  } catch (err) {
    const e = err as ExecError;
    if (e.code === 'ENOENT') {
      if (override) {
        // The override is the determinism escape hatch (sc-render.md §2); a
        // typo'd wrapper must never silently render through the app bundle.
        throw new Error(`BLOOM_SCLANG points at a missing binary: ${override}`);
      }
      if (existsSync(SCLANG_APP_FALLBACK)) {
        try {
          await execFileAsync(SCLANG_APP_FALLBACK, [programPath], options);
          return;
        } catch (fallbackErr) {
          throw formatScError(fallbackErr as ExecError, programPath, timeout);
        }
      }
      throw new Error('sclang not found on PATH (install SuperCollider or set BLOOM_SCLANG)');
    }
    throw formatScError(e, programPath, timeout);
  }
}

export const supercolliderGenerator: Generator<SupercolliderSound> = {
  version: 1,
  wiringFields: ['source'],

  sources() {
    // The program is an input by content hash, not a graph node.
    return [];
  },

  validate(sound, ctx) {
    if (sound.source !== posix.normalize(sound.source) || sound.source.includes('\\')) {
      ctx.push(`program path not in normalized form: ${sound.source}`);
      return;
    }
    const resolved = ctx.resolveFile('', programPath(sound)); // project-relative
    if (resolved.problem) ctx.push(`program ${resolved.problem}`);
  },

  async extraInputs(root, sound) {
    const program = programPath(sound);
    return [{ label: program, sha256: await sha256File(join(root, program)) }];
  },

  async execute(sound, _inputPaths, outputPath, ctx) {
    await runScProgram(join(ctx.root, programPath(sound)), outputPath, {
      seed: sound.seed,
      duration: sound.duration,
      channels: sound.channels,
      sampleRate: ctx.sampleRate,
    });
    if (!existsSync(outputPath)) {
      throw new Error(
        `sc program ${sound.source} exited without writing BLOOM_OUTPUT — ` +
          `it must render to the path in BLOOM_OUTPUT and call 0.exit`,
      );
    }
  },

  async verifyAfterRun(root, sound, extraInputs) {
    const after = await sha256File(join(root, programPath(sound)));
    if (after !== extraInputs[0]!.sha256) {
      throw new Error(
        `refusing to cache: ${sound.source} changed during the render — re-run the build`,
      );
    }
  },
};
