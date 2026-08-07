import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GeneratorRunner } from '../graph/build.js';
import { createSong } from './create.js';
import { exportBaseName, exportLabels, homeRelative, nextVersion } from './export.js';
import { importAsset } from './import.js';
import { init } from './init.js';

// Export is a copy with a readable name and a version number, so the
// tests are about the name, which files land, and — most of all — that
// nothing already on the destination is ever lost.

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

const normalizeYaml = (name: string, rate = 96000) =>
  [`name: ${name}`, 'type: normalize', 'source: pad', `sample_rate: ${rate}`, 'bit_depth: 16', ''].join('\n');

// Output tracks the input *and* the spec, so a parameter edit moves the
// output hash the way a real render would. (Copying the input straight
// through would make a sample-rate change produce identical bytes, which
// the export's own unchanged-detection would then correctly ignore —
// hiding the versioning being tested.)
const runner: GeneratorRunner = async (node, inputPaths, outputPath) => {
  const input = inputPaths.length > 0 ? readFileSync(inputPaths[0]!) : Buffer.alloc(0);
  writeFileSync(outputPath, Buffer.concat([input, Buffer.from(JSON.stringify(node.spec))]));
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

describe('exportBaseName', () => {
  it('flattens the whole label, minus the songs/ prefix', () => {
    expect(exportBaseName('//songs/creek/mix:main')).toBe('creek-mix-main');
    expect(exportBaseName('//songs/creek/tracks:drums')).toBe('creek-tracks-drums');
    expect(exportBaseName('//songs/creek/sounds:still-water-keys')).toBe(
      'creek-sounds-still-water-keys',
    );
  });

  it('keeps shared material on its shelf', () => {
    expect(exportBaseName('//shared/assets:water')).toBe('shared-assets-water');
  });

  it('distinguishes a track from a sound of the same name', () => {
    // The reason the name is long: both of these are legal in one song
    // (the one-namespace rule covers sounds and assets), and they are
    // different files.
    expect(exportBaseName('//songs/creek/tracks:pad')).not.toBe(
      exportBaseName('//songs/creek/sounds:pad'),
    );
  });
});

describe('nextVersion', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bloom-version-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts at 1 in an empty directory', () => {
    expect(nextVersion(dir, 'creek-mix-main', '.wav')).toBe(1);
  });

  it('counts past the highest, and past gaps', () => {
    writeFileSync(join(dir, 'creek-mix-main-v1.wav'), 'a');
    writeFileSync(join(dir, 'creek-mix-main-v3.wav'), 'b'); // v2 was thrown away
    expect(nextVersion(dir, 'creek-mix-main', '.wav')).toBe(4);
  });

  it('ignores other exports, other extensions, and near-misses', () => {
    writeFileSync(join(dir, 'creek-mix-bed-v9.wav'), 'a');
    writeFileSync(join(dir, 'creek-mix-main-v9.aiff'), 'b');
    writeFileSync(join(dir, 'creek-mix-main-v9.wav.bak'), 'c');
    writeFileSync(join(dir, 'creek-mix-main-vX.wav'), 'd');
    writeFileSync(join(dir, 'my-creek-mix-main-v9.wav'), 'e');
    expect(nextVersion(dir, 'creek-mix-main', '.wav')).toBe(1);
  });
});

describe('homeRelative', () => {
  it('abbreviates $HOME and only $HOME', () => {
    expect(homeRelative('/Users/justin/Desktop/creek-mix-main-v1.wav', '/Users/justin')).toBe(
      '~/Desktop/creek-mix-main-v1.wav',
    );
    expect(homeRelative('/Users/justin', '/Users/justin')).toBe('~');
    // A sibling whose name merely starts with the home path is not home.
    expect(homeRelative('/Users/justinx/Desktop', '/Users/justin')).toBe('/Users/justinx/Desktop');
    expect(homeRelative('/tmp/elsewhere.wav', '/Users/justin')).toBe('/tmp/elsewhere.wav');
  });
});

