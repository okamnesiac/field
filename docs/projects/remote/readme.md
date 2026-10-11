---
status: in-progress
priority: next
---

# Remote — login, clone, push, and a read-through cache

**Goal:** the CLI half of audiofield.io: `field login`, `field clone
<owner>/<project>`, `field push` and `field pull`, and a `field build`
that asks the remote for an artifact before rendering one — so a fresh
clone builds with cache hits from the site, a push carries the renders
the author already heard, and nothing in Field itself learns to
collaborate or render in the cloud.

This is the plan that `audiofield-io.md §6` in okamnesiac/audiofield
(`docs/projects/audiofield-io/readme.md` there) asked for. That plan
owns the site and its API; this one owns the CLI surface, where a token
lives, and what the cache does when a remote is in reach. Each cites
the other by section, and where the two disagree the code that ships
decides and both get corrected.

## 1 Shape

- **Four verbs and one flag, over Git.** `login`/`logout` mint and
  forget a token; `clone` expands a short name and warms the cache;
  `push`/`pull` are `git push`/`git pull` followed by an exchange of
  build artifacts; and `build` reads through to the remote when it
  misses locally. Git carries history and, through LFS, committed
  audio; Field carries only what Git never sees — the outputs under
  `.field/cache/`.
- **The remote is a second action cache, not a second source of
  truth.** [build-graph.md](../../build-graph.md) "Caching, and
  freezing is caching" and
  [plugin-hosting.md](../plugin-hosting/readme.md) §2 already say what
  a shared cache is for: "any machine *holding the artifact* serves it
  without the plugin — today that means the machine that rendered it,
  because the cache is local and unversioned … Freezing is the
  collaboration story, not an optimization." This plan makes the
  holder a server. The action key stays what `src/graph/build.ts`
  computes today; nothing about identity moves.
- **Nothing here renders remotely or edits collaboratively.**
  [docs/README.md](../../README.md) keeps cloud collaboration and
  remote rendering out of V1, and a read-through cache and a push are
  neither: the site renders on its own worker (audiofield-io.md §5.4)
  and the CLI never asks it to. A `field build` with the remote
  unreachable behaves exactly as it does now.
- **Committed audio stays on Git LFS**, which `field init` already
  configures (`src/commands/init.ts`, `LFS_PATTERNS`). The S3 store
  that [remote-asset-store.md](../remote-asset-store/readme.md)
  reserves a slot for is a separate question about where LFS objects
  live; this plan neither needs it nor precludes it.
- **Following a README must not dirty the tree**
  ([bloom-in-tree.md](../bloom-in-tree/readme.md) §7). `clone` and
  `pull` write only under `.field/`, which `init` gitignores, so a
  warmed checkout is a clean one. And `check` keeps answering "is this
  project coherent", never "is this machine logged in"
  (bloom-in-tree.md §3): no rule here consults the remote.

## 2 Where the code stands

Verified against main (7c84226):

- **Git is spawned in two places, with no shared helper.** `init`
  runs `git init` and `git lfs install --local` through
  `execFileSync` — `git init` failing throws, a missing `git-lfs` is
  a stderr warning and init still succeeds (`src/commands/init.ts`
  lines 68–73) — and `field --version` reads build identity through
  a function-local `git` closure over `spawnSync`
  (`src/commands/version.ts:73`). There is no clone, push or remote
  handling anywhere. Extracting a subprocess helper is a decision this
  plan records (§5 decision 10).
- **The cache is five private functions, not a module.** `cacheDir`,
  `casPath`, `actionPath`, `readAction`, `writeAction` in
  `src/graph/build.ts`. `buildNode` (line 180) computes
  `actionKey(node, inputHashes)`, calls `readAction(project, key)`,
  and on a hit materializes `casPath(project, sha256)` into
  `.field/out/<pkg>/<name>.wav`. On a miss it runs the rule, hashes the
  output, renames it into the CAS, and writes the entry last
  (`writeAction`, tmp + rename). An `ActionEntry` is
  `{ rule, outputs: [{ sha256, bytes }] }`. The remote lookup slots
  into the miss branch, right after `const cached = readAction(project,
  key)` and before the tamper guard and `await runner(...)`; the
  upload point on push is the `writeAction` call at the bottom of the
  same function.
- **CAS reads are never verified.** `readAction` checks that each
  output exists and nothing else, and `materialize()` copies from the
  CAS without hashing (copy-to-temp plus rename, never in place, so a
  playing pass is not truncated under its reader — `watch.md §1.6`).
  That is fine for bytes this machine hashed on the way in and wrong
  for bytes that arrived over a network: a fetched output must be
  hashed before it lands at `casPath()`, and the hash check belongs on
  the fetch path, not inside `materialize`, whose swap is the
  constraint to keep. Otherwise the comment on the tamper guard in
  the same function describes exactly what happens — "a tampered file
  gets cached under the clean file's key and the poisoned entry
  outlives the tampering".
- **`explain()` reads the cache too** (`src/graph/build.ts:347`), to
  report `cached:`. It has to consult the remote the same way, or
  `field explain` will say "not cached" for a label `field build`
  would fetch.
- **The runner is injected, and the remote should be.**
  `build(project, graph, nodes, runner = defaultRunner, signal?)`
  takes a `GeneratorRunner` "so tests can count executions or fake the
  tool". A remote client is the same kind of dependency, injected at
  the same seam, never a `fetch` reached for inside `buildNode`.
