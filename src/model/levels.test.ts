import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check } from '../commands/check.js';
import { explainLabel } from '../commands/build.js';
import { createSong } from '../commands/create.js';
import { init } from '../commands/init.js';
import { loadProject } from './project.js';
import { formatReach, reaches, rootNote, type Reach } from './levels.js';

// One gain, and it lives on the edge (nested-tracks.md §1.13) — so a
// track's own file says nothing about its level, and the answer is spread
// across the placements above it. These tests are creek's real shape:
// `keys` at -4 dB inside `phrase`, `phrase` placed three times by both
// `main` and `bed`.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-levels-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const track = (name: string, yaml: string) =>
  writeFileSync(join(root, 'songs/creek/tracks', `${name}.yaml`), yaml);

const leaf = (name: string) => track(name, `name: ${name}\ntype: audio\nclips: []\n`);

// main and bed both make three passes of a phrase; the phrase holds a
// panned, attenuated `keys` beside a flat `drums`.
function creek(): void {
  for (const name of ['drums', 'keys', 'pad']) leaf(name);
  track(
    'phrase',
    [
      'name: phrase',
      'type: audio',
      'inputs:',
      '  - track: drums',
      '    at: 0',
      '  - track: keys',
      '    at: 0',
      '    gain_db: -4',
      '    pan: 0.2',
      'clips: []',
      '',
    ].join('\n'),
  );
  const passes = ['  - track: phrase', '    at: [1]', '  - track: phrase', '    at: [5]', '  - track: phrase', '    at: [9]'];
  track(
    'main',
    [
      'name: main',
      'type: audio',
      'inputs:',
      ...passes,
      '  - track: pad',
      '    at: 0',
      '    gain_db: -6',
      '    pan: -0.2',
      'clips: []',
      '',
    ].join('\n'),
  );
  track('bed', ['name: bed', 'type: audio', 'inputs:', ...passes, 'clips: []', ''].join('\n'));
}

const song = () => loadProject(root).songs.find((s) => s.name === 'creek')!;

describe('effective levels', () => {
  it('sums the placement gains between a track and each root', async () => {
    creek();
    expect((await check(root)).diagnostics).toEqual([]);
    // -4 comes from `phrase`'s file, which `keys` has no way to know
    // about — that is the whole reason the question needs answering.
    expect(reaches(song(), 'keys').map((r) => [r.to, r.gainDb])).toEqual([
      ['bed', -4],
      ['main', -4],
    ]);
  });

  it('sums every hop, not just the nearest one', () => {
    creek();
    // creek itself cannot catch this: `phrase` is placed at 0 dB, so
    // -4 + 0 and "the nearest gain" agree. Give the outer placement a
    // level of its own and they stop agreeing — which is the case a
    // deeper tree makes ordinary.
    track(
      'main',
      [
        'name: main',
        'type: audio',
        'inputs:',
        '  - track: phrase',
        '    at: [1]',
        '    gain_db: -2',
        'clips: []',
        '',
      ].join('\n'),
    );
    expect(reaches(song(), 'keys').find((r) => r.to === 'main')!.gainDb).toBe(-6);
  });

  it('counts identical placements instead of listing them', () => {
    creek();
    // `phrase` is placed three times by main at the same level. That is
    // one fact about the level, not three.
    const toMain = reaches(song(), 'phrase').find((r) => r.to === 'main')!;
    expect(toMain.paths).toBe(3);
    expect(toMain.gainDb).toBe(0);
  });

  it('splits when the placements are not at the same level', () => {
    creek();
    // Collapsing on the destination alone would report one of these and
    // hide the other, which is precisely the surprise this answers.
    track(
      'main',
      [
        'name: main',
        'type: audio',
        'inputs:',
        '  - track: phrase',
        '    at: [1]',
        '  - track: phrase',
        '    at: [5]',
        '    gain_db: -3',
        'clips: []',
        '',
      ].join('\n'),
    );
    expect(reaches(song(), 'phrase').map((r) => [r.to, r.gainDb, r.paths])).toEqual([
      ['bed', 0, 3], // untouched: bed still makes three passes at one level
      ['main', 0, 1],
      ['main', -3, 1],
    ]);
  });

  it('reports every root, not only the song output', () => {
    creek();
    // `bed` is a second render target: nothing places it, and
    // `field build creek/track:bed` renders it. A walk that stopped at
    // `main` would say `keys` reaches one place when it reaches two.
    expect(reaches(song(), 'keys').map((r) => r.to)).toEqual(['bed', 'main']);
  });

  it('names the tracks in between, and not the destination', () => {
    creek();
    expect(reaches(song(), 'keys').find((r) => r.to === 'main')!.via).toEqual(['phrase']);
    // `pad` is placed directly, so there is nothing in between.
    expect(reaches(song(), 'pad').find((r) => r.to === 'main')!.via).toEqual([]);
  });

  it('is empty for a track nothing places', () => {
    creek();
    expect(reaches(song(), 'main')).toEqual([]);
    expect(reaches(song(), 'bed')).toEqual([]);
  });

  it('lists the pans on a path rather than composing them into one', () => {
    creek();
    // Two pans do not make a third. The daemon applies pan as a balance
    // that attenuates one side (`balanceGains`), so hard left then hard
    // right is silence, not centre — and composing them here would put a
    // second copy of that law in TypeScript to drift against the one the
    // audio goes through.
    track(
      'main',
      [
        'name: main',
        'type: audio',
        'inputs:',
        '  - track: phrase',
        '    at: [1]',
        '    pan: -0.5',
        'clips: []',
        '',
      ].join('\n'),
    );
    const toMain = reaches(song(), 'keys').find((r) => r.to === 'main')!;
    expect(toMain.pans).toEqual([
      { in: 'phrase', track: 'keys', pan: 0.2 },
      { in: 'main', track: 'phrase', pan: -0.5 },
    ]);
    // The route keeps its position on every line, so the caveat comes
    // after it — two parenthetical groups back to back read as one.
    expect(formatReach(toMain)).toBe(
      'track:main -4.0 dB, pan 0.2 in track:phrase, then -0.5 in track:main (via track:phrase) — balances compose per channel, not into one pan',
    );
  });
});

