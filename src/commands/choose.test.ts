import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check } from './check.js';
import { createSong } from './create.js';
import { init } from './init.js';
import { chooseVariant, generateVariants } from './generate.js';
import { explainLabel } from './build.js';
import { importAsset } from './import.js';
import { resolvePlayables } from './play.js';
import { sha256Text } from '../hash.js';
import { loadProject } from '../model/project.js';
import {
  generativeTakesOrder,
  generativeTakesSchema,
  TAKES_FILENAME,
  type GenerativeTakes,
} from '../schema/index.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

// Generative requests as project citizens (project-layout.md §1.4, §4):
// a leaf track carries the request, the takes beside the audio pin the
// committed variants, every variant is auditionable, and `field choose`
// repoints what the gen node's label resolves to — placements reference
// the track, so nothing is ever copied into a ledger. (These lived in
// sounds/ until nested-tracks.md §18 decision 12 folded them in.)

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-choose-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'opener');
  writeGenerateLeaf('keys', ['fake wav one', 'fake wav two'], { chosen: 1 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A generative leaf with takes on disk, written through the same
// schema+canonicalize path the command uses: the request in
// tracks/<name>.yaml, variants in audio/<name>/. `chosen` is settable
// because some guards below are about the unchosen state, which no
// command produces — `field generate` chooses its first take — so
// reaching it means a hand edit.
function writeGenerateLeaf(
  name: string,
  variantContents: string[],
  opts: { chosen?: number } = {},
): void {
  const songDir = join(root, 'songs/opener');
  mkdirSync(join(songDir, 'audio', name), { recursive: true });
  mkdirSync(join(songDir, 'tracks'), { recursive: true });
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
  writeFileSync(
    join(songDir, 'tracks', `${name}.yaml`),
    `name: ${name}\ninputs:\n  - generative:\n      prompt: warm keys over still water\n` +
      `      bpm: 96\n      duration_seconds: 10\n      bars: 4\n`,
  );
  const takes = new Document(
    generativeTakesSchema.parse({ gen: name, ...(opts.chosen !== undefined ? { chosen: opts.chosen } : {}), variants }),
  );
  canonicalizeDocument(takes, generativeTakesOrder);
  writeFileSync(join(songDir, 'audio', name, TAKES_FILENAME), stringifyDocument(takes));
}

// The fixture's takes file, which most of these tests edit — the request
// and the takes are separate files (bloom-in-tree.md §7).
const takesPath = () => join(root, 'songs/opener/audio/keys', TAKES_FILENAME);

function loadedTakes(name = 'keys'): GenerativeTakes {
  const takes = loadProject(root).songs[0]!.genTakes.get(name);
  expect(takes).toBeDefined();
  return takes!.data;
}

const placementYaml = (source: string) =>
  `name: piano\ninputs:\n  - id: intro\n    track: ${source}\n    at: 0\n    duration: 960\n`;

describe('generative requests in the project model', () => {
  it('loads, validates, and formats canonically', async () => {
    const result = await check(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.unformatted).toEqual([]);
    expect(loadedTakes().variants).toHaveLength(2);
  });

  it('fmt sees a noncanonical takes file (#105 review)', async () => {
    // The takes file is a schema-validated project file, so it is fmt's
    // to cover — it was invisible to allFiles until the gen-takes fix,
    // valid YAML in the wrong canonical order sailing through as
    // "already canonical".
    const raw = readFileSync(takesPath(), 'utf8');
    // Same data with `gen:` moved to the end — valid, non-canonical.
    writeFileSync(takesPath(), raw.replace('gen: keys\n', '') + 'gen: keys\n');
    const result = await check(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.unformatted).toContain('songs/opener/audio/keys/variants.yaml');
  });

  it('diagnoses name/filename mismatch, dangling files, and bad chosen', async () => {
    const leafPath = join(root, 'songs/opener/tracks/keys.yaml');
    const leaf = readFileSync(leafPath, 'utf8');
    writeFileSync(leafPath, leaf.replace('name: keys', 'name: pads'));
    expect((await check(root)).diagnostics.some((d) => d.message.includes('must match filename'))).toBe(true);
    writeFileSync(leafPath, leaf);

    const raw = readFileSync(takesPath(), 'utf8');
    writeFileSync(takesPath(), raw.replace('audio/keys/2.wav', 'audio/keys/missing.wav'));
    expect((await check(root)).diagnostics.some((d) => d.message.includes('file not found'))).toBe(true);

    writeFileSync(takesPath(), raw.replace('chosen: 1', 'chosen: 5'));
    expect(
      (await check(root)).diagnostics.some((d) => d.message.includes('chosen variant 5')),
    ).toBe(true);
    writeFileSync(takesPath(), raw);

    // And a takes file that names a different gen node than the directory
    // it sits in, which is the split's own version of the filename rule.
    writeFileSync(takesPath(), raw.replace('gen: keys', 'gen: pads'));
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

  it('explain answers which take is chosen, of how many', async () => {
    // The readout for "which variant are we using": the node the
    // request's own label resolves to names its choice, the take count,
    // and the committed file. The alternatives were reading raw YAML or
    // inferring the number from a build line's filename — explain is the
    // command whose job this is, and it knew the file all along.
    const e = await explainLabel(root, '//songs/opener/gen:keys');
    expect(e.choice).toEqual({ chosen: 1, takes: 2 });
    expect(e.file).toBe('audio/keys/1.wav');
    // An audition node names its own file but carries no choice — it is
    // one take, not the choosing.
    const take = await explainLabel(root, '//songs/opener/gen:keys-2');
    expect(take.choice).toBeUndefined();
    expect(take.file).toBe('audio/keys/2.wav');
  });

  it('variants are auditionable by number under the gen package', async () => {
    const playables = await resolvePlayables(root, ['//songs/opener/gen:keys-2']);
    expect(playables).toHaveLength(1);
    expect(playables[0]!.path).toBe(join(root, 'songs/opener/audio/keys/2.wav'));
  });

  it('takes with nothing picked are diagnosed — choose is named', () => {
    writeGenerateLeaf('hum', ['fake wav'], {});
    const diags = loadProject(root).diagnostics;
    expect(
      diags.some((d) => d.message.includes('no chosen variant yet — field choose hum first')),
    ).toBe(true);
  });

  it('a takeless request is a request, and check says the project is fine', async () => {
    // The one the example project depends on (bloom-in-tree.md §3): a
    // request whose takes do not exist yet is well-formed, and a
    // placement may reference its track. `check` answers "is this
    // project coherent", not "is this machine ready" — so it stays quiet
    // here and `build` is what refuses.
    writeFileSync(
      join(root, 'songs/opener/tracks/topline.yaml'),
      'name: topline\ninputs:\n  - generative:\n      text: the water knows the way\n',
    );
    writeFileSync(join(root, 'songs/opener/tracks/piano.yaml'), placementYaml('topline'));
    const result = await check(root);
    expect(result.diagnostics).toEqual([]);
    // Not by accident of the name being unknown: a genuinely unknown
    // placement is still an error, which is what tells the two apart.
    writeFileSync(join(root, 'songs/opener/tracks/piano.yaml'), placementYaml('ghost'));
    expect(
      (await check(root)).diagnostics.some((d) => d.message.includes('unknown track "ghost"')),
    ).toBe(true);
  });

  it('a generative entry may not mint an asset\'s name: one directory per claimant', async () => {
    writeFileSync(join(root, 'songs/opener/audio/keys.wav'), 'recorded keys');
    writeFileSync(
      join(root, 'songs/opener/assets.yaml'),
      `assets:\n  - name: keys\n    file: audio/keys.wav\n    sha256: ${sha256Text('recorded keys')}\n    bytes: ${'recorded keys'.length}\n`,
    );
    expect(
      loadProject(root).diagnostics.some((d) =>
        d.message.includes('both claim audio/keys/'),
      ),
    ).toBe(true);
  });

  it('import pre-flights the namespace: a gen node name refuses', async () => {
    // The #31 review's asymmetry, closed from the import side: without
    // the guard the copy succeeds and check goes red afterwards. The
    // audition labels live in the gen: package and reserve nothing here —
    // an asset named keys-2 claims audio/keys-2/, not audio/keys/.
    const src = join(root, 'water.wav');
    writeFileSync(src, 'not really a wav');
    await expect(importAsset(root, 'opener', src, 'keys')).rejects.toThrow('one namespace');
    // A free name passes the namespace gate.
    const result = await importAsset(root, 'opener', src, 'rain');
    expect(result.name).toBe('rain');
  });

  it('generate pre-flights the audition labels its variants would mint', async () => {
    // A generator named other-2 exists, so generating "other" with two
    // variants would mint gen:other-2 as an audition label over it.
    writeFileSync(
      join(root, 'songs/opener/tracks/other-2.yaml'),
      'name: other-2\ninputs:\n  - supercollider:\n      source: keys.scd\n      seed: 1\n      duration: 1\n',
    );
    await expect(
      generateVariants(root, 'other', {
        song: 'opener',
        prompt: 'water',
        seed: 1,
        bars: 1,
        variants: 2,
      }),
    ).rejects.toThrow('"other-2" is already a generator name');
  });
});

describe('field choose', () => {
  it('repoints the gen node to a variant', async () => {
    writeGenerateLeaf('hum', ['hum one', 'hum two'], {});
    const result = await chooseVariant(root, 'hum', { song: 'opener', variant: 1 });
    expect(result).toMatchObject({
      file: 'audio/hum/1.wav',
      sha256: sha256Text('hum one'),
      bytes: 'hum one'.length,
    });
    expect(result.previous).toBeUndefined();

    const project = loadProject(root);
    expect(project.diagnostics).toEqual([]);
    // No ledger entry: the takes file itself pins its variants.
    expect(project.songs[0]!.assets).toBeUndefined();
    expect(loadedTakes('hum').chosen).toBe(1);
    // The rewritten file must still be canonically formatted.
    expect((await check(root)).unformatted).toEqual([]);
  });

  it('a chosen gen node resolves by its own label and is placeable', async () => {
    await chooseVariant(root, 'keys', { song: 'opener', variant: 2 });

    const playables = await resolvePlayables(root, ['//songs/opener/gen:keys']);
    expect(playables[0]!.path).toBe(join(root, 'songs/opener/audio/keys/2.wav'));

    writeFileSync(join(root, 'songs/opener/tracks/piano.yaml'), placementYaml('keys'));
    expect(loadProject(root).diagnostics).toEqual([]);
  });

  it('re-choose moves what the label means — a one-line diff', async () => {
    await chooseVariant(root, 'keys', { song: 'opener', variant: 1 });
    const result = await chooseVariant(root, 'keys', { song: 'opener', variant: 2 });
    expect(result.previous).toBe(1);
    expect(loadedTakes().chosen).toBe(2);

    const playables = await resolvePlayables(root, ['//songs/opener/gen:keys']);
    expect(playables[0]!.path).toBe(join(root, 'songs/opener/audio/keys/2.wav'));
  });

  it('rejects non-slug names before building any path', async () => {
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

  it('refuses choosing on a supercollider generator', async () => {
    writeFileSync(
      join(root, 'songs/opener/tracks/verse.yaml'),
      'name: verse\ninputs:\n  - supercollider:\n      source: keys.scd\n      seed: 1\n      duration: 1\n',
    );
    await expect(chooseVariant(root, 'verse', { song: 'opener', variant: 1 })).rejects.toThrow(
      'built by a rule, and has no takes to choose',
    );
  });
});
