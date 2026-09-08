import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { buildLabels, explainLabel, remoteReads } from '../commands/build.js';
import { git } from '../git.js';
import { RemoteReads, projectCache } from '../remote/cache.js';
import { RemoteClient } from '../remote/client.js';
import { fileStore } from '../remote/credentials.js';
import { deadPort, fakeRemote, type FakeRemote } from '../testing/fake-remote.js';
import type { GeneratorRunner } from './build.js';

// The read-through cache (remote.md §3.4, §7): a local miss asks the
// remote, a hit lands in the CAS and the index only after its hash
// agrees, and every failure falls through to the render exactly as a
// local miss does — with one line, once.

let root: string;
const remotes: FakeRemote[] = [];

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

const writeTrack = (name: string, yaml: string) => {
  mkdirSync(join(root, 'songs/creek/tracks'), { recursive: true });
  writeFileSync(join(root, `songs/creek/tracks/${name}.yaml`), yaml);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'field-remote-cache-'));
  init({ dir: root, name: 'chemicals' });
  createSong(root, 'creek');
  const src = join(root, '..', `field-remote-src-${Math.random()}.wav`);
  writeWav(src);
  await importAsset(root, 'creek', src, 'pad');
  rmSync(src);
  // Two rule nodes, one above the other: the mix's key is computed from
  // the stem's output hash, so a warm that stopped at `main` would be
  // caught here.
  writeTrack(
    'pad-eq',
    'name: pad-eq\ninserts:\n  - effect: eq\n    bands:\n      - type: lowpass\n        frequency: 700\ninputs:\n  - audio: pad\n',
  );
  writeTrack('main', 'name: main\ninputs:\n  - track: pad-eq\n');
});

afterEach(async () => {
  await Promise.all(remotes.splice(0).map((r) => r.close()));
  rmSync(root, { recursive: true, force: true });
});

async function remote(options: Parameters<typeof fakeRemote>[0] = {}) {
  const r = await fakeRemote(options);
  remotes.push(r);
  r.addProject('howlo/chemicals', { clone_url: 'file:///nowhere', default_branch: 'main', visibility: 'public' });
  return r;
}

const countingRunner = () => {
  const state = { runs: 0 };
  const runner: GeneratorRunner = async (_node, inputPaths, outputPath) => {
    state.runs++;
    copyFileSync(inputPaths[0]!, outputPath);
  };
  return { state, runner };
};

const MAIN = '//songs/creek/track:main';
const STEM = '//songs/creek/track:pad-eq';
const casPath = (sha256: string) => join(root, '.field', 'cache', 'cas', sha256);
const actionsDir = () => join(root, '.field', 'cache', 'actions');

// Copies every local action entry and its bytes into the stub, as the
// site would hold them after a push.
function publish(r: FakeRemote): string[] {
  const keys: string[] = [];
  for (const file of readdirSync(actionsDir())) {
    const key = file.replace(/\.json$/, '');
    const entry = JSON.parse(readFileSync(join(actionsDir(), file), 'utf8')) as {
      rule: string;
      outputs: { sha256: string; bytes: number }[];
    };
    r.addArtifact('howlo/chemicals', key, entry, entry.outputs.map((o) => readFileSync(casPath(o.sha256))));
    keys.push(key);
  }
  return keys;
}

const wipeCache = () => rmSync(join(root, '.field'), { recursive: true, force: true });

function reads(url: string, notices: string[], token?: string) {
  const client = new RemoteClient(url, { token });
  return new RemoteReads(projectCache(client, { api: url, owner: 'howlo', project: 'chemicals' }), (l) => notices.push(l));
}

