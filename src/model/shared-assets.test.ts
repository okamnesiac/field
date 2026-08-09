import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLabels, queryDeps } from '../commands/build.js';
import { check } from '../commands/check.js';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { loadProject } from '../model/project.js';
import type { GeneratorRunner } from '../graph/build.js';

// The shared scope end to end (project-layout.md §1.5–1.6):
// shared/assets.yaml pins committed material, //shared/asset:<name> is
// the one cross-scope reference clips may make, and visibility is
// enforced — a bare name can only mean the song's own ledger.

let root: string;

// A tiny valid 48 kHz 16-bit mono WAV (100 samples of silence).
function wavBytes(): Buffer {
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
  return Buffer.concat([header, data]);
}

const clipTrack = (sourceRef: string) =>
  [
    'name: drums',
    'type: audio',
    'clips:',
    '  - id: c1',
    `    source: ${sourceRef}`,
    '    anchor: absolute',
    '    position: 0',
    '    duration: 100',
    '',
  ].join('\n');

function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-shared-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  createTrack(root, 'creek', 'drums', 'audio');
  const wav = wavBytes();
  writeFileSync(join(root, 'shared/samples/rain.wav'), wav);
  writeFileSync(
    join(root, 'shared/assets.yaml'),
    `assets:\n  - name: rain\n    file: samples/rain.wav\n` +
      `    sha256: ${sha256OfBytes(wav)}\n    bytes: ${wav.length}\n`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the shared ledger', () => {
  it('loads, validates, and hash-verifies against the shared scope root', async () => {
    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);
    expect(project.shared!.data.assets[0]!.name).toBe('rain');
    expect((await check(root)).diagnostics).toEqual([]);
  });

  it('diagnoses dangling files and content drift', async () => {
    writeFileSync(
      join(root, 'shared/assets.yaml'),
      'assets:\n  - name: ghost\n    file: samples/ghost.wav\n' +
        `    sha256: ${'deadbeef'.repeat(8)}\n    bytes: 1\n`,
    );
    expect(loadProject(root).diagnostics.some((d) => d.message.includes('file not found'))).toBe(
      true,
    );

    writeFileSync(join(root, 'shared/samples/rain.wav'), 'tampered longer than before');
    const wav = wavBytes();
    writeFileSync(
      join(root, 'shared/assets.yaml'),
      `assets:\n  - name: rain\n    file: samples/rain.wav\n` +
        `    sha256: ${sha256OfBytes(wav)}\n    bytes: ${wav.length}\n`,
    );
    expect(
      (await check(root)).diagnostics.some((d) => d.message.includes('bytes on disk')),
    ).toBe(true);
  });
});

describe('cross-scope clip references', () => {
  it('a clip plays a shared asset through the full label, wired into the graph', async () => {
    writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), clipTrack('//shared/asset:rain'));
    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);

    expect(queryDeps(root, 'deps(//songs/creek/track:drums)')).toEqual([
      '//shared/asset:rain',
      '//songs/creek/track:drums',
    ]);

    const runs: string[] = [];
    const runner: GeneratorRunner = async (node, inputPaths, outputPath) => {
      runs.push(node.label.name);
      // The stem's input path resolves into shared/.
      expect(inputPaths[0]).toBe(join(root, 'shared/samples/rain.wav'));
      writeFileSync(outputPath, 'out');
    };
    await buildLabels(root, ['//songs/creek/track:drums'], runner);
    expect(runs).toEqual(['drums']);
  });

  it('unknown shared assets are diagnosed by name', () => {
    writeFileSync(join(root, 'songs/creek/tracks/drums.yaml'), clipTrack('//shared/asset:ghost'));
    expect(
      loadProject(root).diagnostics.some((d) =>
        d.message.includes('references unknown shared asset "ghost"'),
      ),
    ).toBe(true);
  });

  it('no spelling reaches another song: only bare names and //shared/asset:', () => {
    createSong(root, 'opener');
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      clipTrack('//songs/opener/asset:borrowed'),
    );
    // Rejected at the schema layer — the ref shape admits the song's own
    // names (bare or track:) and the one cross-scope spelling, //shared/asset:.
    expect(
      loadProject(root).diagnostics.some((d) =>
        d.message.includes('must be a name in the song, track:<name>, or //shared/asset:<name>'),
      ),
    ).toBe(true);
  });

  it('shared sources loop-tile at their own length', async () => {
    mkdirSync(join(root, 'songs/creek/tracks'), { recursive: true });
    writeFileSync(
      join(root, 'songs/creek/tracks/drums.yaml'),
      [
        'name: drums',
        'type: audio',
        'clips:',
        '  - id: c1',
        '    source: //shared/asset:rain',
        '    anchor: absolute',
        '    position: 0',
        '    duration: 300',
        '    loop:',
        '      enabled: true',
        '      fade: 0',
        '',
      ].join('\n'),
    );
    // Tiling at source length needs the shared file's frame count; a
    // diagnostic-free load proves the lookup crossed the scope.
    expect(loadProject(root).diagnostics).toEqual([]);
  });
});

describe('the old layout is diagnosed, not ignored', () => {
  it('names each legacy file and where its contents went', () => {
    writeFileSync(join(root, 'songs/creek/targets.yaml'), 'targets: []\n');
    writeFileSync(join(root, 'songs/creek/mix.yaml'), 'mixes: []\n');
    mkdirSync(join(root, 'songs/creek/generation'), { recursive: true });
    const messages = loadProject(root).diagnostics.map((d) => `${d.file}: ${d.message}`);
    expect(messages.some((m) => m.includes('targets.yaml') && m.includes('sounds/'))).toBe(true);
    // Still named, now pointed at the output track: mixes/ retired too, so
    // the old advice would have been a second dead end.
    expect(messages.some((m) => m.includes('mix.yaml') && m.includes('track named "main"'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('generation') && m.includes('audio/'))).toBe(true);
  });
});

