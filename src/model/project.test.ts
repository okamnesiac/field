import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../commands/init.js';
import { createSong, createTrack } from '../commands/create.js';
import { check } from '../commands/check.js';
import { fmt } from '../commands/fmt.js';
import { importAsset } from '../commands/import.js';
import { sha256Text } from '../hash.js';
import { writeWavFloat32 } from '../audio/wav.js';
import { findProjectRoot, loadProject } from './project.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-test-'));
  init({ dir: root, name: 'test-album' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A source file to import, created outside the project.
function sourceFile(content = 'not really audio'): string {
  const path = join(root, '..', `field-test-src-${Date.now()}-${Math.random()}.wav`);
  writeFileSync(path, content);
  return path;
}

describe('init', () => {
  it('creates a valid, canonically formatted project', async () => {
    const result = await check(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.unformatted).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('writes .gitkeep so empty structure survives clone', () => {
    expect(existsSync(join(root, 'shared/instruments/.gitkeep'))).toBe(true);
    expect(existsSync(join(root, 'songs/.gitkeep'))).toBe(true);
    createSong(root, 'opener');
    expect(existsSync(join(root, 'songs/opener/tracks/.gitkeep'))).toBe(true);
    expect(existsSync(join(root, 'songs/opener/audio/.gitkeep'))).toBe(true);
  });

  it('refuses to reinitialize', () => {
    expect(() => init({ dir: root })).toThrow('already');
  });

  it('is discoverable from a subdirectory', () => {
    mkdirSync(join(root, 'songs', 'x'), { recursive: true });
    expect(findProjectRoot(join(root, 'songs', 'x'))).toBe(root);
  });
});

describe('song and track creation', () => {
  it('creates songs and tracks that pass check', async () => {
    createSong(root, 'opener');
    createTrack(root, 'opener', 'lead-vocal', 'audio');
    expect((await check(root)).ok).toBe(true);

    const project = loadProject(root);
    expect(project.songs).toHaveLength(1);
    expect(project.songs[0]!.tracks[0]!.data.name).toBe('lead-vocal');
  });

  it('rejects non-slug names', () => {
    expect(() => createSong(root, 'My Song')).toThrow('slug');
    createSong(root, 'opener');
    expect(() => createTrack(root, 'opener', 'Lead_Vocal', 'audio')).toThrow('slug');
  });

  it('rejects tracks in missing songs', () => {
    expect(() => createTrack(root, 'nope', 'lead-vocal', 'audio')).toThrow('does not exist');
  });

  it('recovers from a partially created song', async () => {
    createSong(root, 'opener');
    // Simulate a crash between tempo.yaml and song.yaml: the existence
    // marker (song.yaml) is missing, so createSong must succeed again.
    rmSync(join(root, 'songs/opener/song.yaml'));
    expect(() => createSong(root, 'opener')).not.toThrow();
    expect((await check(root)).ok).toBe(true);
  });

  it('ignores editor dotfiles that end in .yaml', async () => {
    createSong(root, 'opener');
    createTrack(root, 'opener', 'lead-vocal', 'audio');
    // Emacs marks an unsaved buffer with a dangling symlink whose name
    // ends in .yaml. Loading it throws ENOENT rather than producing a
    // diagnostic, so under --watch merely opening a track file would end
    // the rebuild (#34 review footnote).
    symlinkSync(
      'justin@Mac.12345:1754500000',
      join(root, 'songs/opener/tracks/.#lead-vocal.yaml'),
    );
    expect(() => loadProject(root)).not.toThrow();
    expect((await check(root)).ok).toBe(true);
    expect(loadProject(root).songs[0]!.tracks).toHaveLength(1);
  });
});

describe('import', () => {
  it('copies the file, records name + sha256 + size, and passes check', async () => {
    createSong(root, 'opener');
    const src = sourceFile('hello audio');
    const result = await importAsset(root, 'opener', src, 'first-take');

    expect(result.file).toBe('audio/first-take.wav');
    expect(result.sha256).toBe(sha256Text('hello audio'));
    expect(existsSync(join(root, 'songs/opener/audio/first-take.wav'))).toBe(true);
    expect((await check(root)).ok).toBe(true);
    rmSync(src);
  });

  it('pre-flights past an editor lock file in sounds/', async () => {
    createSong(root, 'opener');
    mkdirSync(join(root, 'songs/opener/sounds'), { recursive: true });
    // The name-collision pre-flight reads every sounds/*.yaml, and a
    // dangling `.#hum.yaml` made it throw ENOENT before it could parse —
    // crashing the command it exists to protect (#38 review P2).
    symlinkSync('justin@Mac.12345:1754500000', join(root, 'songs/opener/sounds/.#hum.yaml'));
    const src = sourceFile('hello audio');
    await expect(importAsset(root, 'opener', src, 'first-take')).resolves.toBeDefined();
    rmSync(src);
  });

  it('derives a slug name from the filename', async () => {
    createSong(root, 'opener');
    const src = sourceFile();
    const result = await importAsset(root, 'opener', src);
    expect(result.name).toMatch(/^field-test-src-/);
    rmSync(src);
  });

  it('rejects duplicate asset names', async () => {
    createSong(root, 'opener');
    const src = sourceFile();
    await importAsset(root, 'opener', src, 'take-one');
    await expect(importAsset(root, 'opener', src, 'take-one')).rejects.toThrow('already');
    rmSync(src);
  });

  it('recovers from a partial import (orphaned file, no declaration)', async () => {
    createSong(root, 'opener');
    const src = sourceFile('good bytes');
    await importAsset(root, 'opener', src, 'good-take');
    // Simulate a crash between copy and manifest write: file on disk,
    // declaration gone.
    writeFileSync(join(root, 'songs/opener/assets.yaml'), 'assets: []\n');
    await expect(importAsset(root, 'opener', src, 'good-take')).resolves.toBeDefined();
    expect((await check(root)).ok).toBe(true);
    rmSync(src);
  });

  it('refuses to overwrite a file belonging to a declared asset', async () => {
    createSong(root, 'opener');
    const src = sourceFile('kick bytes');
    await importAsset(root, 'opener', src, 'kick');
    // Hand-rename the entry's name; its file still references audio/kick.wav.
    const assetsPath = join(root, 'songs/opener/assets.yaml');
    writeFileSync(assetsPath, readFileSync(assetsPath, 'utf8').replace('name: kick', 'name: kick-alt'));
    expect((await check(root)).ok).toBe(true);

    const other = sourceFile('other bytes');
    await expect(importAsset(root, 'opener', other, 'kick')).rejects.toThrow(
      'already belongs to a declared asset',
    );
    expect(readFileSync(join(root, 'songs/opener/audio/kick.wav'), 'utf8')).toBe('kick bytes');
    expect((await check(root)).ok).toBe(true);
    rmSync(src);
    rmSync(other);
  });

  it('blocks the overwrite even when the declared file is spelled oddly', async () => {
    createSong(root, 'opener');
    const src = sourceFile('kick bytes');
    await importAsset(root, 'opener', src, 'kick');
    const assetsPath = join(root, 'songs/opener/assets.yaml');
    // "./audio/kick.wav" resolves identically and passes check; the guard
    // must compare resolved paths, not strings.
    writeFileSync(
      assetsPath,
      readFileSync(assetsPath, 'utf8')
        .replace('name: kick', 'name: kick-alt')
        .replace('file: audio/kick.wav', 'file: ./audio/kick.wav'),
    );
    const other = sourceFile('other bytes');
    await expect(importAsset(root, 'opener', other, 'kick')).rejects.toThrow(
      'already belongs to a declared asset',
    );
    expect(readFileSync(join(root, 'songs/opener/audio/kick.wav'), 'utf8')).toBe('kick bytes');
    rmSync(src);
    rmSync(other);
  });

  it('does not corrupt an assets.yaml that reads {}', async () => {
    createSong(root, 'opener');
    writeFileSync(join(root, 'songs/opener/assets.yaml'), '{}\n');
    const src = sourceFile();
    await importAsset(root, 'opener', src, 'first');
    expect((await check(root)).ok).toBe(true);
    rmSync(src);
  });

  it('records forward-slash file paths', async () => {
    createSong(root, 'opener');
    const src = sourceFile();
    const result = await importAsset(root, 'opener', src, 'first');
    expect(result.file).toBe('audio/first.wav');
    rmSync(src);
  });

  it('preserves comments in assets.yaml across imports', async () => {
    createSong(root, 'opener');
    const src = sourceFile();
    await importAsset(root, 'opener', src, 'take-one');
    const assetsPath = join(root, 'songs/opener/assets.yaml');
    writeFileSync(assetsPath, '# the good ones\n' + readFileSync(assetsPath, 'utf8'));
    await importAsset(root, 'opener', src, 'take-two');
    const text = readFileSync(assetsPath, 'utf8');
    expect(text).toContain('# the good ones');
    expect(text).toContain('take-two');
    expect((await check(root)).ok).toBe(true);
    rmSync(src);
  });
});

describe('check', () => {
  it('flags a track whose name does not match its filename', async () => {
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/opener/tracks/lead-vocal.yaml'),
      'name: other-name\ntype: audio\nclips: []\n',
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('must match filename');
  });

  it('flags clips referencing undeclared assets', async () => {
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/opener/tracks/vox.yaml'),
      [
        'name: vox',
        'type: audio',
        'clips:',
        '  - id: intro-vox-abc12',
        '    source: nonexistent',
        '    position: 0',
        '    duration: 960',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('unknown source');
  });

  it('diagnoses loop sources exhausted by their read offset — check, not a graph crash', async () => {
    createSong(root, 'opener');
    // A real one-second wav, so validate can learn its true frame count.
    const wavPath = join(root, '..', `field-test-loop-${Date.now()}.wav`);
    writeWavFloat32(wavPath, 48000, [new Float32Array(48000)]);
    await importAsset(root, 'opener', wavPath, 'hit');
    rmSync(wavPath);
    writeFileSync(
      join(root, 'songs/opener/tracks/vox.yaml'),
      [
        'name: vox',
        'type: audio',
        'clips:',
        '  - id: loop-vox-abc12',
        '    source: hit',
        '    position: 0',
        '    duration: 3840',
        '    loop:',
        '      enabled: true',
        '    source_offset: 48000',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain(
      'source content after its read offset',
    );
  });

  it('diagnoses loop fades that outgrow their slots', async () => {
    createSong(root, 'opener');
    const wavPath = join(root, '..', `field-test-slot-${Date.now()}.wav`);
    writeWavFloat32(wavPath, 48000, [new Float32Array(48000)]);
    await importAsset(root, 'opener', wavPath, 'hit');
    rmSync(wavPath);
    writeFileSync(
      join(root, 'songs/opener/tracks/vox.yaml'),
      [
        'name: vox',
        'type: audio',
        'clips:',
        '  - id: loop-vox-abc12',
        '    source: hit',
        '    position: 0',
        '    duration: 960',
        '    loop:',
        '      every: 30', // 750-sample slots at 120; the default 480+480 seam fades overlap
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('loop fades');
  });

  it('flags loops over targets without loop.every', async () => {
    createSong(root, 'opener');
    mkdirSync(join(root, 'songs/opener/sounds'), { recursive: true });
    writeFileSync(
      join(root, 'songs/opener/sounds/pad.yaml'),
      [
        'name: pad',
        'type: supercollider',
        'source: sc/pad.scd',
        'seed: 1',
        'duration: 2',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'songs/opener/tracks/pad.yaml'),
      [
        'name: pad',
        'type: audio',
        'clips:',
        '  - id: loop-pad-abc12',
        '    source: pad',
        '    position: 0',
        '    duration: 3840',
        '    loop:',
        '      enabled: true',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('set loop.every');
  });

  it('flags tampered asset content', async () => {
    createSong(root, 'opener');
    const src = sourceFile('original bytes');
    await importAsset(root, 'opener', src, 'take-one');
    writeFileSync(join(root, 'songs/opener/audio/take-one.wav'), 'tampered bytes');
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain(
      'does not match its recorded sha256',
    );
    rmSync(src);
  });

  it('flags a voice recipe whose reference recording is missing or drifted', async () => {
    // The hash has to be a *pin*, not a field. Both of these parsed fine
    // and left `field check` green (#58 review): the schema pairs
    // `voice_ref` with its sha, but nothing resolved the name or compared
    // the bytes, so the recording could be absent or swapped under a
    // recipe still claiming to describe it — which is exactly the
    // provenance guarantee §1.3 offers in place of a vendor's voice ID.
    createSong(root, 'opener');
    const src = sourceFile('reference recording');
    await importAsset(root, 'opener', src, 'ref-voice');
    rmSync(src);

    mkdirSync(join(root, 'songs/opener/sounds'), { recursive: true });
    const recipe = (lines: string[]) =>
      writeFileSync(
        join(root, 'songs/opener/sounds/line.yaml'),
        [
          'name: line',
          'type: generative',
          'model: chatterbox',
          'text: I walked the fence line',
          ...lines,
          'seed: 1',
          'variants:',
          '  - file: audio/line/1.wav',
          '    seed: 1',
          `    sha256: ${'a'.repeat(64)}`,
          'generated_at: 2026-08-07T12:00:00Z',
          '',
        ].join('\n'),
      );

    recipe([`voice_ref: ghost`, `voice_ref_sha256: ${'b'.repeat(64)}`]);
    const missing = await check(root);
    expect(missing.diagnostics.map((d) => d.message).join()).toContain(
      'voice_ref references unknown asset "ghost"',
    );

    recipe([`voice_ref: ref-voice`, `voice_ref_sha256: ${'b'.repeat(64)}`]);
    const drifted = await check(root);
    expect(drifted.diagnostics.map((d) => d.message).join()).toContain(
      'the reference recording changed under the recipe',
    );
  });

  it('scopes reference hashes to the song that owns the name', async () => {
    // Bare asset names are per-song, so two songs may each have a
    // `ref-voice` with different bytes. A single project-wide map lets
    // the second overwrite the first — false drift for one recipe and a
    // silent pass for the other, both from the same off-by-one-scope
    // (#58 review). Correctly pinned recipes in both songs must produce
    // no diagnostics at all.
    for (const [song, contents] of [
      ['opener', 'first reference'],
      ['closer', 'second reference'],
    ] as const) {
      createSong(root, song);
      const src = sourceFile(contents);
      await importAsset(root, song, src, 'ref-voice');
      rmSync(src);
    }

    const shaOf = (song: string): string => {
      const ledger = readFileSync(join(root, `songs/${song}/assets.yaml`), 'utf8');
      return /sha256:\s*([0-9a-f]{64})/.exec(ledger)![1]!;
    };
    // Different bytes must mean different hashes, or the test proves
    // nothing about scoping.
    expect(shaOf('opener')).not.toBe(shaOf('closer'));

    for (const song of ['opener', 'closer']) {
      mkdirSync(join(root, `songs/${song}/sounds`), { recursive: true });
      writeFileSync(
        join(root, `songs/${song}/sounds/line.yaml`),
        [
          'name: line',
          'type: generative',
          'model: chatterbox',
          'text: I walked the fence line',
          'voice_ref: ref-voice',
          `voice_ref_sha256: ${shaOf(song)}`,
          'seed: 1',
          'variants:',
          '  - file: audio/line/1.wav',
          '    seed: 1',
          `    sha256: ${'a'.repeat(64)}`,
          'generated_at: 2026-08-07T12:00:00Z',
          '',
        ].join('\n'),
      );
    }

    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).not.toContain('voice_ref');
  });

  it('accepts a voice recipe with no reference — the default voice', async () => {
    // The other half of the same rule: absent is legal and must stay so,
    // or bloom's current configuration becomes a diagnostic.
    createSong(root, 'opener');
    mkdirSync(join(root, 'songs/opener/sounds'), { recursive: true });
    writeFileSync(
      join(root, 'songs/opener/sounds/line.yaml'),
      [
        'name: line',
        'type: generative',
        'model: chatterbox',
        'text: I walked the fence line',
        'seed: 1',
        'variants:',
        '  - file: audio/line/1.wav',
        '    seed: 1',
        `    sha256: ${'a'.repeat(64)}`,
        'generated_at: 2026-08-07T12:00:00Z',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).not.toContain('voice_ref');
  });

  it('flags absolute and project-escaping asset file paths', async () => {
    createSong(root, 'opener');
    const entry = (file: string) =>
      [
        'assets:',
        '  - name: bad-asset',
        `    file: ${file}`,
        `    sha256: ${'a'.repeat(64)}`,
        '    bytes: 1',
        '',
      ].join('\n');
    const assetsPath = join(root, 'songs/opener/assets.yaml');

    writeFileSync(assetsPath, entry('/etc/hosts'));
    expect((await check(root)).diagnostics.map((d) => d.message).join()).toContain(
      'must be relative',
    );

    // An escaping path whose target exists: diagnosed once, never hashed.
    const outside = sourceFile('outside bytes');
    writeFileSync(assetsPath, entry(`../../../../${outside.split('/').pop()}`));
    const escaped = await check(root);
    const messages = escaped.diagnostics.map((d) => d.message);
    expect(messages.join()).toContain('escapes the project');
    expect(messages.join()).not.toContain('sha256');
    rmSync(outside);
  });

  it('diagnoses a directory asset path instead of crashing (EISDIR)', async () => {
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/opener/assets.yaml'),
      ['assets:', '  - name: oops', '    file: audio', `    sha256: ${'a'.repeat(64)}`, '    bytes: 1', ''].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('not a regular file');
  });

  it('flags a bytes field that disagrees with the file', async () => {
    createSong(root, 'opener');
    const src = sourceFile('twelve bytes');
    await importAsset(root, 'opener', src, 'sized');
    const assetsPath = join(root, 'songs/opener/assets.yaml');
    writeFileSync(assetsPath, readFileSync(assetsPath, 'utf8').replace(/bytes: \d+/, 'bytes: 999999'));
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('999999 recorded');
    rmSync(src);
  });

  it('flags meter changes off the bar boundary', async () => {
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/opener/tempo.yaml'),
      [
        'tempo:',
        '  - at: 0',
        '    bpm: 120',
        'meter:',
        '  - at: 0',
        '    numerator: 4',
        '    denominator: 4',
        '  - at: 100',
        '    numerator: 3',
        '    denominator: 4',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('bar boundary');
  });

  it('flags schema violations with paths', async () => {
    createSong(root, 'opener');
    writeFileSync(join(root, 'songs/opener/song.yaml'), 'name: opener\nbogus: true\n');
    const result = await check(root);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.file).toBe('songs/opener/song.yaml');
  });
});

describe('takes', () => {
  const takeYaml = (positionSamples: number) =>
    [
      'id: take-20260804-202355',
      'track: vox',
      'asset: take-audio',
      'anchor: musical',
      'position: 960',
      `position_samples: ${positionSamples}`,
      'duration_samples: 48000',
      '',
    ].join('\n');

  const setupTake = async (yaml: string, filename = 'take-20260804-202355.yaml') => {
    createSong(root, 'opener');
    createTrack(root, 'opener', 'vox', 'audio');
    const src = sourceFile();
    await importAsset(root, 'opener', src, 'take-audio');
    rmSync(src);
    mkdirSync(join(root, 'songs/opener/takes/vox'), { recursive: true });
    writeFileSync(join(root, 'songs/opener/takes/vox', filename), yaml);
  };

  it('accepts a take whose derived samples agree with the tempo map', async () => {
    // default song: 120 BPM at 48 kHz → 960 ticks = 1 beat = 0.5 s = 24000 samples
    await setupTake(takeYaml(24000));
    expect((await check(root)).ok).toBe(true);
  });

  it('flags position_samples that disagree with the tempo map (§3.1)', async () => {
    await setupTake(takeYaml(999999));
    const messages = (await check(root)).diagnostics.map((d) => d.message).join();
    expect(messages).toContain('disagrees with tempo map');
    expect(messages).toContain('24000');
  });

  it('flags id ≠ filename and track ≠ containing directory (§6)', async () => {
    await setupTake(takeYaml(24000), 'take-20260101-000000.yaml');
    const messages = (await check(root)).diagnostics.map((d) => d.message).join();
    expect(messages).toContain('must match filename');
  });

  it('flags takes referencing undeclared assets', async () => {
    await setupTake(takeYaml(24000).replace('take-audio', 'phantom'));
    const messages = (await check(root)).diagnostics.map((d) => d.message).join();
    expect(messages).toContain('unknown asset');
  });
});

describe('musical time (musical-time.md)', () => {
  // 4/4 at PPQ 960: a bar is 3840 ticks.
  const BAR = 3840;

  function writeMusicalSong() {
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/opener/song.yaml'),
      'name: opener\nlength: [12]\nloop: true\n',
    );
    writeFileSync(
      join(root, 'songs/opener/arrangement.yaml'),
      'sections:\n  - name: verse\n    at: [5]\n',
    );
    writeFileSync(
      join(root, 'songs/opener/tracks/keys.yaml'),
      [
        'name: keys',
        'type: audio',
        'clips:',
        '  - id: keys-1',
        '    source: hit',
        '    position: [2]',
        '    duration: [4]',
        '    loop:',
        '      every: [1]',
        '',
      ].join('\n'),
    );
  }

  async function importHit() {
    const src = sourceFile('pretend audio');
    await importAsset(root, 'opener', src, 'hit');
    rmSync(src);
  }

  it('resolves arrays to ticks at load — the graph never sees them', async () => {
    writeMusicalSong();
    await importHit();
    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);
    const song = project.songs[0]!;
    expect(song.song?.data.length).toBe(BAR * 12);
    expect(song.arrangement?.data.sections[0]!.at).toBe(BAR * 4);
    const clip = song.tracks[0]!.data.clips[0]!;
    expect(clip.position).toBe(BAR);
    expect(clip.duration).toBe(BAR * 4);
    expect(clip.loop?.every).toBe(BAR);
  });

  it('loads array and tick spellings to identical data', async () => {
    writeMusicalSong();
    await importHit();
    const musical = loadProject(root);

    const other = mkdtempSync(join(tmpdir(), 'field-test-ticks-'));
    try {
      init({ dir: other, name: 'test-album' });
      createSong(other, 'opener');
      writeFileSync(
        join(other, 'songs/opener/song.yaml'),
        `name: opener\nlength: ${BAR * 12}\nloop: true\n`,
      );
      writeFileSync(
        join(other, 'songs/opener/arrangement.yaml'),
        `sections:\n  - name: verse\n    at: ${BAR * 4}\n`,
      );
      writeFileSync(
        join(other, 'songs/opener/tracks/keys.yaml'),
        [
          'name: keys',
          'type: audio',
          'clips:',
          '  - id: keys-1',
          '    source: hit',
          `    position: ${BAR}`,
          `    duration: ${BAR * 4}`,
          '    loop:',
          `      every: ${BAR}`,
          '',
        ].join('\n'),
      );
      const src = sourceFile('pretend audio');
      await importAsset(other, 'opener', src, 'hit');
      rmSync(src);
      const ticks = loadProject(other);

      expect(musical.diagnostics).toEqual([]);
      expect(ticks.diagnostics).toEqual([]);
      expect(musical.songs[0]!.tracks[0]!.data).toEqual(ticks.songs[0]!.tracks[0]!.data);
      expect(musical.songs[0]!.song?.data).toEqual(ticks.songs[0]!.song?.data);
      expect(musical.songs[0]!.arrangement?.data).toEqual(ticks.songs[0]!.arrangement?.data);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('fmt keeps musical arrays single-line and never rewrites notation', async () => {
    writeMusicalSong();
    await importHit();
    fmt(root);
    const song = readFileSync(join(root, 'songs/opener/song.yaml'), 'utf8');
    expect(song).toContain('length: [12]');
    const track = readFileSync(join(root, 'songs/opener/tracks/keys.yaml'), 'utf8');
    expect(track).toContain('position: [2]');
    expect(track).toContain('every: [1]');
    expect((await check(root)).ok).toBe(true);
  });

  it('flags out-of-range beats through the meter map', async () => {
    writeMusicalSong();
    await importHit();
    writeFileSync(
      join(root, 'songs/opener/tracks/keys.yaml'),
      [
        'name: keys',
        'type: audio',
        'clips:',
        '  - id: keys-1',
        '    source: hit',
        '    position: [2, 5]',
        '    duration: [4]',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain(
      'beat 5 out of range for 4/4',
    );
  });

  it('flags musical arrays on absolute clips instead of unit-punning', async () => {
    writeMusicalSong();
    await importHit();
    writeFileSync(
      join(root, 'songs/opener/tracks/keys.yaml'),
      [
        'name: keys',
        'type: audio',
        'clips:',
        '  - id: keys-1',
        '    source: hit',
        '    anchor: absolute',
        '    position: [2]',
        '    duration: 960',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('anchor: musical');
  });

  it('flags spans that resolve to zero ticks', async () => {
    writeMusicalSong();
    await importHit();
    writeFileSync(
      join(root, 'songs/opener/tracks/keys.yaml'),
      [
        'name: keys',
        'type: audio',
        'clips:',
        '  - id: keys-1',
        '    source: hit',
        '    position: [2]',
        '    duration: [0]',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('resolves to zero ticks');
  });

  it('diagnoses musical time when the meter map itself is invalid', async () => {
    writeMusicalSong();
    await importHit();
    writeFileSync(
      join(root, 'songs/opener/tempo.yaml'),
      [
        'tempo:',
        '  - at: 0',
        '    bpm: 120',
        'meter:',
        '  - at: 0',
        '    numerator: 4',
        '    denominator: 4',
        '  - at: 2880', // off the bar boundary: the map will not construct
        '    numerator: 3',
        '    denominator: 4',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    const messages = result.diagnostics.map((d) => d.message).join();
    expect(messages).toContain('bar boundary');
    expect(messages).toContain('no valid meter map');
  });
});

describe('anchors and aliases', () => {
  it('rejects anchors and aliases in project files (§3.6)', async () => {
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/opener/tracks/vox.yaml'),
      'name: &n vox\ntype: audio\nclips: []\n',
    );
    const messages = (await check(root)).diagnostics.map((d) => d.message).join();
    expect(messages).toContain('anchors and aliases are not allowed');
  });
});

describe('fmt', () => {
  it('formats a track named "song" with track order, not song order', async () => {
    createSong(root, 'opener');
    createTrack(root, 'opener', 'song', 'audio');
    const path = join(root, 'songs/opener/tracks/song.yaml');
    writeFileSync(path, 'type: audio\nclips: []\nname: song\n');

    expect((await check(root)).unformatted).toEqual(['songs/opener/tracks/song.yaml']);
    expect(fmt(root).formatted).toEqual(['songs/opener/tracks/song.yaml']);
    expect((await check(root)).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('name: song\ntype: audio\nclips: []\n');
  });

  it('canonicalizes shuffled keys and preserves comments', async () => {
    createSong(root, 'opener');
    const path = join(root, 'songs/opener/tracks/vox.yaml');
    writeFileSync(path, '# my favorite track\ntype: audio\nclips: []\nname: vox\n');

    expect((await check(root)).unformatted).toEqual(['songs/opener/tracks/vox.yaml']);
    const result = fmt(root);
    expect(result.formatted).toEqual(['songs/opener/tracks/vox.yaml']);

    expect((await check(root)).ok).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# my favorite track');
    expect(text.indexOf('name:')).toBeLessThan(text.indexOf('type:'));
  });

  it('refuses to format an invalid project', () => {
    createSong(root, 'opener');
    writeFileSync(join(root, 'songs/opener/song.yaml'), 'name: 123\n');
    const result = fmt(root);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('placed tracks (nested-tracks.md §1.3)', () => {
  // A child worth placing, so every diagnosis below is about the
  // placement rather than about the child being empty.
  function writeInner(song = 'opener'): void {
    writeFileSync(
      join(root, `songs/${song}/tracks/inner.yaml`),
      [
        'name: inner',
        'type: audio',
        'clips:',
        '  - id: c1',
        '    source: hit',
        '    anchor: absolute',
        '    position: 0',
        '    duration: 4',
        '',
      ].join('\n'),
    );
  }

  function writeTrack(name: string, body: string[], song = 'opener'): void {
    writeFileSync(
      join(root, `songs/${song}/tracks/${name}.yaml`),
      [`name: ${name}`, 'type: audio', ...body, ''].join('\n'),
    );
  }

  const messages = async (): Promise<string> =>
    (await check(root)).diagnostics.map((d) => d.message).join('\n');

  beforeEach(async () => {
    createSong(root, 'opener');
    const wavPath = join(root, '..', `field-test-nest-${Date.now()}-${Math.random()}.wav`);
    writeWavFloat32(wavPath, 48000, [Float32Array.from([1, 0.5, 0.25, 0])]);
    await importAsset(root, 'opener', wavPath, 'hit');
    rmSync(wavPath);
    writeInner();
  });

  it('accepts a placement, forward reference and all', async () => {
    writeTrack('outer', ['inputs:', '  - track: inner', '    at: 0']);
    expect(await messages()).toBe('');
  });

  it('names an unknown track', async () => {
    writeTrack('outer', ['inputs:', '  - track: ghost', '    at: 0']);
    expect(await messages()).toContain('placement 1 ("ghost") references unknown track "ghost"');
  });

  it('names a track placed inside itself, rather than reporting a cycle', async () => {
    writeTrack('outer', ['inputs:', '  - track: outer', '    at: 0']);
    const out = await messages();
    expect(out).toContain('placement 1 ("outer") places this track inside itself');
    expect(out).not.toContain('cycle');
  });

  it('names a containment cycle before the build walker can trip on it', async () => {
    writeTrack('a', ['inputs:', '  - track: b', '    at: 0']);
    writeTrack('b', ['inputs:', '  - track: a', '    at: 0']);
    expect(await messages()).toContain('track containment cycle: a → b → a');
  });

  it('refuses a placed track with nothing in it', async () => {
    writeTrack('empty', ['clips: []']);
    writeTrack('outer', ['inputs:', '  - track: empty', '    at: 0']);
    expect(await messages()).toContain(
      'placement 1 ("empty") places a track with no clips and no tracks of its own',
    );
  });

  it('refuses a placed midi track, and a midi track that places', async () => {
    writeFileSync(
      join(root, 'songs/opener/tracks/keys.yaml'),
      'name: keys\ntype: midi\nclips: []\n',
    );
    writeTrack('outer', ['inputs:', '  - track: keys', '    at: 0']);
    expect(await messages()).toContain('places a midi track, which renders no audio');

    writeFileSync(
      join(root, 'songs/opener/tracks/keys.yaml'),
      'name: keys\ntype: midi\ninputs:\n  - track: inner\n    at: 0\n',
    );
    expect(await messages()).toContain('a midi track cannot place tracks');
  });

  it('refuses a child whose fader is set, pointing at the placement that replaces it', async () => {
    writeFileSync(
      join(root, 'songs/opener/tracks/inner.yaml'),
      readFileSync(join(root, 'songs/opener/tracks/inner.yaml'), 'utf8').replace(
        'type: audio\n',
        'type: audio\ngain_db: -3\n',
      ),
    );
    writeTrack('outer', ['inputs:', '  - track: inner', '    at: 0']);
    const out = await messages();
    expect(out).toContain('places a track with a fader set (gain_db -3, pan 0)');
    // The field is retiring, not pending: the message must say where the
    // level goes, not which chunk to wait for (nested-tracks.md §1.13).
    expect(out).toContain("move them to this placement's gain_db and pan");
    expect(out).not.toContain('chunk');
  });

  it('refuses musical time on an absolute placement', async () => {
    writeTrack('outer', ['inputs:', '  - track: inner', '    anchor: absolute', '    at: [5]']);
    expect(await messages()).toContain('musical arrays need anchor: musical');
  });

  it('resolves a musical placement through the meter map', async () => {
    writeTrack('outer', ['inputs:', '  - track: inner', '    at: [5]']);
    expect(await messages()).toBe('');
  });

  it('catches fades that outgrow a declared window, and holds off without one', async () => {
    writeTrack('outer', [
      'inputs:',
      '  - track: inner',
      '    anchor: absolute',
      '    at: 0',
      '    duration: 100',
      '    fade_in: 80',
      '    fade_out: 80',
    ]);
    expect(await messages()).toContain('fades (80 + 80 samples) exceed its 100-sample window');

    // No declared window, nothing to measure against until the child
    // renders — the daemon is the backstop, so check stays quiet.
    writeTrack('outer', [
      'inputs:',
      '  - track: inner',
      '    anchor: absolute',
      '    at: 0',
      '    fade_in: 80',
      '    fade_out: 80',
    ]);
    expect(await messages()).toBe('');
  });

  it('lets a mix reference a track that only contains tracks', async () => {
    writeTrack('outer', ['inputs:', '  - track: inner', '    at: 0']);
    mkdirSync(join(root, 'songs/opener/mixes'), { recursive: true });
    writeFileSync(
      join(root, 'songs/opener/mixes/main.yaml'),
      'name: main\ntracks:\n  - outer\n',
    );
    expect(await messages()).toBe('');
  });
});

describe("a song's output (nested-tracks.md §7 chunk 2)", () => {
  beforeEach(async () => {
    createSong(root, 'opener');
    const wavPath = join(root, '..', `field-out-${Date.now()}-${Math.random()}.wav`);
    writeWavFloat32(wavPath, 48000, [Float32Array.from([1, 0.5, 0.25, 0])]);
    await importAsset(root, 'opener', wavPath, 'hit');
    rmSync(wavPath);
    writeFileSync(
      join(root, 'songs/opener/tracks/verse.yaml'),
      'name: verse\ntype: audio\nclips:\n  - id: c\n    source: hit\n    anchor: absolute\n    position: 0\n    duration: 4\n',
    );
  });

  const messages = async (): Promise<string> =>
    (await check(root)).diagnostics.map((d) => d.message).join('\n');

  function writeOutputTrack(): void {
    writeFileSync(
      join(root, 'songs/opener/tracks/main.yaml'),
      'name: main\ntype: audio\ninputs:\n  - track: verse\n    at: 0\n',
    );
  }

  it('refuses a song with both an output track and an output mix', async () => {
    // createSong scaffolds mixes/main.yaml, so adding the track is all it
    // takes — which is the migration's first step, and the point.
    expect(existsSync(join(root, 'songs/opener/mixes/main.yaml'))).toBe(true);
    writeOutputTrack();
    const out = await messages();
    expect(out).toContain('song has two outputs');
    expect(out).toContain('delete one');
  });

  it('accepts the output track once the mix is gone', async () => {
    writeOutputTrack();
    rmSync(join(root, 'songs/opener/mixes'), { recursive: true });
    expect(await messages()).toBe('');
  });

  it('says nothing about a song that still has only a mix', async () => {
    expect(await messages()).toBe('');
  });

  it('says nothing about a midi or empty track named main', async () => {
    // Only a renderable track ever claims the song's extent, so neither of
    // these is a second output — claiming they carry the length would be
    // false about tracks the graph never builds a stem for.
    writeFileSync(
      join(root, 'songs/opener/tracks/main.yaml'),
      'name: main\ntype: midi\nclips: []\n',
    );
    expect(await messages()).toBe('');

    writeFileSync(
      join(root, 'songs/opener/tracks/main.yaml'),
      'name: main\ntype: audio\nclips: []\n',
    );
    expect(await messages()).toBe('');
  });

  it('says nothing about a non-output track sharing the song with a mix', async () => {
    writeFileSync(
      join(root, 'songs/opener/tracks/bridge.yaml'),
      'name: bridge\ntype: audio\ninputs:\n  - track: verse\n    at: 0\n',
    );
    expect(await messages()).toBe('');
  });
});
