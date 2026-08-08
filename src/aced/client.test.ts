import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcedClient } from './client.js';
import { acedHelloResponseSchema, acedOkResponseSchema } from './protocol.js';

// Live protocol tests against the real Python daemon, spawned through the
// FIELD_ACED_PYTHON override. No model environment required: the daemon's
// ACE-Step imports are lazy, so spawn, handshake, request validation, and
// quit all work from a bare >=3.11 interpreter with the sources on
// PYTHONPATH — which is exactly the wrapper/test use case the override
// exists for (ace-generation.md §3.4).

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Both source roots: the lifecycle lives in `field_worker` and is shared
// with field-voiced (voice-generation.md §1.4), so a bare interpreter
// needs it on the path alongside the worker's own package. These live
// protocol tests are what proved the extraction preserved behaviour —
// they spawn the real daemon, so a lifecycle regression fails here.
const acedSrc = [
  join(packageRoot, 'python', 'worker', 'src'),
  join(packageRoot, 'python', 'aced', 'src'),
].join(delimiter);

function findInterpreter(): string | undefined {
  const venv = join(packageRoot, 'python', 'aced', '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  const probe = spawnSync(
    'python3',
    ['-c', 'import sys; print(sys.executable if sys.version_info >= (3, 11) else "")'],
    { encoding: 'utf8' },
  );
  const found = probe.status === 0 ? probe.stdout.trim() : '';
  return found || undefined;
}

const interpreter = findInterpreter();

describe.skipIf(!interpreter)('field-aced protocol (live daemon)', () => {
  let root: string;
  let client: AcedClient;
  let savedPythonPath: string | undefined;

  beforeEach(async () => {
    process.env['FIELD_ACED_PYTHON'] = interpreter;
    savedPythonPath = process.env['PYTHONPATH'];
    process.env['PYTHONPATH'] = acedSrc;
    root = mkdtempSync(join(tmpdir(), 'field-aced-'));
    client = await AcedClient.connect(root);
  });

  afterEach(async () => {
    try {
      await client.quit();
    } catch {
      // the test may have quit already; a dead daemon is the goal state
    }
    client.close();
    delete process.env['FIELD_ACED_PYTHON'];
    if (savedPythonPath === undefined) delete process.env['PYTHONPATH'];
    else process.env['PYTHONPATH'] = savedPythonPath;
    rmSync(root, { recursive: true, force: true });
  });

  it('spawns and handshakes with the model unloaded', () => {
    expect(client.daemonVersion).not.toBe('unknown');
    expect(client.modelLoaded).toBe(false);
  });

  it('answers unknown ops with a protocol error and keeps serving', async () => {
    await expect(client.request('mystery', {}, acedOkResponseSchema, 5000)).rejects.toThrow(
      /unknown op/,
    );
    const hello = await client.request('hello', {}, acedHelloResponseSchema, 5000);
    expect(hello.model_loaded).toBe(false);
  });

  it('rejects out-of-range generate params before any model work', async () => {
    await expect(
      client.generate({
        prompt: 'x',
        duration_seconds: 5, // below the [10, 600] floor
        seed: 1,
        variants: 2,
        output_dir: join(root, 'out'),
      }),
    ).rejects.toThrow(/duration_seconds/);
  });
});
