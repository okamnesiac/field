---
status: in-progress
priority: now
---

# Install and upgrade

**Goal:** one command installs Field and another keeps it current, the
way Projector's `install.sh` and `project upgrade` do. `./install.sh`
installs a checkout today, and `field upgrade` runs it from any
directory. Field has releases now, and once the release installer
exists, `curl -fsSL https://field.one/install.sh | bash` installs one
with no clone, building it as the checkout installer does, and
`field upgrade` moves it to the next release.

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
| `cli` | `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm run build:ui`, and `pnpm add -g <checkout>` unless pnpm's global `field` already links this checkout. |
| `audiod` | `pnpm run build:native`. |
| `workers` | `field setup --existing` (§2.4). |
| `all` | `cli`, `audiod`, `workers`. |
| `status` | One row per fact, changing nothing (§2.6). |

Every target except `status` ends by fetching the checkout's upstream
and warning when the checkout is behind it. The installer never pulls.

Each prerequisite is checked before anything changes, and a missing one
stops the installer with exit status 69 and a message that names the
fix: Node 24 or newer, pnpm (`corepack enable pnpm`), a pnpm global bin
directory on PATH (`pnpm setup`), and CMake 3.24 or newer for `audiod`
and `all`. A C++ compiler and the Linux development headers are not
checked; the daemon build reports either one missing. An unknown target
exits 64.

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
otherwise. The CLI's own remedies come from `src/remedies.ts`, so they
name the upgrade rather than a pnpm script that is not a script inside a
song project. The eight daemon error messages name `BUILD_DAEMON`, which
is `field upgrade audiod`. `field --version` names `BUILD_CLI` for a
stale build, and `field ui` names `BUILD_UI` for a missing client and
`INSTALL_UI` for a missing app shell, each of which is
`field upgrade cli`. On Windows each names its pnpm script in the
checkout instead, because `field upgrade` refuses there (§7.6).

### 2.6 `status` compares what is installed with its source

| Piece | Current when | Compared by |
| --- | --- | --- |
| Checkout | it is not behind its upstream after a fetch | `git rev-list --count HEAD..@{upstream}`, as Projector's installer does, and `@{upstream}..HEAD` for `repo-ahead` |
| CLI | `dist/` was built from `HEAD` with the same number of uncommitted changes | `dist/build-info.json`, which `pnpm build` stamps and `field --version` already reads |
| UI | no tracked file it may bundle is newer than `ui/dist/index.html`: anything under `ui/` or `src/` but a test, and `pnpm-lock.yaml` | file mtimes, because Vite rewrites `index.html` on every build (§8.1) |
| Daemon | no tracked file under `native/audiod` is newer than the binary | file mtimes, with the binary touched after each build (§8.1) |
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
| `src/remedies.ts` | New. `BUILD_CLI`, `BUILD_UI`, `INSTALL_UI`, and `BUILD_DAEMON`, the commands the CLI's messages name (§2.5). |
| `src/audiod/client.ts`, `src/audio/plugins.ts`, `src/audio/render-daemon.ts`, `src/keys/helper.ts` | The daemon error messages name `BUILD_DAEMON`. |
| `src/commands/version.ts`, `src/commands/ui.ts` | A stale build, a missing client, and a missing app shell name `field upgrade cli`. |
| `docs/install.md` | New. How install and upgrade work, and every status row. |
| `docs/cli.md` | The install section, `field upgrade`, and the new `field setup` options. |
| `README.md`, `examples/bloom/README.md` | Lead with `./install.sh`. |

## 3 Releases and the one-line install

These are chunks 2 to 4. They are designed far enough to show that
chunk 1 does not paint them into a corner, and the open questions in §7
decide the rest.

### 3.1 Releases (chunk 2)

A release is a version tag and a GitHub release, as Projector's are,
and publishes no files. Whoever installs it builds it from the tag's
source, the daemon included, because Field publishes no daemon binary
(§7.1). `docs/release.md` describes how to cut one.

The version is `package.json`'s, the one `field --version` prints.
`scripts/release.ts`, modeled on Projector's `.github/scripts/release.py`,
has four commands:

| Command | Does |
| --- | --- |
| `bump patch\|minor\|major` | Raises one part of the version, writes it to `package.json`, and prints it. |
| `set X.Y.Z` | Writes an exact version. Both refuse a version that does not go up. |
| `released` | Exits 0 when the version on `origin/main` is tagged, and 3 when it is not. With `--since COMMIT`, it also exits 0 when that version is not above `COMMIT`'s. |
| `tag` | Tags that version `vX.Y.Z`, force-moves the major tag `v0` to the same commit, pushes both, and creates the GitHub release with generated notes. `--no-release` skips the GitHub release. |

