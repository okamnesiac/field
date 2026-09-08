import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLabels } from './build.js';
import { createSong } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { describeOffer, push, remoteGitConfig } from './push.js';
import { git } from '../git.js';
import { fileStore } from '../remote/credentials.js';
import { fakeRemote, type FakeRemote } from '../testing/fake-remote.js';
import type { GeneratorRunner } from '../graph/build.js';

// Git, for real (remote.md §7): a bare repository in a temp directory is
// the origin the project pushes to, and the stub is the API the offer
// talks to, pointed at by FIELD_REMOTE since a file:// origin implies no
// API of its own.

let tmp: string;
let source: string; // the author's checkout, built once
let bare: string; // <tmp>/remotes/howlo/chemicals.git
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

function commit(message: string): void {
  git(['add', '-A'], { cwd: source });
  git(['-c', 'user.name=field-test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', message], {
    cwd: source,
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'field-push-'));
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
  // A recipe-only song beside it: nothing above its request can be keyed.
  createSong(source, 'tall-grass');
  writeFileSync(
    join(source, 'songs/tall-grass/tracks/topline.yaml'),
    'name: topline\ninputs:\n  - generative:\n      text: the water knows the way\n',
  );
  writeFileSync(join(source, 'songs/tall-grass/tracks/main.yaml'), 'name: main\ninputs:\n  - track: topline\n');
  await buildLabels(source, ['//songs/creek/track:main'], copyingRunner);
  commit('chemicals');
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: source });

  bare = join(tmp, 'remotes', 'howlo', 'chemicals.git');
  mkdirSync(join(tmp, 'remotes', 'howlo'), { recursive: true });
  git(['init', '-q', '--bare', bare], { cwd: tmp });
  git(['remote', 'add', 'origin', `file://${bare}`], { cwd: source });

  remote = await fakeRemote();
  remote.addProject('howlo/chemicals', { clone_url: `file://${bare}`, default_branch: branch, visibility: 'public' });
});

afterEach(async () => {
  await remote.close();
  rmSync(tmp, { recursive: true, force: true });
});

const options = (overrides: Partial<Parameters<typeof push>[0]> = {}) => {
  const out: string[] = [];
  return {
    out,
    opts: {
      cwd: join(source, 'songs'), // anywhere inside the project
      gitArgs: ['-u', 'origin', branch],
      out: (line: string) => out.push(line),
      env: { FIELD_REMOTE: remote.url, FIELD_TOKEN: remote.token },
      store: fileStore(join(tmp, 'credentials')),
      interactive: false,
      ...overrides,
    },
  };
};

