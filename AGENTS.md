# Project Guidelines

## Docs

[`docs/`](docs/) describes how the system is designed to work —
[overview](docs/overview.md), [architecture](docs/architecture.md),
[project model](docs/project-model.md), [build graph](docs/build-graph.md),
[audio engine](docs/audio-engine.md). Keep it current when the design or
behaviour changes. Until code exists these are the source of truth; read them
before proposing design changes, because most obvious alternatives are already
recorded there with the reason they lost.

[`docs/projects/`](docs/projects/README.md) is the work itself: three lists
([now](docs/projects/now.md), [next](docs/projects/next.md),
[later](docs/projects/later.md)) pointing into [`all/`](docs/projects/all),
where every plan lives and nothing ever moves. Read
[docs/projects/README.md](docs/projects/README.md) before adding to it. Two
things that catch people out: plans are cited by section (`project-core.md
§6`), so renumbering a section silently breaks references — add new sections
at the end; and a plan whose status line is stale is worse than one with no
status at all.

Settled decisions are recorded `(DECIDED)` with the alternatives that lost and
why. Do not reopen one casually — the ID scheme in particular has a full
decision record ([project-core.md §6](docs/projects/all/project-core.md))
written so it never gets re-litigated. If new evidence genuinely overturns a
decision, update the record with what changed, don't just diverge from it.

## Stack

Stack choices (Node 24, pnpm, ESM-only, strict TypeScript, zod v4 +
generated JSON Schema, commander, vitest, afconvert) are recorded in
[project-core.md §5](docs/projects/all/project-core.md). Use pnpm — never npm
or yarn, and never generate a package-lock.json.

## Pull requests

**Open pull requests; never merge them.** Merging is Justin's review
checkpoint, no matter how small or docs-only the change is. End PR work at
`gh pr create` and hand over the URL. After he merges, sync local main before
continuing.

Main takes no direct pushes (repository ruleset: PRs required, linear
history, squash merges only — the PR title and body become the commit
message, so write them like one). Open PRs ready for review by default; use
draft status only when a PR is genuinely not ready and we intentionally do
not want it reviewed yet, not merely because more work is planned. Roughly
one PR per coherent chunk of a phase, not one giant phase PR.

## Pull request reviews are local by default

When someone asks to "review this PR" (or equivalent), review the checked-out
pull request directly: resolve its exact head, inspect the local diff and the
code it depends on, verify every finding, and post the resulting feedback to
GitHub. A generic review request does **not** select or authorize a separate
Codex or Claude reviewer.

### Codex and Claude CLI reviews are opt-in

Neither Codex nor Claude reviews this repo automatically. Opening a pull
request, marking a draft ready, or pushing another commit does not trigger a
review. Run one only when the developer explicitly names it (for example,
"run a Codex review" or "run a Claude review"). That explicit request
authorizes sending the repository context needed for the review to the named
service. Use the selected CLI directly; do not start a review with an
`@codex review` comment.

### Running an external review

Resolve the pull request head, run the selected CLI against that exact code,
and wait for the CLI process to finish before acting on its results. CI going
green is unrelated to review completion. Keep me updated about once a minute
during longer review runs.

### Findings live in review threads

Fetch findings through thread-aware `reviewThreads` in GraphQL, not through
issue comments — Codex, Claude, and Bugbot attach them as inline review
comments:

```
gh api graphql -f query='query { repository(owner:"okamnesiac",name:"field"){
  pullRequest(number:<n>){ reviewThreads(first:60){ nodes{
    id isResolved path line comments(last:1){nodes{author{login} body}} } } } } }'
```

### Handling a finding

1. Verify the claim against the code before acting on it. Reviewers are often
   right and occasionally right about the wrong reason; say so plainly in the
   reply when the reasoning does not hold but the fix does.
2. Implement and validate the fix, then commit and push to the PR branch.
3. Reply in the thread with the disposition — fixed, deferred, non-actionable,
   or needs clarification — naming the commit.
4. Resolve the thread explicitly. Codex, Claude, and Bugbot do not resolve
   their own threads after a later push.
5. Re-fetch `reviewThreads` and confirm `isResolved: true`.

Never resolve a finding that was not fixed. Explain the disposition and leave
it open. Merging is gated on every conversation being resolved (the ruleset
requires review-thread resolution), so resolving is what unblocks a merge —
treat it as an assertion that the branch already carries the fix, which is why
the push comes before the reply and the reply before the resolve. Resolving
threads does not change who merges: that is still Justin.

Do not request a fresh review after every fix batch. Request one for P0/P1
fixes, broad refactors, schema or protocol changes, or changes spanning
interacting components. Decide case by case for P2. Normally skip it for
narrow, well-tested P2/P3 fixes that add no significant behavior.

### Review fixes deliberately

A push does not trigger another review. Fixes can still introduce
regressions, so decide after each batch whether a new manual review is
warranted. When one is requested, make sure it covers the current head; a
review of an earlier commit does not cover later fixes. Never wait for or
claim an automatic Codex or Claude review.
