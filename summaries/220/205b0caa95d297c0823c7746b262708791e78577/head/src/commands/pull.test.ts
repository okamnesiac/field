import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLabels } from './build.js';
import { LFS_FILTER_CONFIG } from './clone.js';
import { createSong } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { pull } from './pull.js';
import { push } from './push.js';
import { git } from '../git.js';
import { fileStore } from '../remote/credentials.js';
import { fakeRemote, type FakeRemote } from '../testing/fake-remote.js';
import type { GeneratorRunner } from '../graph/build.js';

// The other direction of push.test.ts: the author pushes with the offer,
// and a plain `git clone` elsewhere, which warmed nothing, pulls with
// `field pull` and gets the warm for its HEAD.

let tmp: string;
let source: string;
let bare: string;
let work: string; // the plain clone
let branch: string;
let remote: FakeRemote;

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

const copyingRunner: GeneratorRunner = async (_node, inputPaths, outputPath) => {
  copyFileSync(inputPaths[0]!, outputPath);
};
const refusingRunner: GeneratorRunner = async (node) => {
  throw new Error(`rendered ${node.label.name}, which a warmed checkout must never do`);
};

// The setup below builds the source, commits it, pushes it to a bare
// remote, and clones that, one git or git-lfs process after another,
// and two of the three tests then pull. Process starts on the windows
// CI runner stall now and then, and one stall pushed the hook past
// vitest's 10 s hook default. Nothing here measures how fast pull is,
// so the hook and every test get room to finish, as in clone.test.ts.
const GIT_HEAVY_MS = 30_000;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'field-pull-'));
  source = join(tmp, 'source');
  init({ dir: source, name: 'chemicals' });
  createSong(source, 'creek');
  const wav = join(tmp, 'pad.wav');
  writeWav(wav);
  await importAsset(source, 'creek', wav, 'pad');
  writeFileSync(
    join(source, 'songs/creek/tracks/pad-eq.yaml'),
    'name: pad-eq\ninserts:\n  - effect: eq\n    bands:\n      - type: lowpass\n        frequency: 700\ninputs:\n  - audio: pad\n',
  );
  writeFileSync(join(source, 'songs/creek/tracks/main.yaml'), 'name: main\ninputs:\n  - track: pad-eq\n');
  await buildLabels(source, ['//songs/creek/track:main'], copyingRunner);
  git(['add', '-A'], { cwd: source });
  git(['-c', 'user.name=field-test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'chemicals'], {
    cwd: source,
  });
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: source });
  bare = join(tmp, 'remotes', 'howlo', 'chemicals.git');
  mkdirSync(join(tmp, 'remotes', 'howlo'), { recursive: true });
  git(['init', '-q', '--bare', bare], { cwd: tmp });
  // The remote as a file URL, built by pathToFileURL rather than by
  // prefixing "file://": on Windows the prefix gives file://C:\..., which
  // git-lfs cannot parse ("batch request: missing protocol").
  git(['remote', 'add', 'origin', pathToFileURL(bare).href], { cwd: source });

  remote = await fakeRemote();
  remote.addProject('howlo/chemicals', { clone_url: pathToFileURL(bare).href, default_branch: branch, visibility: 'public' });
  await push({
    cwd: source,
    gitArgs: ['-u', 'origin', branch],
    out: () => {},
    env: { FIELD_REMOTE: remote.url, FIELD_TOKEN: remote.token },
    store: fileStore(join(tmp, 'credentials')),
    interactive: false,
  });

  // A plain clone, with the LFS filters so committed audio arrives where
  // git-lfs is present, and no warm.
  work = join(tmp, 'work');
  git(['clone', '-q', ...LFS_FILTER_CONFIG.flatMap(([k, v]) => ['-c', `${k}=${v}`]), pathToFileURL(bare).href, work], { cwd: tmp });
}, GIT_HEAVY_MS);

afterEach(async () => {
  await remote.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('field pull', { timeout: GIT_HEAVY_MS }, () => {
  it('pulls, then warms the cache for HEAD so the next build renders nothing', async () => {
    expect(existsSync(join(work, '.field', 'cache'))).toBe(false);
    const out: string[] = [];
    const result = await pull({
      cwd: work,
      out: (line) => out.push(line),
      env: { FIELD_REMOTE: remote.url },
      store: fileStore(join(tmp, 'credentials')),
      interactive: false,
    });
    expect(result.commit).toBe(git(['rev-parse', 'HEAD'], { cwd: source }));
    expect(result.remote).toEqual({ api: remote.url, owner: 'howlo', project: 'chemicals' });
    expect(result.warmed.find((w) => w.song === 'creek')).toMatchObject({ fetched: 2 });
    expect(out).toContainEqual(expect.stringMatching(/^creek: fetched 2 artifacts/));
    expect(readdirSync(join(work, '.field', 'cache', 'actions'))).toHaveLength(2);

    const outcomes = await buildLabels(work, ['//songs/creek/track:main'], refusingRunner);
    expect(outcomes.filter((o) => o.committed !== true).every((o) => o.cached)).toBe(true);
    // The warm writes only under .field/, so the checkout stays clean.
    expect(git(['status', '--porcelain'], { cwd: work })).toBe('');
  });

  it('pulls without a remote and says the cache was not warmed', async () => {
    const out: string[] = [];
    const result = await pull({ cwd: work, out: (line) => out.push(line), env: {}, interactive: false });
    expect(result.remote).toBeUndefined();
    expect(result.warmed).toEqual([]);
    expect(out[0]).toMatch(/^pulled; cache not warmed \(/);
  });

  it('refuses outside a Field project', async () => {
    await expect(pull({ cwd: tmp, out: () => {}, interactive: false })).rejects.toThrow(/not inside a Field project/);
  });
});
