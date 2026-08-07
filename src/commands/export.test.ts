import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GeneratorRunner } from '../graph/build.js';
import { createSong } from './create.js';
import { exportFileName, exportLabels, homeRelative } from './export.js';
import { importAsset } from './import.js';
import { init } from './init.js';

// Export is a copy with a readable name, so the tests are about the name
// and about *which* files land: a build prints its dependencies, and an
// export must not scatter them across someone's Desktop.

let root: string;
let dest: string;

// A tiny valid 48 kHz 16-bit mono WAV (100 samples of silence).
function writeWav(path: string): void {
  const n = 100;
  const data = Buffer.alloc(n * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

const writeSound = (name: string, yaml: string) => {
  mkdirSync(join(root, 'songs/creek/sounds'), { recursive: true });
  writeFileSync(join(root, `songs/creek/sounds/${name}.yaml`), yaml);
};

const normalizeYaml = (name: string) =>
  ['name: ' + name, 'type: normalize', 'source: pad', 'sample_rate: 96000', 'bit_depth: 16', ''].join('\n');

// Copies the input through, so an exported file is byte-comparable with
// the asset it came from.
const runner: GeneratorRunner = async (_node, inputPaths, outputPath) => {
  if (inputPaths.length > 0) copyFileSync(inputPaths[0]!, outputPath);
  else writeFileSync(outputPath, 'rendered');
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bloom-export-'));
  // Never the real Desktop: every test passes an explicit --to.
  dest = mkdtempSync(join(tmpdir(), 'bloom-export-dest-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  const src = join(root, '..', `bloom-export-src-${Math.random()}.wav`);
  writeWav(src);
  await importAsset(root, 'creek', src, 'pad');
  rmSync(src);
  writeSound('pad-normalized', normalizeYaml('pad-normalized'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});

describe('exportFileName', () => {
  it('names a song label by song and thing', () => {
    expect(exportFileName('//songs/creek/mix:main', '.wav')).toBe('creek-main.wav');
    expect(exportFileName('//songs/creek/tracks:drums', '.wav')).toBe('creek-drums.wav');
    expect(exportFileName('//songs/creek/sounds:still-water-keys', '.wav')).toBe(
      'creek-still-water-keys.wav',
    );
  });

  it('leaves shared material its own name: there is no song to name', () => {
    expect(exportFileName('//shared/assets:water', '.wav')).toBe('water.wav');
  });

  it('adds the package scope only when asked (the collision case)', () => {
    expect(exportFileName('//songs/creek/tracks:pad', '.wav', true)).toBe('creek-tracks-pad.wav');
    expect(exportFileName('//shared/assets:water', '.wav', true)).toBe('assets-water.wav');
  });

  it('keeps the source extension', () => {
    expect(exportFileName('//songs/creek/assets:pad', '.aiff')).toBe('creek-pad.aiff');
  });
});

describe('homeRelative', () => {
  it('abbreviates $HOME and only $HOME', () => {
    expect(homeRelative('/Users/justin/Desktop/creek-main.wav', '/Users/justin')).toBe(
      '~/Desktop/creek-main.wav',
    );
    expect(homeRelative('/Users/justin', '/Users/justin')).toBe('~');
    // A sibling whose name merely starts with the home path is not home.
    expect(homeRelative('/Users/justinx/Desktop', '/Users/justin')).toBe('/Users/justinx/Desktop');
    expect(homeRelative('/tmp/elsewhere.wav', '/Users/justin')).toBe('/tmp/elsewhere.wav');
  });
});

describe('exportLabels', () => {
  it('copies the built artifact under a readable name', async () => {
    const results = await exportLabels(root, ['//songs/creek/sounds:pad-normalized'], {
      to: dest,
      runner,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.to).toBe(join(dest, 'creek-pad-normalized.wav'));
    expect(results[0]!.replaced).toBe(false);
    expect(readFileSync(results[0]!.to)).toEqual(readFileSync(results[0]!.from));
  });

  it('exports what was asked for, not what the build had to make', async () => {
    // The rule depends on the asset, so `bloom build` prints two labels.
    // Exporting must still put exactly one file on the Desktop.
    await exportLabels(root, ['//songs/creek/sounds:pad-normalized'], { to: dest, runner });
    expect(readdirSync(dest)).toEqual(['creek-pad-normalized.wav']);
  });

  it('exports committed sources too, straight from the song', async () => {
    const [asset] = await exportLabels(root, ['//songs/creek/assets:pad'], { to: dest, runner });
    expect(asset!.to).toBe(join(dest, 'creek-pad.wav'));
    expect(asset!.from).toBe(join(root, 'songs/creek/audio/pad.wav'));
  });

  it('re-exporting replaces the file and says so', async () => {
    await exportLabels(root, ['//songs/creek/assets:pad'], { to: dest, runner });
    const [again] = await exportLabels(root, ['//songs/creek/assets:pad'], { to: dest, runner });
    expect(again!.replaced).toBe(true);
    expect(readdirSync(dest)).toHaveLength(1); // replaced, not accumulated
  });

  it('disambiguates only the labels that collide', async () => {
    // A song's one namespace covers sounds and assets — the `source:`
    // namespace — but a track may share a sound's name, and those two
    // land on `creek-pad.wav` together. The third label keeps its plain
    // name: one collision must not rename everything else.
    writeSound('pad-copy', normalizeYaml('pad-copy'));
    mkdirSync(join(root, 'songs/creek/tracks'), { recursive: true });
    writeFileSync(
      join(root, 'songs/creek/tracks/pad-copy.yaml'),
      // A track is a node where there is content: an empty one has no
      // stem to build, so the clip is what makes this a label at all.
      [
        'name: pad-copy',
        'type: audio',
        'clips:',
        '  - id: pad-clip',
        '    source: pad',
        '    position: [1]',
        '    duration: [1]',
        '',
      ].join('\n'),
    );
    const results = await exportLabels(
      root,
      [
        '//songs/creek/sounds:pad-copy',
        '//songs/creek/tracks:pad-copy',
        '//songs/creek/sounds:pad-normalized',
      ],
      { to: dest, runner },
    );
    expect(results.map((r) => r.to.split('/').pop()).sort()).toEqual([
      'creek-pad-normalized.wav',
      'creek-sounds-pad-copy.wav',
      'creek-tracks-pad-copy.wav',
    ]);
  });

  it('refuses a destination that does not exist rather than creating one', async () => {
    await expect(
      exportLabels(root, ['//songs/creek/assets:pad'], { to: join(dest, 'Desktps'), runner }),
    ).rejects.toThrow('no such directory');
  });

  it('errors on a pattern that matches nothing', async () => {
    await expect(exportLabels(root, ['//nowhere/...'], { to: dest, runner })).rejects.toThrow(
      'matched no labels',
    );
  });
});
