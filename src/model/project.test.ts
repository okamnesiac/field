import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../commands/init.js';
import { createSong, createTrack } from '../commands/create.js';
import { check } from '../commands/check.js';
import { fmt } from '../commands/fmt.js';
import { findProjectRoot, loadProject } from './project.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bloom-test-'));
  init({ dir: root, name: 'test-album' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('init', () => {
  it('creates a valid, canonically formatted project', () => {
    const result = check(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.unformatted).toEqual([]);
    expect(result.ok).toBe(true);
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
  it('creates songs and tracks that pass check', () => {
    createSong(root, 'opener');
    createTrack(root, 'opener', 'lead-vocal', 'audio');
    const result = check(root);
    expect(result.ok).toBe(true);

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

  it('recovers from a partially created song', () => {
    createSong(root, 'opener');
    // Simulate a crash between tempo.yaml and song.yaml: the existence
    // marker (song.yaml) is missing, so createSong must succeed again.
    rmSync(join(root, 'songs/opener/song.yaml'));
    expect(() => createSong(root, 'opener')).not.toThrow();
    expect(check(root).ok).toBe(true);
  });
});

describe('check', () => {
  it('flags a track whose name does not match its filename', () => {
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/opener/tracks/lead-vocal.yaml'),
      'name: other-name\ntype: audio\nclips: []\n',
    );
    const result = check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('must match filename');
  });

  it('flags missing clip assets', () => {
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/opener/tracks/vox.yaml'),
      [
        'name: vox',
        'type: audio',
        'clips:',
        '  - id: intro-vox-abc12',
        '    asset: audio/missing.wav',
        '    position: 0',
        '    duration: 960',
        '',
      ].join('\n'),
    );
    const result = check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('asset not found');
  });

  it('flags meter changes off the bar boundary', () => {
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
    const result = check(root);
    expect(result.diagnostics.map((d) => d.message).join()).toContain('bar boundary');
  });

  it('flags schema violations with paths', () => {
    createSong(root, 'opener');
    writeFileSync(join(root, 'songs/opener/song.yaml'), 'name: opener\nbogus: true\n');
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.file).toBe('songs/opener/song.yaml');
  });
});

describe('takes', () => {
  const takeYaml = (positionSamples: number, extra: Record<string, string> = {}) =>
    [
      'id: take-20260804-202355',
      `track: ${extra['track'] ?? 'vox'}`,
      'asset: audio/take.wav',
      'anchor: musical',
      'position: 960',
      `position_samples: ${positionSamples}`,
      'duration_samples: 48000',
      '',
    ].join('\n');

  const setupTake = (yaml: string, filename = 'take-20260804-202355.yaml') => {
    createSong(root, 'opener');
    createTrack(root, 'opener', 'vox', 'audio');
    writeFileSync(join(root, 'songs/opener/audio/take.wav'), '');
    mkdirSync(join(root, 'songs/opener/takes/vox'), { recursive: true });
    writeFileSync(join(root, 'songs/opener/takes/vox', filename), yaml);
  };

  it('accepts a take whose derived samples agree with the tempo map', () => {
    // default song: 120 BPM at 48 kHz → 960 ticks = 1 beat = 0.5 s = 24000 samples
    setupTake(takeYaml(24000));
    expect(check(root).ok).toBe(true);
  });

  it('flags position_samples that disagree with the tempo map (§3.1)', () => {
    setupTake(takeYaml(999999));
    const messages = check(root).diagnostics.map((d) => d.message).join();
    expect(messages).toContain('disagrees with tempo map');
    expect(messages).toContain('24000');
  });

  it('flags id ≠ filename and track ≠ containing directory (§6)', () => {
    setupTake(takeYaml(24000), 'take-20260101-000000.yaml');
    const messages = check(root).diagnostics.map((d) => d.message).join();
    expect(messages).toContain('must match filename');
  });

  it('flags absolute asset paths', () => {
    setupTake(takeYaml(24000).replace('audio/take.wav', '/etc/hosts'));
    const messages = check(root).diagnostics.map((d) => d.message).join();
    expect(messages).toContain('must be relative');
  });

  it('flags asset paths that escape the project', () => {
    setupTake(takeYaml(24000).replace('audio/take.wav', '../../../outside.wav'));
    const messages = check(root).diagnostics.map((d) => d.message).join();
    expect(messages).toContain('escapes the project');
  });
});

describe('anchors and aliases', () => {
  it('rejects anchors and aliases in project files (§3.6)', () => {
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/opener/tracks/vox.yaml'),
      'name: &n vox\ntype: audio\nclips: []\n',
    );
    const messages = check(root).diagnostics.map((d) => d.message).join();
    expect(messages).toContain('anchors and aliases are not allowed');
  });
});

describe('fmt', () => {
  it('formats a track named "song" with track order, not song order', () => {
    createSong(root, 'opener');
    createTrack(root, 'opener', 'song', 'audio');
    const path = join(root, 'songs/opener/tracks/song.yaml');
    writeFileSync(path, 'type: audio\nclips: []\nname: song\n');

    expect(check(root).unformatted).toEqual(['songs/opener/tracks/song.yaml']);
    expect(fmt(root).formatted).toEqual(['songs/opener/tracks/song.yaml']);
    expect(check(root).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('name: song\ntype: audio\nclips: []\n');
  });

  it('canonicalizes shuffled keys and preserves comments', () => {
    createSong(root, 'opener');
    const path = join(root, 'songs/opener/tracks/vox.yaml');
    writeFileSync(path, '# my favorite track\ntype: audio\nclips: []\nname: vox\n');

    expect(check(root).unformatted).toEqual(['songs/opener/tracks/vox.yaml']);
    const result = fmt(root);
    expect(result.formatted).toEqual(['songs/opener/tracks/vox.yaml']);

    const after = check(root);
    expect(after.ok).toBe(true);
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