- **`BuildOutcome` already distinguishes where bytes came from**:
  `cached` and `committed` exist because "nothing executed" and "this
  came out of the cache" are different claims (#35 review). A third,
  `fetched`, is the same honesty applied to the remote.
- **The manifest is strict.** `projectSchema` is
  `z.strictObject({ field: z.literal(1), name: slug, sample_rate })`
  (`src/schema/manifest.ts`), loaded through `loadFile`
  (`src/model/project.ts:290`), so a `license:` line is a hard check
  error today. `projectOrder.keys` has to gain the key or `fmt` and
  `check` disagree; `init()` builds the manifest with
  `projectSchema.parse` and writes it with `stringifyCanonical`, so it
  either emits the line or deliberately does not. Semantic rules live
  beside `verifyAssetHashes` returning `Diagnostic[]`, not in zod; the
  `sampleRate` message in `src/schema/common.ts` is the precedent
  that a refusal is the documentation.
- **`splice.md` already has a `license:`** —
  [splice.md](../splice/readme.md) §1–2 designs one per imported
  asset, a file and a hash beside the bytes. A project-level key has
  to say how the two relate (§3.5).
- **Nothing prints JSON, and no `--json` or `--format` exists.**
  `explainLabel` (`src/commands/build.ts:90`) returns a typed
  `Explanation`; `arrangement` already separates
  `songArrangement(): ArrangementView` from `formatArrangement()`;
  both are direct retrofits. `status` is inline in `cli.ts` with no
  command module, and `check` has a `CheckResult`. Nothing tests
  `cli.ts` action callbacks, so serializers belong in the command
  modules. [mcp-surface.md](../mcp-surface/readme.md) is the standing
  argument for JSON landing first.
- **No HTTP client, no `fetch` call, three dependencies.**
  `commander`, `yaml`, `zod`. Node 24's global `fetch` means the
  remote client adds nothing to that list — the boring answer
  [project-core.md](../project-core/readme.md) §5 prefers, recorded
  there by the PR that flips this plan to in-progress like every
  stack decision.
- **No per-user state anywhere.** No config file, no `~/.field/` on
  the TypeScript side, no XDG lookup; `~/.field/models` is one
  sentence in [ace-generation.md](../ace-generation/readme.md) §5
  about where the worker keeps weights. `field login` creates Field's
  first per-user state, and §5 decision 5 says where.
- **The `FIELD_*` contract is five binary overrides**: `FIELD_AUDIOD`,
  `FIELD_AUDIOD_NULL`, `FIELD_SCLANG`, `FIELD_ACED_PYTHON`,
  `FIELD_VOICED_PYTHON`; the render-time `FIELD_OUTPUT`, `FIELD_SEED`,
  `FIELD_DURATION`, `FIELD_SAMPLE_RATE`, `FIELD_CHANNELS` are handed to
  a subprocess, never read. Subsystem constants live with the
  subsystem — `SOCKET_RELATIVE` in `src/audiod/protocol.ts`, with its
  reason at lines 11–16 — so a `src/remote/` module carrying the API
  version, the default base URL and the credential path fits the
  house, and the four-line `src/constants.ts` stays four lines.
- **Versioning has a house style.** `WORKER_PROTOCOL_VERSION = 2`
  (`src/workers/protocol.ts`) and `RENDER_PLAN_VERSION = 11`
  (`src/audio/render-daemon.ts`) each carry a comment saying why the
  number last moved; the daemon's `hello` answers with `protocol`,
  `version`, and a `features: []` list (`helloResponseSchema`,
  `src/audiod/protocol.ts`), and every capability gate is
  `client.supports()` rather than semver arithmetic —
  [recording.md](../recording/readme.md) §2 records why. `daemonNote()`
  in `src/commands/version.ts` is the peer-skew formatter a remote
  joins.
- **Tests spawn Git already.** The temp-project idiom is
  `mkdtempSync` plus `init({ dir, name })` plus `createSong`, pasted
  into 25 files with no shared helper, and every one of them runs
  `git init` through `init()`. No test runs the `field` binary.
  `src/commands/version.test.ts:36` has `fakeDaemon()` over
  `node:net`; the HTTP equivalent does not exist (§7).

## 3 The verbs

### 3.1 `field login` and `field logout`

`field login [--remote <url>]` runs the device-code flow
(audiofield-io.md §5.5): it asks the remote for a code, prints the
verification URL and the short code, opens the browser where it can,
polls until the person approves, and stores the token. `field logout`
forgets it and revokes it on the remote when reachable. `FIELD_TOKEN`
overrides stored credentials for CI and agents, and is never written
anywhere. `field --version` grows a line saying which remote a token
is held for, without printing it, through `daemonNote()`'s sibling.

### 3.2 `field clone <owner>/<project> [dir]`

Expands the short name to the clone URL the remote reports, runs
`git clone` (LFS included, §5 decision 6), then warms the cache: for
each song's `main` target at the checked-out commit it asks the remote
for the action entries of `main` and every rule node beneath it,
downloads their outputs, hashes each before it lands at `casPath()`,
and writes the action entries — the index, not only the bytes,
because `readAction` is what makes a hit. A full URL is accepted where
a short name is expected, so a project hosted anywhere Git reaches can
still be cloned; only the short form and the warm depend on the
remote's API. The origin is recorded by Git as usual and is what §3.4
reads.

### 3.3 `field push` and `field pull`

