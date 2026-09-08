# Remote

A Field project can live on an audiofield remote: a site that serves the
repository over Git, keeps its committed audio in Git LFS, and holds the
build outputs the author already rendered so that a fresh clone builds
from cache hits instead of rendering. Field talks to it through four
verbs and one flag, all over Git and HTTPS, and the remote is a second
action cache, never a second source of truth. Nothing in Field renders
remotely or edits collaboratively; the plan that shaped this is
[remote.md](projects/remote/readme.md), and the site's own plan is
`audiofield-io.md` in the audiofield repository.

## Log in

`field login` runs a device-code flow. It asks the remote for a code,
prints the verification URL and the short code, opens the browser where
it can, and polls until you approve:

```console
$ field login
Open https://audiofield.io/device and enter the code: WDJB-MJHT
waiting for approval in the browser…
logged in to https://audiofield.io as howlo (token in keychain)
```

No password enters the terminal, and the token never prints. `field
logout` forgets it, revoking it on the remote when the remote is
reachable and forgetting it locally either way.

Both verbs act on the project's remote when you run them inside a
project, on `FIELD_REMOTE` otherwise, and on `https://audiofield.io`
when neither says anything. Pass `--remote <url>` to name another site,
such as a staging one; one token is held per remote.

### Where the token lives

This is the first per-user state Field keeps.

- On macOS the token is a generic password in the login keychain,
  service `field`, account the remote's URL. Field reads and writes it
  through the `security` tool; Keychain Access shows it under that
  service, and deleting it there is the same as `field logout`.
- Elsewhere it is `~/.field/credentials`, a JSON file mode `0600` in a
  `0700` directory, mapping each remote to its token. Delete the file
  to log out of everything.

`FIELD_TOKEN` overrides both for CI and agents. Field reads it and
never writes it, and `field login` warns when it is set, because the
stored token is then not the one that will be sent.

`field --version` reports which remote a project talks to, where that
URL came from, and whether a token is held for it, without printing the
token:

```console
$ field --version
field 0.1.0  (24b7499 on main)
worker protocol 2
remote        https://audiofield.io (origin)  token in keychain
```

## Clone a project

`field clone <owner>/<project> [dir]` expands the short name through the
remote's API, clones with Git LFS, and warms the build cache:

```console
$ field clone howlo/chemicals
cloning https://git.audiofield.io/howlo/chemicals.git into chemicals
creek: fetched 14 artifacts (212.5 MB)
tall-grass: not warmed — //songs/tall-grass/gen:topline has no takes yet
cloned into chemicals
```

The warm fetches, for every song's `main`, the action entry and outputs
of `main` and of every rule node beneath it, so the first `field build`
is hits all the way down. It writes only under `.field/`, which is
gitignored, so a warmed checkout is a clean one. A song whose generative
requests have no committed takes cannot be keyed and is reported in the
words `build` uses, rather than warmed.

`field clone` refuses before touching the network when `git-lfs` is not
installed, because a clone without it lands pointer files where audio
should be and the first `field check` then reports every ledger row as
corrupt. `field init` only warns about a missing `git-lfs`, since a new
project has no audio yet. The clone carries the LFS filters itself and
runs `git lfs install --local` in the new checkout, so audio arrives as
audio and a later push uploads it, whether or not LFS was ever installed
globally on the machine.

When the remote cannot be reached during the warm, each song reports
`not warmed` with the reason rather than claiming nothing was cached.

A full clone URL works where a short name is expected, so a project
hosted anywhere Git reaches can still be cloned; only the expansion and
the warm need the remote's API. For an audiofield git host, the clone is
configured with `field git-credential` as the only credential helper for
that host, so Git over HTTPS and the API share the one stored token and
no other helper keeps a copy. The helper answers only for the remote
your shell points at, with `FIELD_TOKEN` honoured there, and for a host
you logged in to by name; it stays silent for anything else, so a token
never goes to a host it was not minted for. `field push` and `field
pull` pass `http.proactiveAuth=basic` (Git 2.46 and later) per
invocation when they hold a token, so Git sends it without a 401 round
trip; the clone does not persist that setting, because with it set and
no credential Git asks for a username before its first request.

## The read-through cache

When a project has a remote, a local cache miss in `field build` asks
the remote for the action key before running the rule. A hit downloads
the outputs, verifies each against the entry's hash and size before it
lands in `.field/cache/cas/`, writes the entry into
`.field/cache/actions/`, and reports the target as `fetched` where a
local hit says `cached`:

```console
$ field build creek
fetched  //songs/creek/track:pad-eq → .field/out/songs/creek/track/pad-eq.wav
fetched  //songs/creek/track:main → .field/out/songs/creek/track/main.wav
```

`field explain <label>` reads through the same way and reports
`fetched` for the same label. `field play` and `field export` build
through the same path. `field build --watch` and `field play --watch`
do not read through: a rebuild loop that waits on a network on every
edit is a different trade.

