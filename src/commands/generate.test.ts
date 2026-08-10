import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check } from './check.js';
import { createSong } from './create.js';
import { chooseVariant, generateVariants } from './generate.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { sha256File, sha256Text } from '../hash.js';
import { generatorName } from '../generators/stem.js';
import { loadProject } from '../model/project.js';
import { type GenerativeEntry, type GenerativeTakes } from '../schema/index.js';

// The CLI seam: one `field generate` over two generators, and the first
// code in field that *writes* a content hash into a committed file rather
// than checking one somebody else wrote (voice-generation.md §1.3, §6).
//
// Two kinds of test here, on purpose. The option-shape group asserts that
// every wrong combination fails *before* a worker is spawned — the schema
// would reject the same request on the way to disk, but by then the model
// minutes are spent. The end-to-end group runs against the stub worker
// (src/testing/stub-worker.mjs) so the job actually sent and the file
// actually written are both observed; the wire protocol itself is covered
// the other way round, against the real daemons, in src/*/client.test.ts.
//
// Requests live as `generative:` entries in tracks (nested-tracks.md §18,
// decision 12 — `sounds/` retired): filling targets an entry by its gen
// node name, and a brand-new name scaffolds a leaf track carrying it.

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

// The request as the project reads it: the generative entry minting this
// gen node name, wherever it lives.
function entryOf(name: string, song = 'creek'): GenerativeEntry {
  const loaded = loadProject(root).songs.find((s) => s.name === song)!;
  for (const track of loaded.tracks) {
    for (const entry of track.data.inputs) {
      if (entry.generative !== undefined && generatorName(entry, track.data.name) === name) {
        return entry.generative;
      }
    }
  }
  throw new Error(`no generative entry "${name}" in ${song}`);
}

// The run-recorded half, beside the audio (bloom-in-tree.md §7).
function takesOf(name: string, song = 'creek'): GenerativeTakes {
  const takes = loadProject(root)
    .songs.find((s) => s.name === song)!
    .genTakes.get(name);
  expect(takes).toBeDefined();
  return takes!.data;
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

  it('refuses a request that is both kinds or neither', async () => {
    await expect(
      generateVariants(root, 'line', { ...voice, prompt: 'warm keys' }),
    ).rejects.toThrow('not both');
    await expect(
      generateVariants(root, 'line', { song: 'creek', seed: 7, variants: 2 }),
    ).rejects.toThrow('--prompt to generate music, or --text');
  });

  it('refuses a music flag on a voice line, naming the flag', async () => {
    // A voice request carrying `duration_seconds` declares a field its
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
    // The delivery knobs are voice-only for the same reason a music
    // request may not carry `voice_ref`: a field its generator ignores is
    // a request describing something that did not happen.
    await expect(
      generateVariants(root, 'pad', { ...music, exaggeration: 0.3 }),
    ).rejects.toThrow('--exaggeration is a voice option');
    await expect(
      generateVariants(root, 'pad', { ...music, conviction: 0.3 }),
    ).rejects.toThrow('--conviction is a voice option');
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
    expect(entryOf('line').duration_seconds).toBeUndefined();
  });
});

