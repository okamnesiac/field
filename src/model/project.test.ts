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
    createTrack(root, 'opener', 'lead-vocal');
    expect((await check(root)).ok).toBe(true);

    const project = loadProject(root);
    expect(project.songs).toHaveLength(1);
    expect(project.songs[0]!.tracks[0]!.data.name).toBe('lead-vocal');
  });

  it('rejects non-slug names', () => {
    expect(() => createSong(root, 'My Song')).toThrow('slug');
    createSong(root, 'opener');
    expect(() => createTrack(root, 'opener', 'Lead_Vocal')).toThrow('slug');
  });

  it('rejects tracks in missing songs', () => {
    expect(() => createTrack(root, 'nope', 'lead-vocal')).toThrow('does not exist');
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
    createTrack(root, 'opener', 'lead-vocal');
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
    // The scaffolded output track plus lead-vocal — and not the dotfile,
    // which is what this is about.
    const names = loadProject(root).songs[0]!.tracks.map((t) => t.data.name).sort();
    expect(names).toEqual(['lead-vocal', 'main']);
  });
});

describe('import', () => {
  it('copies the file, records name + sha256 + size, and passes check', async () => {
    createSong(root, 'opener');
    const src = sourceFile('hello audio');
    const result = await importAsset(root, 'opener', src, 'first-take');

    expect(result.file).toBe('audio/first-take/first-take.wav');
    expect(result.sha256).toBe(sha256Text('hello audio'));
    expect(existsSync(join(root, 'songs/opener/audio/first-take/first-take.wav'))).toBe(true);
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
    // Hand-rename the entry's name; its file still references the kick item.
    const assetsPath = join(root, 'songs/opener/assets.yaml');
    writeFileSync(assetsPath, readFileSync(assetsPath, 'utf8').replace('name: kick', 'name: kick-alt'));
    expect((await check(root)).ok).toBe(true);

    const other = sourceFile('other bytes');
    await expect(importAsset(root, 'opener', other, 'kick')).rejects.toThrow(
      'already belongs to a declared asset',
    );
    expect(readFileSync(join(root, 'songs/opener/audio/kick/kick.wav'), 'utf8')).toBe('kick bytes');
    expect((await check(root)).ok).toBe(true);
    rmSync(src);
    rmSync(other);
  });

  it('blocks the overwrite even when the declared file is spelled oddly', async () => {
    createSong(root, 'opener');
    const src = sourceFile('kick bytes');
    await importAsset(root, 'opener', src, 'kick');
    const assetsPath = join(root, 'songs/opener/assets.yaml');
    // "./audio/kick/kick.wav" resolves identically and passes check; the
    // guard must compare resolved paths, not strings.
    writeFileSync(
      assetsPath,
      readFileSync(assetsPath, 'utf8')
        .replace('name: kick', 'name: kick-alt')
        .replace('file: audio/kick/kick.wav', 'file: ./audio/kick/kick.wav'),
    );
    const other = sourceFile('other bytes');
    await expect(importAsset(root, 'opener', other, 'kick')).rejects.toThrow(
      'already belongs to a declared asset',
    );
    expect(readFileSync(join(root, 'songs/opener/audio/kick/kick.wav'), 'utf8')).toBe('kick bytes');
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
    expect(result.file).toBe('audio/first/first.wav');
    rmSync(src);
  });

  it('reads a flat pre-rule ledger path as declared (project-layout.md §4.11)', async () => {
    // A ledger written before every-item-is-a-directory: bytes at a
    // flat path, declared by hand. Every other ledger in this suite is
    // written by importAsset and so wears the new shape — without this
    // one, a future rule deriving the expected path from the item name
    // would break existing projects while the whole suite stayed green.
    createSong(root, 'opener');
    mkdirSync(join(root, 'songs/opener/audio'), { recursive: true });
    writeFileSync(join(root, 'songs/opener/audio/legacy.wav'), 'legacy bytes');
    writeFileSync(
      join(root, 'songs/opener/assets.yaml'),
      'assets:\n  - name: legacy\n    file: audio/legacy.wav\n' +
        `    sha256: ${sha256Text('legacy bytes')}\n    bytes: 12\n`,
    );
    expect((await check(root)).ok).toBe(true);
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
      'name: other-name\n',
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
        'inputs:',
        '  - id: intro-vox-abc12',
        '    sound: nonexistent',
        '    at: 0',
        '    duration: 960',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('unknown sound');
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
        'inputs:',
        '  - id: loop-vox-abc12',
        '    audio: hit',
        '    at: 0',
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
        'inputs:',
        '  - id: loop-vox-abc12',
        '    audio: hit',
        '    at: 0',
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
        'inputs:',
        '  - id: loop-pad-abc12',
        '    sound: pad',
        '    at: 0',
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
    writeFileSync(join(root, 'songs/opener/audio/take-one/take-one.wav'), 'tampered bytes');
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
          'text: I walked the fence line',
          ...lines,
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
          'text: I walked the fence line',
          'voice_ref: ref-voice',
          `voice_ref_sha256: ${shaOf(song)}`,
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
        'text: I walked the fence line',
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
    createTrack(root, 'opener', 'vox');
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
      join(root, 'songs/opener/tracks/keys.yaml'),
      [
        'name: keys',
        'inputs:',
        '  - id: keys-1',
        '    audio: hit',
        '    at: [2]',
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
    const entry = song.tracks[0]!.data.inputs[0]!;
    expect(entry.at).toBe(BAR);
    expect(entry.duration).toBe(BAR * 4);
    expect(entry.loop?.every).toBe(BAR);
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
        join(other, 'songs/opener/tracks/keys.yaml'),
        [
          'name: keys',
          'inputs:',
          '  - id: keys-1',
          '    audio: hit',
          `    at: ${BAR}`,
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
    expect(track).toContain('at: [2]');
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
        'inputs:',
        '  - id: keys-1',
        '    audio: hit',
        '    at: [2, 5]',
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
        'inputs:',
        '  - id: keys-1',
        '    audio: hit',
        '    anchor: absolute',
        '    at: [2]',
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
        'inputs:',
        '  - id: keys-1',
        '    audio: hit',
        '    at: [2]',
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
      'name: &n vox\n',
    );
    const messages = (await check(root)).diagnostics.map((d) => d.message).join();
    expect(messages).toContain('anchors and aliases are not allowed');
  });
});

describe('fmt', () => {
  it('formats a track named "song" with track order, not song order', async () => {
    createSong(root, 'opener');
    createTrack(root, 'opener', 'song');
    const path = join(root, 'songs/opener/tracks/song.yaml');
    writeFileSync(path, 'inputs: []\nname: song\n');

    expect((await check(root)).unformatted).toEqual(['songs/opener/tracks/song.yaml']);
    expect(fmt(root).formatted).toEqual(['songs/opener/tracks/song.yaml']);
    expect((await check(root)).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('name: song\ninputs: []\n');
  });

  it('canonicalizes shuffled keys and preserves comments', async () => {
    createSong(root, 'opener');
    const path = join(root, 'songs/opener/tracks/vox.yaml');
    writeFileSync(path, '# my favorite track\ninputs: []\nname: vox\n');

    expect((await check(root)).unformatted).toEqual(['songs/opener/tracks/vox.yaml']);
    const result = fmt(root);
    expect(result.formatted).toEqual(['songs/opener/tracks/vox.yaml']);

    expect((await check(root)).ok).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# my favorite track');
    expect(text.indexOf('name:')).toBeLessThan(text.indexOf('inputs:'));
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
        'inputs:',
        '  - id: c1',
        '    audio: hit',
        '    anchor: absolute',
        '    at: 0',
        '    duration: 4',
        '',
      ].join('\n'),
    );
  }

  function writeTrack(name: string, body: string[], song = 'opener'): void {
    writeFileSync(
      join(root, `songs/${song}/tracks/${name}.yaml`),
      [`name: ${name}`, ...body, ''].join('\n'),
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
    expect(await messages()).toContain('input 1 ("ghost") references unknown track "ghost"');
  });

  it('names a track placed inside itself, rather than reporting a cycle', async () => {
    writeTrack('outer', ['inputs:', '  - track: outer', '    at: 0']);
    const out = await messages();
    expect(out).toContain('input 1 ("outer") places this track inside itself');
    expect(out).not.toContain('cycle');
  });

  it('names a containment cycle before the build walker can trip on it', async () => {
    writeTrack('a', ['inputs:', '  - track: b', '    at: 0']);
    writeTrack('b', ['inputs:', '  - track: a', '    at: 0']);
    expect(await messages()).toContain('track containment cycle: a → b → a');
  });

  it('accepts a placed track with nothing in it — silence is content', async () => {
    // An empty audio track renders as silence (stem.ts renderableTrack),
    // so placing one places silence rather than dangling an edge. This was
    // an error until a song's output became a track that starts empty.
    writeTrack('empty', ['inputs: []']);
    writeTrack('outer', ['inputs:', '  - track: empty', '    at: 0']);
    expect(await messages()).toBe('');
  });

  it('has no track-level fader to refuse: the field retired with the mix', async () => {
    // A level lives on the placement (nested-tracks.md §1.13). `gain_db`
    // on a track file used to be applied by the mix rule and then, for one
    // commit, by nothing at all — accepted, silent, and unread. The schema
    // refuses it now rather than letting it sit there meaning nothing.
    writeFileSync(
      join(root, 'songs/opener/tracks/inner.yaml'),
      readFileSync(join(root, 'songs/opener/tracks/inner.yaml'), 'utf8').replace(
        'name: inner\n',
        'name: inner\ngain_db: -3\n',
      ),
    );
    // Not "Unrecognized key": a removal without a forwarding address is
    // the failure this retirement fixes everywhere else — mixes/ names what
    // to move, mix.yaml is repointed, mix: suggests track:.
    expect(await messages()).toContain('a level lives on the placement that consumes this track');
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

});

describe('input entries with ids (nested-tracks.md §18)', () => {
  // One list: an entry that places a track carries the same checks the
  // placement always had, plus an optional id — and the id, not the
  // entry's kind, is how it is named in diagnostics.
  function writeTrack(name: string, body: string[]): void {
    writeFileSync(
      join(root, `songs/opener/tracks/${name}.yaml`),
      [`name: ${name}`, ...body, ''].join('\n'),
    );
  }

  const messages = async (): Promise<string> =>
    (await check(root)).diagnostics.map((d) => d.message).join('\n');

  beforeEach(async () => {
    createSong(root, 'opener');
    const wavPath = join(root, '..', `field-test-clip-${Date.now()}-${Math.random()}.wav`);
    writeWavFloat32(wavPath, 48000, [Float32Array.from([1, 0.5, 0.25, 0])]);
    await importAsset(root, 'opener', wavPath, 'hit');
    rmSync(wavPath);
    writeTrack('inner', [
      'inputs:',
      '  - id: c1',
      '    audio: hit',
      '    anchor: absolute',
      '    at: 0',
      '    duration: 4',
    ]);
  });

  it('accepts a track entry with an id and a window, forward reference and all', async () => {
    writeTrack('outer', [
      'inputs:',
      '  - id: k1',
      '    track: inner',
      '    at: 0',
    ]);
    expect(await messages()).toBe('');
  });

  it('names an unknown track by the entry id when there is one', async () => {
    writeTrack('outer', ['inputs:', '  - id: k1', '    track: ghost', '    at: 0']);
    expect(await messages()).toContain('input "k1" references unknown track "ghost"');
  });

  it('does not fall back to the song namespace: track: means a track', async () => {
    // `hit` exists as an asset; `track: hit` must not find it. The kind
    // lives in the field name (§18), and no field is a search path over
    // namespaces (project-core.md §3.4).
    writeTrack('outer', ['inputs:', '  - id: k1', '    track: hit', '    at: 0']);
    expect(await messages()).toContain('input "k1" references unknown track "hit"');
  });

  it('names an entry that plays two kinds at once', async () => {
    writeTrack('outer', [
      'inputs:',
      '  - id: k1',
      '    track: inner',
      '    audio: hit',
      '    at: 0',
    ]);
    expect(await messages()).toContain('an entry plays exactly one thing');
  });

  it('audio: refuses a name that renders, pointing at sound:', async () => {
    mkdirSync(join(root, 'songs/opener/sounds'), { recursive: true });
    writeFileSync(
      join(root, 'songs/opener/sounds/pad.yaml'),
      'name: pad\ntype: supercollider\nsource: pad.scd\nseed: 1\nduration: 2\n',
    );
    writeFileSync(join(root, 'shared/instruments/pad.scd'), 'Out.ar(0, Silent.ar(2));\n');
    writeTrack('outer', ['inputs:', '  - id: k1', '    audio: pad', '    at: 0']);
    expect(await messages()).toContain('audio: names the sound "pad"');
    // And the reverse: sound: refuses committed bytes, pointing back.
    writeTrack('outer', ['inputs:', '  - id: k2', '    sound: hit', '    at: 0']);
    expect(await messages()).toContain('sound: names the asset "hit"');
  });

  it('refuses a duplicate id, and accepts entries with no id at all', async () => {
    writeTrack('outer', [
      'inputs:',
      '  - id: k1',
      '    track: inner',
      '    at: 0',
      '  - id: k1',
      '    audio: hit',
      '    at: 0',
      '  - track: inner',
      '    at: 0',
    ]);
    expect(await messages()).toContain('duplicate input id "k1"');
  });

  it('names a track placed inside itself, rather than reporting a cycle', async () => {
    writeTrack('outer', ['inputs:', '  - id: k1', '    track: outer', '    at: 0']);
    const out = await messages();
    expect(out).toContain('input "k1" places this track inside itself');
    expect(out).not.toContain('cycle');
  });

  it('an id-carrying entry closes a containment cycle like any placement', async () => {
    writeTrack('a', ['inputs:', '  - id: k1', '    track: b', '    at: 0']);
    writeTrack('b', ['inputs:', '  - track: a', '    at: 0']);
    expect(await messages()).toContain('track containment cycle: a → b → a');
  });

  it('type: is retired with a forwarding message, not an unrecognized-key shrug', async () => {
    // `midi` was the one kind that rendered nothing; §18 retires the
    // field and the message says where kinds went.
    writeFileSync(
      join(root, 'songs/opener/tracks/scratch.yaml'),
      'name: scratch\ntype: midi\ninputs: []\n',
    );
    expect(await messages()).toContain('every track is audio — delete type:');
  });

  it('clips: is retired with a forwarding message naming the field moves', async () => {
    writeFileSync(
      join(root, 'songs/opener/tracks/scratch.yaml'),
      'name: scratch\nclips:\n  - id: k1\n    source: hit\n    position: 0\n',
    );
    expect(await messages()).toContain('clips: merged into inputs:');
  });

  it('a loop on a track still needs every — its length is unknown before it builds', async () => {
    writeTrack('outer', [
      'inputs:',
      '  - id: k1',
      '    track: inner',
      '    anchor: absolute',
      '    at: 0',
      '    duration: 8',
      '    loop:',
      '      fade: 0',
    ]);
    expect(await messages()).toContain(
      'input "k1" loops a track — set loop.every',
    );
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
      'name: verse\ninputs:\n  - id: c\n    audio: hit\n    anchor: absolute\n    at: 0\n    duration: 4\n',
    );
  });

  const messages = async (): Promise<string> =>
    (await check(root)).diagnostics.map((d) => d.message).join('\n');

  function writeOutputTrack(): void {
    writeFileSync(
      join(root, 'songs/opener/tracks/main.yaml'),
      'name: main\ninputs:\n  - track: verse\n    at: 0\n',
    );
  }


  it('accepts the output track alone', async () => {
    writeOutputTrack();
    expect(await messages()).toBe('');
  });


  it('says nothing about an empty track named main', async () => {
    // An empty output renders as the silence it contains and still
    // carries the song's extent — starting empty is exactly how `field
    // song create` writes it.
    writeFileSync(
      join(root, 'songs/opener/tracks/main.yaml'),
      'name: main\n',
    );
    expect(await messages()).toBe('');
  });

  it('says nothing about a non-output track sharing the song with a mix', async () => {
    writeFileSync(
      join(root, 'songs/opener/tracks/bridge.yaml'),
      'name: bridge\ninputs:\n  - track: verse\n    at: 0\n',
    );
    expect(await messages()).toBe('');
  });
});

describe('generative entries (nested-tracks.md §18 step 3)', () => {
  // The deliberate kind inline: the request lives in the entry, the
  // run-recorded state beside the audio under the gen node's name —
  // audio/<name>/variants.yaml with `gen: <name>`.
  function writeLeaf(body?: string[]): void {
    writeFileSync(
      join(root, 'songs/opener/tracks/rain-pad.yaml'),
      (
        body ?? [
          'name: rain-pad',
          'inputs:',
          '  - generative:',
          '      prompt: soft rain over a warm pad',
          '      bpm: 96',
          '      duration_seconds: 10',
        ]
      )
        .concat('')
        .join('\n'),
    );
  }

  function writeTakes(
    name: string,
    contents: string[],
    opts: { key?: string; keyName?: string; chosen?: number } = {},
  ): void {
    mkdirSync(join(root, `songs/opener/audio/${name}`), { recursive: true });
    const rows = contents.map((content, i) => {
      writeFileSync(join(root, `songs/opener/audio/${name}/${i + 1}.wav`), content);
      return (
        `  - file: audio/${name}/${i + 1}.wav\n    model: acestep-v15-turbo\n` +
        `    seed: ${90210 + i}\n    sha256: ${sha256Text(content)}\n` +
        `    generated_at: 2026-08-05T21:00:00.000Z\n`
      );
    });
    writeFileSync(
      join(root, `songs/opener/audio/${name}/variants.yaml`),
      `${opts.key ?? 'gen'}: ${opts.keyName ?? name}\n` +
        (opts.chosen !== undefined ? `chosen: ${opts.chosen}\n` : '') +
        `variants:\n${rows.join('')}`,
    );
  }

  const messages = async (): Promise<string> =>
    (await check(root)).diagnostics.map((d) => d.message).join('\n');

  beforeEach(() => {
    createSong(root, 'opener');
  });

  it('a request with no takes is legal — the shape a project ships in', async () => {
    writeLeaf();
    expect(await messages()).toBe('');
  });

  it('stitches takes in by gen node name', async () => {
    writeLeaf();
    writeTakes('rain-pad', ['take one', 'take two'], { chosen: 1 });
    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);
    const takes = project.songs[0]!.genTakes.get('rain-pad')!.data;
    expect(takes.variants).toHaveLength(2);
    expect(takes.chosen).toBe(1);
  });

  it('an id keys the takes under <track>-<id>', async () => {
    writeLeaf([
      'name: rain-pad',
      'inputs:',
      '  - id: alt',
      '    generative:',
      '      prompt: soft rain over a warm pad',
      '      bpm: 96',
      '      duration_seconds: 10',
    ]);
    writeTakes('rain-pad-alt', ['take one'], { chosen: 1 });
    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);
    expect(project.songs[0]!.genTakes.get('rain-pad-alt')).toBeDefined();
  });

  it('takes with nothing chosen say choose', async () => {
    writeLeaf();
    writeTakes('rain-pad', ['take one']);
    expect(await messages()).toContain(
      'has takes but no chosen variant yet — field choose rain-pad first',
    );
  });

  it('a sound-keyed takes file is told the move', async () => {
    writeLeaf();
    writeTakes('rain-pad', ['take one'], { key: 'sound', chosen: 1 });
    expect(await messages()).toContain('rename sound: to gen: (nested-tracks.md §18)');
  });

  it('takes must match their directory', async () => {
    writeLeaf();
    writeTakes('rain-pad', ['take one'], { keyName: 'other-name', chosen: 1 });
    expect(await messages()).toContain(
      'takes name "other-name" must match the directory audio/rain-pad/',
    );
  });

  it('chosen must name a take that exists', async () => {
    writeLeaf();
    writeTakes('rain-pad', ['take one'], { chosen: 5 });
    expect(await messages()).toContain('chosen variant 5 does not exist (1 variants)');
  });

  it('a voice entry needs a committed reference recording', async () => {
    writeLeaf([
      'name: rain-pad',
      'inputs:',
      '  - generative:',
      '      text: down to the creek',
      '      voice_ref: ghost',
      '      voice_ref_sha256: ' + sha256Text('anything'),
    ]);
    expect(await messages()).toContain(
      'voice_ref references unknown asset "ghost" — a reference recording is a committed asset',
    );
  });

  it('a chimera recipe is refused at the entry', async () => {
    writeLeaf([
      'name: rain-pad',
      'inputs:',
      '  - generative:',
      '      prompt: rain',
      '      text: down to the creek',
      '      bpm: 96',
      '      duration_seconds: 10',
    ]);
    expect(await messages()).toContain(
      'a recipe carries either `prompt` (music) or `text` (voice), not both',
    );
  });

  it('generative and supercollider entries share the gen namespace', async () => {
    // Both kinds mint gen nodes, so two un-id'd generators in one track
    // collide across kinds — the check reads one namespace, not two.
    writeLeaf([
      'name: rain-pad',
      'inputs:',
      '  - generative:',
      '      prompt: soft rain over a warm pad',
      '      bpm: 96',
      '      duration_seconds: 10',
      '  - supercollider:',
      '      source: kit.scd',
      '      seed: 1',
      '      duration: 2',
    ]);
    expect(await messages()).toContain(
      'give each an id so its render has a name of its own',
    );
  });
});

