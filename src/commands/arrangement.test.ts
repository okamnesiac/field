import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { arrangement } from './arrangement.js';
import { check } from './check.js';
import { createSong } from './create.js';
import { init } from './init.js';

// `arrangement.yaml` stored the structure and nothing read it, which is how
// creek's came to say `chorus` at bar 13 of a twelve-bar song. It is derived
// now, from the output track's placements — the thing that actually renders
// (nested-tracks.md §11).

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-arrangement-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const track = (name: string, yaml: string) =>
  writeFileSync(join(root, 'songs/creek/tracks', `${name}.yaml`), yaml);

function threePasses(): void {
  // `field song create` scaffolds no length; the header only has something
  // to report when the song declares one.
  writeFileSync(join(root, 'songs/creek/song.yaml'), 'name: creek\nlength: [12]\nloop: true\ntime:\n  tempo:\n    - at: 0\n      bpm: 120\n  meter:\n    - at: 0\n      numerator: 4\n      denominator: 4\n');
  track('phrase', 'name: phrase\n');
  track('vox', 'name: vox\n');
  track(
    'main',
    [
      'name: main',
      'inserts: []',
      'inputs:',
      '  - track: phrase',
      '    at: [1]',
      '  - track: phrase',
      '    at: [5]',
      '  - track: phrase',
      '    at: [9]',
      '  - track: vox',
      '    at: [5]',
      '    gain_db: 3',
      '    pan: 0.2',
      '',
    ].join('\n'),
  );
}

describe('field arrangement', () => {
  it('derives the structure from the output track, in time order', async () => {
    threePasses();
    expect((await check(root)).diagnostics).toEqual([]);
    const out = arrangement(root, 'creek');
    expect(out.split('\n')).toEqual([
      'creek (12 bars)',
      '  1.1.1 0:00.0  phrase',
      // 8 s a pass, not 10: `field song create` scaffolds 120 bpm, where
      // creek runs at 96. The seconds come from the song's own tempo map.
      '  5.1.1 0:08.0  phrase',
      '  5.1.1 0:08.0  vox  (+3 dB, pan 0.2)',
      '  9.1.1 0:16.0  phrase',
    ]);
  });

  it('reports the song length as a span, not the downbeat after it', () => {
    // `length: [12]` is twelve bars. Formatting it as bar.beat.tick gives
    // "13.1.1" — the position *after* the song — which is exactly the
    // off-by-one the retired file carried as `chorus` at bar 13.
    threePasses();
    expect(arrangement(root, 'creek')).toContain('creek (12 bars)');
    expect(arrangement(root, 'creek')).not.toContain('13.1.1');
  });

  it('follows the placements, so it cannot disagree with what renders', () => {
    // The whole argument for deriving it. Move a pass and the arrangement
    // moves; a stored file would have had to be remembered.
    threePasses();
    const before = arrangement(root, 'creek');
    expect(before).toContain('9.1.1');
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      readFileSync(join(root, 'songs/creek/tracks/main.yaml'), 'utf8').replace(
        '    at: [9]',
        '    at: [11]',
      ),
    );
    const after = arrangement(root, 'creek');
    expect(after).not.toContain('9.1.1');
    expect(after).toContain('11.1.1');
  });

  it('reads an absolute placement in time, not as if its samples were ticks', () => {
    // `at` is ticks when the placement is musical and samples when it is
    // absolute. Formatting samples through the meter map is not a rounding
    // error: 48000 samples is one second, and it came out as bar 13 of an
    // eight-bar song — the same class of lie this command exists to stop.
    writeFileSync(join(root, 'songs/creek/song.yaml'), 'name: creek\nlength: [8]\nloop: true\ntime:\n  tempo:\n    - at: 0\n      bpm: 120\n  meter:\n    - at: 0\n      numerator: 4\n      denominator: 4\n');
    track('child', 'name: child\n');
    track(
      'main',
      [
        'name: main',
        'inserts: []',
        'inputs:',
        '  - track: child',
        '    anchor: absolute',
        '    at: 48000',
        '',
      ].join('\n'),
    );
    const out = arrangement(root, 'creek');
    // One second at the scaffolded 120 bpm in 4/4 is half a bar: beat 3.
    expect(out).toContain('1.3.1 0:01.0  child  (absolute)');
    expect(out).not.toContain('13.');
  });

  it('refuses a project with diagnostics rather than printing a plausible view', () => {
    // Unresolved musical time prints as a raw array, and `[5]` reads as
    // bar 5 — a structure nothing consuming it can tell is wrong, which is
    // the failure the whole command exists to end. `build` and `fmt` both
    // stop on diagnostics; this used to be the outlier.
    threePasses();
    writeFileSync(
      join(root, 'songs/creek/song.yaml'),
      'name: creek\ntime:\n  tempo:\n    - at: 0\n      bpm: 120\n  meter:\n    - at: [5]\n      numerator: 4\n      denominator: 4\n',
    );
    expect(() => arrangement(root, 'creek')).toThrow('project has errors (field check)');
  });

  it('measures the length through the meter map, not the opening meter', async () => {
    // A song that changes meter has no single bar length. Dividing by the
    // first meter's bar printed 10 for creek's twelve on a project that
    // checked ok — the one number not computed from the map being wrong.
    threePasses();
    writeFileSync(
      join(root, 'songs/creek/song.yaml'),
      [
        'name: creek',
        'length: [12]',
        'loop: true',
        'time:',
        '  tempo:',
        '    - at: 0',
        '      bpm: 120',
        '  meter:',
        '    - at: 0',
        '      numerator: 4',
        '      denominator: 4',
        '    - at: 7680', // bar 3 in 4/4 at 960 ticks a quarter
        '      numerator: 3',
        '      denominator: 4',
        '',
      ].join('\n'),
    );
    expect((await check(root)).diagnostics).toEqual([]);
    expect(arrangement(root, 'creek')).toContain('creek (12 bars)');
  });

  it('says so when the output track places nothing', () => {
    expect(arrangement(root, 'creek')).toContain('nothing placed');
  });

  it('refuses a song that has no output track, naming the rule', () => {
    rmSync(join(root, 'songs/creek/tracks/main.yaml'));
    expect(() => arrangement(root, 'creek')).toThrow('has no track named "main"');
    expect(() => arrangement(root, 'ghost')).toThrow('no such song');
  });
});
