import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav } from '../audio/wav.js';
import { buildTargets, queryDeps } from '../commands/build.js';
import { createSong } from '../commands/create.js';
import { init } from '../commands/init.js';
import { sha256File } from '../hash.js';
import { sayTargetSchema } from '../schema/schemas.js';
import { sayRule } from './say.js';

// These run the real `say` and `afconvert` — macOS-only, like the sclang
// integration tests. Samantha ships with macOS.
const target = (over: Record<string, unknown> = {}) =>
  sayTargetSchema.parse({ name: 'scratch', rule: 'say', text: 'bloom', voice: 'Samantha', ...over });

describe('sayRule.execute', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bloom-say-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders speech to a WAV at the project rate', { timeout: 30_000 }, async () => {
    const out = join(dir, 'out.wav');
    await sayRule.execute(target(), [], out, { root: dir, sampleRate: 48000 });
    const wav = readWav(out);
    expect(wav.sampleRate).toBe(48000);
    expect(wav.channels[0]!.length).toBeGreaterThan(4800); // said something
  });

  it('is deterministic: same text, voice, and rate → same bytes', { timeout: 30_000 }, async () => {
    const a = join(dir, 'a.wav');
    const b = join(dir, 'b.wav');
    const ctx = { root: dir, sampleRate: 48000 };
    await sayRule.execute(target({ rate: 200 }), [], a, ctx);
    await sayRule.execute(target({ rate: 200 }), [], b, ctx);
    expect(await sha256File(a)).toBe(await sha256File(b));
  });

  it('treats text as data, not argv — leading dashes speak fine', { timeout: 30_000 }, async () => {
    const out = join(dir, 'dash.wav');
    await sayRule.execute(target({ text: '-r is not a flag here' }), [], out, {
      root: dir,
      sampleRate: 48000,
    });
    expect(readWav(out).channels[0]!.length).toBeGreaterThan(0);
  });

  it('names the voice when say rejects it', async () => {
    const out = join(dir, 'nope.wav');
    await expect(
      sayRule.execute(target({ voice: 'no-such-voice-xyz' }), [], out, {
        root: dir,
        sampleRate: 48000,
      }),
    ).rejects.toThrow('no-such-voice-xyz');
  });

  it('voice: Siri renders with the system voice — the recorded escape hatch', { timeout: 30_000 }, async () => {
    // Siri voices are hidden from say -v, so "Siri" omits -v entirely and
    // takes whatever the machine's Spoken Content voice is.
    const a = join(dir, 'siri-a.wav');
    const b = join(dir, 'siri-b.wav');
    const ctx = { root: dir, sampleRate: 48000 };
    await sayRule.execute(target({ voice: 'Siri' }), [], a, ctx);
    await sayRule.execute(target({ voice: 'Siri' }), [], b, ctx);
    expect(readWav(a).channels[0]!.length).toBeGreaterThan(4800);
    expect(await sha256File(a)).toBe(await sha256File(b)); // stable while Settings are
  });
});

describe('say targets in the build graph', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bloom-say-graph-'));
    init({ dir: root, name: 'test-album' });
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/opener/targets.yaml'),
      [
        'targets:',
        '  - name: scratch-vocal',
        '    rule: say',
        '    text: down by the creek',
        '    voice: Samantha',
        '    rate: 180',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds, caches, and re-keys on a text edit', { timeout: 30_000 }, async () => {
    const label = '//songs/opener/targets:scratch-vocal';
    expect(queryDeps(root, `deps(${label})`)).toEqual([label]);

    const first = await buildTargets(root, [label]);
    expect(first[0]!.cached).toBe(false);
    expect(readWav(first[0]!.outputPath!).sampleRate).toBe(48000);

    const again = await buildTargets(root, [label]);
    expect(again[0]!.cached).toBe(true);

    writeFileSync(
      join(root, 'songs/opener/targets.yaml'),
      [
        'targets:',
        '  - name: scratch-vocal',
        '    rule: say',
        '    text: down by the wide creek', // the text is the action key
        '    voice: Samantha',
        '    rate: 180',
        '',
      ].join('\n'),
    );
    const edited = await buildTargets(root, [label]);
    expect(edited[0]!.cached).toBe(false);
  });
});
