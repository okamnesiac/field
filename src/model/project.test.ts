import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  root = mkdtempSync(join(tmpdir(), 'bloom-test-'));
  init({ dir: root, name: 'test-album' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A source file to import, created outside the project.
function sourceFile(content = 'not really audio'): string {
  const path = join(root, '..', `bloom-test-src-${Date.now()}-${Math.random()}.wav`);
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

  it('derives a slug name from the filename', async () => {
    createSong(root, 'opener');
    const src = sourceFile();
    const result = await importAsset(root, 'opener', src);
    expect(result.name).toMatch(/^bloom-test-src-/);
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
        '    asset: nonexistent',
        '    position: 0',
        '    duration: 960',
        '',
      ].join('\n'),
    );
    const result = await check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('unknown asset');
  });

  it('diagnoses loop sources exhausted by their read offset — check, not a graph crash', async () => {
    createSong(root, 'opener');
    // A real one-second wav, so validate can learn its true frame count.
    const wavPath = join(root, '..', `bloom-test-loop-${Date.now()}.wav`);
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
        '    asset: hit',
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
    const wavPath = join(root, '..', `bloom-test-slot-${Date.now()}.wav`);
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
        '    asset: hit',
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
    mkdirSync(join(root, 'songs/opener/targets'), { recursive: true });
    writeFileSync(
      join(root, 'songs/opener/targets/pad.yaml'),
      [
        'name: pad',
        'rule: sc-render',
        'program: sc/pad.scd',
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
        '    target: pad',
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
        '    asset: hit',
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

    const other = mkdtempSync(join(tmpdir(), 'bloom-test-ticks-'));
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
          '    asset: hit',
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
        '    asset: hit',
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
        '    asset: hit',
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
        '    asset: hit',
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