describe('field push', () => {
  it('pushes, then offers every entry beneath main for HEAD, uploading only what the remote lacks', async () => {
    const { opts, out } = options();
    const result = await push(opts);
    const head = git(['rev-parse', 'HEAD'], { cwd: source });
    expect(result.commit).toBe(head);
    expect(result.remote).toEqual({ api: remote.url, owner: 'howlo', project: 'chemicals' });

    // Git pushed: the bare repository has the commit.
    expect(git(['rev-parse', branch], { cwd: bare })).toBe(head);

    // The offer: both rule entries beneath creek's main, registered under
    // the commit and their labels, as the site's player will read them.
    const project = remote.projects.get('howlo/chemicals')!;
    const actions = readdirSync(join(source, '.field', 'cache', 'actions')).map((f) => f.replace(/\.json$/, ''));
    expect(actions).toHaveLength(2);
    expect([...project.artifacts.keys()].sort()).toEqual([...actions].sort());
    expect(project.refs.get(`${head} //songs/creek/track:pad-eq`)).toBeDefined();
    expect(project.refs.get(`${head} //songs/creek/track:main`)).toBeDefined();
    expect(project.offers.size).toBe(0);

    // Two entries, one blob: the mix of one unprocessed input is the
    // stem's bytes again, so the second offer had nothing to upload.
    const creek = result.offered.find((r) => r.song === 'creek')!;
    expect(creek.offered).toBe(2);
    expect(creek.uploaded).toBe(1);
    expect(creek.note).toBeUndefined();
    expect(remote.blobs.size).toBe(1);
    expect(out).toContainEqual(expect.stringMatching(/^creek: offered 2 entries, uploaded 1 output \(\d+ B\)$/));

    // The recipe-only song is reported in the words build would use.
    expect(result.offered.find((r) => r.song === 'tall-grass')?.note).toContain('has no takes yet');
    expect(out).toContain('tall-grass: not offered — //songs/tall-grass/gen:topline has no takes yet');

    // A second push offers the same entries and uploads nothing.
    const again = options();
    const second = await push(again.opts);
    expect(second.offered.find((r) => r.song === 'creek')).toMatchObject({ offered: 2, uploaded: 0 });
    expect(again.out).toContain('creek: offered 2 entries, already on the remote');
    expect(remote.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });

  it('offers nothing for a working tree with uncommitted changes, and says so', async () => {
    writeFileSync(join(source, 'songs/creek/tracks/main.yaml'), 'name: main\ninputs:\n  - track: pad-eq\n# edited\n');
    const { opts, out } = options();
    const result = await push(opts);
    expect(result.note).toContain('uncommitted changes');
    expect(result.offered).toEqual([]);
    expect(out).toEqual([expect.stringContaining('pushed; nothing offered')]);
    // Pushed all the same.
    expect(git(['rev-parse', branch], { cwd: bare })).toBe(git(['rev-parse', 'HEAD'], { cwd: source }));
    expect(remote.requests.filter((r) => r.path.includes('/artifacts'))).toEqual([]);
  });

  it('pushes without a remote and says why nothing was offered', async () => {
    const { opts, out } = options({ env: {} });
    const result = await push(opts);
    expect(result.remote).toBeUndefined();
    expect(result.note).toContain('not an audiofield git host');
    expect(out[0]).toMatch(/^pushed; nothing offered \(/);
    expect(git(['rev-parse', branch], { cwd: bare })).toBe(result.commit);

    const off = options({ env: { FIELD_REMOTE: 'off' } });
    expect((await push(off.opts)).note).toContain('FIELD_REMOTE=off');
  });

  it('reports a token the remote refuses rather than swallowing it', async () => {
    const { opts, out } = options({ env: { FIELD_REMOTE: remote.url, FIELD_TOKEN: 'not-a-token' } });
    const result = await push(opts);
    const creek = result.offered.find((r) => r.song === 'creek')!;
    expect(creek.offered).toBe(0);
    expect(creek.note).toContain('refused the token');
    expect(out).toContainEqual(expect.stringMatching(/^creek: not offered — .*refused the token/));
    expect(remote.projects.get('howlo/chemicals')!.artifacts.size).toBe(0);
  });

  it('refuses outside a Field project', async () => {
    const { opts } = options({ cwd: tmp });
    await expect(push(opts)).rejects.toThrow(/not inside a Field project/);
  });

  it('carries the credential helper and proactive auth only when a token is held', () => {
    expect(remoteGitConfig('https://git.audiofield.io/howlo/chemicals.git', 'tok')).toEqual([
      '-c',
      'credential.https://git.audiofield.io.helper=',
      '-c',
      'credential.https://git.audiofield.io.helper=!field git-credential',
      '-c',
      'http.proactiveAuth=basic',
    ]);
    // A file:// origin gets the auth flag alone; no token gets nothing.
    expect(remoteGitConfig('file:///tmp/x.git', 'tok')).toEqual(['-c', 'http.proactiveAuth=basic']);
    expect(remoteGitConfig('https://git.audiofield.io/howlo/chemicals.git', undefined)).toEqual([]);
  });

  it('describes an offer in one line each way', () => {
    expect(describeOffer({ song: 'creek', offered: 2, uploaded: 1, bytes: 2048 })).toBe(
      'creek: offered 2 entries, uploaded 1 output (2.0 KB)',
    );
    expect(describeOffer({ song: 'creek', offered: 1, uploaded: 0, bytes: 0 })).toBe(
      'creek: offered 1 entry, already on the remote',
    );
    expect(describeOffer({ song: 'creek', offered: 0, uploaded: 0, bytes: 0, note: 'x' })).toBe('creek: not offered — x');
    expect(describeOffer({ song: 'creek', offered: 1, uploaded: 0, bytes: 0, note: 'y' })).toBe(
      'creek: offered 1 entry, already on the remote; then stopped — y',
    );
  });
});
