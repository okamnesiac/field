import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLabels } from './build.js';
import { clone, describeWarm, gitConfigForRemote } from './clone.js';
import { createSong } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { git, gitLfsAvailable, tryGit } from '../git.js';
import { fileStore } from '../remote/credentials.js';
import { fakeRemote, type FakeRemote } from '../testing/fake-remote.js';
import type { GeneratorRunner } from '../graph/build.js';

// Git, for real (remote.md §7): a bare repository in a temp directory is
// the remote for `clone`, and the stub serves the short name's
// `clone_url` pointing at it. The LFS assertion runs when `git lfs` is
// on the path and the filters are configured, and says so when it is
// not, so a CI runner without them still runs the rest.

let tmp: string;
let source: string; // the project as its author has it, built once
let bare: string; // <tmp>/remotes/howlo/chemicals.git
let work: string; // where the clone lands
let remote: FakeRemote;
let branch: string;

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
  throw new Error(`rendered ${node.label.name}, which a warmed clone must never do`);
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'field-clone-'));
  source = join(tmp, 'source');
  work = join(tmp, 'work');
  mkdirSync(work);
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
  // A recipe-only song beside it (bloom-in-tree.md §7): its takes are
  // not committed, so nothing above the request can be keyed.
  createSong(source, 'tall-grass');
  writeFileSync(
    join(source, 'songs/tall-grass/tracks/topline.yaml'),
    'name: topline\ninputs:\n  - generative:\n      text: the water knows the way\n',
  );
  writeFileSync(join(source, 'songs/tall-grass/tracks/main.yaml'), 'name: main\ninputs:\n  - track: topline\n');

  // The author built creek, committed, and pushed — including LFS
  // objects when LFS is here to push them.
  await buildLabels(source, ['//songs/creek/track:main'], copyingRunner);
  git(['add', '-A'], { cwd: source });
  git(['-c', 'user.name=field-test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'chemicals'], {
    cwd: source,
  });
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: source });
  bare = join(tmp, 'remotes', 'howlo', 'chemicals.git');
  mkdirSync(join(tmp, 'remotes', 'howlo'), { recursive: true });
  git(['clone', '-q', '--bare', source, bare], { cwd: tmp });
  if (gitLfsAvailable()) tryGit(['lfs', 'push', '--all', `file://${bare}`, branch], source);

  remote = await fakeRemote();
  remote.addProject('howlo/chemicals', { clone_url: `file://${bare}`, default_branch: branch, visibility: 'public' });
  const actions = join(source, '.field', 'cache', 'actions');
  for (const file of readdirSync(actions)) {
    const entry = JSON.parse(readFileSync(join(actions, file), 'utf8')) as {
      rule: string;
      outputs: { sha256: string; bytes: number }[];
    };
    remote.addArtifact(
      'howlo/chemicals',
      file.replace(/\.json$/, ''),
      entry,
      entry.outputs.map((o) => readFileSync(join(source, '.field', 'cache', 'cas', o.sha256))),
    );
  }
});

afterEach(async () => {
  await remote.close();
  rmSync(tmp, { recursive: true, force: true });
});

const options = (overrides: Partial<Parameters<typeof clone>[0]> = {}) => {
  const out: string[] = [];
  return {
    out,
    opts: {
      target: 'howlo/chemicals',
      cwd: work,
      out: (line: string) => out.push(line),
      env: { FIELD_REMOTE: remote.url },
      store: fileStore(join(tmp, 'credentials')),
      lfsAvailable: () => true,
      interactive: false,
      ...overrides,
    },
  };
};