`.github/workflows/release.yml` runs them as Projector's Release
workflow does. Started by hand with `patch`, `minor`, or `major`, its
propose job runs `bump` on a `release/vX.Y.Z` branch and opens the
release pull request. When a change to `package.json` reaches `main`,
its publish job runs `released --since` with the commit `main` held
before the push, and `tag` when that exits 3. So only a push that raises
the version releases, though 0.1.0, the version `main` starts at, has no
tag (§9.1). Node 24
runs the script directly by stripping its types, and the script imports
only Node's own modules, so neither job installs a dependency.

`field-audiod` (`native/audiod/src/version.h`) and the model workers
(`DAEMON_VERSION`) keep versions of their own. They report them in
`hello`, the daemon stamps its version into take manifests, and they
move with what each process does, so a release leaves them alone.

### 3.2 The release installer (chunk 3)

Without a checkout, `install.sh` installs a release by building it:

1. It reads the version from `package.json` at `FIELD_REF` (default
   `v0`) in `FIELD_REPO` (default `okamnesiac/field`), which is how
   Projector's installer learns the version it is installing.
2. It downloads GitHub's source archive of the immutable tag for that
   version, `vX.Y.Z` rather than `v0`, and unpacks it into
   `~/.local/share/field/<version>/`.
3. It runs the same steps a checkout install runs, with the same
   prerequisite checks: `pnpm install --frozen-lockfile`, the CLI and UI
   builds, and the daemon build.
4. It switches `~/.local/share/field/current` to the new version and
   links `field` to it. The previous version stays until the switch
   succeeds, so a failed download or build leaves the old install
   working.
5. It sets up again each worker that was set up in the previous version
   (§7.5).

It needs what `./install.sh` needs, plus curl and tar: Node 24, pnpm,
CMake 3.24 or newer, and a C++ compiler. The first install compiles
JUCE, which takes a few minutes. Each version unpacks into a directory
of its own, so chunk 3 keeps JUCE's download outside it, for example
with CMake's `FETCHCONTENT_BASE_DIR`, so that an upgrade does not fetch
JUCE again. Whether `field` is linked by `pnpm add -g`, as a checkout
is, or through `~/.local/bin`, is chunk 3's to settle (§4).

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
    installs (chunk 3) were to use `~/.local/bin` because they would not
    need pnpm. Since §7.1 they build with pnpm too, so chunk 3 settles
    how they link `field`. `status` reports `cli-shadowed` when two
    `field` commands exist and the wrong one is first on PATH.
- **Never pull, never switch branches.** The checkout may hold work in
  progress. `status` reports how far behind it is, which is Projector's
  choice too.
- **Build every time.** `pnpm install` builds through `prepare` only
  when it installed a dependency, so a second run after a `git pull`
  would build nothing. The CLI build takes about three seconds, and the
  UI build about two.
- **`--frozen-lockfile`.** An installer has no business rewriting the
  checkout's lockfile, and pnpm's error says which `package.json` moved
  ahead of it.
- **Workers re-sync; none is set up.** Leaving them out keeps the stale
  venv §1 describes. Setting every worker up starts a 12 GB download
  nobody asked for.
- **The daemon is compared by mtime, not by a stamp.** A commit stamped
  into the binary, as `dist/` has, would need the daemon to report it,
  and would miss uncommitted edits. Mtimes are the build's own test,
  and the installer touches the binary after each build, so
  `audiod-stale` means a source changed since the installer last built
  the daemon, and the build it asks for clears it (§8.1).
- **Releases are tags, and whoever installs one builds it** (§3.1,
  amended 2026-10-11). This first said releases ship built artifacts, a
  CLI tarball and a daemon per platform, so that a release install would
  need no pnpm and no compiler. What changed is §7.1: a published daemon
  binary is a distribution of JUCE and the VST3 SDK under copyleft
  terms, and a user who builds the daemon from the release's source
  distributes nothing. Once every user needs a compiler for the daemon,
  a prebuilt CLI saves only the three seconds `tsc` takes, so it went
  too, and with it the checksums and the per-platform builds. A release
  install runs the steps a checkout install runs. Prebuilt binaries
  remain the optimization to make if the toolchain turns out to be the
  barrier (§7.3).
- **The UI builds with the CLI.** `field ui` serves `ui/dist`, which
  bundles code from `src/`, so a CLI built without its UI leaves
  `field ui` stale or refusing. The `cli` target builds both rather than
  growing a `ui` target, because `field upgrade cli` is then the one
  remedy for either.

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

Chunk 2:

