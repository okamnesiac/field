import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BuildOutcome, GeneratorRunner } from '../graph/build.js';
import { createSong } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { watchBuild } from './watch.js';

// The watch loop against a real project and real FS events (FSEvents via
// fs.watch — macOS is the charter): baseline build, hash-moved reporting,
// the check-gate, and no-op silence. Debounce is shrunk so the tests wait
// on outcomes, not the clock.

let root: string;

// A tiny valid 48 kHz 16-bit mono WAV (100 samples of silence).
function writeWav(path: string): void {
  const n = 100;
  const data = Buffer.alloc(n * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

const writeSound = (name: string, yaml: string) => {
  mkdirSync(join(root, 'songs/creek/sounds'), { recursive: true });
  writeFileSync(join(root, `songs/creek/sounds/${name}.yaml`), yaml);
};

const normalizeYaml = (rate: number) =>
  ['name: pad-normalized', 'type: normalize', 'source: pad', `sample_rate: ${rate}`, 'bit_depth: 16', ''].join('\n');

const runner: GeneratorRunner = async (node, _inputPaths, outputPath) => {
  // Parameter-sensitive fake: output content tracks the spec, so a
  // parameter edit moves the output hash the way a real render would.
  writeFileSync(outputPath, JSON.stringify({ label: node.label, spec: node.spec }));
};

type Recorded =
  | { kind: 'outcomes'; outcomes: BuildOutcome[]; changed: BuildOutcome[] }
  | { kind: 'diagnostics'; lines: string[] }
  | { kind: 'error'; message: string; phase: string };

function startWatch(patterns: string[]) {
  const events: Recorded[] = [];
  const abort = new AbortController();
  const done = watchBuild(
    root,
    patterns,
    { debounceMs: 50, signal: abort.signal, runner },
    {
      onOutcomes: (outcomes, changed) => events.push({ kind: 'outcomes', outcomes, changed }),
      onDiagnostics: (lines) => events.push({ kind: 'diagnostics', lines }),
      onError: (err, phase) => events.push({ kind: 'error', message: err.message, phase }),
    },
  );
  return { events, abort, done };
}

// Polls until get() returns something, or the deadline passes.
async function until<T>(get: () => T | undefined, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('timed out waiting for a watch event');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bloom-watch-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  const src = join(root, '..', `bloom-watch-src-${Math.random()}.wav`);
  writeWav(src);
  await importAsset(root, 'creek', src, 'pad');
  rmSync(src);
  writeSound('pad-normalized', normalizeYaml(96000));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('watchBuild', { timeout: 20_000 }, () => {
  it('baselines, then reports the label whose output hash moved', async () => {
    const { events, abort, done } = startWatch(['//songs/creek/sounds:pad-normalized']);
    const first = await until(() => events.find((e) => e.kind === 'outcomes'));
    expect(first.kind).toBe('outcomes');
    if (first.kind !== 'outcomes') return;
    expect(first.changed).toEqual([]); // the baseline is not a change
    expect(first.outcomes.some((o) => o.label.endsWith(':pad-normalized'))).toBe(true);

    writeSound('pad-normalized', normalizeYaml(44100));
    const moved = await until(() => {
      const later = events.filter((e) => e.kind === 'outcomes').slice(1);
      return later.find((e) => e.kind === 'outcomes' && e.changed.length > 0);
    });
    if (moved.kind !== 'outcomes') return;
    expect(moved.changed.map((o) => o.label)).toEqual(['//songs/creek/sounds:pad-normalized']);

    abort.abort();
    await done;
  });

  it('a red project prints diagnostics, keeps the baseline, and recovers', async () => {
    const { events, abort, done } = startWatch(['//songs/creek/sounds:pad-normalized']);
    await until(() => events.find((e) => e.kind === 'outcomes'));

    writeSound('pad-normalized', 'name: [broken\n');
    const red = await until(() => events.find((e) => e.kind === 'diagnostics'));
    if (red.kind !== 'diagnostics') return;
    expect(red.lines.join('\n')).toContain('pad-normalized');

    // Fixing the file rebuilds against the last GOOD baseline: the rate
    // moved from 96000 to 44100, so the recovery reports a change.
    writeSound('pad-normalized', normalizeYaml(44100));
    const recovered = await until(() =>
      events.find((e) => e.kind === 'outcomes' && e.changed.length > 0),
    );
    if (recovered.kind !== 'outcomes') return;
    expect(recovered.changed.map((o) => o.label)).toEqual(['//songs/creek/sounds:pad-normalized']);

    abort.abort();
    await done;
  });

  it('a no-op edit rebuilds to silence: cache hits, nothing changed', async () => {
    const { events, abort, done } = startWatch(['//songs/creek/sounds:pad-normalized']);
    await until(() => events.find((e) => e.kind === 'outcomes'));

    // A comment is invisible to the parsed spec — the action key holds,
    // the output hash holds, and the report says so (watch.md §1.3: a
    // fmt pass is all cache hits).
    writeSound('pad-normalized', `# tweaked comment\n${normalizeYaml(96000)}`);
    const quiet = await until(() => {
      const later = events.filter((e) => e.kind === 'outcomes').slice(1);
      return later[0];
    });
    if (quiet.kind !== 'outcomes') return;
    expect(quiet.changed).toEqual([]);
    expect(quiet.outcomes.every((o) => o.cached)).toBe(true);

    abort.abort();
    await done;
  });

  it('a loader throw routes to onError and the watch survives (P2)', async () => {
    const { events, abort, done } = startWatch(['//songs/creek/sounds:pad-normalized']);
    await until(() => events.find((e) => e.kind === 'outcomes'));

    // The reviewer's repro: a dangling symlink directly under songs/
    // makes loadProject itself throw (statSync on the song scan) — not a
    // diagnostic, a loader crash. The session must report and wait, not
    // die (§1.2).
    const ghost = join(root, 'songs/ghost');
    symlinkSync(join(root, 'nowhere-to-be-found'), ghost);
    const crashed = await until(() => events.find((e) => e.kind === 'error'));
    if (crashed.kind !== 'error') return;
    expect(crashed.message).toBeTruthy();
    expect(crashed.phase).toBe('load'); // the report never blames the build

    // Removing the wreckage plus a real edit: the same session recovers
    // and reports against the last good baseline.
    rmSync(ghost);
    writeSound('pad-normalized', normalizeYaml(44100));
    const recovered = await until(() =>
      events.find((e) => e.kind === 'outcomes' && e.changed.length > 0),
    );
    if (recovered.kind !== 'outcomes') return;
    expect(recovered.changed.map((o) => o.label)).toEqual(['//songs/creek/sounds:pad-normalized']);

    abort.abort();
    await done;
  });

  it('an aborted session resolves', async () => {
    const { abort, done } = startWatch(['//songs/creek/sounds:pad-normalized']);
    abort.abort();
    await done;
  });
});
