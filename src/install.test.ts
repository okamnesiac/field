import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// install.sh, run by real bash against a clone of its own in a temporary
// directory (install.md §2). pnpm, cmake, and the field CLI are stand-ins
// that record what they were asked, and PATH holds nothing else but links
// to the ordinary tools the script needs, so whatever happens to be
// installed on the machine running the suite cannot answer in their place.
// Locally that is macOS's bash 3.2 and in CI bash 5, so both run it.
// Windows skips them: the installer does not support it yet
// (install.md §7.6), and `field upgrade` refuses there instead.
const posix = describe.skipIf(process.platform === 'win32');

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIOD = 'native/audiod/build/field-audiod_artefacts/Release/field-audiod';

function which(tool: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const path = join(dir, tool);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return undefined;
}

const BASH = which('bash')!;
const TOOLS = ['bash', 'git', 'node', 'dirname', 'uname', 'sed', 'grep', 'cat', 'mkdir', 'ln', 'rm', 'chmod', 'touch'];

let root: string;
let upstream: string;
let repo: string;
let bin: string;
let pnpmHome: string;
let log: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
}

// A stand-in pnpm, which does what each command the installer runs would
// do to the files the installer then reads, and nothing more.
const PNPM = `#!${BASH}
echo "pnpm $*" >> "$FAKE_LOG"
dir=""
if [ "$1" = --dir ]; then dir="$2"; shift 2; fi
case "$1 \${2:-}" in
  "--version ") echo 11.15.1 ;;
  "bin -g") [ -z "\${FAKE_NO_GLOBAL_BIN:-}" ] || exit 1; echo "$FAKE_PNPM_HOME/bin" ;;
  "ls -g")
    if [ -L "$FAKE_PNPM_HOME/global/field" ]; then
      printf '[{"path":"g","dependencies":{"field":{"path":"%s"}}}]\\n' "$FAKE_PNPM_HOME/global/field"
    else
      echo '[{"path":"g"}]'
    fi ;;
  "add -g")
    mkdir -p "$FAKE_PNPM_HOME/global" "$FAKE_PNPM_HOME/bin"
    rm -f "$FAKE_PNPM_HOME/global/field"
    ln -s "$3" "$FAKE_PNPM_HOME/global/field"
    printf '#!/bin/sh\\n' > "$FAKE_PNPM_HOME/bin/field"
    chmod +x "$FAKE_PNPM_HOME/bin/field" ;;
  "install --frozen-lockfile") ;;
  "run build")
    mkdir -p "$dir/dist"
    node "$dir/scripts/stamp-build.mjs" > /dev/null
    cat "$FAKE_CLI" > "$dir/dist/cli.js" ;;
  "run build:ui")
    [ -z "\${FAKE_UI_FAILS:-}" ] || exit 2
    mkdir -p "$dir/ui/dist"
    printf '<!doctype html>\\n' > "$dir/ui/dist/index.html" ;;
  "run build:native")
    [ -z "\${FAKE_NATIVE_FAILS:-}" ] || exit 2
    # A daemon already built is left alone, as CMake leaves field-audiod
    # when the edit was to another target's source.
    [ ! -e "$dir/${AUDIOD}" ] || exit 0
    mkdir -p "$dir/${dirname(AUDIOD)}"
    printf '#!/bin/sh\\n' > "$dir/${AUDIOD}"
    chmod +x "$dir/${AUDIOD}" ;;
  *) echo "pnpm stand-in: unexpected $*" >&2; exit 99 ;;
esac
`;

// The CLI's half of the workers target and of the status rows.
const CLI = `require('fs').appendFileSync(process.env.FAKE_LOG, 'field ' + process.argv.slice(2).join(' ') + '\\n');
if (process.argv.includes('--check')) {
  console.log('worker-current field-aced');
  console.log('worker-stale   field-voiced is out of date — run field setup voiced');
  process.exitCode = 1;
}
`;