- Running the Release workflow with `patch`, `minor`, or `major` opens a
  pull request that changes only the version in `package.json`.
- Merging it tags `vX.Y.Z`, moves `v0` to the same commit, and creates
  the GitHub release. A `package.json` change that leaves the version
  alone releases nothing.
- A release publishes no files.

Chunks 3 and 4:

- On a machine with the checkout installer's prerequisites and no
  checkout, `curl -fsSL https://field.one/install.sh | bash` installs
  `field` and builds `field-audiod`, and `field upgrade` later moves both
  to the next release.

## 6 Chunks

1. **The checkout installer and `field upgrade`.** §2. Shipped in #185.
2. **Releases.** §3.1. This change.
3. **The release installer.** §3.2. Needs chunk 2, and decides whether
   Windows gets an `install.ps1` (§7.6).
4. **The one-line install.** §3.3, in `okamnesiac/audiofield`. Needs
   chunk 3 and a public repository.

## 7 Open questions

### 7.1 The daemon binary's license (DECIDED, 2026-10-11)

Field's code is under the MIT License (#184). The daemon carries more
than Field's code: `field-audiod` links JUCE, which is AGPLv3 or
commercial, and compiles in Steinberg's VST3 SDK, which JUCE 8.0.4
bundles under GPLv3 or Steinberg's proprietary VST3 license. A
commercial JUCE license does not cover the SDK.
[README.md](../../../README.md) "License" and
[architecture.md](../../architecture.md) "Licensing" record these terms.

So a daemon binary that a release published would be a distribution
under AGPLv3 and GPLv3, unless the publisher held both commercial
licenses.

**Decided: Field publishes no daemon binary, and whoever installs Field
builds it.** What a release distributes is Field's MIT source. JUCE is
not in the repository either: `native/audiod/CMakeLists.txt` fetches it
from JUCE's own repository at build time. A user's build is under the
copyleft terms for that user's own use, and those terms attach only to
someone who distributes it. The two options this beat:

- **Publish under the copyleft terms**, with the license notices in the
  daemon's archive and the repository at the release tag as its source.
  It would make the one-line install need no compiler, at the price of
  building, signing, and hosting a binary per platform (§7.3), and of a
  source obligation on every release.
- **Hold both commercial licenses**: a commercial JUCE license and
  Steinberg's proprietary VST3 license. It costs money every month to
  remove an obligation that publishing nothing removes for free.

One obligation remains outside this plan: if audiofield.io ever runs
`field-audiod` on its servers to render for users, AGPLv3 §13 asks it to
offer those users the daemon's source. The source is public, so that is
easy to meet, but it is an obligation.

