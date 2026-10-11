# Install and upgrade

You install Field from a checkout with `./install.sh`, and you keep it
current with `field upgrade`, which runs the same installer from any
directory. The installer builds the checkout, links it onto your PATH as
`field`, builds the audio daemon `field-audiod`, and re-syncs any model
worker environment you have set up. `./install.sh status` and
`field upgrade status` report what is installed and what is out of date.

```sh
git clone https://github.com/okamnesiac/field
cd field
./install.sh
```

Installing a release without a checkout, and the one-line `curl`
install from the website, are planned in
[install.md](projects/install/readme.md) §3.

The installer is bash and does not support Windows yet, and
`field upgrade` refuses there. On Windows, run the steps by hand in the
checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:native
pnpm add -g .
```

## Before you install

Before it changes anything, the installer checks for each of these that
the target needs, and stops with a message naming the one that is
missing:

- **Node 24 or newer.** The version in `.nvmrc`.
- **pnpm.** `corepack enable pnpm` installs the version `package.json`
  names. Run `pnpm setup` once, then open a new shell, so pnpm has a
  global bin directory on your PATH to link `field` into.
- **CMake 3.24 or newer and a C++20 compiler**, for `field-audiod`. On
  macOS, `brew install cmake` and Xcode's command line tools. On Linux,
  JUCE also needs the ALSA, X11, and freetype development headers;
  `.github/workflows/ci.yml` installs the packages it needs on Ubuntu.

`field build` also needs [SuperCollider](https://supercollider.github.io/),
and `field generate` needs [uv](https://docs.astral.sh/uv/). The
installer installs neither.

## What each target does

`./install.sh [target]` and `field upgrade [target]` take one target.
With none, they run `all`.

| Target | What it runs |
| --- | --- |
| `cli` | `pnpm install --frozen-lockfile`, then `pnpm run build`, then `pnpm add -g <checkout>` unless pnpm's global `field` already links this checkout. |
| `audiod` | `pnpm run build:native`. The first build fetches and compiles JUCE, which takes a few minutes; later builds compile only what changed. |
| `workers` | `field setup --existing`, which re-syncs each worker environment you set up with `field setup` and sets up no new one. |
| `all` | `cli`, then `audiod`, then `workers`. |
| `status` | Reports what is installed, changing nothing. |

Each target except `status` ends by fetching the checkout's upstream
and warning if the checkout is behind it.

The installer installs the checkout as it is. It never pulls, and it
never switches branches, because the checkout may hold work in progress.
To pick up new commits, pull first:

```sh
git pull                 # in the checkout
field upgrade
```

### The link

`field` is a link to the checkout, not a copy. pnpm's global
`node_modules/field` is a symlink into the checkout, and `pnpm build`
rewrites the `dist/` it points at, so a build takes effect without
relinking. The link also decides which checkout `field upgrade` runs:
`field upgrade` runs the `install.sh` beside the package it was loaded
from.

If pnpm's global `field` links a different checkout, `./install.sh cli`
moves the link to this checkout and prints a `moved` row naming both.
Run it in whichever checkout you want `field` to be.

### Worker environments

Setting up a worker is explicit, because the first `field generate` of
each kind downloads that model's weights: about 10 GB for ACE-Step and
2 GB for Chatterbox. The `workers` target therefore re-syncs only the
environments that are already set up, so an upgrade keeps them current
with the checkout's lockfiles and never starts a download you did not
ask for. A worker counts as set up when its console script is installed
in `python/<worker>/.venv`, which is the same test `field generate`
applies before it starts one.

```console
$ field setup --existing
skipping field-voiced: not set up (field setup voiced)
syncing the field-aced environment (uv)…
```

## Read the status

`field upgrade status` prints one row per fact. A row marked ⚠️ needs
you to do something, and it names the command.

```console
$ field upgrade status
+ /Users/you/field/install.sh status
checkout       ~/field (main at f80efb6)
repo-behind    ⚠️  main is 2 commits behind origin/main — run git pull in ~/field, then field upgrade all
node           24.19.0
pnpm           11.15.1
cmake          4.4.0
cli            ~/Library/pnpm/bin/field -> ~/field
cli-current    built from f80efb6
audiod-stale   ⚠️  native/audiod/src/player.cpp changed since field-audiod was built — run field upgrade audiod
worker-current field-aced
worker-absent  field-voiced is not set up — field setup voiced sets it up
```

| Row | Meaning |
| --- | --- |
| `checkout` | The checkout this installer belongs to, its branch, and its commit. |
| `repo-current`, `repo-ahead`, `repo-behind` | Whether the branch matches its upstream after a fetch, has commits the upstream lacks, or lacks commits the upstream has. A branch that is both ahead and behind reports `repo-behind`. |
| `repo-untracked` | The branch has no upstream, or HEAD is detached, so there is nothing to compare against. |
| `node`, `pnpm`, `cmake` | The versions found. `node-old`, `node-missing`, `pnpm-missing`, and `cmake-missing` say what to install. |
| `cli` | pnpm's global `field` links this checkout. |
| `cli-missing`, `cli-elsewhere` | pnpm links no `field`, or links another checkout. Run `./install.sh cli` here to link this one. |
| `cli-shadowed` | Another `field` comes before pnpm's on your PATH, so that one runs. |
| `not-on-path` | pnpm's global bin directory is not on your PATH. Run `pnpm setup`. |
| `cli-current`, `cli-stale`, `cli-unbuilt` | Whether `dist/` was built from the checkout as it stands: the same commit, and the same number of uncommitted changes. `field --version` makes the same comparison. |
| `audiod-current`, `audiod-stale`, `audiod-missing` | Whether `field-audiod` is built, and whether any tracked file under `native/audiod` is newer than it. The installer touches `field-audiod` after each build, because CMake relinks it only when its own sources change, so `field upgrade audiod` clears `audiod-stale`. |
| `audiod-override` | `FIELD_AUDIOD` is set, so `field` runs that binary instead of this build. |
| `worker-current`, `worker-stale`, `worker-absent`, `worker-no-uv` | Each worker environment, from `field setup --check`. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `FIELD_OFFLINE=1` | Skips the fetch, and compares the checkout against the last fetch of its upstream. |
| `NO_COLOR` | Prints warning rows without color. The ⚠️ marker stays. |
| `FIELD_AUDIOD` | Not read by the installer. `status` reports it, because `field` runs that binary instead of the one the installer builds. |
