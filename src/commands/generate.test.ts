import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check } from './check.js';
import { createSong } from './create.js';
import { generateVariants } from './generate.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { sha256File, sha256Text } from '../hash.js';
import { loadProject } from '../model/project.js';
import { type GenerativeSound } from '../schema/index.js';

// The CLI seam: one `field generate` over two generators, and the first
// code in field that *writes* a content hash into a committed file rather
// than checking one somebody else wrote (voice-generation.md §1.3, §6).
//
// Two kinds of test here, on purpose. The option-shape group asserts that
// every wrong combination fails *before* a worker is spawned — the schema
// would reject the same recipe on the way to disk, but by then the model
// minutes are spent. The end-to-end group runs against the stub worker
// (src/testing/stub-worker.mjs) so the job actually sent and the recipe
// actually written are both observed; the wire protocol itself is covered
// the other way round, against the real daemons, in src/*/client.test.ts.

const stubWorker = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'testing',
  'stub-worker.mjs',
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-generate-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  process.env['FIELD_VOICED_PYTHON'] = stubWorker;
  process.env['FIELD_ACED_PYTHON'] = stubWorker;
});

afterEach(() => {
  delete process.env['FIELD_VOICED_PYTHON'];
  delete process.env['FIELD_ACED_PYTHON'];
  rmSync(root, { recursive: true, force: true });
});

const REF_BYTES = 'a three second recording of a voice\n';

// A committed reference recording, through the same `field import` a
// person would use — so the ledger entry under test is one the tool
// wrote, not one the test invented.
async function importReference(name = 'ref-voice', song = 'creek'): Promise<string> {
  const source = join(root, `${name}.wav`);
  writeFileSync(source, REF_BYTES);
  const result = await importAsset(root, song, source, name);
  rmSync(source);
  return join(root, 'songs', song, result.file);
}

function recipe(name: string, song = 'creek'): GenerativeSound {
  const sound = loadProject(root)
    .songs.find((s) => s.name === song)!
    .sounds.find((f) => f.data.name === name)!.data;
  expect(sound.type).toBe('generative');
  return sound as GenerativeSound;
}