`field push [git args]` is `git push` with the arguments passed
through, followed by the artifact offer of audiofield-io.md §5.2: for
each song at the pushed commit, walk `main` and its rule dependencies,
collect the action keys whose entries exist locally, ask the remote
which it lacks, and upload only those — the entry, each output's
bytes, and the commit and label the entry satisfies. Nothing renders
on push; an artifact the author never built is simply not offered.
`field pull` is `git pull` followed by the warm §3.2 does for the new
HEAD. Plain `git push` and `git pull` keep working unchanged; the
site's worker fills what it can when no artifacts arrive.

*Amended (2026-09-08, as built):* every entry beneath `main` is
offered, not only the ones the remote lacks, because the site indexes
its player by commit and label (audiofield-io.md §5.7) and an unchanged
mix at a new commit needs a ref at that commit; the remote asks for no
upload when it holds the bytes, so "upload only those" still holds for
the bytes. The offer describes `HEAD`, so a working tree with
uncommitted changes pushes and offers nothing, since keys computed from
the files on disk would not be the commit's. And when a token is held,
`push` and `pull` pass the credential helper for the origin's host per
invocation as well as `http.proactiveAuth`, so a project made with
`field init` needs only `field login` before its first push, which is
what the site's own instructions say.

### 3.4 The read-through cache in `field build`

When a project has a remote (§5 decision 3), a local miss in
`buildNode` asks the injected remote client for the action key before
running the rule. A hit downloads the outputs, verifies their hashes,
writes them into the CAS and the entry into the index, and returns a
`BuildOutcome` with `cached: true, fetched: true`; the build log says
`fetched` where it says `cached` today, and `explain` reports
`fetched` for the same label. A miss, an unreachable remote, a token
the remote refuses, or a download whose hash disagrees all fall
through to the render exactly as a local miss does — with one line on
stderr for the unreachable and refused cases, once per build, so a
slow network is visible without being fatal. Reads only: a `field
build` never uploads. `--no-remote` skips the lookup for one build.

### 3.5 `license` in `field.yaml`

An optional `license:` key holding an SPDX identifier (`CC-BY-4.0`,
`CC0-1.0`, `MIT`) for the work as a whole — the songs, the recipes,
the recorded and generated takes the project commits. Validated for
shape in the schema and for nothing else; `field check` reports a
malformed one as an error, says nothing when it is absent, and whether
a project must carry one is the site's rule for public projects
(audiofield-io.md §10.5), which a project on disk cannot know.
`field init --license <id>` writes it, and without the flag `init`
emits no line rather than a guess; `projectOrder` places it after
`name`. It does not override splice.md's per-asset `license:`, which
records the terms an imported asset arrived under: an asset keeps its
own license, the site shows both, and a project license speaks only
for what the project's authors made.

### 3.6 `--json` on `field explain` and `field arrangement`

Each prints its existing typed value — `Explanation`,
`ArrangementView` — as JSON to stdout, with `fetched` and any new
field this plan adds carried along. Field names are the TypeScript
interfaces' names, which are already the documented shape; the flag
adds no second vocabulary, and the serializer lives in the command
module where a test can reach it. The site's worker consumes these
(audiofield-io.md §5.6) and so does the artifact offer in §3.3, which
is `explain` for every rule node, minus the printing.

## 4 The contract with the remote

The site owns the API and its paths; this section is what the CLI
needs it to say, so the two can be built to each other. Every
conversation is HTTPS and JSON, authenticated by
`Authorization: Bearer <token>` where the project is private or the
call writes, and opens the way the daemons do:

```ts
// src/remote/protocol.ts
// 1: first contract — device auth, resolve, missing, fetch, offer.
export const REMOTE_API_VERSION = 1;
```

- **Hello**: `{ protocol, version, features: [] }`, checked once per
  process. A `protocol` other than `REMOTE_API_VERSION` gets the
  `field-audiod speaks protocol N, this CLI speaks M` treatment
  (`src/audiod/client.ts:152`): stop, and say which side to update.
  Everything finer is a name in `features`, gated by a `supports()`
  on the client, never by arithmetic on `version`.
- **Device authorization**: request a code; poll for the token. The
  shape is RFC 8628's — `device_code`, `user_code`,
  `verification_uri`, `interval`, `expires_in` — because every client
  library and every reviewer already knows it.
- **Resolve a project**: `<owner>/<project>` → `{ clone_url,
  default_branch, visibility }`. 404 for a private project the token
  cannot see, the same answer as for one that does not exist
  (audiofield-io.md §5.5).
- **Which of these do you lack**: a list of action keys in, the subset
  the remote lacks out. Idempotent and unauthenticated on public
  projects, so a stranger's `field build` can read through.
- **Fetch an entry**: action key → `{ rule, outputs: [{ sha256, bytes,
  url }] }`, where `url` is a presigned download. The entry mirrors
  `ActionEntry` exactly so the CLI writes it as-is once the bytes
  have been hashed.
- **Offer an entry**: `{ commit, label, action_key, rule, outputs:
  [{ sha256, bytes }] }` in; presigned upload URLs for the outputs the
  remote lacks out; then a completion call once the bytes have landed
  so a crashed upload never registers a partial entry. The commit and
  label are what the site indexes for its player; the action key is
  what the cache reads.

Two things the contract deliberately does not carry: musical time
(the action key already covers the resolved placement plan, and the
site derives `bar.beat` from its own copy of Field's tempo map,
audiofield-io.md §13.9), and any request to render. The remote never
asks the CLI for anything; every conversation starts here. The request
and response shapes are zod schemas in `src/remote/protocol.ts`, the
way `helloResponseSchema` is, so the site's tests can import the same
file (§7).

