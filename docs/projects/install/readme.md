---
status: in-progress
priority: now
---

# Plan: Install and upgrade

**Goal:** one command installs Field and another keeps it current, the
way Projector's `install.sh` and `project upgrade` do. `./install.sh`
installs a checkout today, and `field upgrade` runs it from any
directory. Once Field has releases, `curl -fsSL https://field.one/install.sh | bash`
installs one with no clone, no pnpm, and no compiler, and `field upgrade`
moves it to the next release.

## 1 The problem

Installing Field from a checkout is four commands from the README, each
of which has to be run from the checkout:

```sh
pnpm install
pnpm build
pnpm add -g .
pnpm build:native
```

Nothing tells you when the result goes stale. After a `git pull`, the
linked `field` runs the old `dist/` until someone runs `pnpm build`, the
daemon stays the old build until someone runs `pnpm build:native`, and a
worker environment keeps the old packages until someone runs
`field setup`. `field --version` catches the first of those, and only
when someone thinks to ask. The second and third have each cost a
debugging round: `src/commands/version.ts` records a `field-voiced`
that silently dropped a flag it predated, and a venv that held a stale
copy of `field_worker` while the CLI read the new source.

The remedies are also in the wrong place. Eight error messages told you
to run `pnpm build:native`, and every one of them fires while you are
inside a song project, where `build:native` is not a script.

And there is no way to install Field without a clone at all.
`okamnesiac/field` is about to become public, and `field.one` should be
able to offer the one-line install that <https://projector.bot> offers
for Projector.

## 2 The solution

### 2.1 One installer, two modes

`install.sh` at the root of the repository is the only installer. It is
a checkout's installer when `src/cli.ts` sits beside it, and a release
installer otherwise: piped from curl, bash reads it from stdin with
nothing beside it, and the copy `field upgrade` downloads sits alone in a
temporary directory. Chunk 1 builds the checkout mode. Until chunk 3, the
release mode says to clone and stops:

```console
$ curl -fsSL https://raw.githubusercontent.com/okamnesiac/field/main/install.sh | bash
install.sh: run this from a Field checkout: git clone https://github.com/okamnesiac/field, then ./install.sh in it
```

### 2.2 The targets

`./install.sh [target]` takes one target, and `all` when given none:

| Target | Runs |
| --- | --- |
| `cli` | `pnpm install --frozen-lockfile`, `pnpm run build`, and `pnpm add -g <checkout>` unless pnpm's global `field` already links this checkout. |
| `audiod` | `pnpm run build:native`. |
| `workers` | `field setup --existing` (§2.4). |
| `all` | `cli`, `audiod`, `workers`. |
| `status` | One row per fact, changing nothing (§2.6). |

Every target except `status` ends by fetching the checkout's upstream
and warning when the checkout is behind it. The installer never pulls.

Each prerequisite is checked before anything changes, and a missing one
stops the installer with exit status 69 and a message that names the
fix: Node 24 or newer, pnpm (`corepack enable pnpm`), a pnpm global bin
directory on PATH (`pnpm setup`), and CMake for `audiod` and `all`. An
unknown target exits 64.

### 2.3 The CLI is a link to the checkout

`pnpm add -g <checkout>` makes pnpm's global `node_modules/field` a
symlink into the checkout, and its bin directory gets a `field` shim
that runs `dist/cli.js` through it. The installer keeps that, which is
what the README already documented and what every existing install is.
`pnpm ls -g --json` names the global package's path, and its realpath is
the checkout it links, so the installer can tell an install of this
checkout from one of another.

A link that already points here is left alone. One that points at
another checkout moves, with a `moved` row naming both, because running
the installer in a checkout means "make `field` this one".

### 2.4 Worker environments re-sync, and none is set up

