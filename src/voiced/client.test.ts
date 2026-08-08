import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VoicedClient } from './client.js';
import { workerHelloResponseSchema, workerOkResponseSchema } from '../workers/protocol.js';

// Live protocol tests against the real Python daemon, spawned through the
// FIELD_VOICED_PYTHON override — the same harness field-aced has had
// since #49, and the reason the Chatterbox imports in adapter.py are
// lazy. No model environment: no torch, no weights, no ~2 GB download.
// Spawn, handshake, request validation and quit all work from a bare
// >=3.11 interpreter with the sources on PYTHONPATH.
//
// That constraint came out of the #59 review rather than from planning:
// the aced harness only works because ACE's imports are lazy, so voice
// keeps the coverage only by being lazy too. This file is what would
// notice if a future edit imported chatterbox at module scope.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const voicedSrc = [
  join(packageRoot, 'python', 'worker', 'src'),
  join(packageRoot, 'python', 'voiced', 'src'),
].join(delimiter);

function findInterpreter(): string | undefined {
  const venv = join(packageRoot, 'python', 'voiced', '.venv', 'bin', 'python');
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

describe.skipIf(!interpreter)('field-voiced protocol (live daemon)', () => {
  let root: string;
  let client: VoicedClient;
  let savedPythonPath: string | undefined;

  beforeEach(async () => {
    process.env['FIELD_VOICED_PYTHON'] = interpreter;
    savedPythonPath = process.env['PYTHONPATH'];
    process.env['PYTHONPATH'] = voicedSrc;
    root = mkdtempSync(join(tmpdir(), 'field-voiced-'));
    client = await VoicedClient.connect(root);
  });

  afterEach(async () => {
    try {
      await client.quit();
    } catch {
      // the test may have quit already; a dead daemon is the goal state
    }
    client.close();
    delete process.env['FIELD_VOICED_PYTHON'];
    if (savedPythonPath === undefined) delete process.env['PYTHONPATH'];
    else process.env['PYTHONPATH'] = savedPythonPath;
    rmSync(root, { recursive: true, force: true });
  });

  it('spawns and handshakes with the model unloaded', () => {
    expect(client.daemonVersion).not.toBe('unknown');
    expect(client.modelLoaded).toBe(false);
  });

  it('answers unknown ops with a protocol error and keeps serving', async () => {
    await expect(client.request('mystery', {}, workerOkResponseSchema, 5000)).rejects.toThrow(
      /unknown op/,
    );
    const hello = await client.request('hello', {}, workerHelloResponseSchema, 5000);
    expect(hello.daemon).toBe('field-voiced');
    expect(hello.model_loaded).toBe(false);
  });

  it('rejects a malformed job before any model work', async () => {
    // Validation happens in `parse_job`, which the shared lifecycle calls
    // before it takes the generation gate — so a bad request never
    // reaches Chatterbox and never triggers a weights download. Empty
    // text and an out-of-range variant count are the two the job spec
    // actually bounds.
    await expect(
      client.generate({ text: '', seed: 1, variants: 2, output_dir: join(root, 'out') }),
    ).rejects.toThrow(/non-empty string 'text'/);
    await expect(
      client.generate({ text: 'a line', seed: 1, variants: 99, output_dir: join(root, 'out') }),
    ).rejects.toThrow(/'variants' must be in/);
    // …and it is still serving afterwards.
    const hello = await client.request('hello', {}, workerHelloResponseSchema, 5000);
    expect(hello.model_loaded).toBe(false);
  });

  it('does not treat an omitted voice_ref as the error', async () => {
    // Narrow on purpose, and named for what it actually shows. A job with
    // no reference and one genuinely bad field comes back complaining
    // about *that* field — so the absent reference was accepted rather
    // than being what failed. It is the configuration bloom uses (§6).
    //
    // Proving the default voice end to end would mean loading the model,
    // which is the one thing this harness exists to avoid, so that
    // belongs to the first real run rather than here.
    await expect(
      client.generate({ text: 'a line', seed: 1, variants: 0, output_dir: join(root, 'out') }),
    ).rejects.toThrow(/'variants' must be in/);
  });
});