*Amended (2026-10-11, review of #193):* this said the site derives
`bar.beat` "from `arrangement --json`", which §9.1 had already
overtaken on 2026-10-10: the site computes it from its own copy of the
tempo map.

Paths, as the CLI speaks them since chunk 2 shipped (`paths` in
`src/remote/protocol.ts`; the site is built to these, and either side
changing one changes both):

| Conversation | Method and path |
| --- | --- |
| Hello | `GET /api/hello` |
| Device code | `POST /api/device/code` |
| Token poll | `POST /api/device/token` with `{ device_code }` |
| Revoke | `DELETE /api/token` with the bearer token |
| Resolve | `GET /api/projects/<owner>/<project>` |
| Which do you lack | `POST /api/projects/<owner>/<project>/artifacts/missing` |
| Fetch an entry | `GET /api/projects/<owner>/<project>/artifacts/<action_key>` |
| Offer | `POST /api/projects/<owner>/<project>/artifacts` |
| Complete | `POST /api/projects/<owner>/<project>/artifacts/<action_key>/complete` |

The token poll answers the RFC's `authorization_pending`, `slow_down`,
`access_denied` and `expired_token` behind a 400, and the token itself
with `token_type: bearer` and an optional `login` naming the handle for
the "logged in as" line. Git receives the same token as the HTTP basic
password with username `field`, through the credential helper of
decision 13.

## 5 Decisions (DECIDED, 2026-09-07)

1. **A remote is a second cache, keyed by the action key that
   exists.** The alternative was a release upload — export the mix,
   post the file — which the site's plan rejects at
   audiofield-io.md §9.4 for losing the link between bytes and the
   commit that made them. On this side the argument is simpler:
   `actionKey` is computable from the repository alone
   (plugin-hosting.md §2), so a remote that speaks it needs no
   protocol of its own for identity, and a fetched artifact is
   indistinguishable from a local hit to everything below `buildNode`.

2. **`field push` is a verb, not a hook.** A post-push hook would
   make every `git push` load the project, walk the graph and talk to
   the network, in a process Git owns and a person did not start —
   slow where Git is fast, and surprising when the offer fails. A
   verb runs when asked, prints what it uploaded, and leaves `git
   push` meaning what it means everywhere. *Rejected: a hook installed
   by `field clone`.* It would keep artifacts flowing from people who
   forget the verb, at the cost above; the site's worker fills that
   gap by rendering what it can (audiofield-io.md §5.4). Open in §9.3
   for the sync, because the trade is a product one.

3. **The remote is the origin, read from Git, with `FIELD_REMOTE` as
   the override.** A project cloned from
   `https://audiofield.io/howlo/chemicals.git` already records where
   it came from; the CLI reads `git remote get-url origin`,
   recognizes an audiofield host, and uses its API. No second file
   says the same thing. `FIELD_REMOTE` points somewhere else — a
   staging site, a local stub in tests — and `FIELD_REMOTE=off`
   disables reads for a shell. *Rejected: a `.field/remote` file
   written by `clone`.* It is unversioned and machine-local like
   `.field/plugins.json`, which is right for an inventory and wrong
   for a fact Git already holds; the two would drift the first time
   someone re-pointed origin. *Rejected: `git config field.remote`.*
   Same drift, one layer down.

4. **Reads are on whenever a remote is known; writes only on
   `push`.** A read costs one request per local miss and can only
   ever make a build faster; it fails soft (§3.4). An upload is a
   publication and happens only when the verb says so. *Rejected:
   opt-in reads.* A flag nobody sets is a cache nobody uses, and the
   whole point of warming on `clone` is that the first build is hits.

5. **Tokens go in the macOS keychain through `security`, and in
   `~/.field/credentials` (mode 0600) elsewhere.** Field's pattern for
   platform services is to shell out — `afplay`, `git`, `sclang` —
   and `security add-generic-password` is that pattern applied to
   secrets, with no dependency added. Linux has no single keyring a
   runner image is guaranteed to have, so a file under a home
   directory Field is about to own anyway is the honest fallback; the
   path is a constant in `src/remote/`, and this is Field's first
   per-user state, so the docs say where it is and what deletes it.
   *Rejected: a keyring npm dependency.* A native module in a repo
   with three dependencies, ahead of
   [windows-portability.md](../windows-portability/readme.md), for a
   value a `security` call already stores. Open in §9.2, because the
   file fallback is the part worth a second opinion.

6. **`field clone` refuses without `git-lfs`; `init` keeps its
   warning.** A clone without LFS installed lands pointer files where
   audio should be, and the first `field check` fails every ledger row
   with a hash mismatch that looks like corruption. Refusing before
   cloning, with the install hint, is the cheapest true message.
   `init` warns and continues today because a new project has no
   audio yet and may never commit any (bloom-in-tree.md §2 decision
   3), and that stays. Open in §9.5.
   *Amended (2026-09-08, audiofield's read of #171):* the binary being
   on the path is not the filter being installed — `git lfs version`
   answers on a machine where `git lfs install` was never run, and the
   checkout then lands pointer files anyway. So the clone carries the
   four `filter.lfs.*` settings as `clone -c` config, which applies to
   the initial checkout, and runs `git lfs install --local` in the new
   repository afterwards for the hooks a push needs. The refusal stays
   for the binary; the filters no longer depend on anyone's global
   config.

7. **`license` is validated for shape, not against a list.** Field
   accepts any SPDX-shaped identifier and the site decides which are
   allowed for public projects. *Rejected: an enum in the schema.*
   It couples Field's release cycle to the site's licensing policy: a
   new allowed license would mean a Field release before anyone could
   set it.

8. **`--json` is a flag on the existing commands, printing the
   existing types.** *Rejected: a `field api` command or a separate
   JSON vocabulary.* The typed values are the documented shape
   already, and a second one would drift from the first at the next
   field added to either.

9. **A recipe-only project gets no special case on `clone`.** The
   remote cache is the answer to "clone and it plays" for a project
   that never committed its takes (bloom-in-tree.md §2 decision 4,
   §7): if the site holds the artifacts, `build` fetches them; if not,
   `build` stops at the generative request as it does today, and the
   message adds that the remote had nothing for it. *Rejected:
   `clone` refusing or warning up front.* It would have to run the
   graph to know, which is what `build` is for. Open in §9.6.

10. **One `git` helper, in `src/git.ts`, and the two callers move to
    it.** Four verbs that spawn Git is where a third copy of
    `execFileSync('git', …)` stops being cheaper than a function.
    It takes a cwd and arguments, returns stdout, and throws Git's
    stderr as the message — which is what `init` does by accident
    and `version` does by hand. *Rejected: leaving each caller its
    own.* `init` and `version` already disagree on whether a
    failure throws or returns `undefined`; a third and fourth would
    disagree further.

11. **The remote client is injected where the runner is.** `build()`
    and `explain()` take it as a parameter with a default, the way
    `runner = defaultRunner` works, so a test counts fetches the way
    it counts executions. *Rejected: `fetch` inside `buildNode`.* It
    would make every build test a network test or a mock of the
    global.

12. **The API host is derived from the git host, and `FIELD_REMOTE`
    replaces only the API base** (2026-09-08, chunk 2). Git and LFS are
    served from `git.<site>` and the API from `<site>`
    (audiofield-io.md §10.9), so stripping the `git.` label is the whole
    mapping, and it works unchanged for a staging host. The project is
    the origin's last two path segments minus `.git`. `FIELD_REMOTE`
    swaps the API base and leaves the project alone, which is what lets
    a test clone from a bare repository at `/remotes/howlo/chemicals.git`
    and talk to an in-process stub about `howlo/chemicals`, and lets
    anyone point a real checkout at staging. *Rejected: `FIELD_REMOTE`
    carrying the project too* (`http://stub/howlo/chemicals`) — a
    second spelling of a fact origin already holds, which decision 3
    argued against for a file and applies to a variable. *Rejected:
    recognizing any host* — a GitHub origin would then be asked
    `/api/hello` on every build and told "not an audiofield remote"
    once per build, for a project that never wanted a remote.
    *Amended (2026-09-08, minjudd on #171):* the derivation accepted
    `http:` for any host, so an origin of `http://git.example.com/…`
    yielded a base the client then sent a bearer to, against §4's
    first sentence. Now `RemoteClient` refuses any base that is not
    `https` or loopback `http` before a token or device code can cross
    it, whichever route produced the URL; an origin on cleartext
    yields no remote at all rather than a remote every build fails
    against, because its scheme was inherited rather than typed, while
    a typed `FIELD_REMOTE` or `--remote` on cleartext is refused loudly.
    The reviewer left `FIELD_REMOTE` to judgement; holding it to the
    same rule won because a warning still sends the token.

13. **Git gets the token through `field git-credential`** (2026-09-08,
    chunk 3). `clone` configures the helper for the git host and
    `http.proactiveAuth=basic` (git 2.46+) in the new checkout, so Git
    over HTTPS and the API share the one stored token and Git sends it
    without a 401 probe. The helper answers only `get`, only for a host
    shaped `git.<site>` whose API host holds a token, and stays silent
    otherwise so Git falls through to its own helpers. *Rejected:
    `http.extraHeader`* — the token rides argv and `ps`, and every push
    would have to be spawned by Field to carry it. *Rejected: copying
    the token into Git's own credential store* — a second copy that
    `logout` would have to find, and that outlives it when it cannot.
    *Amended (2026-09-08, against the live git host):* proactive auth
    is set only when a token is held at clone time. With
    `http.proactiveAuth=basic` and no credential, Git asks for a
    username before its first request, so an anonymous clone of a
    public project would have become a prompt. The helper is still
    always configured; a `login` after an anonymous clone costs that
    checkout one 401 probe per push until `push` sets the option
    itself, which is the push chunk's job.
    *Amended again (2026-09-08, audiofield's read of #171):* `clone`
    persists no `http.proactiveAuth` at all. A clone-time snapshot of
    "a token is held" goes stale the moment `logout` runs, and that
    checkout then prompts for a username on every fetch; `push` and
    `pull` pass the option per invocation when they hold a token, which
    is the only moment the fact is known to be true. Two more from the
    same read: the helper is registered behind an empty value that
    resets the helper list for the host, because a global osxkeychain
    helper ahead of it would store a copy of the token on the first
    successful push and serve that copy first ever after — one `logout`
    never erases; and the helper answers `FIELD_TOKEN` or the
    `FIELD_REMOTE` token only for the remote the shell points at,
    since any `git.*` host derives an API and `clone` registers the
    helper for whatever it cloned, so `git fetch` from `git.sr.ht`
    would otherwise have carried the audiofield token.

14. **The engine's default is no remote; the command layer resolves
    it** (2026-09-08, chunk 2, refining decision 11). `build()` and
    `explain()` take a `RemoteReads` and do nothing when handed none;
    `remoteReads()` in `src/commands/build.ts` reads origin and the
    environment, and `build`, `explain`, `play` and `export` pass its
    answer in. *Rejected: the engine reading origin itself as the
    default* — every one of the 25 test files that builds a temp project
    would spawn `git remote get-url` per build, and the engine would
    know about environment variables for the first time.

15. **Watch and live do not read through** (2026-09-08, chunk 2).
    `field build --watch`, `field play --watch` and the live session's
    compile build without a remote. A rebuild loop that waits on a
    network on every edit is a different trade from a one-shot build
    that can only get faster; open in §9.12 for when the network is
    fast enough to make it.

## 6 Chunks

In dependency order; the first two need no site at all.

1. **`--json` and `license`** (§3.5, §3.6). `explain --json`,
   `arrangement --json`, the manifest arm and `projectOrder` entry,
   `init --license`, the `check` diagnostic, and the docs. Ships with
   no remote and unblocks the site's worker the day it exists.
2. **The read-through cache** (§3.4, §4). `src/remote/protocol.ts`
   with `REMOTE_API_VERSION` and the zod shapes, `src/remote/client.ts`
   over global `fetch`, the origin resolution of decision 3, the
   injected client in `build()` and `explain()`, hashing before the
   CAS write, the `fetched` outcome, `--no-remote`, the stderr line.
   Tested against an in-process stub; usable against staging as soon
   as the site's §7.4 serves the fetch endpoints. This is the PR that
   flips the plan to in-progress and records the stack note against
   project-core.md §5.
3. **`login` and `logout`** (§3.1). The device flow, storage per
   decision 5, `FIELD_TOKEN`, the `--version` line, and the bearer
   header on client calls. Needs the site's §7.2.
4. **`clone`, `push`, `pull`** (§3.2, §3.3). `src/git.ts` per
   decision 10 with `init` and `version` moved onto it, the LFS
   refusal, the short-name expansion, the warm, the offer, and the
   tests. Needs the site's §7.3 and §7.4. Closes the loop
   audiofield-io.md §1 describes.

## 7 Tests

- **Unit, as today.** Temp projects through `mkdtempSync` and
  `init()`, the runner injected, no rendering. Chunk 2 adds
  `fakeRemote()` beside `fakeDaemon()`'s pattern: a `node:http`
  server on an ephemeral port with an in-memory map of action entries
  and a temp directory standing in for the bucket, its base URL
  injected as the client's — so a fetch, a hash mismatch, a 404, a
  refused token, and a dead port each have a test and none touch the
  network. A fetched blob whose bytes do not match the entry's hash
  must never appear under `casPath()`; that test is the one the
  tamper-guard comment asks for.
- **Git, for real, in chunk 4.** A bare repository in a temp directory
  is the remote for `clone`, `push` and `pull`; the stub serves the
  short name's `clone_url` pointing at it. Every temp-project test
  already runs `git init` through `init()`, so spawning Git in tests
  is established; these are the first to clone and push. LFS
  assertions run when `git lfs` is on the path and skip with a note
  when it is not, and the chunk records whether CI's runner image
  ships it rather than assuming.
- **Credentials never touch the real keychain.** The `security` call
  is injected like the runner is; the file fallback runs under a temp
  `HOME`.
- **The contract is one file both sides import.** The zod shapes in
  `src/remote/protocol.ts` are what the stub validates against and
  what the site's tests import from a published copy, so a drift
  fails a test on whichever side moved second.

## 8 Definition of done

On a machine that has never seen the project, `field clone
howlo/chemicals` followed by `field build` completes with
`//songs/chemicals/track:main` reported as `fetched`, and the same
build with the network off renders locally, prints one line about the
remote, and exits 0. `field push` after a one-line change to a track
file uploads exactly the entries the change re-rendered and reports
them by label, and a second `field push` uploads nothing. `field
explain //songs/creek/track:main --json` and `field arrangement creek
--json` print the values their text forms are built from: positions in
ticks and as bar.beat.tick, with seconds left to a reader that brings
the song's tempo map, as the site does (audiofield-io.md §13.9). A
`license: not a license` line fails `field check` with the file and the
key, and a missing `license` passes. `field clone` on a machine without
`git-lfs` stops before cloning and names the package to install. And
real music has been cloned and built through it: a HOWLO project on
the site, on a second machine, playing from fetched artifacts with
nothing rendered locally.

*Amended (2026-10-11, review of #193):* the two JSON commands were to
"print the values their text forms show", but the text forms derive
seconds and a bar span that `Explanation` and `ArrangementView` do not
hold, and carrying those would give the JSON a second vocabulary
(§3.6). A malformed license was to fail `field check` "with the file
and line", but a diagnostic carries no line, so it names the file and
the key.

## 9 Open questions

For the sync on the audiofield.io plan. Each records what this draft
assumes so the work can start without the answer.

### 9.1 Priority, against `recording` (now) and `ui` (next)

Draft: `next`, behind `ui`, because chunks 3–4 wait on the site.
Chunk 1 could ride sooner as a small PR of its own if the site's
worker needs `--json` before the rest, and `priority` can move
without the plan moving.

Settled (2026-09-08): `now`. Implementation began the night the plan
merged, at Justin's ask, and the site's v1 renders nothing on the
server (audiofield-io.md §9.14), so the artifacts a push offers are
what make a hosted project play — which put chunks 2–4 ahead of chunk
1 rather than behind it. Chunk 1 is unstarted and rides when the site
wants `--json`.

Moved to `next` (2026-10-10), with chunks 2–4 shipped and chunk 1 the
whole of what remains. The site's player computes `bar.beat` from its
own copy of Field's tempo map (audiofield-io.md §13.9) rather than
from `arrangement --json`, and the render worker that wants `--json`
is moot for v1 (audiofield-io.md §10.14), so chunk 1 waits on that
worker.

Landed ahead of the worker (2026-10-11): Justin chose chunk 1 for the
overnight batch, since it needs no remote at all, and it landed before
the render worker exists. The priority stays `next`; §8's definition
of done is what keeps the plan open.

### 9.2 Keychain, or `~/.field/credentials` everywhere

Decision 5 splits by platform. The alternative is the file everywhere
— simpler, one code path, and what most CLIs of this shape do — at
the cost of a plaintext token on macOS.

Answered by the implementation (2026-09-08): as decision 5 says. Both
stores are `src/remote/credentials.ts` behind one interface with the
`security` call injected, so the file-everywhere alternative is the
deletion of one branch if the keychain turns out to prompt or fail on
someone's machine. One cost to know: `security add-generic-password`
takes the secret on argv, visible to `ps` for the instant of the call,
because the tool has no stdin form.

### 9.3 `field push` as a verb, or a hook too

Decision 2 says verb. Whether `clone` should also install a
post-push hook that runs the offer is a product call about how much
a collaborator has to remember.

Settled for v1 (2026-09-08): verb only, and `clone` installs no hook.
With no server rendering in v1 a forgotten `field push` leaves the
project page with nothing to play, which is visible enough to teach
the verb; the hook stays available if that turns out to be wrong.

### 9.4 Reads on by default

Decision 4 says yes when an origin is an audiofield host. Whether
`FIELD_REMOTE=off` is enough of an off switch, or whether a project
needs a way to say "never" on disk.

Settled (2026-09-08): `FIELD_REMOTE=off` for a shell and `--no-remote`
for a build, nothing on disk. Reads happen only when origin is an
audiofield git host (decision 12), so a project that wants "never" is
one whose origin is not, and a project that is hosted there wanting
"never" is a contradiction the flag covers.

### 9.5 Missing `git-lfs`

Decision 6 refuses on `clone`. The alternative is to clone anyway and
have `field check` explain the pointer files, which keeps `clone`
working on a machine that only wants to read the YAML.

Settled (2026-09-08): refuse, before the network is touched, naming
the package. A machine that only wants the YAML has `git clone`.

### 9.6 Recipe-only projects on `clone`

Decision 9 leaves it to `build`. Whether `clone` should print what
the remote holds for the project — "artifacts for 2 of 3 songs" — so
the person knows before the first build.

Settled (2026-09-08): `clone` prints one line per song — how many
entries it fetched, or that the remote held nothing yet, or that the
song cannot be warmed and why, in the words `build` would use
(`tall-grass: not warmed — //songs/tall-grass/gen:topline has no
takes yet`). That is the "2 of 3 songs" answer, per song. Why a
recipe-only song cannot be warmed at all is §9.11.

### 9.7 The name

`remote` was audiofield-io.md §10.12's proposal, and it sits beside
`remote-asset-store`, which is about LFS bytes and not this. `hosting`
and `audiofield` were the alternatives; `remote` is Git's word for the
thing and the one a `field remote` subcommand would want later.

Settled (2026-09-08): `remote`, which is also the module (`src/remote/`)
and the document ([docs/remote.md](../../remote.md)).

### 9.8 `--json` further out

`explain` and `arrangement` are what the site needs. `build` outcomes,
`status` (which needs a command module first) and `check` (which has
`CheckResult` already) are the obvious next three; not in this plan
unless the worker turns out to want them.

Unchanged (2026-10-11): chunk 1 landed `--json` on `explain` and
`arrangement`; these three stay out until the worker asks for them.

### 9.9 What `pull` does to `.field/out`

The warm writes the CAS and the index; `.field/out` pointers refresh
on the next `build`, as they do after any local change. Whether
`pull` should materialize them itself so `field play` works with no
build in between.

Open (2026-09-08): note that `field play` builds before it plays and
reads through, so on a warmed clone `play` already works with no
`build` in between; the question is only what `pull` leaves under
`.field/out`.

*Amended (2026-09-08, as built):* `pull` is built, and it warms only —
the CAS and the index — so `.field/out` refreshes on the next `build`,
which is the status quo this section describes, now chosen by the
implementation rather than by the verb not existing. Whether `pull`
should materialize the pointers itself is still open.

### 9.10 Project license against asset licenses

§3.5 keeps them independent. Whether `field check` should warn when
an asset's license is stricter than the project's — a CC-BY-SA sample
in a CC0 project — is a question splice.md's chunk owns once both
keys exist.

Open (2026-10-11): chunk 1 landed the project license; whether `check`
compares it with an asset's stays splice.md's question.

### 9.11 A recipe-only song cannot be warmed by action key

Found implementing the warm. A node's action key is computed from its
dependencies' output hashes, and a generative request with no
committed takes mints no node at all (`graph.ungenerated`), so nothing
above it has a key and the remote cannot be asked for anything in that
song: `clone` reports `has no takes yet` for it, and `build` stops at
the request exactly as it does today. Decision 9 assumed "if the site
holds the artifacts, `build` fetches them", and by key it cannot. The
site indexes artifacts by commit and label as well (§4), so a by-label
fetch of `main` is possible — but `build` still refuses a node whose
dependency is takeless (`assertGenerated`), so "clone and it plays"
for a recipe-only project would need `play` to accept a by-label
artifact for `main` without a graph walk, which is a different verb
from the one this plan builds. The honest v1 answer is the one
bloom-in-tree.md §7 already gives — the takes are yours, run `field
generate` — and the site labels such projects (audiofield-io.md §9.13)
because it holds the author's render and the clone does not. For the
sync: is by-label playback of a recipe-only clone wanted, or is the
label enough?

Settled (2026-09-08, audiofield-io.md §10.15): no, for v1. The label
and `field generate` are the answer, and by-label playback is recorded
in that plan's §11 for the sync to reopen.

### 9.12 Reading through in watch and live

Decision 15 keeps the rebuild loops local. When the network is fast
enough that a fetch beats a render for a stem, `--watch` would want the
read-through too, probably with a shorter timeout than a one-shot
build tolerates. Not needed until someone edits a hosted project under
watch and misses it.

## 10 Progress

- 2026-09-08 — Chunks 2 and 3 and the `clone` half of chunk 4 landed
  together as one pull request (branch `remote/login-clone`): the
  `src/remote/` module, the read-through in `build` and `explain`,
  `login`/`logout`/`git-credential`, `clone` with the warm, `src/git.ts`
  with `init` and `version` moved onto it, and
  [docs/remote.md](../../remote.md). One PR rather than three because
  the warm *is* the read-through with `git clone` in front of it, and
  `login` is what makes a private clone possible, so none of the three
  was verifiable without the others. Chunk 1 and the `push`/`pull`
  half of chunk 4 remain; the push offer covers every stem beneath
  `main`, as §3.3 says and audiofield-io.md §5.2 now says too.
- The tests found that git-lfs 3.7 pushes to and fetches from a
  `file://` bare repository, so the clone test commits real LFS audio
  and asserts it arrives intact; the assertion skips with a note where
  the LFS filters are not configured. Whether CI's runner image ships
  them is recorded by the first CI run of that pull request.
- 2026-09-08 — `git.audiofield.io` went live (okamnesiac/audiofield#17)
  serving smart HTTP and LFS, before the API on `audiofield.io`. Probed
  read-only from this side: `howlo/chemicals` answers 401 anonymously,
  so no public project exists yet to clone; and `http.proactiveAuth=
  basic` with no credential makes Git ask for a username before its
  first request even against a public repository (`git/git`), which is
  why decision 13 was amended — first to set it only when a token is
  held, then to leave it out of `clone` altogether and have `push` and
  `pull` pass it per invocation.
  Facts the push chunk builds to, from the host's author: the token is
  the basic-auth password and the username is ignored; a private
  project is 401 anonymously and 404 to a token without access; the
  first push to an unused name under the token's handle creates the
  project; a default branch without `field.yaml` at the root is refused
  as `[remote rejected] main -> main (no field.yaml)`; a racing push
  loses as `fetch first` or `failed to update ref` depending on timing.
  Until the API exists, `field clone` with the full git URL clones and
  then reports that `https://audiofield.io` is not an audiofield remote
  and warms nothing, which is the protocol check doing its job.
- 2026-09-08 — audiofield's read of #171 at 8ddd321 against the live
  host found the git side matching and five things to fix, landed as
  three commits by cause: the credential helper handing `FIELD_TOKEN`
  to any `git.*` host, the helper list not reset ahead of osxkeychain,
  and the persisted proactive auth (decision 13, amended twice); no
  request timeout, redirects followed, and a 400's message hidden
  (client); and the warm claiming "nothing cached" after the remote
  failed, the LFS check testing the binary rather than the filter
  (decision 6, amended), a short name expanded under `FIELD_REMOTE=off`,
  and the destination check after the network call (clone).
- 2026-09-08 — The `push`/`pull` half of chunk 4 (branch `remote/push`),
  the day the site's artifact API and player landed
  (okamnesiac/audiofield#22) and `audiofield.io` went live. `field
  push` is `git push` plus the offer for `HEAD`, entry by entry:
  `POST …/artifacts`, a PUT per output the remote lacks, and the
  completion; `field pull` is `git pull` plus the clone's warm. The
  client gains `offer`, `upload` and `complete`; the stub gains the
  three routes with a staging area and a hash check at completion, as
  the site does. Three things §3.3 now records as amended: every entry
  beneath `main` is offered so the site has a ref per commit and
  label, a dirty tree offers nothing, and the credential helper rides
  per invocation with the proactive auth. The tests push a built
  project to a bare repository with the stub as its API and assert the
  bare has the commit, the stub has both entries under the commit's
  labels with one blob between them, a second push moves nothing, a
  dirty tree and a missing remote push without offering, and a refused
  token is reported per song; `pull` from a plain clone warms two
  entries and a build with a refusing runner is hits throughout.
  Chunk 1 (`--json` and `license`) is what remains of the plan.
- 2026-10-11 — Chunk 1 (branch `remote/json-license`), ahead of the site
  worker that wants it, at Justin's call. `field.yaml` takes an optional
  `license:`, an SPDX identifier checked for shape (`SPDX_IDENTIFIER` in
  `src/schema/manifest.ts`), which `projectOrder` places after `name`;
  `field init --license <id>` writes it and refuses one of the wrong
  shape, and `field check` reports a malformed one through the manifest
  schema. `field explain --json` and `field arrangement --json` print
  `Explanation` and `ArrangementView` through `explanationJson` and
  `arrangementJson`, each in its command module. With this, every chunk
  of §6 has landed; §8's definition of done, a real project on a second
  machine, and the open questions in §9 are what keep the plan open.
