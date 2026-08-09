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
  writeFileSync(join(root, 'songs/creek/song.yaml'), 'name: creek\nlength: [12]\nloop: true\n');
  track('phrase', 'name: phrase\ntype: audio\nclips: []\n');
  track('vox', 'name: vox\ntype: audio\nclips: []\n');
  track(
    'main',
    [
      'name: main',
      'type: audio',
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
      'clips: []',
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

  it('says so when the output track places nothing', () => {
    expect(arrangement(root, 'creek')).toContain('nothing placed');
  });

  it('refuses a song that has no output track, naming the rule', () => {
    rmSync(join(root, 'songs/creek/tracks/main.yaml'));
    expect(() => arrangement(root, 'creek')).toThrow('has no track named "main"');
    expect(() => arrangement(root, 'ghost')).toThrow('no such song');
  });
});
