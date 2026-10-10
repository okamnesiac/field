import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWavFloat32 } from '../audio/wav.js';
import { loadProject } from '../model/project.js';
import { createSong, createTrack } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { projectTimeline } from './ui-timeline.js';

// A lane's `entry` is what every socket op writes through, into the
// document's `inputs:` list. Receives draw no lane, so the lane list is
// shorter than `inputs:` whenever one is present, and the index has to be
// the entry's place in the document, not its place among the lanes.

describe('timeline lanes', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'field-ui-timeline-'));
    init({ dir: root, name: 'album' });
    createSong(root, 'creek');
    for (const name of ['riff', 'pad']) {
      const src = join(root, `${name}.wav`);
      writeWavFloat32(src, 48000, [new Float32Array(4800)]);
      await importAsset(root, 'creek', src, name);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function lanesOf(song = 'creek') {
    const project = loadProject(root);
    const loaded = project.songs.find((s) => s.name === song)!;
    return projectTimeline(root, loaded, 48000, 96000, 8).lanes;
  }

  it('names a placement by its index in inputs:, past a receive ahead of it', () => {
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      ['name: main', 'inputs:', '  - receive: verb', '  - audio: riff', '  - audio: pad', ''].join('\n'),
    );
    expect(lanesOf().map((l) => [l.name, l.entry])).toEqual([
      ['riff', 1],
      ['pad', 2],
    ]);
  });

  it("does the same for a placed track's children", () => {
    createTrack(root, 'creek', 'keys');
    writeFileSync(
      join(root, 'songs/creek/tracks/keys.yaml'),
      ['name: keys', 'inputs:', '  - receive: verb', '  - audio: pad', ''].join('\n'),
    );
    writeFileSync(join(root, 'songs/creek/tracks/main.yaml'), ['name: main', 'inputs:', '  - track: keys', ''].join('\n'));
    const [keys] = lanesOf();
    expect(keys?.children?.map((l) => [l.name, l.entry])).toEqual([['pad', 1]]);
  });

  it("draws a placed track's children where they sound, past its slip and source offset", () => {
    // keys plays its render from source_offset - slip = 4800 - 1200 =
    // 3600 at the window start (sample 0), so its child at local 0
    // sounds at -3600 on the song's timeline.
    createTrack(root, 'creek', 'keys');
    writeFileSync(join(root, 'songs/creek/tracks/keys.yaml'), ['name: keys', 'inputs:', '  - audio: pad', ''].join('\n'));
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      ['name: main', 'inputs:', '  - track: keys', '    source_offset: 4800', '    slip: 1200', ''].join('\n'),
    );
    const [keys] = lanesOf();
    expect(keys?.start).toBe(0);
    expect(keys?.children?.map((l) => l.start)).toEqual([-3600]);
  });
});
