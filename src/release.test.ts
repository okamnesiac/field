import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bump, current, main, NOT_RELEASED, parse, repoSlug, setVersion, tag } from '../scripts/release.js';

// scripts/release.ts against a temporary repository whose `origin` is a
// bare repository beside it (install.md §3.1), so tags are really pushed
// and really fetched. The GitHub release is the one step a test cannot
// take, so it is a stand-in that records its arguments.

let root: string;
let origin: string;
let checkout: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(message: string): void {
  git(checkout, 'commit', '--quiet', '-am', message);
  git(checkout, 'push', '--quiet', 'origin', 'HEAD:main');
}

const PACKAGE = '{\n  "name": "field",\n  "version": "0.1.0",\n  "type": "module"\n}\n';
const GITHUB = 'https://github.com/okamnesiac/field.git';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'field-release-')));
  origin = join(root, 'origin.git');
  checkout = join(root, 'checkout');
  git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(root, 'clone', '--quiet', origin, checkout);
  for (const [key, value] of [
    ['user.name', 't'],
    ['user.email', 't@t'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
  ] as const) {
    git(checkout, 'config', key, value);
  }
  // origin names the GitHub repository, as a real clone's does, and git
  // rewrites that URL to the bare repository beside it.
  git(checkout, 'config', 'remote.origin.url', GITHUB);
  git(checkout, 'config', `url.${origin}.insteadOf`, GITHUB);
  writeFileSync(join(checkout, 'package.json'), PACKAGE);
  git(checkout, 'add', 'package.json');
  git(checkout, 'commit', '--quiet', '-m', 'one');
  git(checkout, 'push', '--quiet', 'origin', 'HEAD:main');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the release version', () => {
  it('raises each part, resetting the parts below it, and writes only the version field', () => {
    expect(bump(checkout, 'patch')).toBe('0.1.1');
    expect(bump(checkout, 'minor')).toBe('0.2.0');
    expect(bump(checkout, 'major')).toBe('1.0.0');
    expect(readFileSync(join(checkout, 'package.json'), 'utf8')).toBe(PACKAGE.replace('0.1.0', '1.0.0'));
  });

  it('sets an exact version, and refuses one that does not go up', () => {
    setVersion(checkout, '0.10.0');
    expect(current(checkout)).toBe('0.10.0');
    // 0.9.0 sorts after 0.10.0 as text and before it as a version.
    expect(() => setVersion(checkout, '0.9.0')).toThrow('0.9.0 is not above the current version 0.10.0');
    expect(() => setVersion(checkout, '0.10.0')).toThrow('is not above');
    expect(() => setVersion(checkout, '1.0')).toThrow('"1.0" is not X.Y.Z');
    expect(current(checkout)).toBe('0.10.0');
  });

  it('parses only X.Y.Z', () => {
    expect(parse('12.0.3')).toEqual([12, 0, 3]);
    expect(() => parse('v1.2.3')).toThrow('is not X.Y.Z');
    expect(() => parse('1.2.3-rc.1')).toThrow('is not X.Y.Z');
  });
});

