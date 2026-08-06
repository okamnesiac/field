import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check } from './check.js';
import { createSong } from './create.js';
import { init } from './init.js';
import { aceChoose } from './ace.js';
import { resolvePlayables } from './play.js';
import { sha256Text } from '../hash.js';
import { loadProject } from '../model/project.js';
import { generationRecipeOrder, generationRecipeSchema } from '../schema/schemas.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

// Generation recipes as project citizens (ace-generation.md §4.2): loaded,
// validated, hash-verified, playable pre-promotion, and promoted by
// `bloom ace choose` into assets.yaml without moving bytes.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bloom-ace-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'opener');
  writeGeneration('keys', ['fake wav one', 'fake wav two']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The recipe a real `bloom ace generate` would leave behind, via the same
// schema+canonicalize path the command uses.
function writeGeneration(name: string, variantContents: string[]): void {
  const generationDir = join(root, 'songs/opener/generation');
  mkdirSync(join(generationDir, name), { recursive: true });
  const variants = variantContents.map((content, i) => {
    const file = `${name}/${name}-${i + 1}.wav`;
    writeFileSync(join(generationDir, file), content);
    return { file, seed: 90210 + i, sha256: sha256Text(content) };
  });
  const recipe = generationRecipeSchema.parse({
    name,
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
  canonicalizeDocument(doc, generationRecipeOrder);
  writeFileSync(join(generationDir, `${name}.yaml`), stringifyDocument(doc));
}

describe('generation recipes in the project model', () => {
  it('loads, validates, and formats canonically', async () => {
    const result = await check(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.unformatted).toEqual([]);
    const project = loadProject(root);
    expect(project.songs[0]!.generation).toHaveLength(1);
    expect(project.songs[0]!.generation[0]!.data.variants).toHaveLength(2);
  });

  it('diagnoses name/filename mismatch, dangling files, and bad chosen', async () => {
    const recipePath = join(root, 'songs/opener/generation/keys.yaml');
    const raw = readFileSync(recipePath, 'utf8');
    writeFileSync(recipePath, raw.replace('name: keys', 'name: pads'));
    expect((await check(root)).diagnostics.some((d) => d.message.includes('must match filename'))).toBe(true);

    writeFileSync(recipePath, raw.replace('keys/keys-2.wav', 'keys/missing.wav'));
    expect((await check(root)).diagnostics.some((d) => d.message.includes('file not found'))).toBe(true);

    writeFileSync(recipePath, raw.replace('seed: 90210\n', 'seed: 90210\nchosen: 5\n'));
    expect(
      (await check(root)).diagnostics.some((d) => d.message.includes('chosen variant 5')),
    ).toBe(true);
  });

  it('check catches variant content drift', async () => {
    writeFileSync(join(root, 'songs/opener/generation/keys/keys-1.wav'), 'tampered');
    const result = await check(root);
    expect(
      result.diagnostics.some((d) => d.message.includes('does not match its recorded sha256')),
    ).toBe(true);
  });

  it('variants are playable pre-promotion', async () => {
    const playables = await resolvePlayables(root, ['//songs/opener/generation:keys-2']);
    expect(playables).toHaveLength(1);
    expect(playables[0]!.path).toBe(join(root, 'songs/opener/generation/keys/keys-2.wav'));
  });
});

describe('bloom ace choose', () => {
  it('promotes a variant in place and annotates the recipe', async () => {
    const result = await aceChoose(root, 'keys', { song: 'opener', variant: 1 });
    expect(result).toMatchObject({
      assetName: 'keys',
      file: 'generation/keys/keys-1.wav',
      sha256: sha256Text('fake wav one'),
      replaced: false,
    });

    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);
    const song = project.songs[0]!;
    expect(song.assets!.data.assets).toEqual([
      {
        name: 'keys',
        file: 'generation/keys/keys-1.wav',
        sha256: sha256Text('fake wav one'),
        bytes: 'fake wav one'.length,
      },
    ]);
    expect(song.generation[0]!.data.chosen).toBe(1);
    // Both rewritten files must still be canonically formatted.
    expect((await check(root)).unformatted).toEqual([]);
  });

  it('promoted variants are clip-referenceable', async () => {
    await aceChoose(root, 'keys', { song: 'opener', variant: 1 });
    writeFileSync(
      join(root, 'songs/opener/tracks/piano.yaml'),
      'name: piano\ntype: audio\nclips:\n  - id: intro\n    asset: keys\n    position: 0\n    duration: 960\n',
    );
    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);
  });

  it('re-choose moves the reference and never duplicates', async () => {
    await aceChoose(root, 'keys', { song: 'opener', variant: 1 });
    const result = await aceChoose(root, 'keys', { song: 'opener', variant: 2 });
    expect(result.replaced).toBe(true);

    const song = loadProject(root).songs[0]!;
    expect(song.assets!.data.assets).toHaveLength(1);
    expect(song.assets!.data.assets[0]!.file).toBe('generation/keys/keys-2.wav');
    expect(song.generation[0]!.data.chosen).toBe(2);
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
    await expect(aceChoose(root, 'keys', { song: 'opener', variant: 1 })).rejects.toThrow(
      'not a promotion of this generation',
    );

    const result = await aceChoose(root, 'keys', { song: 'opener', variant: 1, as: 'keys-gen' });
    expect(result.assetName).toBe('keys-gen');
    expect(loadProject(root).diagnostics).toEqual([]);
  });

  it('refuses out-of-range variants and drifted content', async () => {
    await expect(aceChoose(root, 'keys', { song: 'opener', variant: 3 })).rejects.toThrow(
      'variant 3 does not exist',
    );
    writeFileSync(join(root, 'songs/opener/generation/keys/keys-1.wav'), 'tampered');
    await expect(aceChoose(root, 'keys', { song: 'opener', variant: 1 })).rejects.toThrow(
      'refusing to promote',
    );
  });

  it('refuses promoting the same file under a second name', async () => {
    await aceChoose(root, 'keys', { song: 'opener', variant: 1 });
    await expect(
      aceChoose(root, 'keys', { song: 'opener', variant: 1, as: 'keys-two' }),
    ).rejects.toThrow('already promoted as asset "keys"');
  });
});