`field setup --existing` re-syncs each worker environment that is
already set up and sets up no new one. Setting a worker up stays explicit
([ace-generation.md](../ace-generation/readme.md) §3.4), because the
first `field generate` after it downloads gigabytes of weights;
re-syncing one that exists downloads none. Set up means the worker's
console script is installed in `python/<worker>/.venv`, the same test
`field generate` gates on, not that a `.venv` exists: a dev-only
`uv sync` makes one with no worker in it (#61).

`field setup --check` prints one row per worker in the installer's row
format, from `probeEnvironment`, the side-effect-free probe
`field generate` refuses on. `install.sh status` passes those rows
through. The CLI answers both questions, rather than the installer
listing `python/*/`, because `SETUP_SPECS` is the one list of workers
(#67).

### 2.5 `field upgrade` runs the installer

`field upgrade [target]` runs the `install.sh` beside the package it was
loaded from, with the same target, and returns its exit status. It
prints the command first, as Projector's does:

```console
$ field upgrade status
+ /Users/you/field/install.sh status
checkout       ~/field (main at f80efb6)
...
```

For a linked checkout, the package it was loaded from is the checkout,
so `field upgrade` reaches the right installer from any directory with
no record of where it was installed from. Projector reads pip's
`direct_url.json` for the same answer; a link carries it. It runs the
installer through `bash`, not through its execute bit, which a checkout
with `core.fileMode` off does not keep.

The installer's own messages name `field upgrade <target>` as the way
back when pnpm's `field` links this checkout, and the script's path
otherwise. The eight daemon error messages name `BUILD_DAEMON` from
`src/audiod/client.ts`, which is `field upgrade audiod`, and on Windows
`pnpm build:native` in the checkout, because `field upgrade` refuses
there (§7.6).

### 2.6 `status` compares what is installed with its source

| Piece | Current when | Compared by |
| --- | --- | --- |
| Checkout | it matches its upstream after a fetch | `git rev-list --count HEAD..@{upstream}`, as Projector's installer does |
| CLI | `dist/` was built from `HEAD` with the same number of uncommitted changes | `dist/build-info.json`, which `pnpm build` stamps and `field --version` already reads |
| Daemon | no tracked file under `native/audiod` is newer than the binary | file mtimes, the test the build itself makes |
| Workers | each one set up passes `uv sync --check --locked` | `field setup --check` |

`docs/install.md` lists every row.

### 2.7 Files

| File | Change |
| --- | --- |
| `install.sh` | New. The installer. |
| `src/commands/upgrade.ts` | New. `field upgrade`. |
| `src/commands/generate.ts` | `selectWorkers`, `partitionExisting`, and `checkWorkers`; `setupWorker` takes `existing`. |
| `src/cli.ts` | `field upgrade`, and `--existing` and `--check` on `field setup`. |
| `scripts/gen-plan-limits.ts` | Writes the header only when it changes (§8.1). |
| `src/audiod/client.ts` | `BUILD_DAEMON`, which the eight daemon error messages name. |
| `docs/install.md` | New. How install and upgrade work, and every status row. |
| `docs/cli.md` | The install section, `field upgrade`, and the new `field setup` options. |
| `README.md`, `examples/bloom/README.md` | Lead with `./install.sh`. |

## 3 Releases and the one-line install

These are chunks 2 to 4. They are designed far enough to show that
chunk 1 does not paint them into a corner, and the open questions in §7
decide the rest.

### 3.1 Releases (chunk 2)

Projector releases need no artifact: pip builds the package from
GitHub's source archive of the `v0` tag. Field cannot do that cheaply,
because turning its source into something that runs needs pnpm, `tsc`,
CMake, a C++ compiler, and three minutes of compiling JUCE. So a Field
release publishes built artifacts:

- **`field-<version>.tgz`.** The CLI, platform-independent: `dist/`,
  `package.json`, production `node_modules/` (commander, yaml, and zod,
  all plain JavaScript), and the directories the CLI reads from its
  package root, which are `keymaps/`, `sc/`, and `python/`. It needs
  only Node 24 to run.
- **`field-audiod-<version>-<platform>.tgz`.** The daemon, one per
  platform: `darwin-arm64` and `linux-x64` first (§7.2).
- **`SHA256SUMS`**, which the installer verifies.

The version is `package.json`'s. A release script, like Projector's
`.github/scripts/release.py`, bumps it and, once the bump merges, pushes
an immutable `v0.2.0` tag, moves `v0` to the same commit, and creates
the GitHub release. `v0` is the channel the installer follows.

### 3.2 The release installer (chunk 3)

Without a checkout, `install.sh` installs a release:

1. It reads the version from `package.json` at `FIELD_REF` (default
   `v0`) in `FIELD_REPO` (default `okamnesiac/field`), which is how
   Projector's installer learns the version it is installing.
2. It downloads the CLI and the daemon for this platform from that
   GitHub release, and verifies both against `SHA256SUMS`.
3. It unpacks them into `~/.local/share/field/<version>/`, with the daemon
   where `daemonBinary()` looks, switches
   `~/.local/share/field/current` to it, and links `~/.local/bin/field`
   to `current/dist/cli.js`. The previous version stays until the switch
   succeeds, so a failed download leaves the old install working.
4. It sets up again each worker that was set up in the previous version
   (§7.5).

It needs Node 24, curl, and tar, and no pnpm and no compiler. A platform
with no prebuilt daemon stops and says to install from a checkout.

`field upgrade` in a release install finds no checkout beside its
package, so it downloads the newest installer, from
`https://field.one/install.sh` or from `install.sh` at `FIELD_REF` in
the fork it was installed from, and runs that. `status` compares the
installed version with the release's.

### 3.3 The one-line install (chunk 4)

```sh
curl -fsSL https://field.one/install.sh | bash
```

`apps/field-one` in `okamnesiac/audiofield` rewrites `/install.sh` to
`https://raw.githubusercontent.com/okamnesiac/field/v0/install.sh`, as
`projector.bot` does for Projector, so the URL always serves the newest
release's installer rather than `main`'s. The rewrite proxies rather
than redirects, so the command is one request to `field.one`. It needs
the repository to be public: `raw.githubusercontent.com` answers 404 for
a private one. The website and the README then lead with this command.

## 4 Why this design (DECIDED, 2026-10-11)

- **A bash installer, as Projector has.** A Node script cannot run
  before Node is installed, and a missing or old Node is the first thing
  a fresh machine lacks, so checking for it is the installer's first
  job. `curl | bash` needs bash anyway. Bash 3.2 is what macOS ships, so
  the script uses nothing newer, and the tests run it under 3.2 locally
  and bash 5 in CI.
- **One installer, two modes**, from Projector. One file to maintain,
  and `field upgrade` always runs an `install.sh`, whichever kind of
  install it is.
- **The checkout install stays a pnpm link**, over two alternatives:
  - Copying the checkout into `~/.local/share`, as pipx does for
    Projector. A checkout that moves on then leaves the command behind
    with nothing saying so; Projector's installer diffs every installed
    file against the checkout to notice. A link reduces staleness to
    "is `dist/` built from `HEAD`", which `field --version` already
    answers.
  - A shim in `~/.local/bin` that runs `node <checkout>/dist/cli.js`.
    It would spare newcomers `pnpm setup`, but every existing install is
    a pnpm link and moving them means migrating each one. Release
    installs (chunk 3) use `~/.local/bin` because they must not need
    pnpm, and `status` reports `cli-shadowed` when both exist and the
    wrong one is first on PATH.
- **Never pull, never switch branches.** The checkout may hold work in
  progress. `status` reports how far behind it is, which is Projector's
  choice too.
- **Build every time.** `pnpm install` builds through `prepare` only
  when it installed a dependency, so a second run after a `git pull`
  would build nothing. The build takes about three seconds.
- **`--frozen-lockfile`.** An installer has no business rewriting the
  checkout's lockfile, and pnpm's error says which `package.json` moved
  ahead of it.
- **Workers re-sync; none is set up.** Leaving them out keeps the stale
  venv §1 describes. Setting every worker up starts a 12 GB download
  nobody asked for.
- **The daemon is compared by mtime, not by a stamp.** A commit stamped
  into the binary, as `dist/` has, would need the daemon to report it,
  and would miss uncommitted edits. Mtimes are the build's own test, so
  `audiod-stale` means a build would compile something, and nothing
  else (§8.1).
- **Releases ship built artifacts**, not a source archive (§3.1). The
  source archive is what Projector installs from, and for Field it would
  make every user install pnpm and a compiler and wait out a JUCE build.

## 5 Acceptance criteria

Chunk 1:

- In a clone with Node 24, pnpm set up, and CMake, `./install.sh` puts
  `field` on PATH and builds `field-audiod`, and `field --version` in
  `examples/bloom` reports that build.
- A second run does not relink, and the daemon build compiles only what
  changed.
- `field upgrade [target]`, from any directory, runs the linked
  checkout's `install.sh` with the same output and exit status.
- `field upgrade status` reports each state in `docs/install.md` with
  the command that fixes it.
- A missing prerequisite stops the installer before anything changes,
  with exit status 69 and the fix.
- `field upgrade workers` re-syncs the worker environments that are set
  up and creates none.

Chunks 2 to 4:

- A release publishes the CLI, a daemon for each supported platform, and
  checksums, and moves `v0`.
- On a machine with Node 24 and no checkout,
  `curl -fsSL https://field.one/install.sh | bash` installs `field` and
  `field-audiod`, and `field upgrade` later moves both to the next
  release.

## 6 Chunks

1. **The checkout installer and `field upgrade`.** §2. This change.
2. **Releases.** §3.1. Blocked on §7.1.
3. **The release installer.** §3.2. Needs chunk 2.
4. **The one-line install.** §3.3, in `okamnesiac/audiofield`. Needs
   chunk 3 and a public repository.

## 7 Open questions

### 7.1 The license, and the daemon binary

The repository has no `LICENSE` yet. As of 2026-10-11 the leaning is
MIT. Whatever it is, `field-audiod` links JUCE, which is AGPLv3 or
commercial ([architecture.md](../../architecture.md) "Licensing"), and
a published daemon binary is a distribution of JUCE. Either the daemon
ships under AGPLv3 with its source, which a public repository at the
release tag provides, or a JUCE commercial license covers it. Decide
this, and check JUCE's current terms, before chunk 2 publishes a binary.

### 7.2 Platforms

`darwin-arm64` and `linux-x64` first. Intel Macs (`darwin-x64`) and
`linux-arm64` each cost one more build per release. A platform with no
binary can still install from a checkout.

### 7.3 Where the macOS daemon builds

GitHub bills a macOS runner at ten times the Linux rate, a cold JUCE
build takes minutes, and this account caps Actions spending at $40 a
month. Either the release workflow builds the macOS daemon with a warm
cache, or the release script builds it locally and uploads it with
`gh release upload`. The second is cheaper, and makes a release depend
on one machine.

### 7.4 Which domain serves the installer

`field.one` is the marketing site (`apps/field-one`), and the
repository's GitHub homepage says `field.amnes.ac`. This plan assumes
`field.one`, where the waitlist for source access already lives.

### 7.5 Worker environments across release versions

In a checkout, a worker's venv lives in `python/<worker>/.venv` and
survives every upgrade. In a release install, each version unpacks into
a directory of its own, so the venv would be left behind with the old
version. Chunk 3 either sets each worker up again in the new version,
which re-downloads no weights because they live in the Hugging Face
cache, or points `UV_PROJECT_ENVIRONMENT` at a directory outside the
version.

### 7.6 Windows

`install.sh` is bash, and Field's Windows support is
[windows-portability.md](../windows-portability/readme.md). Windows
installs from a checkout by hand for now, `field upgrade` refuses there
with the steps, and the installer's tests skip there. Whether Windows
gets an `install.ps1` of its own is open.

## 8 Chunk 1 as built (2026-10-11)

### 8.1 What implementation settled

- **A generated header made the daemon look stale.**
  `src/schema/plan-limits.test.ts` runs `pnpm gen:limits` on every
  `pnpm test`, and the generator rewrote
  `native/audiod/src/plan-limits.h` with identical bytes. The new mtime
  made `audiod-stale` true after every test run, and it made the next
  daemon build recompile every file that includes the header, which the
  stale row was correctly reporting. `scripts/gen-plan-limits.ts` now
  writes only when the content changes, which fixes both.
- **`pnpm install` builds only when it installs.** Verified against pnpm
  11.15.1: a repeat `pnpm install` prints "Already up to date" and skips
  `prepare`. Hence §4's "build every time".
- **pnpm refuses to link without its bin directory on PATH**, with
  "Run pnpm setup". The installer checks first, so its own message names
  the command to run again.
- **Worker rows come from the CLI in the installer's format**, so the
  installer passes them through and marks `worker-stale` and
  `worker-no-uv` as warnings. A worker nobody set up is not a problem,
  so `field setup --check` exits 1 only for those two.

### 8.2 What was verified, and how

- `src/install.test.ts` runs the real `install.sh` under real bash
  against a temporary clone, with stand-ins for pnpm, cmake, and the CLI
  and a PATH that holds nothing else. It covers each target, each
  prerequisite failure, the link left alone and moved, and every status
  row, including a checkout behind its upstream, online and offline.
- `src/commands/upgrade.test.ts` runs real bash against a stand-in
  installer: the target, the exit status, the printed command, and a
  missing installer.
- `src/workers/setup.test.ts` covers `--existing` and `--check` against
  a temporary worker, asserting the probe asks uv nothing about a worker
  nobody set up.
- By hand, in a fresh worktree: `./install.sh audiod` built
  `field-audiod` from cold in 3 minutes 8 seconds. With a throwaway
  `PNPM_HOME`, `install.sh cli` run from `/tmp` linked the worktree, a
  second run did not relink, and `field upgrade status` from `/tmp` ran
  the worktree's installer.

### 8.3 What is still owed

- Chunks 2 to 4, and the decisions in §7 that gate them.
