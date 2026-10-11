import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sha256File } from '../hash.js';
import type { SupercolliderSound } from './types.js';
import type { Generator } from './types.js';

const execFileAsync = promisify(execFile);

// supercollider: a SuperCollider program defines the sound, rendered
// offline (NRT). The contract (sc-render.md §2): the program is a plain
// .scd run via sclang with FIELD_OUTPUT / FIELD_SEED / FIELD_DURATION /
// FIELD_SAMPLE_RATE / FIELD_CHANNELS in the environment; it writes
// FIELD_OUTPUT and exits. Determinism given the seed is the program's
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
export function programPath(sound: Pick<SupercolliderSound, 'source'>): string {
  return sound.source.includes('/') ? sound.source : posix.join('shared/instruments', sound.source);
}

// An instrument named by `field keys` or a record entry
// (keyboard-instrument.md §2.1, §12.2): `.scd` is added to a name without
// an extension, then it resolves as a supercollider: entry's source does.
export function instrumentProgram(instrument: string): string {
  return programPath({ source: posix.extname(instrument) === '' ? `${instrument}.scd` : instrument });
}

// Field's own SuperCollider programs, beside the package's source.
export function scScript(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sc', name);
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

// The sclang to run: FIELD_SCLANG, then PATH, then the app bundle. One
// lookup for a render and for the long-running voice host
// (keyboard-instrument.md §2.8). The override is the determinism escape
// hatch (sc-render.md §2); a typo'd wrapper must never silently run the
// app bundle instead.
export function sclangCommand(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['FIELD_SCLANG'];
  if (override) {
    const found = override.includes('/') ? (existsSync(override) ? override : undefined) : onPath(override, env);
    if (found === undefined) throw new Error(`FIELD_SCLANG points at a missing binary: ${override}`);
    return found;
  }
  const found = onPath('sclang', env) ?? (existsSync(SCLANG_APP_FALLBACK) ? SCLANG_APP_FALLBACK : undefined);
  if (found === undefined) throw new Error('sclang not found on PATH (install SuperCollider or set FIELD_SCLANG)');
  return found;
}

// Run an SC program under the supercollider contract. Used by the rule
// and by `field sc render` (direct, uncached iteration).
export async function runScProgram(
  programPath: string,
  outputPath: string,
  params: {
    seed: number;
    duration: number;
    channels: number;
    sampleRate: number;
    timeoutMs?: number;
    // More of the program's environment, such as a take render's
    // FIELD_INSTRUMENT and FIELD_EVENTS (keyboard-instrument.md §12.3).
    env?: Record<string, string>;
  },
): Promise<void> {
  const env = {
    ...process.env,
    ...params.env,
    FIELD_OUTPUT: outputPath,
    FIELD_SEED: String(params.seed),
    FIELD_DURATION: String(params.duration),
    FIELD_SAMPLE_RATE: String(params.sampleRate),
    FIELD_CHANNELS: String(params.channels),
  };
  // The ceiling scales with the render: NRT is usually faster than realtime,
  // but the schema admits hour-long renders, and the ceiling exists to catch
  // hangs, not to race legitimate work.
  const timeout = params.timeoutMs ?? Math.max(180_000, 60_000 + params.duration * 10_000);
  // scsynth prints a line per score bundle in NRT, about 20 bytes, so a
  // long take's render outgrows Node's 1 MiB default and is killed.
  const options = { env, timeout, maxBuffer: 64 * 1024 * 1024 };
  const sclang = sclangCommand();
  try {
    await execFileAsync(sclang, [programPath], options);
  } catch (err) {
    throw formatScError(err as ExecError, programPath, timeout);
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
        `sc program ${sound.source} exited without writing FIELD_OUTPUT — ` +
          `it must render to the path in FIELD_OUTPUT and call 0.exit`,
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
