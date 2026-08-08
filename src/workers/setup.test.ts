import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ACED_SPEC } from '../aced/client.js';
import { VOICED_SPEC } from '../voiced/client.js';
import { workerAvailable, workerLaunchCommand, workerPackagePresent } from './client.js';
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

describe('starting a worker never installs its environment', () => {
  it('runs uv with --no-sync', () => {
    // The gate itself. Without this flag uv installs the environment as a
    // side effect of starting the daemon, and every other check here is
    // decoration.
    for (const spec of [ACED_SPEC, VOICED_SPEC]) {
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

    // And the availability gate lets it past with no .venv anywhere.
    // Asserted here rather than left to the harness: every worker package
    // in this checkout happens to be synced, so a gate that wrongly
    // caught the override would pass locally and strand CI — where
    // nothing runs `uv sync` for the workers at all.
    mkdirSync(tempProject, { recursive: true });
    writeFileSync(join(tempProject, 'pyproject.toml'), '[project]\nname = "x"\n');
    expect(existsSync(join(tempProject, '.venv'))).toBe(false);
    expect(workerAvailable(tempSpec).ok).toBe(true);
  });
});

describe('an uninstalled environment is diagnosed, not spawned into', () => {
  it('names the setup command that fixes it', () => {
    // A package with no .venv is exactly a fresh checkout. Before the
    // gate this spawned, uv installed, and it worked; after the gate it
    // would spawn, uv would refuse, and the caller would wait out a
    // sixty-second connect timeout to be told "did not start". Neither is
    // an answer, so the answer comes from here.
    mkdirSync(tempProject, { recursive: true });
    writeFileSync(join(tempProject, 'pyproject.toml'), '[project]\nname = "x"\n');
    expect(workerPackagePresent(tempSpec).ok).toBe(true);

    const available = workerAvailable(tempSpec);
    expect(available.ok).toBe(false);
    expect(available.reason).toContain(`field setup ${tempDir}`);

    // Installed is the whole difference: nothing else about the checkout
    // changes between these two assertions.
    mkdirSync(join(tempProject, '.venv'));
    expect(workerAvailable(tempSpec).ok).toBe(true);
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
