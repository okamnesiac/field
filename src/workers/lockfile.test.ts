import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VOICED_SPEC } from '../voiced/client.js';
import { probeEnvironment } from './client.js';
import type { WorkerSpec } from './protocol.js';

// Against real uv, because the thing under test is uv's own semantics.
//
// `--frozen` means "sync without updating the lock" — permission to
// proceed on a stale one. `--locked` means "assert uv.lock will not
// change" — a check that it is current. Both leave the lockfile alone,
// which is why `--frozen` looked sufficient when the probe was written;
// only `--locked` reports that pyproject has moved past the lock
// (#61 follow-up review).
//
// A worker whose environment matches a lockfile that no longer matches
// pyproject launches — the daemon starts with `--no-sync` — and then
// fails on whatever the new dependency was, which is the delayed,
// silent failure the whole gate exists to replace with "run field setup".

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempDir = `.test-lock-${process.pid}`;
const tempSpec: WorkerSpec = { ...VOICED_SPEC, packageDir: tempDir };
const tempProject = join(packageRoot, 'python', tempDir);

// Both halves of "can this machine run the test", asked together so an
// unusable one produces a visible skip. setup-uv installs uv, not an
// interpreter, and the sync below passes --no-python-downloads on
// purpose — so uv being present says nothing about whether this can run
// (#62 review).
function uvUsable(): boolean {
  if (spawnSync('uv', ['--version'], { stdio: 'ignore' }).status !== 0) return false;
  return (
    spawnSync('uv', ['python', 'find', MIN_PYTHON, '--no-python-downloads'], { stdio: 'ignore' })
      .status === 0
  );
}

// No dependencies and no network: the divergence is about the lockfile's
// agreement with pyproject, not about resolving anything.
const MIN_PYTHON = '>=3.11';
const WIDER_PYTHON = '>=3.10';
const PYPROJECT = (requiresPython: string) =>
  `[project]\nname = "demo-worker"\nversion = "0.1.0"\n` +
  `requires-python = "${requiresPython}"\ndependencies = []\n` +
  `[tool.uv]\npackage = false\n`;

afterEach(() => {
  rmSync(tempProject, { recursive: true, force: true });
});

describe.skipIf(!uvUsable())('a lockfile that has fallen behind pyproject', () => {
  it('is refused rather than launched into', () => {
    mkdirSync(tempProject, { recursive: true });
    writeFileSync(join(tempProject, 'pyproject.toml'), PYPROJECT(MIN_PYTHON));
    const sync = spawnSync('uv', ['sync', '--no-python-downloads', '--project', tempProject], {
      stdio: 'ignore',
    });
    // Loud, not skipped. `uvUsable` has already established uv and an
    // interpreter, so a failure here is a real one — and returning early
    // instead would report a green pass with nothing asserted, which is
    // precisely the silent non-coverage this file's CI change exists to
    // remove (#62 review).
    expect(sync.status).toBe(0);

    // `package = false` keeps uv from reinstalling the project itself on
    // every pyproject edit — which is what masks this divergence in a
    // packaged project, and why it took four scenarios to reproduce. The
    // console script is placed by hand for the same reason: the probe
    // only asks uv anything once the worker looks installed, and this
    // test is about what it asks, not about how the file got there.
    const binDir = join(tempProject, '.venv', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, tempSpec.script), '');

    expect(probeEnvironment(tempSpec).synced).toBe(true);

    // pyproject moves; the lockfile does not; the environment is still
    // exactly what the lockfile describes.
    //
    // *Widened*, never narrowed. Narrowing (>=3.11 to >=3.12) is a
    // lock/pyproject divergence and an interpreter demand at once, so on
    // a machine with only 3.11 the second probe fails because uv cannot
    // find an interpreter — `synced` is false, the assertion below
    // passes, and the test proves nothing about the flag. Verified: with
    // a constraint nothing satisfies, `--frozen` and `--locked` both exit
    // 2, identically. Widening cannot do that — anything that satisfied
    // the lock satisfies the wider constraint — while leaving the
    // lockfile just as out of date (#62 review).
    const lockPath = join(tempProject, 'uv.lock');
    const lockBefore = readFileSync(lockPath, 'utf8');
    writeFileSync(join(tempProject, 'pyproject.toml'), PYPROJECT(WIDER_PYTHON));

    expect(probeEnvironment(tempSpec).synced).toBe(false);
    // …and asking did not repair it. A probe that rewrites the repo to
    // find out whether it may run has answered a different question.
    expect(readFileSync(lockPath, 'utf8')).toBe(lockBefore);
    expect(existsSync(join(tempProject, '.venv'))).toBe(true);
  });
});