Every failure falls through to the render exactly as a local miss does.
A miss on the remote is silent. An unreachable remote, a refused token,
or a remote speaking another protocol prints one line on stderr, once
per build, and the remote is not asked again that build:

```console
$ field build creek
remote: https://audiofield.io is unreachable (ENOTFOUND); building locally
built    //songs/creek/track:pad-eq → .field/out/songs/creek/track/pad-eq.wav
```

A download whose hash disagrees with its entry is discarded, reported,
and treated as a miss, so a wrong remote can cost a render but never
poison the cache. Reads only: a build never uploads.

A request that gets no answer within 15 seconds, or a download that
goes idle for 30 seconds, counts as unreachable, so a black-holed remote
holds a build for at most that long before the notice. An API that
redirects, say to a marketing site, is reported as misconfigured rather
than followed.

### Which remote

Field reads the remote from Git. The project's `origin` names it: for
`https://git.audiofield.io/howlo/chemicals.git`, the git host `git.<site>`
implies the API at `https://<site>`, and the last two path segments name
the project. No second file records the same fact.

- `FIELD_REMOTE=<url>` replaces the API base and nothing else, for a
  staging site or a test stub. The project is still read from
  `origin`'s path, so a checkout cloned from a bare repository at
  `/remotes/howlo/chemicals.git` talks to the stub about
  `howlo/chemicals`.
- `FIELD_REMOTE=off` disables reads for a shell, including the read
  that expands a short name, so `field clone` under it takes a URL.
- `--no-remote` skips the lookup for one `build` or `explain`.

A project whose `origin` is not an audiofield git host, and has no
`FIELD_REMOTE`, has no remote, and every command behaves as it did
before this existed.

Every conversation is HTTPS. Plain `http` is accepted only for a
loopback host (`localhost`, `127.0.0.1`, `::1`), which is how you run
the CLI against a site on your own machine. An `origin` on plain `http`
anywhere else gives the project no remote, and a plain-`http`
`FIELD_REMOTE` or `--remote` is refused with a message saying so, before
a token or a device-code exchange can cross the network in the clear.

## The contract

The remote's API is versioned the way the daemons' protocols are. The
CLI checks `/api/hello` once per process and stops if `protocol` is not
`REMOTE_API_VERSION` (`src/remote/protocol.ts`), saying which side to
update; anything finer is a name in the hello's `features` list. The
request and response shapes are zod schemas in the same file, so the
site's tests can import them and a drift fails a test on whichever side
moved second. Device authorization uses RFC 8628's field names. A
private project answers 404 to anyone without access, the same as one
that does not exist.

## Push a project

`field push [git args]` is `git push` with everything after the verb
handed to Git, then the artifact offer: every rule entry this machine
holds beneath each song's `main`, sent with the commit at `HEAD` and the
label it satisfies. The remote asks for the outputs it lacks, those are
uploaded, and a completion call registers the entry:

```console
$ field login
$ field push -u origin main
creek: offered 6 entries, uploaded 4 outputs (61.2 MB)
tall-grass: not offered — //songs/tall-grass/gen:topline has no takes yet
```

Nothing renders on push: an artifact you never built is simply not
offered. Every entry beneath `main` is offered, not only the new ones,
because the site plays by commit and label and an unchanged mix at a
new commit still needs to be named at that commit; the remote asks for
no upload when it already holds the bytes, so a second push of the same
commit reports `already on the remote` and moves nothing.

The offer describes `HEAD`, so a working tree with uncommitted changes
pushes and offers nothing, and says so: the keys are computed from the
files on disk, and calling them the commit's would be a lie the site's
player would repeat. Commit, then push again.

When a token is held, the push carries two things per invocation that
let Git use it without any configuration in the checkout: the
credential helper for the origin's host, so a project made with `field
init` needs only `field login` before its first push, and
`http.proactiveAuth=basic` (Git 2.46 and later), so the token goes
without a 401 round trip. Neither is written to the checkout, because
"a token is held" is only known to be true at that moment. Without a
token, `git push` runs as it always did, and a private project asks Git
the usual way.

A remote that refuses the token, or stops answering part way, stops that
song's offer and says why; what was completed is registered, and the
rest is offered again by the next push. Plain `git push` keeps working;
it just carries no artifacts, and the site says `no build yet` for the
songs it cannot play.

## Pull

`field pull [git args]` is `git pull` with the arguments handed to Git,
then the warm `field clone` does, for the `HEAD` the pull left behind:

```console
$ field pull
Already up to date.
creek: fetched 2 artifacts (2.1 MB)
```

A plain `git pull` keeps working and skips the warm; the next `field
build` then reads through per miss instead.

`field push` and `field pull` carry artifacts the other way from the cache, and are
the next chunk of [remote.md](projects/remote/readme.md).