describe('field generate: resolving the voice a line is generated in', () => {
  const voice = { song: 'creek', text: 'the water knows the way', seed: 7, variants: 2 };

  it('refuses a reference that names nothing', async () => {
    await expect(generateVariants(root, 'line', { ...voice, voiceRef: 'ghost' })).rejects.toThrow(
      'voice_ref "ghost" is not a committed asset in creek',
    );
  });

  it('refuses a reference that names a render rather than an asset', async () => {
    // A reference recording must be a committed asset, because that is
    // where the provenance comes from (§1.3). A generator's node
    // resolving here would be the #58 finding's other half.
    mkdirSync(join(root, 'songs/creek/tracks'), { recursive: true });
    writeFileSync(
      join(root, 'songs/creek/tracks/spoken.yaml'),
      'name: spoken\ninputs:\n  - supercollider:\n      source: tone.scd\n      seed: 1\n      duration: 1\n',
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

  it('refuses a name that two ledger rows answer to', async () => {
    // A ledger with two `ref-voice` rows is schema-valid and check-red,
    // but generation never reads diagnostics — so before this it took
    // whichever row sorted first and wrote that arbitrary choice down as
    // provenance (#61 review). Different bytes per row, so "the first
    // one" is a genuinely different recording, not a tie.
    const other = 'a different voice entirely\n';
    writeFileSync(join(root, 'songs/creek/audio/a.wav'), REF_BYTES);
    writeFileSync(join(root, 'songs/creek/audio/b.wav'), other);
    writeFileSync(
      join(root, 'songs/creek/assets.yaml'),
      `assets:\n  - name: ref-voice\n    file: audio/a.wav\n` +
        `    sha256: ${sha256Text(REF_BYTES)}\n    bytes: ${REF_BYTES.length}\n` +
        `  - name: ref-voice\n    file: audio/b.wav\n` +
        `    sha256: ${sha256Text(other)}\n    bytes: ${other.length}\n`,
    );
    await expect(
      generateVariants(root, 'line', { ...voice, voiceRef: 'ref-voice' }),
    ).rejects.toThrow('matches 2 rows in the creek ledger');
  });

  it('refuses an ambiguous shared name too', async () => {
    mkdirSync(join(root, 'shared/audio'), { recursive: true });
    const other = 'a different voice entirely\n';
    writeFileSync(join(root, 'shared/audio/a.wav'), REF_BYTES);
    writeFileSync(join(root, 'shared/audio/b.wav'), other);
    writeFileSync(
      join(root, 'shared/assets.yaml'),
      `assets:\n  - name: justin\n    file: audio/a.wav\n` +
        `    sha256: ${sha256Text(REF_BYTES)}\n    bytes: ${REF_BYTES.length}\n` +
        `  - name: justin\n    file: audio/b.wav\n` +
        `    sha256: ${sha256Text(other)}\n    bytes: ${other.length}\n`,
    );
    await expect(
      generateVariants(root, 'line', { ...voice, voiceRef: '//shared/asset:justin' }),
    ).rejects.toThrow('matches 2 rows in the shared ledger');
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
    // and pinning the *ledger's* hash instead would leave the request
    // check-green while describing the wrong recording entirely.
    const path = await importReference();
    writeFileSync(path, 'a different voice entirely\n');
    await expect(
      generateVariants(root, 'line', { ...voice, voiceRef: 'ref-voice' }),
    ).rejects.toThrow('does not match its recorded sha256');
  });

  it('generates from the bytes it pins, even if the recording changes mid-run', async () => {
    // The window is real: the CLI resolves the reference, then the worker
    // reads it minutes later, after daemon start and a weights download.
    // Edit the recording inside that window and put it back afterwards
    // and every after-the-fact check compares equal — the project ends
    // check-green describing bytes the model never heard (#61 review).
    // So the test edits *inside* the window, with the stub holding at the
    // read, and asserts on what the worker actually hashed.
    const path = await importReference();
    const hold = join(root, 'hold');
    process.env['FIELD_STUB_HOLD'] = hold;
    const reach = async (mark: string) => {
      for (let i = 0; i < 400 && !existsSync(`${hold}.${mark}`); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(`${hold}.${mark}`)).toBe(true);
    };
    try {
      const running = generateVariants(root, 'line', { ...voice, voiceRef: 'ref-voice' });
      const other = 'a completely different voice\n';
      // Swap the recording under the worker, let it read…
      await reach('ready');
      writeFileSync(path, other);
      writeFileSync(`${hold}.go`, '');
      // …and put it back before generate returns, which is what makes a
      // post-generation re-hash useless as a defence: by the time
      // anything could compare, the file is the original again and every
      // comparison passes. Only the bytes the worker read tell the truth.
      await reach('read');
      writeFileSync(path, REF_BYTES);
      writeFileSync(`${hold}.resume`, '');
      await running;

      const heard = stubRequests().find((r) => r['op'] === 'read')!;
      expect(heard['voice_ref_sha256']).toBe(sha256Text(REF_BYTES));
      expect(heard['voice_ref_sha256']).not.toBe(sha256Text(other));
      expect(entryOf('line').voice_ref_sha256).toBe(heard['voice_ref_sha256']);
      // And the path handed over was never the asset itself — that is
      // what made the swap a no-op rather than something to detect.
      const job = stubRequests().find((r) => r['op'] === 'generate')!;
      expect(job['voice_ref']).not.toBe(path);
      expect((await check(root)).diagnostics).toEqual([]);
    } finally {
      delete process.env['FIELD_STUB_HOLD'];
    }
  });

  it('leaves no snapshot behind', async () => {
    await importReference();
    const before = readdirSync(tmpdir()).filter((e) => e.startsWith('field-voice-ref-'));
    await generateVariants(root, 'line', { ...voice, voiceRef: 'ref-voice' });
    const after = readdirSync(tmpdir()).filter((e) => e.startsWith('field-voice-ref-'));
    expect(after).toEqual(before);
  });

  it('pins the reference by name and hash, and hands the worker a path', async () => {
    const path = await importReference();
    const result = await generateVariants(root, 'line', { ...voice, voiceRef: 'ref-voice' });

    const written = entryOf('line');
    expect(written.text).toBe(voice.text);
    expect(written.voice_ref).toBe('ref-voice');
    // The hash of the bytes actually read, which the ledger agrees with —
    // the equality is the point, so both sides are asserted.
    expect(written.voice_ref_sha256).toBe(sha256Text(REF_BYTES));
    expect(written.voice_ref_sha256).toBe(await sha256File(path));

    // The worker is handed a path, never an asset name: it has no project
    // to resolve one against (voice-generation.md §1.4). A snapshot of
    // the recording rather than the recording itself, and so outside the
    // project entirely — but carrying the bytes the request pins.
    const job = stubRequests().find((r) => r['op'] === 'generate')!;
    expect(typeof job['voice_ref']).toBe('string');
    expect(job['voice_ref']).not.toBe(path);
    expect(job['voice_ref'] as string).not.toContain(root);
    expect(stubRequests().find((r) => r['op'] === 'read')!['voice_ref_sha256']).toBe(
      written.voice_ref_sha256,
    );
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

    expect(entryOf('line').voice_ref).toBe('//shared/asset:justin');
    expect(entryOf('line').voice_ref_sha256).toBe(sha256Text(REF_BYTES));
    // Snapshotted like a song-scoped one, and of the shared recording's
    // bytes rather than some same-named song asset's.
    const job = stubRequests().find((r) => r['op'] === 'generate')!;
    expect(job['voice_ref'] as string).not.toContain(root);
    expect(stubRequests().find((r) => r['op'] === 'read')!['voice_ref_sha256']).toBe(
      sha256Text(REF_BYTES),
    );
    expect((await check(root)).diagnostics).toEqual([]);
  });

  it("omits voice_ref entirely for the model's own voice", async () => {
    // "" and absent are different requests (#60), and the entry has the
    // same distinction: no key at all, not an empty one. This is the
    // configuration bloom generates with today (§6).
    await generateVariants(root, 'line', voice);
    const written = entryOf('line');
    expect(written.voice_ref).toBeUndefined();
    expect(written.voice_ref_sha256).toBeUndefined();
    expect(readFileSync(join(root, 'songs/creek/tracks/line.yaml'), 'utf8')).not.toContain(
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

    const takes = takesOf('line');
    // Provenance is per take, because it describes a run and a request
    // accumulates several (bloom-in-tree.md §3).
    expect(takes.variants.map((v) => v.model)).toEqual([
      'field-voiced-stub',
      'field-voiced-stub',
    ]);
    // Generating chooses the first take, so the gen node resolves without
    // a second command — `choose` switches, it does not enable.
    expect(takes.chosen).toBe(1);
    // Each variant's hash is of its own file: the stub writes distinct
    // bytes per seed, so a takes file that paired file 1 with file 2's
    // hash would fail here rather than at some later check.
    for (const [i, variant] of takes.variants.entries()) {
      expect(variant.seed).toBe(7 + i);
      expect(variant.generated_at).toBe(takes.variants[0]!.generated_at);
      expect(variant.sha256).toBe(await sha256File(join(root, 'songs/creek', variant.file)));
      expect(variant.sha256).toBe(sha256Text(`stub audio seed=${7 + i}\n`));
    }
    const checked = await check(root);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.unformatted).toEqual([]);
  });

  it('scaffolds a leaf track for a brand-new request', async () => {
    // The create path's file is a track like any other — the shape every
    // request lives in (nested-tracks.md §18, decision 12) — and it must
    // be exactly the file a person would write: no defaulted placement
    // noise, canonical order, check-green.
    const result = await generateVariants(root, 'line', voice);
    expect(result.recipePath).toBe(join('songs', 'creek', 'tracks', 'line.yaml'));
    const raw = readFileSync(join(root, 'songs/creek/tracks/line.yaml'), 'utf8');
    expect(raw).toContain('name: line');
    expect(raw).toContain('generative:');
    expect(raw).toContain('text: the water knows the way');
    expect(raw).not.toContain('anchor:'); // defaults stay unwritten
    expect((await check(root)).unformatted).toEqual([]);
  });

  it('routes music to field-aced and voice to field-voiced', async () => {
    // Same verb, different socket — which is the whole of the routing
    // decision (project-layout.md §1.7). The stub answers with the name
    // it was invoked as, and the client refuses a mismatch (#60), so a
    // generate that reached the wrong worker would not get this far.
    await generateVariants(root, 'line', voice);
    expect(takesOf('line').variants[0]!.model).toBe('field-voiced-stub');
    await generateVariants(root, 'pad', {
      song: 'creek',
      prompt: 'warm keys',
      seed: 3,
      variants: 1,
      bars: 2,
    });
    expect(takesOf('pad').variants[0]!.model).toBe('field-aced-stub');
    const pad = entryOf('pad');
    expect(pad.prompt).toBe('warm keys');
    expect(pad.duration_seconds).toBeGreaterThan(0);
    expect((await check(root)).diagnostics).toEqual([]);
  });

  it('sends the delivery knobs and records them, translating only at the worker', async () => {
    // `conviction` is our name end to end — schema, protocol and wire —
    // and becomes `cfg_weight` inside the adapter, which is the boundary
    // where Chatterbox's vocabulary starts (voice-generation.md §8).
    await generateVariants(root, 'line', { ...voice, exaggeration: 0.3, conviction: 0.3 });
    const job = stubRequests().find((r) => r['op'] === 'generate')!;
    expect(job['exaggeration']).toBe(0.3);
    expect(job['conviction']).toBe(0.3);
    expect('cfg_weight' in job).toBe(false);

    const written = entryOf('line');
    expect(written.exaggeration).toBe(0.3);
    expect(written.conviction).toBe(0.3);
    expect((await check(root)).diagnostics).toEqual([]);
    expect((await check(root)).unformatted).toEqual([]);
  });

  it('omits them entirely when unset, rather than pinning a default', async () => {
    // Absent means "whatever the model does", which is not the same as
    // the number the model happens to default to today. Writing 0.5 down
    // would silently pin it if Chatterbox ever moved.
    await generateVariants(root, 'line', voice);
    const job = stubRequests().find((r) => r['op'] === 'generate')!;
    expect('exaggeration' in job).toBe(false);
    expect('conviction' in job).toBe(false);
    const raw = readFileSync(join(root, 'songs/creek/tracks/line.yaml'), 'utf8');
    expect(raw).not.toContain('exaggeration');
    expect(raw).not.toContain('conviction');
  });

  it('reports progress from the worker, and says who is starting first', async () => {
    const stages: string[] = [];
    await generateVariants(root, 'line', { ...voice, onProgress: (s) => stages.push(s) });
    // The first line arrives before the worker exists: daemon boot,
    // python import and model load can be a silent minute, and a silent
    // minute reads as a hang (session finding).
    expect(stages[0]).toBe('starting field-voiced — the first progress line can take a minute');
    expect(stages).toContain('stubbing');
  });
});

// The half that makes an example project possible (bloom-in-tree.md §3):
// requests ship without audio, and whoever clones generates their own
// takes into them. The request stops being flags on a command line and
// becomes the file — which is also why nothing here passes --text.
describe('field generate: filling a leaf that shipped without takes', () => {
  const TAKELESS =
    'name: topline\ninputs:\n  - generative:\n      text: the water knows the way\n';
  const run = { song: 'creek', seed: 7, variants: 2 };

  function writeLeaf(yaml: string): void {
    mkdirSync(join(root, 'songs/creek/tracks'), { recursive: true });
    writeFileSync(join(root, 'songs/creek/tracks/topline.yaml'), yaml);
  }

  it('takes the request from the entry and fills it in place, comments intact', async () => {
    writeLeaf(`# generate your own — nobody's creek is anybody else's\n${TAKELESS}`);
    const result = await generateVariants(root, 'topline', run);
    expect(result.files).toHaveLength(2);

    // The comment surviving is the point: a shipped request explains
    // itself, and the fill path never touches the file at all.
    const raw = readFileSync(join(root, 'songs/creek/tracks/topline.yaml'), 'utf8');
    expect(raw).toContain("# generate your own — nobody's creek is anybody else's");

    expect(entryOf('topline').text).toBe('the water knows the way');
    const takes = takesOf('topline');
    expect(takes.chosen).toBe(1);
    expect(takes.variants.map((v) => v.seed)).toEqual([7, 8]);
    expect((await check(root)).diagnostics).toEqual([]);
  });

  it('refuses a flag that would be a second answer to what the entry says', async () => {
    writeLeaf(TAKELESS);
    await expect(
      generateVariants(root, 'topline', { ...run, text: 'a different line' }),
    ).rejects.toThrow('the entry already says what to generate, so --text');
    // Nothing was spent: the refusal is pre-flight, and the same run
    // without the flag still works.
    expect(existsSync(join(root, 'songs/creek/audio/topline'))).toBe(false);
    await generateVariants(root, 'topline', run);
    expect(takesOf('topline').variants).toHaveLength(2);
  });

  it('fills a music entry that carries both lengths', async () => {
    // What `field generate` itself writes: the seconds it ran at, and the
    // bars it was asked for. The flag rule is exactly one, so passing both
    // through would make an ordinary request unfillable — with advice
    // naming flags that filling refuses, which is a closed loop.
    writeLeaf(
      'name: topline\ninputs:\n  - generative:\n      prompt: warm keys\n      bpm: 96\n' +
        '      duration_seconds: 10\n      bars: 4\n',
    );
    await generateVariants(root, 'topline', run);
    expect(takesOf('topline').variants).toHaveLength(2);
    expect((await check(root)).diagnostics).toEqual([]);
  });

  it('refuses to scaffold over a track that already exists', async () => {
    // A track whose file name does not mint this gen node name is not
    // fillable — and creating would overwrite the file. Refused by name
    // rather than clobbered.
    writeLeaf('name: topline\ninputs: []\n');
    await expect(generateVariants(root, 'topline', { ...run, text: 'a line' })).rejects.toThrow(
      '"topline" is already a track in creek',
    );
    expect(existsSync(join(root, 'songs/creek/audio/topline'))).toBe(false);
  });

  it('leaves the leaf byte-identical, writing the takes beside the audio', async () => {
    // The reason for the split (bloom-in-tree.md §7): a shipped request is
    // committed, and generating into it made using the tool as documented
    // produce a diff. Bytes, not just content — a re-emit that happened to
    // round-trip would still rewrite comments and key order.
    writeLeaf(`# generate your own\n${TAKELESS}`);
    const leafPath = join(root, 'songs/creek/tracks/topline.yaml');
    const before = readFileSync(leafPath);
    await generateVariants(root, 'topline', run);
    expect(readFileSync(leafPath).equals(before)).toBe(true);

    // …and the takes went to their own file, beside the WAVs they pin.
    expect(existsSync(join(root, 'songs/creek/audio/topline/variants.yaml'))).toBe(true);
    expect(takesOf('topline').chosen).toBe(1);
    expect(takesOf('topline').variants).toHaveLength(2);

    // Choosing is the same promise: it moves a line in the takes file and
    // the track file still does not change.
    await chooseVariant(root, 'topline', { song: 'creek', variant: 2 });
    expect(readFileSync(leafPath).equals(before)).toBe(true);
    expect(takesOf('topline').chosen).toBe(2);
    expect((await check(root)).diagnostics).toEqual([]);
  });

  it('refuses to run over takes that already exist', async () => {
    writeLeaf(TAKELESS);
    await generateVariants(root, 'topline', run);
    // The trigger policy (project-layout.md §1.2): re-running would
    // replace chosen audio under the project's feet. Filling an empty
    // request is the one thing that opened up, not regeneration.
    await expect(generateVariants(root, 'topline', { ...run, seed: 9 })).rejects.toThrow(
      'already has 2 takes',
    );
    expect(takesOf('topline').variants.map((v) => v.seed)).toEqual([7, 8]);
  });
});

describe('field generate: entry mechanics (nested-tracks.md §18 step 3)', () => {
  // The request lives in a track's inputs:, addressed by its gen node
  // name; the run writes gen-keyed takes and must leave every authored
  // file byte-identical.
  function writeGenLeaf(): void {
    mkdirSync(join(root, 'songs/creek/tracks'), { recursive: true });
    writeFileSync(
      join(root, 'songs/creek/tracks/rain-pad.yaml'),
      'name: rain-pad\ninputs:\n  - generative:\n      prompt: soft rain over a warm pad\n' +
        '      bpm: 96\n      duration_seconds: 10\n',
    );
  }

  it('fills by gen node name and leaves the track file untouched', async () => {
    writeGenLeaf();
    const trackPath = join(root, 'songs/creek/tracks/rain-pad.yaml');
    const before = readFileSync(trackPath, 'utf8');
    const result = await generateVariants(root, 'rain-pad', {
      song: 'creek',
      seed: 7,
      variants: 2,
    });
    expect(result.recipePath).toBe('songs/creek/tracks/rain-pad.yaml');
    // The design constraint, asserted at the byte level: generating
    // changes nothing about the track file.
    expect(readFileSync(trackPath, 'utf8')).toBe(before);
    const takes = readFileSync(
      join(root, 'songs/creek/audio/rain-pad/variants.yaml'),
      'utf8',
    );
    expect(takes).toContain('gen: rain-pad');
    expect(takes).toContain('chosen: 1');
    expect(takes).not.toContain('sound:');
    expect((await check(root)).diagnostics).toEqual([]);
  });

  it('refuses flags that second-guess the entry', async () => {
    writeGenLeaf();
    await expect(
      generateVariants(root, 'rain-pad', { song: 'creek', seed: 7, variants: 2, prompt: 'x' }),
    ).rejects.toThrow('the entry already says what to generate');
  });

  it('refuses to refill an entry that has takes', async () => {
    writeGenLeaf();
    await generateVariants(root, 'rain-pad', { song: 'creek', seed: 7, variants: 1 });
    await expect(
      generateVariants(root, 'rain-pad', { song: 'creek', seed: 9, variants: 1 }),
    ).rejects.toThrow('already has 1 take');
  });

  it('refuses to fill an entry whose name an asset owns', async () => {
    // Reached only by hand-editing (import and check both refuse the
    // collision), but generate must still not spend the run: the model
    // minutes go first, and the takes would land in — and renameSync
    // into — the directory the ledger's files live in.
    writeGenLeaf();
    const src = join(root, 'clash.wav');
    writeFileSync(src, 'asset bytes');
    await importAsset(root, 'creek', src, 'other');
    rmSync(src);
    const assetsPath = join(root, 'songs/creek/assets.yaml');
    writeFileSync(
      assetsPath,
      readFileSync(assetsPath, 'utf8').replaceAll('other', 'rain-pad'),
    );
    await expect(
      generateVariants(root, 'rain-pad', { song: 'creek', seed: 7, variants: 1 }),
    ).rejects.toThrow('is also an asset in creek');
    // The refusal came before the worker: nothing was asked to generate.
    expect(existsSync(join(root, '.field/stub-requests.ndjson'))).toBe(false);
  });

  it('a supercollider node is built, not generated', async () => {
    mkdirSync(join(root, 'songs/creek/tracks'), { recursive: true });
    writeFileSync(
      join(root, 'songs/creek/tracks/kit.yaml'),
      'name: kit\ninputs:\n  - supercollider:\n      source: kit.scd\n      seed: 1\n      duration: 2\n',
    );
    await expect(
      generateVariants(root, 'kit', { song: 'creek', seed: 7, variants: 1 }),
    ).rejects.toThrow('built by a rule, not generated');
  });

  it('choosing repoints the gen-keyed takes and nothing else', async () => {
    writeGenLeaf();
    await generateVariants(root, 'rain-pad', { song: 'creek', seed: 7, variants: 2 });
    const result = await chooseVariant(root, 'rain-pad', { song: 'creek', variant: 2 });
    expect(result.previous).toBe(1);
    const takes = readFileSync(
      join(root, 'songs/creek/audio/rain-pad/variants.yaml'),
      'utf8',
    );
    expect(takes).toContain('gen: rain-pad');
    expect(takes).toContain('chosen: 2');
    expect((await check(root)).diagnostics).toEqual([]);
  });

  it('choose refuses a takes file that attaches elsewhere', async () => {
    // A stale pre-fold sound:-keyed file would otherwise get `chosen`
    // rewritten and a success report, while the loader rejects the
    // file and the graph never sees the choice.
    writeGenLeaf();
    await generateVariants(root, 'rain-pad', { song: 'creek', seed: 7, variants: 2 });
    const takesPath = join(root, 'songs/creek/audio/rain-pad/variants.yaml');
    const raw = readFileSync(takesPath, 'utf8');
    writeFileSync(takesPath, raw.replace('gen: rain-pad', 'sound: rain-pad'));
    await expect(
      chooseVariant(root, 'rain-pad', { song: 'creek', variant: 2 }),
    ).rejects.toThrow('rename sound: to gen:');
    expect(readFileSync(takesPath, 'utf8')).toContain('chosen: 1');
  });

  it('choosing an unknown name says so', async () => {
    await expect(
      chooseVariant(root, 'ghost', { song: 'creek', variant: 1 }),
    ).rejects.toThrow('no generative request "ghost" in creek');
  });
});