describe('one audio/ directory per name (nested-tracks.md §18 step 3)', () => {
  beforeEach(() => {
    createSong(root, 'opener');
  });

  const genLeaf =
    'name: rain-pad\ninputs:\n  - generative:\n      prompt: rain\n      bpm: 96\n      duration_seconds: 10\n';

  it('a generative entry may not mint a name a sound holds', async () => {
    writeFileSync(join(root, 'songs/opener/tracks/rain-pad.yaml'), genLeaf);
    mkdirSync(join(root, 'songs/opener/sounds'), { recursive: true });
    writeFileSync(
      join(root, 'songs/opener/sounds/rain-pad.yaml'),
      'name: rain-pad\ntype: generative\nprompt: rain\nbpm: 96\nduration_seconds: 10\n',
    );
    const messages = (await check(root)).diagnostics.map((d) => d.message).join('\n');
    expect(messages).toContain('which sounds/rain-pad.yaml also holds — both claim audio/rain-pad/');
  });

  it('a generative entry may not mint a name an asset holds', async () => {
    writeFileSync(join(root, 'songs/opener/tracks/rain-pad.yaml'), genLeaf);
    const src = sourceFile();
    await importAsset(root, 'opener', src, 'other');
    // Renamed by hand so the pre-flight cannot refuse it first — this is
    // the check that catches what import could not have seen.
    const assetsPath = join(root, 'songs/opener/assets.yaml');
    writeFileSync(
      assetsPath,
      readFileSync(assetsPath, 'utf8').replaceAll('other', 'rain-pad'),
    );
    const messages = (await check(root)).diagnostics.map((d) => d.message).join('\n');
    expect(messages).toContain('which the asset "rain-pad" also holds');
    rmSync(src);
  });

  it('import pre-flights against gen node names', async () => {
    writeFileSync(join(root, 'songs/opener/tracks/rain-pad.yaml'), genLeaf);
    const src = sourceFile();
    await expect(importAsset(root, 'opener', src, 'rain-pad')).rejects.toThrow(
      'already a sound, a generator, or an audition label',
    );
    rmSync(src);
  });
});

