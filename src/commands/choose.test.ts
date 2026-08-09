import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check } from './check.js';
import { createSong } from './create.js';
import { init } from './init.js';
import { chooseVariant, generateVariants } from './generate.js';
import { importAsset } from './import.js';
import { resolvePlayables } from './play.js';
import { sha256Text } from '../hash.js';
import { loadProject } from '../model/project.js';
import {
  generativeSoundSchema,
  generativeTakesOrder,
  generativeTakesSchema,
  soundOrder,
  TAKES_FILENAME,
  type GenerativeSound,
} from '../schema/index.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

// Deliberate sounds as project citizens (project-layout.md §1.4, §4):
// loaded from sounds/ beside the buildable types, validated,
// hash-verified, every variant auditionable, and `field choose`
// repointing what the sound's own label resolves to — clips reference
// the sound by name, so nothing is ever copied into a ledger.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-choose-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'opener');
  writeGenerateSound('keys', ['fake wav one', 'fake wav two']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Takes on disk with nothing chosen, written through the same
// schema+canonicalize path the command uses: variants in audio/<name>/,
// the sound in sounds/<name>.yaml. `field generate` no longer leaves this
// state — it chooses its first take — so reaching it means a hand edit,
// which is exactly the state the guards below are for.
function writeGenerateSound(name: string, variantContents: string[]): void {
  const songDir = join(root, 'songs/opener');
  mkdirSync(join(songDir, 'audio', name), { recursive: true });
  mkdirSync(join(songDir, 'sounds'), { recursive: true });
  const variants = variantContents.map((content, i) => {
    const file = `audio/${name}/${i + 1}.wav`;
    writeFileSync(join(songDir, file), content);
    return {
      file,
      model: 'acestep-v15-turbo',
      seed: 90210 + i,
      sha256: sha256Text(content),
      generated_at: '2026-08-05T21:00:00.000Z',
    };
  });
  const recipe = generativeSoundSchema.parse({
    name,
    type: 'generative',
    prompt: 'warm keys over still water',
    bpm: 96,
    duration_seconds: 10,
    bars: 4,
  });
  const doc = new Document(recipe);
  canonicalizeDocument(doc, soundOrder);
  writeFileSync(join(songDir, 'sounds', `${name}.yaml`), stringifyDocument(doc));
  // Two files, as on disk: the request in sounds/, the takes beside the
  // audio they pin (bloom-in-tree.md §7).
  const takes = new Document(generativeTakesSchema.parse({ sound: name, variants }));
  canonicalizeDocument(takes, generativeTakesOrder);
  writeFileSync(join(songDir, 'audio', name, TAKES_FILENAME), stringifyDocument(takes));
}

// The fixture's takes file, which most of these tests edit rather than the
// recipe now that the two are separate (bloom-in-tree.md §7).
const takesPath = () => join(root, 'songs/opener/audio/keys', TAKES_FILENAME);

function loadedGenerate(): GenerativeSound {
  const sound = loadProject(root).songs[0]!.sounds[0]!.data;
  expect(sound.type).toBe('generative');
  return sound as GenerativeSound;
}

const clipYaml = (source: string) =>
  `name: piano\ntype: audio\nclips:\n  - id: intro\n    source: ${source}\n    position: 0\n    duration: 960\n`;

describe('generative sounds in the project model', () => {
  it('loads, validates, and formats canonically', async () => {
    const result = await check(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.unformatted).toEqual([]);
    expect(loadedGenerate().variants).toHaveLength(2);
  });

  it('diagnoses name/filename mismatch, dangling files, and bad chosen', async () => {
    const recipePath = join(root, 'songs/opener/sounds/keys.yaml');
    const recipe = readFileSync(recipePath, 'utf8');
    writeFileSync(recipePath, recipe.replace('name: keys', 'name: pads'));
    expect((await check(root)).diagnostics.some((d) => d.message.includes('must match filename'))).toBe(true);
    writeFileSync(recipePath, recipe);

    // The rest are properties of the takes, so they are edited there —
    // the recipe no longer carries a variant list to break
    // (bloom-in-tree.md §7).
    const raw = readFileSync(takesPath(), 'utf8');
    writeFileSync(takesPath(), raw.replace('audio/keys/2.wav', 'audio/keys/missing.wav'));
    expect((await check(root)).diagnostics.some((d) => d.message.includes('file not found'))).toBe(true);

    writeFileSync(takesPath(), raw.replace('variants:', 'chosen: 5\nvariants:'));
    expect(
      (await check(root)).diagnostics.some((d) => d.message.includes('chosen variant 5')),
    ).toBe(true);
    writeFileSync(takesPath(), raw);

    // And a takes file that names a different sound than the directory it
    // sits in, which is the split's own version of the filename rule.
    writeFileSync(takesPath(), raw.replace('sound: keys', 'sound: pads'));
    expect(
      (await check(root)).diagnostics.some((d) =>
        d.message.includes('must match the directory audio/keys/'),
      ),
    ).toBe(true);
    writeFileSync(takesPath(), raw);
  });

  it('rejects variant paths outside audio/<name>/', async () => {
    // choose's repoint and the graph's resolution both assume containment
    // (#18 review, re-based on audio/<name>/ by project-layout.md §1.4).
    const escapee = join(root, 'songs/opener/escapee.wav');
    writeFileSync(escapee, 'fake wav one');
    const raw = readFileSync(takesPath(), 'utf8');
    writeFileSync(takesPath(), raw.replace('audio/keys/1.wav', 'escapee.wav'));
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

  it('variants are auditionable by number under the sounds package', async () => {
    const playables = await resolvePlayables(root, ['//songs/opener/sound:keys-2']);
    expect(playables).toHaveLength(1);
    expect(playables[0]!.path).toBe(join(root, 'songs/opener/audio/keys/2.wav'));
  });

  it('an unchosen sound is not referenceable — clips are told to choose', () => {
    writeFileSync(join(root, 'songs/opener/tracks/piano.yaml'), clipYaml('keys'));
    expect(
      loadProject(root).diagnostics.some((d) =>
        d.message.includes('no chosen variant yet — field choose keys first'),
      ),
    ).toBe(true);
  });

  it('a takeless recipe is a request, and check says the project is fine', async () => {
    // The other half of the rule above, and the one the example project
    // depends on (bloom-in-tree.md §3): a recipe whose takes do not exist
    // yet is well-formed, and a clip may reference it. `check` answers
    // "is this project coherent", not "is this machine ready" — so it
    // stays quiet here and `build` is what refuses.
    writeFileSync(
      join(root, 'songs/opener/sounds/topline.yaml'),
      'name: topline\ntype: generative\ntext: the water knows the way\n',
    );
    writeFileSync(join(root, 'songs/opener/tracks/piano.yaml'), clipYaml('topline'));
    const result = await check(root);
    expect(result.diagnostics).toEqual([]);
    // Not by accident of the name being unknown: a genuinely unknown
    // source is still an error, which is what tells the two apart.
    writeFileSync(join(root, 'songs/opener/tracks/piano.yaml'), clipYaml('ghost'));
    expect(
      (await check(root)).diagnostics.some((d) => d.message.includes('unknown source "ghost"')),
    ).toBe(true);
  });

  it('a sound may not shadow an asset: one namespace per song', async () => {
    writeFileSync(join(root, 'songs/opener/audio/keys.wav'), 'recorded keys');
    writeFileSync(
      join(root, 'songs/opener/assets.yaml'),
      `assets:\n  - name: keys\n    file: audio/keys.wav\n    sha256: ${sha256Text('recorded keys')}\n    bytes: ${'recorded keys'.length}\n`,
    );
    expect(
      loadProject(root).diagnostics.some((d) =>
        d.message.includes('collides with an asset of the same name'),
      ),
    ).toBe(true);
  });

  it('import pre-flights the namespace: sound names and audition labels refuse', async () => {
    // The #31 review's asymmetry, closed from the import side: without
    // the guard the copy succeeds and check goes red afterwards.
    const src = join(root, 'water.wav');
    writeFileSync(src, 'not really a wav');
    await expect(importAsset(root, 'opener', src, 'keys')).rejects.toThrow('one namespace');
    await expect(importAsset(root, 'opener', src, 'keys-2')).rejects.toThrow('one namespace');
    // A free name passes the namespace gate.
    const result = await importAsset(root, 'opener', src, 'rain');
    expect(result.name).toBe('rain');
  });

  it('generate pre-flights the audition labels its variants would mint', async () => {
    // A sound named keys-1 exists (the variant label of "keys" would be
    // fine — "keys" itself is taken — so test a fresh name whose -N
    // label collides).
    writeFileSync(
      join(root, 'songs/opener/sounds/other-2.yaml'),
      'name: other-2\ntype: reverb\nsource: keys\n',
    );
    await expect(
      generateVariants(root, 'other', {
        song: 'opener',
        prompt: 'water',
        seed: 1,
        bars: 1,
        variants: 2,
      }),
    ).rejects.toThrow('"other-2" is already a name');
  });
});

describe('field choose', () => {
  it('repoints the sound to a variant and annotates the recipe', async () => {
    const result = await chooseVariant(root, 'keys', { song: 'opener', variant: 1 });
    expect(result).toMatchObject({
      file: 'audio/keys/1.wav',
      sha256: sha256Text('fake wav one'),
      bytes: 'fake wav one'.length,
    });
    expect(result.previous).toBeUndefined();

    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);
    // No ledger entry: the sound file itself pins its variants.
    expect(project.songs[0]!.assets).toBeUndefined();
    expect(loadedGenerate().chosen).toBe(1);
    // The rewritten file must still be canonically formatted.
    expect((await check(root)).unformatted).toEqual([]);
  });

  it('a chosen sound resolves by its own label and is clip-referenceable', async () => {
    await chooseVariant(root, 'keys', { song: 'opener', variant: 2 });

    const playables = await resolvePlayables(root, ['//songs/opener/sound:keys']);
    expect(playables[0]!.path).toBe(join(root, 'songs/opener/audio/keys/2.wav'));

    writeFileSync(join(root, 'songs/opener/tracks/piano.yaml'), clipYaml('keys'));
    expect(loadProject(root).diagnostics).toEqual([]);
  });

  it('re-choose moves what the label means — a one-line diff', async () => {
    await chooseVariant(root, 'keys', { song: 'opener', variant: 1 });
    const result = await chooseVariant(root, 'keys', { song: 'opener', variant: 2 });
    expect(result.previous).toBe(1);
    expect(loadedGenerate().chosen).toBe(2);

    const playables = await resolvePlayables(root, ['//songs/opener/sound:keys']);
    expect(playables[0]!.path).toBe(join(root, 'songs/opener/audio/keys/2.wav'));
  });

  it('rejects non-slug sound and song names before building any path', async () => {
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
      'refusing to choose',
    );
  });

  it('refuses choosing on a buildable sound', async () => {
    writeFileSync(
      join(root, 'songs/opener/sounds/verse.yaml'),
      'name: verse\ntype: reverb\nsource: keys\n',
    );
    await expect(chooseVariant(root, 'verse', { song: 'opener', variant: 1 })).rejects.toThrow(
      'only deliberate generative sounds',
    );
  });
});