beforeEach(() => {
  // Resolved, because the installer compares paths it resolves with
  // pwd -P, and macOS's temporary directory sits behind /var -> /private/var.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'field-install-')));
  upstream = join(root, 'upstream');
  repo = join(root, 'checkout');
  bin = join(root, 'bin');
  pnpmHome = join(root, 'pnpm');
  log = join(root, 'log');

  // Only what the installer reads: itself, the marker that makes a
  // checkout, the real build stamp, and UI and daemon sources to be newer
  // than.
  copyFileSync(join(packageRoot, 'install.sh'), join(root, 'install.sh'));
  write(join(upstream, 'install.sh'), readFileSync(join(root, 'install.sh'), 'utf8'), 0o755);
  write(join(upstream, 'src/cli.ts'), '');
  write(join(upstream, 'package.json'), '{ "name": "field" }\n');
  write(join(upstream, 'scripts/stamp-build.mjs'), readFileSync(join(packageRoot, 'scripts/stamp-build.mjs'), 'utf8'));
  write(join(upstream, 'ui/src/main.tsx'), '');
  write(join(upstream, 'native/audiod/CMakeLists.txt'), '');
  write(join(upstream, 'native/audiod/src/main.cpp'), '');
  write(join(upstream, '.gitignore'), 'dist/\nnative/audiod/build/\n');
  git(root, 'init', '--quiet', '-b', 'main', upstream);
  git(upstream, 'add', '.');
  git(upstream, 'commit', '--quiet', '-m', 'one');
  git(root, 'clone', '--quiet', upstream, repo);

  mkdirSync(bin);
  for (const tool of TOOLS) {
    const path = which(tool);
    if (path !== undefined) symlinkSync(path, join(bin, tool));
  }
  write(join(bin, 'pnpm'), PNPM, 0o755);
  write(join(bin, 'cmake'), `#!${BASH}\necho "cmake version 3.30.2"\n`, 0o755);
  write(join(root, 'cli.js'), CLI);
  writeFileSync(log, '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  log: string[];
}

function install(target?: string, env: Record<string, string> = {}, script = join(repo, 'install.sh')): Run {
  writeFileSync(log, '');
  const result = spawnSync(BASH, target === undefined ? [script] : [script, target], {
    encoding: 'utf8',
    env: {
      PATH: [join(pnpmHome, 'bin'), bin].join(delimiter),
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      FAKE_LOG: log,
      FAKE_PNPM_HOME: pnpmHome,
      FAKE_CLI: join(root, 'cli.js'),
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    log: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

// The rows of a status, keyed by label, the warning marker dropped.
function rows(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+(?:⚠️ {2})?(.*)$/.exec(line);
    if (match) map.set(match[1]!, match[2]!);
  }
  return map;
}

// The commands a run made that change something: everything but pnpm's
// queries.
function changes(run: Run): string[] {
  return run.log.filter((line) => !/^pnpm (ls|bin|--version)/.test(line));
}

function linkTo(target: string): void {
  mkdirSync(join(pnpmHome, 'global'), { recursive: true });
  mkdirSync(join(pnpmHome, 'bin'), { recursive: true });
  symlinkSync(target, join(pnpmHome, 'global', 'field'));
}

posix('install.sh cli', () => {
  it('installs, builds the CLI and the UI, and links the checkout, in that order', () => {
    const run = install('cli');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(changes(run)).toEqual([
      `pnpm --dir ${repo} install --frozen-lockfile`,
      `pnpm --dir ${repo} run build`,
      `pnpm --dir ${repo} run build:ui`,
      `pnpm add -g ${repo}`,
    ]);
    expect(readlinkSync(join(pnpmHome, 'global', 'field'))).toBe(repo);
    expect(rows(run.stdout).get('linked')).toBe('~/pnpm/bin/field -> ~/checkout');
  });

  it('leaves a link that already points here alone, and builds anyway', () => {
    linkTo(repo);
    const run = install('cli');
    expect(run.status).toBe(0);
    expect(run.log).not.toContain(`pnpm add -g ${repo}`);
    expect(run.log).toContain(`pnpm --dir ${repo} run build`);
    expect(run.log).toContain(`pnpm --dir ${repo} run build:ui`);
  });

  it('stops before linking when the UI does not build', () => {
    const run = install('cli', { FAKE_UI_FAILS: '1' });
    expect(run.status).toBe(2);
    expect(run.log.some((line) => line.startsWith('pnpm add'))).toBe(false);
  });

  it('moves a link from another checkout, and says so', () => {
    const other = join(root, 'other');
    mkdirSync(other);
    linkTo(other);
    const run = install('cli');
    expect(run.status).toBe(0);
    expect(run.log).toContain(`pnpm add -g ${repo}`);
    expect(rows(run.stdout).get('moved')).toBe('field ~/other -> ~/checkout');
  });

  it('stops before installing anything when pnpm has no global bin directory', () => {
    const run = install('cli', { FAKE_NO_GLOBAL_BIN: '1' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('run pnpm setup');
    expect(changes(run)).toEqual([]);
  });

  it('stops before installing anything when that directory is not on PATH', () => {
    const run = install('cli', { PATH: bin });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain(`pnpm's global bin directory ${pnpmHome}/bin is not on PATH`);
    expect(changes(run)).toEqual([]);
  });

  it('needs no global bin directory on PATH when the link already points here', () => {
    linkTo(repo);
    const run = install('cli', { PATH: bin });
    expect(run.status).toBe(0);
    expect(run.log).toContain(`pnpm --dir ${repo} run build`);
  });

  it('refuses a Node older than 24 before touching anything', () => {
    rmSync(join(bin, 'node'));
    write(join(bin, 'node'), `#!${BASH}\necho v22.11.0\n`, 0o755);
    const run = install('cli');
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('Field needs Node 24 or newer, and node is 22.11.0');
    expect(run.log.some((line) => line.includes('install'))).toBe(false);
  });

  it('names corepack when pnpm is missing', () => {
    rmSync(join(bin, 'pnpm'));
    const run = install('cli');
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('corepack enable pnpm');
  });
});

posix('install.sh audiod and workers', () => {
  it('builds the daemon through pnpm build:native', () => {
    const run = install('audiod');
    expect(run.status).toBe(0);
    expect(run.log).toContain(`pnpm --dir ${repo} run build:native`);
    expect(rows(run.stdout).get('building')).toContain('the first time');
    expect(rows(run.stdout).get('built')).toBe(`~/checkout/${AUDIOD}`);
    // A rebuild is not announced as a first build.
    expect(rows(install('audiod').stdout).has('building')).toBe(false);
  });

  it('refuses to build the daemon without CMake', () => {
    rmSync(join(bin, 'cmake'));
    const run = install('audiod');
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('CMake 3.24 or newer');
    expect(run.log).not.toContain(`pnpm --dir ${repo} run build:native`);
  });

  it('stops before installing anything when everything is asked for without CMake', () => {
    rmSync(join(bin, 'cmake'));
    const run = install();
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('CMake 3.24 or newer');
    expect(changes(run)).toEqual([]);
  });

  it('refuses a CMake older than 3.24 before installing anything', () => {
    write(join(bin, 'cmake'), `#!${BASH}\necho "cmake version 3.22.1"\n`, 0o755);
    const run = install();
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('needs CMake 3.24 or newer, and cmake is 3.22.1');
    expect(changes(run)).toEqual([]);
  });

  it('takes a CMake of a newer major version', () => {
    write(join(bin, 'cmake'), `#!${BASH}\necho "cmake version 4.0.0"\n`, 0o755);
    expect(install('audiod').status).toBe(0);
  });

  it('fails when the daemon does not build', () => {
    const run = install('audiod', { FAKE_NATIVE_FAILS: '1' });
    expect(run.status).toBe(1);
    expect(rows(run.stdout).has('built')).toBe(false);
  });

  it('re-syncs workers through the CLI, which knows which are set up', () => {
    install('cli');
    const run = install('workers');
    expect(run.status).toBe(0);
    expect(run.log).toContain('field setup --existing');
  });

  it('needs the CLI built before it can sync workers', () => {
    const run = install('workers');
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('run ~/checkout/install.sh cli first');
  });

  it('installs everything with no target', () => {
    const run = install();
    expect(run.status).toBe(0);
    expect(run.log).toEqual(
      expect.arrayContaining([
        `pnpm --dir ${repo} run build`,
        `pnpm add -g ${repo}`,
        `pnpm --dir ${repo} run build:native`,
        'field setup --existing',
      ]),
    );
  });
});

posix('install.sh status', () => {
  it('reports a fresh checkout as installing nothing yet', () => {
    const run = install('status');
    expect(run.status).toBe(0);
    const status = rows(run.stdout);
    expect(status.get('checkout')).toMatch(/^~\/checkout \(main at [0-9a-f]{7}\)$/);
    expect(status.get('repo-current')).toBe('main matches origin/main');
    expect(status.get('cli-missing')).toBe('pnpm links no field — run ~/checkout/install.sh cli');
    expect(status.get('cli-unbuilt')).toContain('dist/ holds no build');
    expect(status.get('ui-missing')).toBe('ui/dist holds no build, so field ui cannot open — run ~/checkout/install.sh cli');
    expect(status.get('audiod-missing')).toBe('field-audiod is not built — run ~/checkout/install.sh audiod');
    expect(status.get('workers')).toBe('unknown until the CLI is built');
    expect(status.get('cmake')).toBe('3.30.2');
  });

  it('reports an install of this checkout as current, and names field upgrade as the way back', () => {
    install();
    const status = rows(install('status').stdout);
    expect(status.get('cli')).toBe('~/pnpm/bin/field -> ~/checkout');
    expect(status.get('cli-current')).toMatch(/^built from [0-9a-f]{7}$/);
    expect(status.get('ui-current')).toBe('~/checkout/ui/dist');
    expect(status.get('audiod-current')).toBe(`~/checkout/${AUDIOD}`);
    expect(status.get('worker-current')).toBe('field-aced');
    expect(status.get('worker-stale')).toBe('field-voiced is out of date — run field setup voiced');
    expect(install('status').stdout).toContain('worker-stale   ⚠️  field-voiced');
  });

  it('reports a build behind a new commit as stale', () => {
    install();
    const built = git(repo, 'rev-parse', '--short', 'HEAD');
    write(join(repo, 'src/more.ts'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'two');
    const head = git(repo, 'rev-parse', '--short', 'HEAD');
    expect(rows(install('status').stdout).get('cli-stale')).toBe(
      `dist/ was built from ${built}, and the checkout is at ${head} — run field upgrade cli`,
    );
  });

  it('reports a build behind an uncommitted edit as stale', () => {
    install();
    write(join(repo, 'src/cli.ts'), 'edited');
    expect(rows(install('status').stdout).get('cli-stale')).toBe(
      'dist/ was built with 0 uncommitted changes, and the checkout has 1 — run field upgrade cli',
    );
  });

  it('names the file the UI bundles that changed since the UI was built', () => {
    install();
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, 'ui/dist/index.html'), past, past);
    expect(rows(install('status').stdout).get('ui-stale')).toBe(
      'src/cli.ts changed since the UI was built — run field upgrade cli',
    );
  });

  it('leaves tests out of the UI comparison, because no build reads them', () => {
    install();
    const built = new Date(Date.now() - 30_000);
    const sources = new Date(Date.now() - 60_000);
    utimesSync(join(repo, 'ui/dist/index.html'), built, built);
    for (const file of ['src/cli.ts', 'ui/src/main.tsx']) utimesSync(join(repo, file), sources, sources);
    write(join(repo, 'src/cli.test.ts'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'a test');
    expect(rows(install('status').stdout).get('ui-current')).toBe('~/checkout/ui/dist');
  });

  it('names the daemon source that changed since the daemon was built', () => {
    install();
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, AUDIOD), past, past);
    expect(rows(install('status').stdout).get('audiod-stale')).toBe(
      'native/audiod/CMakeLists.txt changed since field-audiod was built — run field upgrade audiod',
    );
  });

  it('reports the daemon current after the rebuild it names, though CMake relinked nothing', () => {
    install();
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, AUDIOD), past, past);
    expect(rows(install('status').stdout).has('audiod-stale')).toBe(true);
    expect(install('audiod').status).toBe(0);
    expect(rows(install('status').stdout).get('audiod-current')).toBe(`~/checkout/${AUDIOD}`);
  });

  it('says when field links another checkout', () => {
    const other = join(root, 'other');
    mkdirSync(other);
    linkTo(other);
    expect(rows(install('status').stdout).get('cli-elsewhere')).toBe(
      'field links ~/other, not this checkout — run ~/checkout/install.sh cli to link this one',
    );
  });

  it("says when another field is ahead of pnpm's on PATH", () => {
    install('cli');
    const elsewhere = join(root, 'elsewhere');
    write(join(elsewhere, 'field'), '#!/bin/sh\n', 0o755);
    const run = install('status', { PATH: [elsewhere, join(pnpmHome, 'bin'), bin].join(delimiter) });
    expect(rows(run.stdout).get('cli-shadowed')).toBe(
      "field on PATH is ~/elsewhere/field, ahead of pnpm's ~/pnpm/bin/field",
    );
  });

  it('says how far the checkout is behind its upstream', () => {
    write(join(upstream, 'src/new.ts'), '');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '--quiet', '-m', 'two');
    // Offline, it compares against the last fetch, which was the clone.
    expect(rows(install('status', { FIELD_OFFLINE: '1' }).stdout).get('repo-current')).toBe(
      'main matches origin/main (offline; compared against the last fetch of origin)',
    );
    expect(rows(install('status').stdout).get('repo-behind')).toBe(
      'main is 1 commit behind origin/main — run git pull in ~/checkout, then ~/checkout/install.sh all',
    );
  });

  it('says a branch with unpushed commits is ahead of its upstream, rather than that it matches', () => {
    write(join(repo, 'src/local.ts'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'local');
    const status = rows(install('status').stdout);
    expect(status.has('repo-current')).toBe(false);
    expect(status.get('repo-ahead')).toBe('main is 1 commit ahead of origin/main');
  });

  it('says when CMake is too old to build the daemon', () => {
    write(join(bin, 'cmake'), `#!${BASH}\necho "cmake version 3.22.1"\n`, 0o755);
    expect(rows(install('status').stdout).get('cmake-old')).toBe(
      '3.22.1 — building field-audiod needs CMake 3.24 or newer',
    );
  });

  it('notes a FIELD_AUDIOD override', () => {
    expect(rows(install('status', { FIELD_AUDIOD: '/opt/field-audiod' }).stdout).get('audiod-override')).toBe(
      'FIELD_AUDIOD is set, so field runs /opt/field-audiod instead of this build',
    );
  });
});

// Reads files only, so it runs on Windows too.
describe('install.sh constants', () => {
  it('requires the CMake that native/audiod/CMakeLists.txt does', () => {
    const cmake = readFileSync(join(packageRoot, 'native/audiod/CMakeLists.txt'), 'utf8');
    const script = readFileSync(join(packageRoot, 'install.sh'), 'utf8');
    const required = /cmake_minimum_required\(VERSION (\d+)\.(\d+)/.exec(cmake);
    expect(required).not.toBeNull();
    expect(/^CMAKE_MAJOR=(\d+)$/m.exec(script)?.[1]).toBe(required![1]);
    expect(/^CMAKE_MINOR=(\d+)$/m.exec(script)?.[1]).toBe(required![2]);
  });
});

posix('install.sh refuses', () => {
  it('outside a checkout, and says to clone', () => {
    const run = install(undefined, {}, join(root, 'install.sh'));
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('run this from a Field checkout');
    expect(run.log).toEqual([]);
  });

  it('an unknown target, as a usage error', () => {
    const run = install('everything');
    expect(run.status).toBe(64);
    expect(run.stderr).toContain('usage: install.sh [all|cli|audiod|workers|status]');
    expect(existsSync(join(repo, 'dist'))).toBe(false);
  });
});