describe('field clone', () => {
  it('refuses without git-lfs, before touching the network or the disk', async () => {
    const { opts } = options({ lfsAvailable: () => false });
    await expect(clone(opts)).rejects.toThrow(/git-lfs is required/);
    expect(remote.requests).toEqual([]);
    expect(readdirSync(work)).toEqual([]);
  });

  it('expands the short name, clones, and warms the closure of main so the first build renders nothing', async () => {
    const { opts, out } = options();
    const result = await clone(opts);
    const dir = join(work, 'chemicals');
    expect(result.dir).toBe(dir);
    expect(result.remote).toEqual({ api: remote.url, owner: 'howlo', project: 'chemicals' });
    expect(existsSync(join(dir, 'field.yaml'))).toBe(true);
    expect(git(['remote', 'get-url', 'origin'], { cwd: dir })).toBe(`file://${bare}`);

    // The index and the bytes, for the stem as well as the mix.
    expect(readdirSync(join(dir, '.field', 'cache', 'actions'))).toHaveLength(2);
    const creek = result.warmed.find((w) => w.song === 'creek')!;
    expect(creek.fetched).toBe(2);
    expect(creek.note).toBeUndefined();
    // Two entries; the mix of one unprocessed input is the stem's bytes
    // again, so the blob count is not the entry count.
    expect(out).toContainEqual(expect.stringMatching(/^creek: fetched 2 artifacts \(\d+ B\)$/));
    // ...and a warmed checkout is a clean one (bloom-in-tree.md §7).
    expect(git(['status', '--porcelain'], { cwd: dir })).toBe('');

    // The whole point: a build on the fresh clone, with a runner that
    // refuses to render, is hits all the way down.
    const outcomes = await buildLabels(dir, ['//songs/creek/track:main'], refusingRunner);
    expect(outcomes.filter((o) => o.committed !== true).every((o) => o.cached)).toBe(true);

    // The recipe-only song is reported rather than crashed on, in the
    // words `build` would use (remote.md §9.11).
    expect(result.warmed.find((w) => w.song === 'tall-grass')?.note).toContain('has no takes yet');
    expect(out).toContain('tall-grass: not warmed — //songs/tall-grass/gen:topline has no takes yet');

    // Committed audio came through LFS, when LFS is here to bring it.
    const audio = join(dir, 'songs/creek/audio/pad/pad.wav');
    if (gitLfsAvailable() && tryGit(['config', '--get', 'filter.lfs.smudge'], dir) !== undefined) {
      expect(statSync(audio).size).toBe(statSync(join(source, 'songs/creek/audio/pad/pad.wav')).size);
      expect(git(['lfs', 'ls-files'], { cwd: dir })).toContain('pad.wav');
    } else {
      process.stderr.write('clone.test: git-lfs filters not configured here; skipping the LFS assertion\n');
    }
  });

  it('names both readings of a 404: no such project, or private and not logged in', async () => {
    const { opts } = options({ target: 'howlo/nothing' });
    await expect(clone(opts)).rejects.toThrow(/no project howlo\/nothing on .*field login/);
    expect(readdirSync(work)).toEqual([]);
  });

  it('rejects a name that is neither a slug pair nor a URL', async () => {
    const { opts } = options({ target: 'Howlo/Chemicals' });
    await expect(clone(opts)).rejects.toThrow(/not an <owner>\/<project> name/);
  });

  it('accepts a full URL, warming only when Field knows the host', async () => {
    // Anywhere Git reaches: cloned, no API, no warm.
    const plain = options({ target: `file://${bare}`, env: {} });
    const result = await clone(plain.opts);
    expect(result.dir).toBe(join(work, 'chemicals'));
    expect(result.remote).toBeUndefined();
    expect(result.warmed).toEqual([]);
    expect(remote.requests).toEqual([]);
    expect(existsSync(join(work, 'chemicals', '.field'))).toBe(false);

    // The same URL with FIELD_REMOTE naming the API: the path's last two
    // segments name the project, and the warm runs.
    const pointed = options({ target: `file://${bare}`, dir: 'again' });
    const again = await clone(pointed.opts);
    expect(again.remote).toEqual({ api: remote.url, owner: 'howlo', project: 'chemicals' });
    expect(again.warmed.find((w) => w.song === 'creek')?.fetched).toBe(2);
  });

  it('refuses to clone over an existing directory', async () => {
    mkdirSync(join(work, 'chemicals'));
    const { opts } = options();
    await expect(clone(opts)).rejects.toThrow('already exists');
  });

  it('configures only the credential helper for an audiofield git host, ahead of a reset list', () => {
    // No http.proactiveAuth: with it set and no credential, Git asks for
    // a username before its first request — probed against
    // git.audiofield.io — so an anonymous clone, or any checkout after
    // logout, would prompt. The reset keeps a global osxkeychain helper
    // from caching a copy of the token that logout never erases.
    expect(gitConfigForRemote('https://git.audiofield.io/howlo/chemicals.git')).toEqual([
      ['credential.https://git.audiofield.io.helper', ''],
      ['credential.https://git.audiofield.io.helper', '!field git-credential'],
    ]);
  });

  it('a reset-then-set helper list is what Git reads back', () => {
    // The pair above is only right if Git honours an empty value as a
    // reset when it arrives through `clone -c`; a repository configured
    // the same way shows both entries in order.
    const repo = join(tmp, 'helper-config');
    git(['init', '-q', repo], { cwd: tmp });
    for (const [k, v] of gitConfigForRemote('https://git.audiofield.io/howlo/chemicals.git')) {
      git(['config', '--add', k, v], { cwd: repo });
    }
    // NUL-separated, because the empty entry is the point and a trimmed
    // line-separated read would lose it.
    expect(git(['config', '--get-all', '-z', 'credential.https://git.audiofield.io.helper'], { cwd: repo })).toBe(
      '\0!field git-credential\0',
    );
  });

  it('describes a warm in one line each way', () => {
    expect(describeWarm({ song: 'creek', fetched: 1, bytes: 1024 })).toBe('creek: fetched 1 artifact (1.0 KB)');
    expect(describeWarm({ song: 'creek', fetched: 0, bytes: 0 })).toBe('creek: nothing cached on the remote yet');
    expect(describeWarm({ song: 'creek', fetched: 0, bytes: 0, note: 'x' })).toBe('creek: not warmed — x');
  });
});