describe('generative-entry takes carry the same pins a sound\'s do', () => {
  // The three verification passes sounds get — variant hashes, the
  // voice_ref pin, fmt coverage — reach entry takes too. Each test here
  // fails if its pass reads song.sounds only.
  beforeEach(() => {
    createSong(root, 'opener');
  });

  function writeLeafWithTakes(): void {
    writeFileSync(
      join(root, 'songs/opener/tracks/rain-pad.yaml'),
      'name: rain-pad\ninputs:\n  - generative:\n      prompt: rain\n      bpm: 96\n      duration_seconds: 10\n',
    );
    mkdirSync(join(root, 'songs/opener/audio/rain-pad'), { recursive: true });
    writeFileSync(join(root, 'songs/opener/audio/rain-pad/1.wav'), 'take one');
    writeFileSync(
      join(root, 'songs/opener/audio/rain-pad/variants.yaml'),
      'gen: rain-pad\nchosen: 1\nvariants:\n' +
        '  - file: audio/rain-pad/1.wav\n    model: acestep-v15-turbo\n    seed: 7\n' +
        `    sha256: ${sha256Text('take one')}\n    generated_at: 2026-08-05T21:00:00.000Z\n`,
    );
  }

  it('flags a tampered take', async () => {
    writeLeafWithTakes();
    expect((await check(root)).diagnostics).toEqual([]);
    writeFileSync(join(root, 'songs/opener/audio/rain-pad/1.wav'), 'tampered');
    const messages = (await check(root)).diagnostics.map((d) => d.message).join('\n');
    expect(messages).toContain(
      'variant "audio/rain-pad/1.wav" content does not match its recorded sha256',
    );
  });

  it('flags a voice reference that changed under the entry', async () => {
    const src = sourceFile('a voice recording');
    await importAsset(root, 'opener', src, 'ref-voice');
    rmSync(src);
    writeFileSync(
      join(root, 'songs/opener/tracks/spoken.yaml'),
      'name: spoken\ninputs:\n  - generative:\n      text: down to the creek\n' +
        `      voice_ref: ref-voice\n      voice_ref_sha256: ${sha256Text('some other recording')}\n`,
    );
    const messages = (await check(root)).diagnostics.map((d) => d.message).join('\n');
    expect(messages).toContain('the reference recording changed under the request');
  });

  it('fmt sees a noncanonical takes file', async () => {
    writeLeafWithTakes();
    // chosen: after variants: is valid YAML in the wrong canonical order.
    const takesPath = join(root, 'songs/opener/audio/rain-pad/variants.yaml');
    const raw = readFileSync(takesPath, 'utf8');
    writeFileSync(takesPath, raw.replace('gen: rain-pad\nchosen: 1\n', 'chosen: 1\ngen: rain-pad\n'));
    const result = await check(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.unformatted).toContain('songs/opener/audio/rain-pad/variants.yaml');
  });
});