describe('exportLabels', () => {
  it('copies the built artifact as v1', async () => {
    const results = await exportLabels(root, ['//songs/creek/sounds:pad-normalized'], {
      to: dest,
      runner,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.to).toBe(join(dest, 'creek-sounds-pad-normalized-v1.wav'));
    expect(results[0]!.version).toBe(1);
    expect(results[0]!.unchanged).toBe(false);
    expect(readFileSync(results[0]!.to)).toEqual(readFileSync(results[0]!.from));
  });

  it('exports what was asked for, not what the build had to make', async () => {
    // The rule depends on the asset, so `bloom build` prints two labels.
    // Exporting must still put exactly one file on the Desktop.
    await exportLabels(root, ['//songs/creek/sounds:pad-normalized'], { to: dest, runner });
    expect(readdirSync(dest)).toEqual(['creek-sounds-pad-normalized-v1.wav']);
  });

  it('exports committed sources too, straight from the song', async () => {
    const [asset] = await exportLabels(root, ['//songs/creek/assets:pad'], { to: dest, runner });
    expect(asset!.to).toBe(join(dest, 'creek-assets-pad-v1.wav'));
    expect(asset!.from).toBe(join(root, 'songs/creek/audio/pad.wav'));
  });

  it('a changed mix becomes the next version, and the old one survives', async () => {
    const [v1] = await exportLabels(root, ['//songs/creek/sounds:pad-normalized'], {
      to: dest,
      runner,
    });
    const before = readFileSync(v1!.to);

    writeSound('pad-normalized', normalizeYaml('pad-normalized', 44100)); // a real change
    const [v2] = await exportLabels(root, ['//songs/creek/sounds:pad-normalized'], {
      to: dest,
      runner,
    });

    expect(v2!.version).toBe(2);
    expect(v2!.to).toBe(join(dest, 'creek-sounds-pad-normalized-v2.wav'));
    expect(readdirSync(dest).sort()).toEqual([
      'creek-sounds-pad-normalized-v1.wav',
      'creek-sounds-pad-normalized-v2.wav',
    ]);
    // The point of the whole design: v1 is byte-for-byte what it was.
    expect(readFileSync(v1!.to)).toEqual(before);
  });

  it('re-exporting an unchanged mix mints nothing and names the version that stands', async () => {
    await exportLabels(root, ['//songs/creek/assets:pad'], { to: dest, runner });
    const [again] = await exportLabels(root, ['//songs/creek/assets:pad'], { to: dest, runner });

    expect(again!.unchanged).toBe(true);
    expect(again!.version).toBe(1);
    expect(again!.to).toBe(join(dest, 'creek-assets-pad-v1.wav'));
    expect(readdirSync(dest)).toHaveLength(1);
  });

  it('recognizes a change undone as the older version it matches', async () => {
    // v1, a change exported as v2, then the change undone: these bytes
    // are v1 again. Filing them as v3 would bury that, and the newest
    // version on the disk would no longer be what you just built — the
    // one case where a silent no-op would mislead, so the caller can see
    // both numbers.
    await exportLabels(root, ['//songs/creek/sounds:pad-normalized'], { to: dest, runner });
    writeSound('pad-normalized', normalizeYaml('pad-normalized', 44100));
    await exportLabels(root, ['//songs/creek/sounds:pad-normalized'], { to: dest, runner });
    writeSound('pad-normalized', normalizeYaml('pad-normalized', 96000)); // back to v1

    const [third] = await exportLabels(root, ['//songs/creek/sounds:pad-normalized'], {
      to: dest,
      runner,
    });

    expect(third!.unchanged).toBe(true);
    expect(third!.version).toBe(1); // the version these bytes already are
    expect(third!.newest).toBe(2); // and the one that is still newest
    expect(third!.to).toBe(join(dest, 'creek-sounds-pad-normalized-v1.wav'));
    expect(readdirSync(dest)).toHaveLength(2); // nothing minted
  });

  it('matching the newest version is not a revert', async () => {
    await exportLabels(root, ['//songs/creek/assets:pad'], { to: dest, runner });
    const [again] = await exportLabels(root, ['//songs/creek/assets:pad'], { to: dest, runner });
    expect(again!.unchanged).toBe(true);
    expect(again!.version).toBe(again!.newest); // same number: nothing to warn about
  });

  it('finds an identical older version even when a same-size one is newer', async () => {
    // The size pre-filter must not be able to end the search early: v2
    // has v1's exact length and different content, and v1 is still the
    // match.
    const [v1] = await exportLabels(root, ['//songs/creek/assets:pad'], { to: dest, runner });
    const sameSize = Buffer.from(readFileSync(v1!.to));
    sameSize[sameSize.length - 1] = sameSize[sameSize.length - 1]! ^ 0xff;
    writeFileSync(join(dest, 'creek-assets-pad-v2.wav'), sameSize);

    const [third] = await exportLabels(root, ['//songs/creek/assets:pad'], { to: dest, runner });
    expect(third!.unchanged).toBe(true);
    expect(third!.version).toBe(1);
    expect(third!.newest).toBe(2);
  });

  it('never touches a file it did not write', async () => {
    // Someone's own work, sitting on the Desktop under a name in the
    // family. Export must leave it exactly as it found it.
    const theirs = join(dest, 'creek-sounds-pad-normalized-v1.wav');
    writeFileSync(theirs, 'a mix I bounced by hand');
    await exportLabels(root, ['//songs/creek/sounds:pad-normalized'], { to: dest, runner });
    expect(readFileSync(theirs, 'utf8')).toBe('a mix I bounced by hand');
    expect(readdirSync(dest).sort()).toEqual([
      'creek-sounds-pad-normalized-v1.wav',
      'creek-sounds-pad-normalized-v2.wav',
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
