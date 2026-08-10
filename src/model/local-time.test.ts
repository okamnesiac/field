import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explainLabel } from '../commands/build.js';
import { check } from '../commands/check.js';
import { createSong } from '../commands/create.js';
import { init } from '../commands/init.js';
import { loadProject } from './project.js';

// A track may carry its own tempo and meter (nested-tracks.md §1.5), which
// is what makes a 7/8 figure inside a 4/4 song a track rather than a
// feature. `field song create` scaffolds 4/4 at 120, so every number here
// is against that:
//
//   4/4 bar = 3840 ticks = 2.000 s = 96000 samples
//   7/8 bar = 3360 ticks = 1.750 s = 84000 samples

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-local-time-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const track = (name: string, yaml: string) =>
  writeFileSync(join(root, 'songs/creek/tracks', `${name}.yaml`), yaml);

const SEVEN_EIGHT = ['time:', '  meter:', '    - at: 0', '      numerator: 7', '      denominator: 8'];

// A silent instrument for clips to point at. A bare `source:` names a
// program on the shared instrument shelf.
function writeSound(): void {
  writeFileSync(
    join(root, 'songs/creek/tracks/kick.yaml'),
    'name: kick\ninputs:\n  - supercollider:\n      source: kick.scd\n      seed: 1\n      duration: 2\n',
  );
  mkdirSync(join(root, 'shared/instruments'), { recursive: true });
  writeFileSync(join(root, 'shared/instruments/kick.scd'), 'Out.ar(0, Silent.ar(2));\n');
}

const song = () => loadProject(root).songs.find((s) => s.name === 'creek')!;
const named = (name: string) => song().tracks.find((t) => t.data.name === name)!.data;

describe('a track with its own time', () => {
  it('resolves its clips through its own meter', async () => {
    track(
      'figure',
      [
        'name: figure',
        ...SEVEN_EIGHT,
        'inputs:',
        '  - id: hit',
        '    track: kick',
        '    at: [2]',
        '    duration: [1]',
        '',
      ].join('\n'),
    );
    // Bar 2 of 7/8 is 3360 ticks. Under the song's 4/4 it would be 3840 —
    // the number this whole feature exists to stop being wrong.
    expect(named('figure').inputs[0]!.at).toBe(3360);
    expect(named('figure').inputs[0]!.duration).toBe(3360);
  });

  it('inherits the half it does not declare', () => {
    // A local meter at the song's tempo is the polymetric case, and it is
    // why `time:` does not demand both: repeating `bpm: 120` here would be
    // a second copy of the song's tempo that nothing can keep in step.
    track(
      'figure',
      ['name: figure', ...SEVEN_EIGHT, ''].join('\n'),
    );
    expect(named('figure').time?.tempo).toBeUndefined();
    expect(named('figure').time?.meter?.[0]?.numerator).toBe(7);
  });

  it('refuses an empty time: rather than treating it as inherit-everything', async () => {
    track('figure', ['name: figure', 'time: {}', ''].join('\n'));
    const messages = (await check(root)).diagnostics.map((d) => d.message);
    expect(messages.join('\n')).toContain('an empty `time:` inherits everything');
  });

  it('diagnoses a broken local map against the track, and does not fall back to the song', async () => {
    // Falling back would resolve the positions against a map the author
    // did not write, producing numbers on top of an error.
    track(
      'figure',
      [
        'name: figure',
        'time:',
        '  meter:',
        '    - at: 1',  // not a bar boundary of the preceding meter
        '      numerator: 7',
        '      denominator: 8',
        'inputs:',
        '  - id: hit',
        '    track: kick',
        '    at: [2]',
        '    duration: [1]',
        '',
      ].join('\n'),
    );
    const diags = (await check(root)).diagnostics;
    expect(diags.some((d) => d.file.endsWith('figure.yaml') && d.message.includes('local meter'))).toBe(true);
    // The position never silently became 3840.
    expect(named('figure').inputs[0]!.at).not.toBe(3840);
  });
});