describe('orphaned takes directories (nested-tracks.md §18 decision 3)', () => {
  // Nothing else opens audio/, so a rename silently strands its takes —
  // model-minutes of them — while check stays green. The scan names the
  // leftover on both sides, which is the parity the decision 3
  // amendment claims.
  beforeEach(() => {
    createSong(root, 'opener');
  });

  function writeOrphanTakes(dir: string, key: string): void {
    mkdirSync(join(root, `songs/opener/audio/${dir}`), { recursive: true });
    writeFileSync(join(root, `songs/opener/audio/${dir}/1.wav`), 'stranded take');
    writeFileSync(
      join(root, `songs/opener/audio/${dir}/variants.yaml`),
      `${key}: ${dir}\nchosen: 1\nvariants:\n` +
        `  - file: audio/${dir}/1.wav\n    model: acestep-v15-turbo\n    seed: 7\n` +
        `    sha256: ${sha256Text('stranded take')}\n    generated_at: 2026-08-05T21:00:00.000Z\n`,
    );
  }

  it('flags a gen-keyed takes file nothing mints', async () => {
    writeOrphanTakes('ghost', 'gen');
    const messages = (await check(root)).diagnostics.map((d) => d.message).join('\n');
    expect(messages).toContain('no generative request claims audio/ghost/');
  });

  it('flags a sound-keyed takes file nothing defines', async () => {
    writeOrphanTakes('ghost', 'sound');
    const messages = (await check(root)).diagnostics.map((d) => d.message).join('\n');
    expect(messages).toContain('no generative request claims audio/ghost/');
  });

  it('a pre-fold file under a live name gets the rename diagnostic alone', async () => {
    writeFileSync(
      join(root, 'songs/opener/tracks/ghost.yaml'),
      'name: ghost\ninputs:\n  - generative:\n      prompt: rain\n      bpm: 96\n      duration_seconds: 10\n',
    );
    writeOrphanTakes('ghost', 'sound');
    const messages = (await check(root)).diagnostics.map((d) => d.message);
    expect(messages.join('\n')).toContain('rename sound: to gen:');
    expect(messages.join('\n')).not.toContain('no generative request claims');
    expect(messages).toHaveLength(1);
  });

  it('says nothing about an asset item directory', async () => {
    const src = sourceFile();
    await importAsset(root, 'opener', src, 'water');
    expect((await check(root)).diagnostics).toEqual([]);
    rmSync(src);
  });
});
