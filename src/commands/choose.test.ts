import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check } from './check.js';
import { createSong } from './create.js';
import { init } from './init.js';
import { chooseVariant } from './generate.js';
import { resolvePlayables } from './play.js';
import { sha256Text } from '../hash.js';
import { loadProject } from '../model/project.js';
import { generateTargetSchema, targetOrder, type GenerateTarget } from '../schema/index.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

// Deliberate targets as project citizens (project-layout.md §1.4): loaded
// from targets/ beside the buildable rules, validated, hash-verified,
// playable pre-promotion, and promoted by `bloom choose` into assets.yaml
// without moving bytes.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bloom-choose-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'opener');
  writeGenerateTarget('keys', ['fake wav one', 'fake wav two']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The recipe a real `bloom generate` would leave behind, via the same
// schema+canonicalize path the command uses: variants in audio/<name>/,
// the target in targets/<name>.yaml.
function writeGenerateTarget(name: string, variantContents: string[]): void {
  const songDir = join(root, 'songs/opener');
  mkdirSync(join(songDir, 'audio', name), { recursive: true });
  mkdirSync(join(songDir, 'targets'), { recursive: true });
  const variants = variantContents.map((content, i) => {
    const file = `audio/${name}/${i + 1}.wav`;
    writeFileSync(join(songDir, file), content);
    return { file, seed: 90210 + i, sha256: sha256Text(content) };
  });
  const recipe = generateTargetSchema.parse({
    name,
    rule: 'generate',
    model: 'acestep-v15-turbo',
    prompt: 'warm keys over still water',
    bpm: 96,
    duration_seconds: 10,
    bars: 4,
    seed: 90210,
    variants,
    generated_at: '2026-08-05T21:00:00.000Z',
  });
  const doc = new Document(recipe);
  canonicalizeDocument(doc, targetOrder);
  writeFileSync(join(songDir, 'targets', `${name}.yaml`), stringifyDocument(doc));
}

function loadedGenerate(): GenerateTarget {
  const target = loadProject(root).songs[0]!.targets[0]!.data;
  expect(target.rule).toBe('generate');
  return target as GenerateTarget;
}

describe('generate targets in the project model', () => {
  it('loads, validates, and formats canonically', async () => {
    const result = await check(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.unformatted).toEqual([]);
    expect(loadedGenerate().variants).toHaveLength(2);
  });

  it('diagnoses name/filename mismatch, dangling files, and bad chosen', async () => {
    const recipePath = join(root, 'songs/opener/targets/keys.yaml');
    const raw = readFileSync(recipePath, 'utf8');
    writeFileSync(recipePath, raw.replace('name: keys', 'name: pads'));
    expect((await check(root)).diagnostics.some((d) => d.message.includes('must match filename'))).toBe(true);

    writeFileSync(recipePath, raw.replace('audio/keys/2.wav', 'audio/keys/missing.wav'));
    expect((await check(root)).diagnostics.some((d) => d.message.includes('file not found'))).toBe(true);

    writeFileSync(recipePath, raw.replace('seed: 90210\n', 'seed: 90210\nchosen: 5\n'));
    expect(
      (await check(root)).diagnostics.some((d) => d.message.includes('chosen variant 5')),
    ).toBe(true);
  });

  it('rejects variant paths outside audio/<name>/', async () => {
    // choose's same-target prefix guard assumes containment (#18 review,
    // re-based on audio/<name>/ by project-layout.md §1.4).
    const escapee = join(root, 'songs/opener/escapee.wav');
    writeFileSync(escapee, 'fake wav one');
    const recipePath = join(root, 'songs/opener/targets/keys.yaml');
    const raw = readFileSync(recipePath, 'utf8');
    writeFileSync(recipePath, raw.replace('audio/keys/1.wav', 'escapee.wav'));
    expect(
      (await check(root)).diagnostics.some((d) =>
        d.message.includes('must live in audio/keys/'),
      ),
    ).toBe(true);
  });

  it('check catches variant content drift', async () => {
    writeFileSync(join(root, 'songs/opener/audio/keys/1.wav'), 'tampered');
    const result = await check(root);
    expect(
      result.diagnostics.some((d) => d.message.includes('does not match its recorded sha256')),
    ).toBe(true);
  });

  it('variants are playable pre-promotion under the targets package', async () => {
    const playables = await resolvePlayables(root, ['//songs/opener/targets:keys-2']);
    expect(playables).toHaveLength(1);
    expect(playables[0]!.path).toBe(join(root, 'songs/opener/audio/keys/2.wav'));
  });

  it('clips may not source a deliberate target directly', async () => {
    writeFileSync(
      join(root, 'songs/opener/tracks/piano.yaml'),
      'name: piano\ntype: audio\nclips:\n  - id: intro\n    target: keys\n    position: 0\n    duration: 960\n',
    );
    const project = loadProject(root);
    expect(
      project.diagnostics.some((d) => d.message.includes('sources deliberate target "keys"')),
    ).toBe(true);
  });
});

describe('bloom choose', () => {
  it('promotes a variant in place and annotates the recipe', async () => {
    const result = await chooseVariant(root, 'keys', { song: 'opener', variant: 1 });
    expect(result).toMatchObject({
      assetName: 'keys',
      file: 'audio/keys/1.wav',
      sha256: sha256Text('fake wav one'),
      replaced: false,
    });

    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);
    const song = project.songs[0]!;
    expect(song.assets!.data.assets).toEqual([
      {
        name: 'keys',
        file: 'audio/keys/1.wav',
        sha256: sha256Text('fake wav one'),
        bytes: 'fake wav one'.length,
      },
    ]);
    expect(loadedGenerate().chosen).toBe(1);
    // Both rewritten files must still be canonically formatted.
    expect((await check(root)).unformatted).toEqual([]);
  });

  it('promoted variants are clip-referenceable', async () => {
    await chooseVariant(root, 'keys', { song: 'opener', variant: 1 });
    writeFileSync(
      join(root, 'songs/opener/tracks/piano.yaml'),
      'name: piano\ntype: audio\nclips:\n  - id: intro\n    asset: keys\n    position: 0\n    duration: 960\n',
    );
    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);
  });

  it('re-choose moves the reference and never duplicates', async () => {
    await chooseVariant(root, 'keys', { song: 'opener', variant: 1 });
    const result = await chooseVariant(root, 'keys', { song: 'opener', variant: 2 });
    expect(result.replaced).toBe(true);

    const song = loadProject(root).songs[0]!;
    expect(song.assets!.data.assets).toHaveLength(1);
    expect(song.assets!.data.assets[0]!.file).toBe('audio/keys/2.wav');
    expect(loadedGenerate().chosen).toBe(2);
  });

  it('never clobbers an unrelated asset; --as names around it', async () => {
    writeFileSync(
      join(root, 'songs/opener/audio/keys.wav'),
      'unrelated recorded keys',
    );
    writeFileSync(
      join(root, 'songs/opener/assets.yaml'),
      `assets:\n  - name: keys\n    file: audio/keys.wav\n    sha256: ${sha256Text('unrelated recorded keys')}\n    bytes: 22\n`,
    );
    await expect(chooseVariant(root, 'keys', { song: 'opener', variant: 1 })).rejects.toThrow(
      'not a promotion of this target',
    );

    const result = await chooseVariant(root, 'keys', { song: 'opener', variant: 1, as: 'keys-gen' });
    expect(result.assetName).toBe('keys-gen');
    expect(loadProject(root).diagnostics).toEqual([]);
  });

  it('rejects non-slug target and song names before building any path', async () => {
    await expect(chooseVariant(root, '../other', { song: 'opener', variant: 1 })).rejects.toThrow(
      'lowercase-slug',
    );
    await expect(chooseVariant(root, 'keys', { song: '../opener', variant: 1 })).rejects.toThrow(
      'lowercase-slug',
    );
  });

  it('refuses out-of-range variants and drifted content', async () => {
    await expect(chooseVariant(root, 'keys', { song: 'opener', variant: 3 })).rejects.toThrow(
      'variant 3 does not exist',
    );
    writeFileSync(join(root, 'songs/opener/audio/keys/1.wav'), 'tampered');
    await expect(chooseVariant(root, 'keys', { song: 'opener', variant: 1 })).rejects.toThrow(
      'refusing to promote',
    );
  });

  it('refuses promoting the same file under a second name', async () => {
    await chooseVariant(root, 'keys', { song: 'opener', variant: 1 });
    await expect(
      chooseVariant(root, 'keys', { song: 'opener', variant: 1, as: 'keys-two' }),
    ).rejects.toThrow('already promoted as asset "keys"');
  });

  it('refuses choosing on a buildable target', async () => {
    writeFileSync(
      join(root, 'songs/opener/targets/verse.yaml'),
      'name: verse\nrule: say\ntext: hello\nvoice: Siri\n',
    );
    await expect(chooseVariant(root, 'verse', { song: 'opener', variant: 1 })).rejects.toThrow(
      'only deliberate generate targets',
    );
  });
});
