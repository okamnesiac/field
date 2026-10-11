// Set Field's release version, or tag a release of it (install.md §3.1).
//
//   node scripts/release.ts bump patch|minor|major   raise one part of the version, write it, and print it
//   node scripts/release.ts set X.Y.Z                write an exact version instead
//   node scripts/release.ts released                 exit 0 if origin/main's version is tagged, 3 if not
//   node scripts/release.ts tag [--no-release]       tag vX.Y.Z at origin/main, move vX, and create the GitHub release
//
// The Release workflow (.github/workflows/release.yml) runs these, as
// Projector's runs its .github/scripts/release.py, and they work by hand
// from any checkout. Node 24 runs this file directly by stripping its
// types, so it imports nothing but Node's own modules: the workflow runs it
// without installing a dependency.
//
// The release version is package.json's, the one `field --version` prints.
// field-audiod (native/audiod/src/version.h) and the model workers carry
// versions of their own, which move with what they report in `hello` and
// stamp into take manifests, so a release leaves them alone.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class ReleaseError extends Error {}

export type Part = 'patch' | 'minor' | 'major';
type Semver = [number, number, number];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_FIELD = /("version"\s*:\s*")[^"]*(")/;
export const NOT_RELEASED = 3;

export function parse(version: string): Semver {
  const match = SEMVER.exec(version);
  if (!match) throw new ReleaseError(`${JSON.stringify(version)} is not X.Y.Z`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function above(a: Semver, b: Semver): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

function versionOf(packageJson: string): string {
  const version: unknown = (JSON.parse(packageJson) as { version?: unknown }).version;
  if (typeof version !== 'string') throw new ReleaseError('package.json has no version');
  return version;
}

export function current(root: string): string {
  return versionOf(readFileSync(join(root, 'package.json'), 'utf8'));
}

// Rewrites the one field rather than the whole file, so package.json keeps
// its formatting and key order, and refuses a version that does not go up:
// a tag names one commit for good.
export function setVersion(root: string, version: string): void {
  const now = current(root);
  if (!above(parse(version), parse(now))) {
    throw new ReleaseError(`${version} is not above the current version ${now}`);
  }
  const path = join(root, 'package.json');
  const text = readFileSync(path, 'utf8');
  if (!VERSION_FIELD.test(text)) throw new ReleaseError('package.json has no version field');
  writeFileSync(path, text.replace(VERSION_FIELD, `$1${version}$2`));
}

export function bump(root: string, part: Part): string {
  const [major, minor, patch] = parse(current(root));
  const version = {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  }[part];
  setVersion(root, version);
  return version;
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw new ReleaseError(`git ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) throw new ReleaseError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function repoSlug(url: string): string | undefined {
  const trimmed = url.trim();
  for (const prefix of ['git@github.com:', 'ssh://git@github.com/', 'https://github.com/']) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).replace(/\.git$/, '').replace(/\/$/, '');
  }
  return undefined;
}

// The branch's commit on the remote, the version it names, and whether that
// version is tagged. Tags are fetched with --force because every release
// moves the major tag, and a local copy of the old one would otherwise
// refuse the fetch.
export function merged(root: string, remote: string, branch: string): { commit: string; version: string; tagged: boolean } {
  git(root, 'fetch', '--quiet', '--tags', '--force', remote, branch);
  const commit = git(root, 'rev-parse', `refs/remotes/${remote}/${branch}`);
  const version = versionOf(git(root, 'show', `${commit}:package.json`));
  parse(version);
  return { commit, version, tagged: git(root, 'tag', '--list', `v${version}`) !== '' };
}

// The repository the remote's configured URL names. `git remote get-url`
// applies `insteadOf` rewrites, which can turn a GitHub URL into a mirror's.
export function githubRepo(root: string, remote: string): string {
  const slug = repoSlug(git(root, 'config', '--get', `remote.${remote}.url`));
  if (slug === undefined) throw new ReleaseError(`${remote} is not a GitHub repository`);
  return slug;
}

export type CreateRelease = (root: string, remote: string, tag: string) => void;

function ghRelease(root: string, remote: string, tag: string): void {
  const slug = githubRepo(root, remote);
  const result = spawnSync('gh', ['release', 'create', tag, '--repo', slug, '--verify-tag', '--generate-notes'], {
    encoding: 'utf8',
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new ReleaseError(code === 'ENOENT' ? 'the gh CLI is not installed' : result.error.message);
  }
  if (result.status !== 0) throw new ReleaseError(`gh release create failed: ${result.stderr.trim()}`);
}

export interface TagOptions {
  remote?: string | undefined;
  branch?: string | undefined;
  githubRelease?: boolean | undefined;
  createRelease?: CreateRelease | undefined;
}

// Tags the version merged on the branch, never the checkout's, so an
// unmerged bump cannot name a release. The immutable tag names the exact
// release, and the major tag is the channel the installer follows
// (install.md §3.2), moved to the same commit.
export function tag(root: string, options: TagOptions = {}): string {
  const remote = options.remote ?? 'origin';
  const branch = options.branch ?? 'main';
  const { commit, version, tagged } = merged(root, remote, branch);
  const release = `v${version}`;
  const major = `v${parse(version)[0]}`;
  if (tagged) throw new ReleaseError(`${release} already exists; set a new version first`);
  git(root, 'tag', '-a', release, commit, '-m', `Field ${version}`);
  git(root, 'tag', '-f', '-a', major, commit, '-m', `Field ${version}`);
  git(root, 'push', '--quiet', remote, `refs/tags/${release}`);
  git(root, 'push', '--quiet', '--force', remote, `refs/tags/${major}`);
  const done = `tagged ${release} and moved ${major} to ${commit.slice(0, 9)} on ${remote}/${branch}`;
  if (options.githubRelease === false) return done;
  try {
    (options.createRelease ?? ghRelease)(root, remote, release);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReleaseError(
      `${release} and ${major} are pushed, but the GitHub release was not created (${reason}); ` +
        `finish with: gh release create ${release} --verify-tag --generate-notes`,
    );
  }
  return `${done}, and published the ${release} GitHub release`;
}

const USAGE = 'usage: node scripts/release.ts bump patch|minor|major | set X.Y.Z | released | tag [--no-release]';

function options(args: string[], flags: string[]): Map<string, string | true> {
  const found = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--no-release' && flags.includes(arg)) {
      found.set(arg, true);
    } else if ((arg === '--remote' || arg === '--branch') && args[i + 1] !== undefined) {
      found.set(arg, args[++i]!);
    } else {
      throw new ReleaseError(`unexpected argument ${arg}\n${USAGE}`);
    }
  }
  return found;
}

export function main(argv: string[], root: string = ROOT, out: (line: string) => void = console.log): number {
  const [command, ...rest] = argv;
  try {
    if (command === 'bump' && rest.length === 1 && ['patch', 'minor', 'major'].includes(rest[0]!)) {
      out(bump(root, rest[0] as Part));
    } else if (command === 'set' && rest.length === 1) {
      setVersion(root, rest[0]!);
      out(`set ${rest[0]} in package.json`);
    } else if (command === 'released') {
      const found = options(rest, []);
      const { version, tagged } = merged(root, (found.get('--remote') as string) ?? 'origin', (found.get('--branch') as string) ?? 'main');
      out(`v${version} is ${tagged ? 'released' : 'not released yet'}`);
      return tagged ? 0 : NOT_RELEASED;
    } else if (command === 'tag') {
      const found = options(rest, ['--no-release']);
      out(
        tag(root, {
          remote: found.get('--remote') as string | undefined,
          branch: found.get('--branch') as string | undefined,
          githubRelease: !found.has('--no-release'),
        }),
      );
    } else {
      console.error(USAGE);
      return 2;
    }
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    console.error(`release: ${error.message}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
