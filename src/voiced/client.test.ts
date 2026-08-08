import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it('refuses a daemon that identifies as a different worker', async () => {
    // Every worker shares one protocol and one socket convention, so a
    // stale or misconfigured socket lets field-aced satisfy a
    // VoicedClient's handshake — reproduced by starting aced on voice's
    // socket path (#60 review). A voice job would then be rejected as a
    // malformed ACE job three seconds later, or worse, understood as one.
    await client.quit();
    client.close();
    rmSync(join(root, '.field'), { recursive: true, force: true });

    const acedSrc = [
      join(packageRoot, 'python', 'worker', 'src'),
      join(packageRoot, 'python', 'aced', 'src'),
    ].join(delimiter);
    mkdirSync(join(root, '.field'), { recursive: true });
    const impostor = spawn(interpreter!, ['-m', 'field_aced', '--socket', '.field/voiced.sock'], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: acedSrc },
      stdio: 'ignore',
    });
    try {
      // Wait for it to bind, then connect as voice.
      for (let i = 0; i < 40 && !existsSync(join(root, '.field/voiced.sock')); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await expect(VoicedClient.connect(root)).rejects.toThrow(/identifies as field-aced/);
    } finally {
      impostor.kill();
    }
    // The afterEach quits `client`, which this test already closed.
    client = await VoicedClient.connect(root).catch(() => client);
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

  it('refuses an empty voice_ref rather than reading it as absent', async () => {
    // "" and omitted are different requests: one asks for a reference
    // recording at no path, the other asks for the model's own voice.
    // Reading the first as the second would generate in the wrong voice
    // and commit it (#60 review, Bugbot).
    await expect(
      client.generate({
        text: 'a line',
        seed: 1,
        variants: 1,
        output_dir: join(root, 'out'),
        voice_ref: '',
      }),
    ).rejects.toThrow(/'voice_ref' must be a non-empty string/);
  });

  it('refuses a fractional seed or variant count rather than truncating', async () => {
    // `int(float(...))` took 2.7 variants as 2 and seed 1.5 as 1, so the
    // recipe would record inputs the caller never gave (#60 review).
    await expect(
      client.generate({ text: 'a line', seed: 1.5, variants: 1, output_dir: join(root, 'out') }),
    ).rejects.toThrow(/'seed' must be a whole number/);
    await expect(
      client.generate({ text: 'a line', seed: 1, variants: 2.7, output_dir: join(root, 'out') }),
    ).rejects.toThrow(/'variants' must be a whole number/);
  });

  it('bounds the delivery knobs rather than clamping them', async () => {
    // The worker validates its own job spec, not just the CLI — a
    // clamped value would be recorded in the recipe as the number asked
    // for while the audio came from a different one. Bounds match the
    // schema's (voice-generation.md §8).
    await expect(
      client.generate({
        text: 'a line',
        seed: 1,
        variants: 1,
        output_dir: join(root, 'out'),
        exaggeration: 5,
      }),
    ).rejects.toThrow(/'exaggeration' must be in/);
    await expect(
      client.generate({
        text: 'a line',
        seed: 1,
        variants: 1,
        output_dir: join(root, 'out'),
        conviction: 0,
      }),
    ).rejects.toThrow(/'conviction' must be in/);
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

// A separate harness with its own interpreter, deliberately. The block
// above prefers python/voiced/.venv when it exists, which after a real
// `field setup voiced` contains Chatterbox — so a test that wants the
// backend to fail on import would instead load a 2 GB model there and
// pass or hang depending on whether anyone had run setup. That is the
// same ambient-state trap the environment gate hit twice in #61/#62, so
// the precondition is stated here instead of inherited.
function findBareInterpreter(): string | undefined {
  const probe = spawnSync(
    'python3',
    ['-c', 'import sys; print(sys.executable if sys.version_info >= (3, 11) else "")'],
    { encoding: 'utf8' },
  );
  const found = probe.status === 0 ? probe.stdout.trim() : '';
  if (!found) return undefined;
  // Must NOT be able to import chatterbox: the failure is the fixture.
  const hasModel = spawnSync(found, ['-c', 'import chatterbox'], { stdio: 'ignore' }).status === 0;
  return hasModel ? undefined : found;
}

const bare = findBareInterpreter();

describe.skipIf(!bare)('a backend failure reaches the log', () => {
  let root: string;
  let client: VoicedClient;
  let savedPythonPath: string | undefined;

  beforeEach(async () => {
    process.env['FIELD_VOICED_PYTHON'] = bare;
    savedPythonPath = process.env['PYTHONPATH'];
    process.env['PYTHONPATH'] = voicedSrc;
    root = mkdtempSync(join(tmpdir(), 'field-voiced-fail-'));
    client = await VoicedClient.connect(root);
  });

  afterEach(async () => {
    try {
      await client.quit();
    } catch {
      // already gone is the goal state
    }
    client.close();
    delete process.env['FIELD_VOICED_PYTHON'];
    if (savedPythonPath === undefined) delete process.env['PYTHONPATH'];
    else process.env['PYTHONPATH'] = savedPythonPath;
    rmSync(root, { recursive: true, force: true });
  });

  it('logs the traceback, not just the sentence it puts on the wire', async () => {
    // A well-formed job gets past `parse_job` into the adapter, which
    // fails here at `from chatterbox.tts import …`. Every model-side
    // failure has that shape: the protocol carries one sentence, which
    // is right for a wire format and useless for a diagnosis.
    //
    // Not hypothetical. creek's first real generation returned
    // `'NoneType' object is not callable` and nothing else existed
    // anywhere; finding the cause — perth swallowing an ImportError for
    // `pkg_resources` three layers down — meant rebuilding the whole
    // model load by hand outside the daemon. The stack was always there.
    await expect(
      client.generate({ text: 'a line', seed: 1, variants: 1, output_dir: join(root, 'out') }),
    ).rejects.toThrow();
    const log = readFileSync(join(root, '.field/voiced.log'), 'utf8');
    expect(log).toContain('generation failed');
    expect(log).toContain('Traceback');
    // Names the module that actually failed, which is the whole point.
    expect(log).toContain('chatterbox');
  });
});
