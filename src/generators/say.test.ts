import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav } from '../audio/wav.js';
import { buildLabels, queryDeps } from '../commands/build.js';
import { createSong } from '../commands/create.js';
import { init } from '../commands/init.js';
import { sha256File } from '../hash.js';
import { saySoundSchema } from '../schema/index.js';
import { hasAfconvert, hasSay } from '../testing/platform.js';
import { sayGenerator } from './say.js';

// These run the real `say` and `afconvert` — macOS-only, like the sclang
// integration tests. Samantha ships with macOS. This is the one file
// where every test is platform-bound, so the guard sits on the describes;
// the other three afconvert tests are guarded one by one
// (linux-portability.md decision 4).
const macosAudioTools = hasSay && hasAfconvert;
const target = (over: Record<string, unknown> = {}) =>
  saySoundSchema.parse({ name: 'scratch', type: 'say', text: 'field', voice: 'Samantha', ...over });

describe.skipIf(!macosAudioTools)('sayGenerator.execute', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-say-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders speech to a WAV at the project rate', { timeout: 30_000 }, async () => {
    const out = join(dir, 'out.wav');
    await sayGenerator.execute(target(), [], out, { root: dir, sampleRate: 48000 });
    const wav = readWav(out);
    expect(wav.sampleRate).toBe(48000);
    expect(wav.channels[0]!.length).toBeGreaterThan(4800); // said something
  });

  it('is deterministic: same text, voice, and rate → same bytes', { timeout: 30_000 }, async () => {
    const a = join(dir, 'a.wav');
    const b = join(dir, 'b.wav');
    const ctx = { root: dir, sampleRate: 48000 };
    await sayGenerator.execute(target({ rate: 200 }), [], a, ctx);
    await sayGenerator.execute(target({ rate: 200 }), [], b, ctx);
    expect(await sha256File(a)).toBe(await sha256File(b));
  });

  it('treats text as data, not argv — leading dashes speak fine', { timeout: 30_000 }, async () => {
    const out = join(dir, 'dash.wav');
    await sayGenerator.execute(target({ text: '-r is not a flag here' }), [], out, {
      root: dir,
      sampleRate: 48000,
    });
    expect(readWav(out).channels[0]!.length).toBeGreaterThan(0);
  });

  it('names the voice when say rejects it', async () => {
    const out = join(dir, 'nope.wav');
    await expect(
      sayGenerator.execute(target({ voice: 'no-such-voice-xyz' }), [], out, {
        root: dir,
        sampleRate: 48000,
      }),
    ).rejects.toThrow('no-such-voice-xyz');
  });

  it('voice: Siri renders with the system voice — the recorded escape hatch', { timeout: 30_000 }, async () => {
    // Siri voices are hidden from say -v, so "Siri" omits -v entirely and
    // takes whatever the machine's Spoken Content voice is. What this
    // pins is the escape hatch: no -v, and audio comes out.
    //
    // It deliberately does not assert that two Siri renders are
    // byte-identical. It used to, and that assertion failed twice on CI
    // in two days (#31, #41) on changes that cannot touch audio, with
    // genuinely different hashes — while passing every time on a machine
    // where the voice is long installed. A system voice that may be
    // fetched or warmed on first use is exactly the thing the design
    // says it will not promise bytes for: `Siri` follows a Settings
    // toggle by construction, which is the trade recorded for it in
    // build-graph.md. Asserting stability anyway made a true statement
    // about Samantha into a false one about Siri.
    //
    // The determinism contract itself is covered above, on a nameable
    // voice, where it holds and has never flaked.
    const a = join(dir, 'siri-a.wav');
    const b = join(dir, 'siri-b.wav');
    const ctx = { root: dir, sampleRate: 48000 };
    await sayGenerator.execute(target({ voice: 'Siri' }), [], a, ctx);
    await sayGenerator.execute(target({ voice: 'Siri' }), [], b, ctx);
    for (const rendered of [a, b]) {
      expect(readWav(rendered).channels[0]!.length).toBeGreaterThan(4800);
    }
  });
});

describe.skipIf(!macosAudioTools)('say sounds in the build graph', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-say-graph-'));
    init({ dir: root, name: 'test-album' });
    createSong(root, 'opener');
    mkdirSync(join(root, 'songs/opener/sounds'), { recursive: true });
    writeFileSync(
      join(root, 'songs/opener/sounds/scratch-vocal.yaml'),
      [
        'name: scratch-vocal',
        'type: say',
        'text: down by the creek',
        'voice: Samantha',
        'rate: 180',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds, caches, and re-keys on a text edit', { timeout: 30_000 }, async () => {
    const label = '//songs/opener/sound:scratch-vocal';
    expect(queryDeps(root, `deps(${label})`)).toEqual([label]);

    const first = await buildLabels(root, [label]);
    expect(first[0]!.cached).toBe(false);
    expect(readWav(first[0]!.outputPath!).sampleRate).toBe(48000);

    const again = await buildLabels(root, [label]);
    expect(again[0]!.cached).toBe(true);

    writeFileSync(
      join(root, 'songs/opener/sounds/scratch-vocal.yaml'),
      [
        'name: scratch-vocal',
        'type: say',
        'text: down by the wide creek', // the text is the action key
        'voice: Samantha',
        'rate: 180',
        '',
      ].join('\n'),
    );
    const edited = await buildLabels(root, [label]);
    expect(edited[0]!.cached).toBe(false);
  });
});