// Everything the stub was asked for, in order. Both stubs log to one file
// beside their sockets, so a test that ran both generators would see both
// conversations — the ones below run one each.
function stubRequests(): Record<string, unknown>[] {
  return readFileSync(join(root, '.field/stub-requests.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('field generate: which generator, decided before anything spawns', () => {
  const voice = { song: 'creek', text: 'the water knows the way', seed: 7, variants: 2 };
  const music = { song: 'creek', prompt: 'warm keys', seed: 7, variants: 2, bars: 4 };

  it('refuses a recipe that is both kinds or neither', async () => {
    await expect(
      generateVariants(root, 'line', { ...voice, prompt: 'warm keys' }),
    ).rejects.toThrow('not both');
    await expect(
      generateVariants(root, 'line', { song: 'creek', seed: 7, variants: 2 }),
    ).rejects.toThrow('--prompt to generate music, or --text');
  });

  it('refuses a music flag on a voice line, naming the flag', async () => {
    // A voice recipe carrying `duration_seconds` declares a field its
    // generator ignores (voice-generation.md §6), and the schema says so
    // — but only once the audio exists. These say it first.
    await expect(generateVariants(root, 'line', { ...voice, bars: 4 })).rejects.toThrow(
      '--bars is a music option',
    );
    await expect(
      generateVariants(root, 'line', { ...voice, durationSeconds: 3 }),
    ).rejects.toThrow('--duration is a music option');
    await expect(generateVariants(root, 'line', { ...voice, bpm: 120 })).rejects.toThrow(
      '--bpm is a music option',
    );
    await expect(generateVariants(root, 'line', { ...voice, lyrics: 'la' })).rejects.toThrow(
      '--lyrics is a music option',
    );
  });

  it('refuses a voice flag on a music prompt', async () => {
    await expect(
      generateVariants(root, 'pad', { ...music, voiceRef: 'ref-voice' }),
    ).rejects.toThrow('--voice-ref is a voice option');
  });

  it('still asks music for exactly one length, and asks voice for none', async () => {
    const { bars: _bars, ...noLength } = music;
    await expect(generateVariants(root, 'pad', noLength)).rejects.toThrow(
      'exactly one of --bars or --duration',
    );
    await expect(
      generateVariants(root, 'pad', { ...music, durationSeconds: 10 }),
    ).rejects.toThrow('exactly one of --bars or --duration');
    // …and a voice line needs no tempo map at all: this song has one, so
    // the point is only that nothing asked for a length.
    const result = await generateVariants(root, 'line', voice);
    expect(result.durationSeconds).toBeUndefined();
    expect(recipe('line').duration_seconds).toBeUndefined();
  });
});

describe('field generate: resolving the voice a line is generated in', () => {
  const voice = { song: 'creek', text: 'the water knows the way', seed: 7, variants: 2 };

  it('refuses a reference that names nothing', async () => {
    await expect(generateVariants(root, 'line', { ...voice, voiceRef: 'ghost' })).rejects.toThrow(
      'voice_ref "ghost" is not a committed asset in creek',
    );
  });

  it('refuses a reference that names a sound rather than an asset', async () => {
    // The namespace holds both (project-layout.md §4.3), and `source:`
    // takes either — but a reference recording must be a committed asset,
    // because that is where the provenance comes from (§1.3). A generated
    // sound resolving here would be the #58 finding's other half.
    mkdirSync(join(root, 'songs/creek/sounds'), { recursive: true });
    writeFileSync(
      join(root, 'songs/creek/sounds/spoken.yaml'),
      'name: spoken\ntype: supercollider\nsource: tone.scd\nseed: 1\nduration: 1\n',
    );
    await expect(generateVariants(root, 'line', { ...voice, voiceRef: 'spoken' })).rejects.toThrow(
      'is not a committed asset',
    );
  });

  it("refuses another song's asset for a bare name", async () => {
    // A bare name is scoped to its song. One project-wide map is exactly
    // the bug #58 found on the verify side; the resolver and the verifier
    // share one lookup now, so this is the same fact seen from the write
    // side. The other song sorts *before* creek deliberately: with it
    // second, a resolver that ignored the scope and took the first match
    // would still land on creek and this would pass while proving
    // nothing.
    createSong(root, 'bank');
    await importReference('ref-voice', 'bank');
    await expect(
      generateVariants(root, 'line', { ...voice, voiceRef: 'ref-voice' }),
    ).rejects.toThrow('is not a committed asset in creek');
  });

  it('refuses an empty --voice-ref rather than reading it as absent', async () => {
    // The CLI end of the distinction the worker enforces (#60): "" is a
    // request for a reference recording at no name, not a request for the
    // model's own voice, and it fails here before the worker ever sees it.
    await expect(generateVariants(root, 'line', { ...voice, voiceRef: '' })).rejects.toThrow(
      'is not a committed asset',
    );
  });

  it('refuses a recording that has drifted from its ledger entry', async () => {
    // The refusal `field choose` already makes about a drifted variant.
    // Generating anyway would pin a hash to bytes the model never heard —
    // and pinning the *ledger's* hash instead would leave the recipe
    // check-green while describing the wrong recording entirely.
    const path = await importReference();
    writeFileSync(path, 'a different voice entirely\n');
    await expect(
      generateVariants(root, 'line', { ...voice, voiceRef: 'ref-voice' }),
    ).rejects.toThrow('does not match its recorded sha256');
  });

  it('pins the reference by name and hash, and hands the worker a path', async () => {
    const path = await importReference();
    const result = await generateVariants(root, 'line', { ...voice, voiceRef: 'ref-voice' });

    const written = recipe('line');
    expect(written.text).toBe(voice.text);
    expect(written.voice_ref).toBe('ref-voice');
    // The hash of the bytes actually read, which the ledger agrees with —
    // the equality is the point, so both sides are asserted.
    expect(written.voice_ref_sha256).toBe(sha256Text(REF_BYTES));
    expect(written.voice_ref_sha256).toBe(await sha256File(path));

    // The worker is handed a path, never an asset name: it has no project
    // to resolve one against (voice-generation.md §1.4).
    const job = stubRequests().find((r) => r['op'] === 'generate')!;
    expect(job['voice_ref']).toBe(path);
    expect(job['text']).toBe(voice.text);
    expect(result.voiceRef).toBe('ref-voice');

    expect((await check(root)).diagnostics).toEqual([]);
    expect((await check(root)).unformatted).toEqual([]);
  });

  it('resolves a shared reference by its full label', async () => {
    mkdirSync(join(root, 'shared/audio'), { recursive: true });
    writeFileSync(join(root, 'shared/audio/justin.wav'), REF_BYTES);
    writeFileSync(
      join(root, 'shared/assets.yaml'),
      `assets:\n  - name: justin\n    file: audio/justin.wav\n` +
        `    sha256: ${sha256Text(REF_BYTES)}\n    bytes: ${REF_BYTES.length}\n`,
    );
    await generateVariants(root, 'line', { ...voice, voiceRef: '//shared/asset:justin' });

    expect(recipe('line').voice_ref).toBe('//shared/asset:justin');
    expect(recipe('line').voice_ref_sha256).toBe(sha256Text(REF_BYTES));
    const job = stubRequests().find((r) => r['op'] === 'generate')!;
    expect(job['voice_ref']).toBe(join(root, 'shared/audio/justin.wav'));
    expect((await check(root)).diagnostics).toEqual([]);
  });

  it("omits voice_ref entirely for the model's own voice", async () => {
    // "" and absent are different requests (#60), and the recipe has the
    // same distinction: no key at all, not an empty one. This is the
    // configuration bloom generates with today (§6).
    await generateVariants(root, 'line', voice);
    const written = recipe('line');
    expect(written.voice_ref).toBeUndefined();
    expect(written.voice_ref_sha256).toBeUndefined();
    expect(readFileSync(join(root, 'songs/creek/sounds/line.yaml'), 'utf8')).not.toContain(
      'voice_ref',
    );
    const job = stubRequests().find((r) => r['op'] === 'generate')!;
    expect('voice_ref' in job).toBe(false);
    expect((await check(root)).diagnostics).toEqual([]);
  });
});

describe('field generate: what lands on disk', () => {
  const voice = { song: 'creek', text: 'the water knows the way', seed: 7, variants: 2 };

  it('lands variants in seed order, hashed as written, and check-green', async () => {
    const result = await generateVariants(root, 'line', voice);
    expect(result.files).toEqual([
      join('songs', 'creek', 'audio', 'line', '1.wav'),
      join('songs', 'creek', 'audio', 'line', '2.wav'),
    ]);
    expect(result.seeds).toEqual([7, 8]);

    const written = recipe('line');
    expect(written.model).toBe('field-voiced-stub');
    // Each variant's hash is of its own file: the stub writes distinct
    // bytes per seed, so a recipe that paired file 1 with file 2's hash
    // would fail here rather than at some later check.
    for (const [i, variant] of written.variants.entries()) {
      expect(variant.seed).toBe(7 + i);
      expect(variant.sha256).toBe(await sha256File(join(root, 'songs/creek', variant.file)));
      expect(variant.sha256).toBe(sha256Text(`stub audio seed=${7 + i}\n`));
    }
    const checked = await check(root);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.unformatted).toEqual([]);
  });

  it('routes music to field-aced and voice to field-voiced', async () => {
    // Same verb, different socket — which is the whole of the routing
    // decision (project-layout.md §1.7). The stub answers with the name
    // it was invoked as, and the client refuses a mismatch (#60), so a
    // generate that reached the wrong worker would not get this far.
    await generateVariants(root, 'line', voice);
    expect(recipe('line').model).toBe('field-voiced-stub');
    await generateVariants(root, 'pad', {
      song: 'creek',
      prompt: 'warm keys',
      seed: 3,
      variants: 1,
      bars: 2,
    });
    const pad = recipe('pad');
    expect(pad.model).toBe('field-aced-stub');
    expect(pad.prompt).toBe('warm keys');
    expect(pad.duration_seconds).toBeGreaterThan(0);
    expect((await check(root)).diagnostics).toEqual([]);
  });

  it('reports progress from the worker', async () => {
    const stages: string[] = [];
    await generateVariants(root, 'line', { ...voice, onProgress: (s) => stages.push(s) });
    expect(stages).toContain('stubbing');
  });
});