describe('the read-through cache', () => {
  it('fetches a local miss from the remote, all the way down, and says fetched', async () => {
    const r = await remote();
    const { state, runner } = countingRunner();
    await buildLabels(root, [MAIN], runner);
    expect(state.runs).toBe(2);
    const keys = publish(r);
    expect(keys).toHaveLength(2);
    wipeCache();

    const notices: string[] = [];
    const outcomes = await buildLabels(root, [MAIN], runner, undefined, undefined, reads(r.url, notices));
    expect(state.runs).toBe(2); // nothing executed
    for (const label of [STEM, MAIN]) {
      const outcome = outcomes.find((o) => o.label === label)!;
      expect(outcome).toMatchObject({ cached: true, fetched: true });
      expect(existsSync(outcome.outputPath!)).toBe(true);
      expect(existsSync(casPath(outcome.sha256))).toBe(true);
    }
    for (const key of keys) expect(existsSync(join(actionsDir(), `${key}.json`))).toBe(true);
    expect(notices).toEqual([]);

    // The index is what makes a hit: the next build is local, no remote
    // in sight, and executes nothing.
    const again = await buildLabels(root, [MAIN], runner);
    expect(state.runs).toBe(2);
    expect(again.find((o) => o.label === MAIN)).toMatchObject({ cached: true });
    expect(again.find((o) => o.label === MAIN)!.fetched).toBeUndefined();
  });

  it('never lets a fetched output whose hash disagrees reach the CAS', async () => {
    // The test the tamper-guard comment asks for (remote.md §7): a wrong
    // remote can cost a render but never poison the cache.
    const r = await remote();
    const { state, runner } = countingRunner();
    await buildLabels(root, [STEM], runner);
    publish(r);
    const [sha, good] = [...r.blobs.entries()][0]!;
    r.blobs.set(sha, Buffer.from(good.map((b) => b ^ 0xff))); // same length, other bytes
    wipeCache();

    const notices: string[] = [];
    // explain executes nothing, so after it the CAS must simply not hold
    // the hash — there is no render to put the right bytes there.
    const explanation = await explainLabel(root, STEM, reads(r.url, notices));
    expect(explanation.cached).toBe(false);
    expect(explanation.fetched).toBeUndefined();
    expect(existsSync(casPath(sha))).toBe(false);
    expect(existsSync(actionsDir())).toBe(false);
    expect(readdirSync(join(root, '.field', 'cache', 'tmp'))).toEqual([]); // the partial file is gone too
    expect(notices).toEqual([expect.stringContaining('disagreed')]);

    // A build renders locally, and what lands under the hash is what the
    // rule produced, not what the remote sent.
    const outcomes = await buildLabels(root, [STEM], runner, undefined, undefined, reads(r.url, notices));
    expect(state.runs).toBe(2);
    expect(outcomes.find((o) => o.label === STEM)).toMatchObject({ cached: false });
    expect(readFileSync(casPath(sha))).toEqual(good);
  });

  it('falls through to a local render, saying so once, when the remote is unreachable', async () => {
    const { state, runner } = countingRunner();
    const notices: string[] = [];
    const outcomes = await buildLabels(root, [MAIN], runner, undefined, undefined, reads(await deadPort(), notices));
    expect(state.runs).toBe(2);
    for (const o of outcomes.filter((o) => o.committed !== true)) {
      expect(o.cached).toBe(false);
      expect(o.fetched).toBeUndefined();
    }
    // Two rule nodes missed; one line. Every later miss would print the
    // same thing and wait for the same timeout.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/unreachable.*building locally/);
  });

  it('falls through the same way when the token is refused', async () => {
    const r = await remote({ refuseAll: true });
    const { state, runner } = countingRunner();
    const notices: string[] = [];
    await buildLabels(root, [MAIN], runner, undefined, undefined, reads(r.url, notices, 'stale'));
    expect(state.runs).toBe(2);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('field login');
  });

  it('is silent about a plain miss, and about a remote speaking another protocol says so once', async () => {
    const r = await remote(); // knows the project, holds nothing
    const { state, runner } = countingRunner();
    const notices: string[] = [];
    await buildLabels(root, [MAIN], runner, undefined, undefined, reads(r.url, notices));
    expect(state.runs).toBe(2);
    expect(notices).toEqual([]);

    const skewed = await remote({ protocol: 99 });
    wipeCache();
    await buildLabels(root, [MAIN], runner, undefined, undefined, reads(skewed.url, notices));
    expect(state.runs).toBe(4);
    expect(notices).toEqual([expect.stringMatching(/speaks protocol 99.*building locally/)]);
  });

  it('explain reads through and reports fetched, then cached', async () => {
    const r = await remote();
    const { runner } = countingRunner();
    await buildLabels(root, [STEM], runner);
    publish(r);
    wipeCache();
    const fetched = await explainLabel(root, STEM, reads(r.url, []));
    expect(fetched).toMatchObject({ cached: true, fetched: true });
    expect(fetched.outputs).toHaveLength(1);
    const local = await explainLabel(root, STEM);
    expect(local.cached).toBe(true);
    expect(local.fetched).toBeUndefined();
  });

  it('a private project reads through only with the token', async () => {
    const r = await remote();
    r.projects.get('howlo/chemicals')!.visibility = 'private';
    const { state, runner } = countingRunner();
    await buildLabels(root, [STEM], runner);
    publish(r);
    wipeCache();
    const notices: string[] = [];
    // Without the token the remote answers 404 — indistinguishable from
    // absent, by design — so this is a plain miss and a render.
    await buildLabels(root, [STEM], runner, undefined, undefined, reads(r.url, notices));
    expect(state.runs).toBe(2);
    expect(notices).toEqual([]);
    wipeCache();
    await buildLabels(root, [STEM], runner, undefined, undefined, reads(r.url, notices, r.token));
    expect(state.runs).toBe(2);
  });
});

describe('remoteReads', () => {
  // The command layer's resolution (remote.md §5 decisions 3 and 4):
  // origin's path names the project, FIELD_REMOTE points at the stub,
  // the store supplies the token, and the switches turn it off.
  it('resolves the project remote from origin and FIELD_REMOTE, with the stored token', async () => {
    const r = await remote();
    r.projects.get('howlo/chemicals')!.visibility = 'private';
    git(['remote', 'add', 'origin', '/remotes/howlo/chemicals.git'], { cwd: root });
    const store = fileStore(join(root, '..', `field-remote-creds-${Math.random()}`));
    store.write(r.url, { token: r.token });
    const { state, runner } = countingRunner();
    await buildLabels(root, [STEM], runner);
    publish(r);
    wipeCache();

    const env = { FIELD_REMOTE: r.url };
    const notices: string[] = [];
    const outcomes = await buildLabels(
      root,
      [STEM],
      runner,
      undefined,
      undefined,
      remoteReads(root, { env, store, notice: (l) => notices.push(l) }),
    );
    expect(state.runs).toBe(1);
    expect(outcomes.find((o) => o.label === STEM)).toMatchObject({ fetched: true });
    expect(notices).toEqual([]);

    expect(remoteReads(root, { env, store, noRemote: true })).toBeUndefined();
    expect(remoteReads(root, { env: { FIELD_REMOTE: 'off' }, store })).toBeUndefined();
    expect(remoteReads(root, { env: {}, store })).toBeUndefined(); // a bare path is not an audiofield host
  });
});
