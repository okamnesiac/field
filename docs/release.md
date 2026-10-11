# Release Field

A Field release is a version tag and a GitHub release, and nothing else.
It publishes no files: whoever installs a release builds it, the
`field-audiod` daemon included. The version is the one in `package.json`,
which `field --version` prints. Each release pushes an immutable tag such
as `v0.2.0`, moves the major tag (`v0`) to the same commit, and creates
the GitHub release with notes generated from the merged pull requests.
`v0` is the channel that the release installer follows
([install.md](install.md#install-a-release)).

## Cut a release

1. On GitHub, open **Actions > Release > Run workflow**, and choose which
   part of the version to raise: `patch`, `minor`, or `major`.
2. The workflow opens a pull request titled `Release X.Y.Z` that changes
   only the version in `package.json`. Review and merge it like any other
   pull request.
3. Merging is the decision to ship. The workflow's publish job sees the
   new version on `main`, tags it, moves `v0`, and creates the GitHub
   release.

The workflow can open the pull request only when the repository allows
GitHub Actions to create pull requests, under **Settings > Actions >
General > Workflow permissions**. Without that setting, the job pushes
the `release/vX.Y.Z` branch, fails, and prints the link that opens the
pull request by hand. Merging that pull request publishes the release
just the same.

Only a merge that raises the version releases. A change to `package.json`
that leaves the version alone releases nothing, even while that version
has no tag, as `0.1.0` has none. A version that is already tagged
releases nothing either.

## Run the steps by hand

`scripts/release.ts` does each step, and the workflow runs nothing else.
Node 24 runs it directly, with no `pnpm install`:

```sh
node scripts/release.ts bump minor                 # raise the version, write it, print it
node scripts/release.ts set 0.3.0                  # write an exact version instead
node scripts/release.ts released                   # exit 0 if origin has main's version tagged, 3 if not
node scripts/release.ts released --since abc1234   # also exit 0 if that version is not above abc1234's
node scripts/release.ts tag                        # tag main's version, move v0, create the GitHub release
```

The publish job runs `released --since` with the commit that `main` held
before the merge, and `tag` only when that exits 3. `bump` and `set`
refuse a version that does not go up. `tag` reads the version from
`origin/main`, not from your checkout, so an unmerged bump cannot name a
release, and it refuses a version that is already tagged. It pushes both
tags in one atomic push, so the remote gets both or neither. `released`
and `tag` ask the remote which tags it has, never your local tags, so if
the remote refuses the push, run `tag` again once the cause is fixed.
`tag` needs an authenticated `gh` for the GitHub release, and
`tag --no-release` pushes the tags alone. If the GitHub release fails
after the tags are pushed, the error prints the `gh release create`
command that finishes it.

## Versions a release leaves alone

`field-audiod` and the model workers keep versions of their own:
`native/audiod/src/version.h` for the daemon, and `DAEMON_VERSION` in
each worker's `protocol.py`. Each one reports its version in `hello`,
which `field --version` prints for each daemon that is running, and the
daemon stamps its version into every take's manifest. They change with
what the daemon or the worker does, not with a release, so the release
script never touches them.

Under `0.x`, a minor release may break compatibility, so the `v0` channel
promises less than a `v1` channel will. A breaking change after `1.0.0`
starts the next major tag.