describe('formatting a reach', () => {
  const reach = (over: Partial<Reach> = {}): Reach => ({
    to: 'main',
    gainDb: 0,
    pans: [],
    via: [],
    paths: 1,
    ...over,
  });

  it('signs the level and keeps one decimal', () => {
    expect(formatReach(reach({ gainDb: 3 }))).toBe('track:main +3.0 dB');
    expect(formatReach(reach({ gainDb: -4 }))).toBe('track:main -4.0 dB');
    // Levels are authored in tenths; -0.0 dB is a rounding artifact that
    // reads as an attenuation nobody wrote.
    expect(formatReach(reach({ gainDb: -0.04 }))).toBe('track:main 0.0 dB');
  });

  it('says the route only when there is one', () => {
    expect(formatReach(reach({ via: ['phrase'], paths: 3 }))).toBe(
      'track:main 0.0 dB (via track:phrase, 3 placements)',
    );
    expect(formatReach(reach({ paths: 3 }))).toBe('track:main 0.0 dB (3 placements)');
    expect(formatReach(reach())).toBe('track:main 0.0 dB');
  });

  it('distinguishes the song output from a track nothing consumes', () => {
    // Same graph fact, very different news: one is the mix, the other is
    // what a typo in an `inputs:` entry leaves behind.
    expect(rootNote('main')).toContain("song's output");
    expect(rootNote('bed')).toContain('build it directly');
  });
});

describe('explain', () => {
  it('answers the level question for a track and not for a sound', async () => {
    creek();
    const keys = await explainLabel(root, '//songs/creek/track:keys');
    expect(keys.levels?.track).toBe('keys');
    expect(keys.levels?.reaches.map((r) => formatReach(r))).toEqual([
      'track:bed -4.0 dB, pan 0.2 (via track:phrase, 3 placements)',
      'track:main -4.0 dB, pan 0.2 (via track:phrase, 3 placements)',
    ]);
    // A root track still reports — an empty list is the answer, and the
    // CLI turns it into rootNote.
    expect((await explainLabel(root, '//songs/creek/track:main')).levels).toEqual({
      track: 'main',
      reaches: [],
    });
  });
});