describe('tagging a release', () => {
  it('tags the merged version, moves the major tag, and creates the GitHub release', () => {
    const calls: string[][] = [];
    const head = git(checkout, 'rev-parse', 'HEAD');
    expect(tag(checkout, { createRelease: (slug, name) => calls.push([slug, name]) })).toBe(
      `tagged v0.1.0 and moved v0 to ${head.slice(0, 9)} on origin/main, and published the v0.1.0 GitHub release`,
    );
    expect(git(origin, 'rev-parse', 'v0.1.0^{commit}')).toBe(head);
    expect(git(origin, 'rev-parse', 'v0^{commit}')).toBe(head);
    expect(git(origin, 'tag', '-l', '--format=%(contents:subject)', 'v0.1.0')).toBe('Field 0.1.0');
    // The repository origin names, though git fetched from a path.
    expect(calls).toEqual([['okamnesiac/field', 'v0.1.0']]);
  });

  it('pushes the tags from a remote that is not GitHub, and says the release is unfinished', () => {
    git(checkout, 'config', 'remote.origin.url', origin);
    expect(() => tag(checkout)).toThrow('the GitHub release was not created (origin is not a GitHub repository)');
    expect(git(origin, 'tag', '--list')).toBe('v0\nv0.1.0');
  });

  it('moves the major tag forward on the next release and leaves the old tag where it was', () => {
    const first = git(checkout, 'rev-parse', 'HEAD');
    tag(checkout, { githubRelease: false });
    bump(checkout, 'minor');
    commit('two');
    const second = git(checkout, 'rev-parse', 'HEAD');
    expect(tag(checkout, { githubRelease: false })).toBe(`tagged v0.2.0 and moved v0 to ${second.slice(0, 9)} on origin/main`);
    expect(git(origin, 'rev-parse', 'v0.1.0^{commit}')).toBe(first);
    expect(git(origin, 'rev-parse', 'v0.2.0^{commit}')).toBe(second);
    expect(git(origin, 'rev-parse', 'v0^{commit}')).toBe(second);
  });

  it('tags what the remote branch holds, not an unpushed bump', () => {
    bump(checkout, 'minor');
    git(checkout, 'commit', '--quiet', '-am', 'unpushed');
    expect(tag(checkout, { githubRelease: false })).toContain('tagged v0.1.0');
  });

  it('refuses a version that is already tagged', () => {
    tag(checkout, { githubRelease: false });
    expect(() => tag(checkout, { githubRelease: false })).toThrow('v0.1.0 already exists; set a new version first');
  });

  it('names the command that finishes a release whose GitHub step failed', () => {
    expect(() =>
      tag(checkout, {
        createRelease: () => {
          throw new Error('HTTP 403');
        },
      }),
    ).toThrow(
      'v0.1.0 and v0 are pushed, but the GitHub release was not created (HTTP 403); ' +
        'finish with: gh release create v0.1.0 --verify-tag --generate-notes',
    );
    expect(git(origin, 'tag', '--list')).toBe('v0\nv0.1.0');
  });

  it('reads GitHub slugs from every URL form git accepts', () => {
    expect(repoSlug('git@github.com:okamnesiac/field.git')).toBe('okamnesiac/field');
    expect(repoSlug('ssh://git@github.com/okamnesiac/field.git')).toBe('okamnesiac/field');
    expect(repoSlug('https://github.com/okamnesiac/field')).toBe('okamnesiac/field');
    expect(repoSlug('/tmp/origin.git')).toBeUndefined();
  });
});

describe('the command line', () => {
  function run(...argv: string[]): { status: number; lines: string[] } {
    const lines: string[] = [];
    return { status: main(argv, checkout, (line) => lines.push(line)), lines };
  }

  it('says whether the merged version is released, and exits 3 while it is not', () => {
    expect(run('released')).toEqual({ status: NOT_RELEASED, lines: ['v0.1.0 is not released yet'] });
    expect(run('tag', '--no-release').status).toBe(0);
    expect(run('released')).toEqual({ status: 0, lines: ['v0.1.0 is released'] });
  });

  it('prints the new version from bump, which is what the workflow reads', () => {
    expect(run('bump', 'minor')).toEqual({ status: 0, lines: ['0.2.0'] });
    expect(run('set', '0.3.0')).toEqual({ status: 0, lines: ['set 0.3.0 in package.json'] });
  });

  it('exits 2 on a usage error and 1 on a refused release', () => {
    expect(run('bump', 'huge').status).toBe(2);
    expect(run('publish').status).toBe(2);
    expect(run('set', '0.0.1').status).toBe(1);
    expect(run('tag', '--force').status).toBe(1);
  });

  it('runs under plain node with no dependencies installed, as the workflow runs it', () => {
    // The script edits the checkout it lives in, which here is this one, so
    // it is asked only for a usage error: that proves it loads, strips its
    // types, and dispatches.
    const script = join(import.meta.dirname, '..', 'scripts', 'release.ts');
    const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('usage: node scripts/release.ts');
    expect(usage.stderr).not.toContain('Warning');
  });
});
