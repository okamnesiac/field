import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VOICED_SPEC } from '../voiced/client.js';
import { checkWorkers, partitionExisting, selectWorkers, SETUP_SPECS } from '../commands/generate.js';
import {
  environmentVerdict,
  workerAvailable,
  workerLaunchCommand,
  workerPackagePresent,
  workerScriptInstalled,
  probeEnvironment,
  type EnvironmentProbe,
  type ProbeRun,
} from './client.js';
import type { WorkerSpec } from './protocol.js';

// `field setup` is meant to be the only thing that installs a worker
// environment — "explicit, never automatic" (ace-generation.md §3.4).
// That was a description of intent rather than of behaviour until #61:
// `uv run` syncs the project environment by default, so the first
// `field generate` installed torch and Chatterbox on its own, and setup
// was a label on a door that was never locked.
//
// These are unit tests on purpose. Proving it end to end would mean a
// checkout with no environment and a multi-GB install as the failure
// mode, which is the thing the gate exists to prevent.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A worker whose package sits where we can control whether it looks
// installed. Under python/ because that is where the resolution looks.
const tempDir = `.test-worker-${process.pid}`;
const tempSpec: WorkerSpec = { ...VOICED_SPEC, packageDir: tempDir };
const tempProject = join(packageRoot, 'python', tempDir);

afterEach(() => {
  rmSync(tempProject, { recursive: true, force: true });
  delete process.env[tempSpec.pythonOverrideEnv];
});

// The two layouts that matter: a worker uv has installed, and the
// `uv sync --only-group dev` environment CI builds for pyright.
function devOnlyWorker(): string {
  const binDir = join(tempProject, '.venv', 'bin');
  rmSync(tempProject, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(tempProject, 'pyproject.toml'), '[project]\nname = "x"\n');
  writeFileSync(join(binDir, 'pyright'), '');
  writeFileSync(join(binDir, 'python3'), '');
  return binDir;
}

function installedWorker(): string {
  const binDir = devOnlyWorker();
  writeFileSync(join(binDir, tempSpec.script), '');
  return binDir;
}

// Records what the probe asks, and answers with whatever the test says.
function recorder(results: ReturnType<ProbeRun>[]): { calls: string[][]; run: ProbeRun } {
  const calls: string[][] = [];
  let next = 0;
  return {
    calls,
    run: (command, args) => {
      calls.push([command, ...args]);
      return results[next++] ?? { status: 0 };
    },
  };
}

describe('starting a worker never installs its environment', () => {
  it('runs uv with --no-sync', () => {
    // The gate itself. Without this flag uv installs the environment as a
    // side effect of starting the daemon, and every other check here is
    // decoration.
    for (const spec of SETUP_SPECS) {
      const { command, args } = workerLaunchCommand(spec);
      expect(command).toBe('uv');
      expect(args[0]).toBe('run');
      expect(args).toContain('--no-sync');
      expect(args).toContain(spec.script);
    }
  });

  it('leaves the interpreter override alone — it brings its own environment', () => {
    // The override is how the live and stub tests run at all, so a gate
    // that caught it would take the whole harness with it.
    process.env[tempSpec.pythonOverrideEnv] = process.execPath;
    const { command, args } = workerLaunchCommand(tempSpec);
    expect(command).toBe(process.execPath);
    expect(args).not.toContain('--no-sync');

    // And the availability gate lets it past with no .venv anywhere,
    // without paying for the uv subprocess. Asserted here rather than
    // left to the harness: a gate that wrongly caught the override would
    // take every stub and live daemon test with it, and would do so
    // differently depending on what happened to be installed.
    mkdirSync(tempProject, { recursive: true });
    writeFileSync(join(tempProject, 'pyproject.toml'), '[project]\nname = "x"\n');
    expect(existsSync(join(tempProject, '.venv'))).toBe(false);
    expect(workerAvailable(tempSpec).ok).toBe(true);
  });
});