describe('inheritance comes from the song, not the parent', () => {
  // The crux (nested-tracks.md §13). A track may be placed in two parents
  // (§1.3) and renders exactly once, so "bar 2" inside it has to mean one
  // thing regardless of who consumes it — which rules out the parent as
  // the source of the fallback.
  beforeEach(() => {
    track(
      'child',
      [
        'name: child',
        'inputs:',
        '  - id: hit',
        '    track: kick',
        '    at: [2]',
        '    duration: [1]',
        '',
      ].join('\n'),
    );
    track(
      'parent',
      [
        'name: parent',
        ...SEVEN_EIGHT,
        'inputs:',
        '  - track: child',
        '    at: [2]',
        '',
      ].join('\n'),
    );
  });

  it('gives the child the song 4/4 while its parent is in 7/8', () => {
    // The placement is in the parent's file, so it is in the parent's
    // time: bar 2 of 7/8.
    expect(named('parent').inputs[0]!.at).toBe(3360);
    // The clip is in the child's file, and the child declared no time, so
    // it is the song's 4/4 — not the 7/8 of the track that places it.
    expect(named('child').inputs[0]!.at).toBe(3840);
  });

  it('does not change the child when the parent changes meter', () => {
    const before = named('child').inputs[0]!.at;
    track(
      'parent',
      [
        'name: parent',
        'time:',
        '  meter:',
        '    - at: 0',
        '      numerator: 5',
        '      denominator: 4',
        'inputs:',
        '  - track: child',
        '    at: [2]',
        '',
      ].join('\n'),
    );
    expect(named('child').inputs[0]!.at).toBe(before);
    expect(named('parent').inputs[0]!.at).toBe(4800); // bar 2 of 5/4
  });
});

describe("the stem is planned in the track's own tempo", () => {
  it("projects ticks to samples under a local tempo, not the song's", async () => {
    // A local *meter* alone cannot catch this: the meter decides the tick
    // position at load, and ticks reach samples through the tempo map. So
    // only a track with its own tempo proves the graph hands planTrack the
    // right one — the first version of this file tested a 7/8 track at the
    // song's tempo and passed with the local map ignored entirely.
    track(
      'slow',
      [
        'name: slow',
        'time:',
        '  tempo:',
        '    - at: 0',
        '      bpm: 60',
        'inputs:',
        '  - id: hit',
        '    track: kick',
        '    at: [2]',
        '    duration: [1]',
        '',
      ].join('\n'),
    );
    writeSound();
    expect((await check(root)).diagnostics).toEqual([]);
    const slow = await explainLabel(root, '//songs/creek/track:slow');
    const clips = (slow.parameters as { clips: { start: number }[] }).clips;
    // Bar 2 is 3840 ticks either way — the song's 4/4 is inherited. At the
    // song's 120 bpm that is 2.000 s; at this track's 60 it is 4.000 s.
    expect(clips[0]!.start).toBe(192000);
    expect(clips[0]!.start).not.toBe(96000);
  });
});

describe('composition is offset addition, not map arithmetic', () => {
  it('plans a 7/8 child into a 4/4 parent by adding samples', async () => {
    track(
      'figure',
      [
        'name: figure',
        ...SEVEN_EIGHT,
        'inputs:',
        '  - id: hit',
        '    track: kick',
        '    at: [2]',
        '    duration: [1]',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      [
        'name: main',
        'inserts: []',
        'inputs:',
        '  - track: figure',
        '    at: [2]',
        '',
      ].join('\n'),
    );
    writeSound();
    expect((await check(root)).diagnostics).toEqual([]);

    // The child's own clip: bar 2 of 7/8 at 120 bpm is 1.750 s.
    const child = await explainLabel(root, '//songs/creek/track:figure');
    const clips = (child.parameters as { clips: { start: number }[] }).clips;
    expect(clips[0]!.start).toBe(84000);

    // The parent's placement: bar 2 of 4/4 at 120 bpm is 2.000 s. The two
    // maps are never reconciled — each side resolved to samples under its
    // own, and the daemon sums at this offset.
    const parent = await explainLabel(root, '//songs/creek/track:main');
    const placed = (parent.parameters as { clips: { start: number }[] }).clips;
    expect(placed[0]!.start).toBe(96000);
  });
});

describe("a take is content on a track, so it is in that track's time", () => {
  it("cross-checks a take's ticks against its own track's tempo", async () => {
    // Takes store both representations and `check` verifies the derived
    // one (project-core.md §3.1). A recording on a track that runs at its
    // own tempo has its ticks in *that* timeline — checking it against the
    // song's rejects a take whose samples are right (#95 review).
    track(
      'slow',
      [
        'name: slow',
        'time:',
        '  tempo:',
        '    - at: 0',
        '      bpm: 60',
        '',
      ].join('\n'),
    );
    mkdirSync(join(root, 'songs/creek/takes/slow'), { recursive: true });
    // Bar 2 is 3840 ticks. At this track's 60 bpm that is 4.000 s; at the
    // song's 120 it would be 2.000 s.
    writeFileSync(
      join(root, 'songs/creek/takes/slow/take-20260808-120000.yaml'),
      [
        'id: take-20260808-120000',
        'track: slow',
        'asset: room',
        'anchor: musical',
        'position: 3840',
        'position_samples: 192000',
        'duration_samples: 48000',
        '',
      ].join('\n'),
    );
    const diags = (await check(root)).diagnostics.map((d) => d.message);
    expect(diags.filter((m) => m.includes('disagrees with tempo map'))).toEqual([]);
  });
});