If prebuilt binaries become worth making, a newer JUCE narrows the
choice they need. Steinberg released VST3 SDK 3.8.0 under the MIT
License
([announcement](https://forums.steinberg.net/t/vst-3-8-0-sdk-released/1011988),
and `LICENSE.txt` at the SDK's `v3.8.0_build_66` tag), and JUCE 8.0.11
is the first JUCE release that bundles it: its
[change list](https://github.com/juce-framework/JUCE/blob/master/CHANGE_LIST.md)
reads "Updated the VST3 SDK to 3.8.0 (MIT license)", and every
`LICENSE.txt` in its `VST3_SDK` directory is MIT. With JUCE 8.0.11 or
later, the SDK asks only that its notice ship with the binary, and the
choice left is JUCE's own: AGPLv3, or a commercial JUCE license. JUCE
8.0.11 also bundles the ASIO SDK under GPLv3, which the daemon does not
enable. Moving the daemon's pin off 8.0.4 is a change of its own.

### 7.2 Platforms

Answered by §7.1. A release has no per-platform files, so it installs
wherever the checkout installer builds: macOS and Linux, on any
architecture CMake and JUCE support. Windows is §7.6.

### 7.3 Where the macOS daemon builds (DECIDED, 2026-10-11)

Nowhere, for now: after §7.1 a release builds nothing that depends on
the platform, so the release workflow runs on Linux in seconds.

If prebuilt binaries come later, they build locally, on a maintainer's
Mac, and `gh release upload` attaches them to the release. GitHub bills
a macOS runner at ten times the Linux rate, a cold JUCE build takes
minutes, and this account caps Actions spending at $40 a month. Building
in the release workflow with a warm cache lost to that cost, and the
price of the local build, a release that depends on one machine, is one
to pay only once binaries exist.

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
with the steps, and the installer's tests skip there.

Chunk 3 decides whether Windows gets an `install.ps1` of its own. A
checkout on Windows installs with the four commands in
`docs/install.md`, but a release install has no checkout to run them
in, and the release installer is bash too. Since §7.1 a Windows release
install would build the daemon with MSVC, as a Windows checkout does.

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
- **CMake relinks `field-audiod` only when its own inputs change.**
  `native/audiod` also builds `field-dsp-check` and `field-fixture`, and
  an edit to `CMakeLists.txt` may only reconfigure. Comparing the sources
  with the binary alone would leave `audiod-stale` standing after the
  rebuild it asks for, so `install_audiod` touches the binary after each
  successful build.
- **`pnpm install` builds only when it installs.** Verified against pnpm
  11.15.1: a repeat `pnpm install` prints "Already up to date" and skips
  `prepare`. Hence §4's "build every time".
- **The UI needs no install step of its own.** `ui/` is a pnpm
  workspace member, so the root `pnpm install` already installs its
  dependencies, the `electron` package included, and `build:ui` runs
  `tsc --noEmit` and `vite build` in about two seconds. The installer
  runs `build:ui` without checking for `ui/`: `package.json` names the
  script and `pnpm-workspace.yaml` names the directory in the same commit
  as the installer, so a checkout without `ui/` is broken, and the failed
  build says so. The `status` row compares mtimes as the daemon's does,
  over `ui/`, `src/`, and `pnpm-lock.yaml`, because the bundle imports
  from `src/` and nothing cheaper names which files.
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

## 9 Chunk 2 as built (2026-10-11)

### 9.1 What implementation settled

- **The script is TypeScript that Node runs directly.** Projector's
  release script is Python, its own language; Field's is
  `scripts/release.ts`. Node 24 strips its types, verified on 24.19.0
  with no warning, and it imports only Node's modules, so the workflow
  sets up Node and runs it with no `pnpm install`. `src/release.test.ts`
  imports it, which is what puts it under `pnpm typecheck`.
- **One version file.** Projector's script checks that three version
  files agree. Field releases only `package.json`'s version, because the
  daemon's and the workers' versions describe their protocols (§3.1).
- **The GitHub repository comes from the configured remote URL.**
  `git remote get-url` applies `insteadOf` rewrites, which can turn a
  GitHub URL into a mirror's, so the script reads
  `remote.<name>.url` instead.
- **Tags are fetched with `--force`.** Every release moves `v0`, and a
  local copy of the old one would otherwise refuse the fetch that
  `released` and `tag` start with.
- **Only a push that raises the version releases.** Projector's publish
  job asks only whether the merged version is tagged, which holds there
  because its version was tagged when its workflow landed. Field's
  `main` starts at 0.1.0 with no tag, so that check alone would release
  0.1.0 on the first change to `package.json` of any kind, such as a new
  script. The job passes `github.event.before` to `released --since`,
  which exits 0 unless the push raised the version. A revert of a
  release pull request lowers the version, so it releases nothing
  either. Tagging 0.1.0 as a baseline would also stop it, but that tag
  would name a version nobody released.
- **This repository does not let GitHub Actions open pull requests**
  (`can_approve_pull_request_reviews` is `false` on 2026-10-11), so the
  propose job can push the release branch but not open its pull
  request. The job then fails with the link that opens it by hand, and
  `docs/release.md` names the setting.

### 9.2 What was verified, and how

- `src/release.test.ts` runs the script's functions against a temporary
  repository whose `origin` is the path of a bare repository beside it,
  never a GitHub URL. Every git process the file starts, the script's
  included, ignores the user's and the system's git config and any
  repository the environment names, so a `pushInsteadOf` rule in
  `~/.gitconfig` cannot send the suite's pushes to GitHub. A test puts
  such rules in a stand-in home directory and checks that the pushes
  still reach `origin` and never the decoy the rules point at. The file
  also covers each `bump` part, `set` refusing a version that does not
  go up, `tag` pushing both tags and moving `v0` on the next release,
  tagging what `origin/main` holds rather than an unpushed bump,
  refusing a tagged version, a remote that is not GitHub, the GitHub
  repository read from a remote's configured URL, a failed GitHub
  release naming the command that finishes it, `released`'s exit codes,
  `released --since` releasing nothing unless the version went up, and
  plain `node` running the file.
- The workflow itself has not run. Its first run is the first release.
  Its publish step was run verbatim against a local bare remote, with
  `tag --no-release` in place of `tag`. After a push that changed only
  a script in `package.json`, it released nothing, and after one that
  raised the version to 0.2.0, it tagged `v0.2.0` and created `v0`.

### 9.3 What is still owed

- The first release. Run the Release workflow with `minor` to release
  0.2.0, which tags `v0.2.0` and creates `v0`.
- Chunks 3 and 4.