describe('an unusable environment is diagnosed, not spawned into', () => {
  // Every combination, decided from a probe rather than from the
  // checkout. `pnpm test` runs before setup-uv in CI, so ambient state
  // there is "no uv, no environments" — assertions that read it would
  // pass or fail by accident of where they ran.
  const probe = (over: Partial<EnvironmentProbe> = {}): EnvironmentProbe => ({
    uvPresent: true,
    scriptInstalled: true,
    synced: true,
    ...over,
  });

  it('accepts only an installed, current environment', () => {
    expect(environmentVerdict(VOICED_SPEC, probe())).toEqual({ ok: true });
  });

  it('refuses an environment it never managed to check', () => {
    // The probe cannot produce this today — it runs the check exactly
    // when uv is present and the worker is installed. Pinned anyway,
    // because "unreachable" is a claim about the caller: if the probe and
    // this function ever disagree about when the check runs, an unchecked
    // environment must read as a refusal rather than as a pass.
    const verdict = environmentVerdict(VOICED_SPEC, probe({ synced: undefined }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('could not be verified');
  });

  it('names the setup command when the worker is not installed', () => {
    // Before the gate this spawned, uv installed, and it worked; after
    // the gate it would spawn, uv would refuse, and the caller would wait
    // out a sixty-second connect timeout to be told "did not start".
    // Neither is an answer, so the answer comes from here.
    const verdict = environmentVerdict(VOICED_SPEC, probe({ scriptInstalled: false }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('not installed');
    expect(verdict.reason).toContain('field setup voiced');
  });

  it('names it again when the environment is installed but stale', () => {
    // Installed is not current. A worker whose lockfile moved underneath
    // it launches and then dies on an import, which is the same
    // sixty-second silence by a different route.
    const verdict = environmentVerdict(VOICED_SPEC, probe({ synced: false }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('out of date');
    expect(verdict.reason).toContain('field setup voiced');
  });

  it('does not tell anyone to run setup when uv is missing', () => {
    // `field setup` runs `uv sync`, so recommending it without uv is
    // advice that cannot work — and uv is also the launcher, so this is
    // fatal either way.
    const verdict = environmentVerdict(VOICED_SPEC, probe({ uvPresent: false, synced: undefined }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('brew install uv');
    expect(verdict.reason).not.toContain('field setup');

    // Both missing at once is the state of a fresh clone — and of CI,
    // where `pnpm test` runs before setup-uv — so it is the combination
    // most likely to be met and the one that fixes the ordering: with
    // the environment checked first, this says "run field setup" and
    // sends someone to a command that cannot run.
    const fresh = environmentVerdict(
      VOICED_SPEC,
      probe({ uvPresent: false, scriptInstalled: false, synced: undefined }),
    );
    expect(fresh.reason).toContain('brew install uv');
    expect(fresh.reason).not.toContain('field setup');
  });

  it('reads a dev-only .venv as uninstalled, which is what the probe sees', () => {
    // The false positive that started this: `uv sync --only-group dev` —
    // what CI builds for the pyright gate, and therefore what a dev
    // checkout has — creates `.venv` with pyright in it and no worker.
    // A directory named `.venv` was the whole test before, so both
    // workers passed the gate here and could not launch (#61 review).
    const binDir = devOnlyWorker();
    expect(existsSync(join(tempProject, '.venv'))).toBe(true);
    expect(workerScriptInstalled(tempSpec)).toBe(false);

    // …and the console script appearing is the whole difference, which is
    // what a full `uv sync` writes and `--only-group dev` does not.
    writeFileSync(join(binDir, tempSpec.script), '');
    expect(workerScriptInstalled(tempSpec)).toBe(true);
  });

  it('installs nothing while deciding whether anything is installed', () => {
    // The probe asked `uv sync --check` before looking at anything else,
    // and uv downloads a CPython when it cannot find one — 24 MB, and it
    // completed rather than merely attempting. So on a fresh machine the
    // gate against automatic installation performed one on its way to
    // reporting that nothing was installed (#61 review).
    //
    // Asserted on the commands, not on the booleans they return: the
    // three booleans were exhaustively covered while this was happening,
    // and no assertion about a return value could have seen it.
    installedWorker();
    const { calls, run } = recorder([{ status: 0 }, { status: 0 }]);
    expect(probeEnvironment(tempSpec, run)).toMatchObject({ uvPresent: true, synced: true });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['uv', '--version']);
    const check = calls[1]!;
    expect(check.slice(0, 5)).toEqual([
      'uv',
      'sync',
      '--check',
      '--locked',
      '--no-python-downloads',
    ]);
    expect(check.at(-1)).toContain(tempDir);
    // `--frozen` is the flag this must never drift back to: it means
    // "sync without updating the lock", which is permission to proceed on
    // a stale one rather than a check that it is current.
    expect(check).not.toContain('--frozen');
  });

  it('never asks uv about a project without disabling downloads', () => {
    // The invariant rather than the instance: any future probe command
    // that names a project can resolve, and resolving is what triggers
    // the interpreter download.
    for (const layout of [installedWorker, devOnlyWorker]) {
      layout();
      const { calls, run } = recorder([{ status: 0 }, { status: 0 }]);
      probeEnvironment(tempSpec, run);
      for (const call of calls) {
        if (call.includes('--project')) expect(call).toContain('--no-python-downloads');
      }
    }
  });

  it('asks uv nothing about the project when the answer is already known', () => {
    // A subprocess whose result nobody reads, and — before the
    // short-circuit — the one that could install an interpreter.
    devOnlyWorker();
    const absent = recorder([{ status: 0 }]);
    expect(probeEnvironment(tempSpec, absent.run).scriptInstalled).toBe(false);
    expect(absent.calls).toEqual([['uv', '--version']]);

    // Same when uv itself is missing: nothing to ask, nothing asked.
    installedWorker();
    const noUv = recorder([{ status: null, error: new Error('ENOENT') }]);
    expect(probeEnvironment(tempSpec, noUv.run).uvPresent).toBe(false);
    expect(noUv.calls).toEqual([['uv', '--version']]);
  });

  it('reads a failed check as stale rather than as fine', () => {
    installedWorker();
    const { run } = recorder([{ status: 0 }, { status: 1 }]);
    expect(probeEnvironment(tempSpec, run).synced).toBe(false);
  });

  it('still reports a missing package differently from a missing environment', () => {
    // Two different problems with two different fixes: `field setup` will
    // not conjure a package that is not in the checkout.
    const absent = workerAvailable({ ...VOICED_SPEC, packageDir: 'not-a-worker' });
    expect(absent.ok).toBe(false);
    expect(absent.reason).toContain('missing from the field checkout');
    expect(absent.reason).not.toContain('field setup');
  });

  it('asks only whether the package is present when setting up', () => {
    // setup is what creates the environment, so gating it on the
    // environment existing would make it impossible to run the first
    // time — the deadlock the split between these two exists to avoid.
    mkdirSync(tempProject, { recursive: true });
    writeFileSync(join(tempProject, 'pyproject.toml'), '[project]\nname = "x"\n');
    expect(existsSync(join(tempProject, '.venv'))).toBe(false);
    expect(workerPackagePresent(tempSpec).ok).toBe(true);
  });
});

describe('the shared lifecycle is edited in place, not copied', () => {
  // `field-worker` is our own source, not a pinned release. Declared as a
  // plain path dependency, uv installs a *copy* into each worker's venv —
  // so adding a symbol to `field_worker` left every worker importing a
  // stale one, and the ImportError named the module that wanted it rather
  // than the module that lacked it. It cost a failed generation on bloom
  // to find, because nothing here could have.
  //
  // Asserted on the declaration rather than the installed layout: the
  // venvs are ambient (CI has none during `pnpm test`), and the thing
  // that was actually wrong is this line.
  it('declares field-worker editable in every worker that depends on it', () => {
    for (const spec of SETUP_SPECS) {
      const pyproject = readFileSync(
        join(packageRoot, 'python', spec.packageDir, 'pyproject.toml'),
        'utf8',
      );
      const source = pyproject
        .split('\n')
        .find((line) => line.trimStart().startsWith('field-worker = '));
      expect(source, `${spec.packageDir} declares no field-worker source`).toBeDefined();
      expect(source, `${spec.packageDir} installs field-worker as a copy`).toContain(
        'editable = true',
      );
    }
  });
});

// An upgrade keeps current what someone set up and sets up nothing new
// (install.md §2.4), and `install.sh status` reports from the same probe
// `field generate` gates on, so these hold the upgrade to the gate.
describe('an upgrade re-syncs only what was set up', () => {
  it('syncs an installed worker and skips a dev-only one', () => {
    installedWorker();
    const absent: WorkerSpec = { ...tempSpec, packageDir: `${tempDir}-absent` };
    expect(partitionExisting([tempSpec, absent])).toEqual({ sync: [tempSpec], skip: [absent] });

    devOnlyWorker();
    expect(partitionExisting([tempSpec])).toEqual({ sync: [], skip: [tempSpec] });
  });

  it('names a worker by its package directory or its daemon name', () => {
    expect(selectWorkers()).toBe(SETUP_SPECS);
    expect(selectWorkers('voiced')).toEqual([VOICED_SPEC]);
    expect(selectWorkers('field-voiced')).toEqual([VOICED_SPEC]);
    expect(() => selectWorkers('nope')).toThrow('unknown worker "nope" — try aced or voiced');
  });
});

describe('field setup --check', () => {
  const label = (line: string): string => line.split(' ')[0]!;

  it('reports a worker nobody set up without asking uv about it, and as no problem', () => {
    devOnlyWorker();
    const { calls, run } = recorder([{ status: 0 }]);
    const { lines, ok } = checkWorkers([tempSpec], run);
    expect(lines.map(label)).toEqual(['worker-absent']);
    expect(lines[0]).toContain(`field setup ${tempDir}`);
    expect(ok).toBe(true);
    expect(calls).toEqual([['uv', '--version']]);
  });

  it('reports an installed, synced worker as current', () => {
    installedWorker();
    const { lines, ok } = checkWorkers([tempSpec], recorder([{ status: 0 }, { status: 0 }]).run);
    expect(lines).toEqual([`${'worker-current'.padEnd(14)} ${tempSpec.name}`]);
    expect(ok).toBe(true);
  });

  it('reports an installed worker that fails the check as stale, and fails', () => {
    installedWorker();
    const { lines, ok } = checkWorkers([tempSpec], recorder([{ status: 0 }, { status: 1 }]).run);
    expect(lines.map(label)).toEqual(['worker-stale']);
    expect(lines[0]).toContain(`run field setup ${tempDir}`);
    expect(ok).toBe(false);
  });

  it('reports an installed worker with uv gone, and does not send anyone to setup', () => {
    installedWorker();
    const noUv = recorder([{ status: null, error: new Error('ENOENT') }]);
    const { lines, ok } = checkWorkers([tempSpec], noUv.run);
    expect(lines.map(label)).toEqual(['worker-no-uv']);
    expect(lines[0]).toContain('brew install uv');
    expect(lines[0]).not.toContain('field setup');
    expect(ok).toBe(false);
  });
});
