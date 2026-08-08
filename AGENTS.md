# Project Guidelines

## Docs

This repo follows the global `docs/` and `docs/projects/` convention. Its docs
are [overview](docs/overview.md), [architecture](docs/architecture.md),
[project model](docs/project-model.md), [build graph](docs/build-graph.md),
[audio engine](docs/audio-engine.md); the work itself is in
[`docs/projects/`](docs/projects/README.md).

Unlike the other repos, these docs describe how the system is *designed* to
work, and until code exists they are the source of truth. Read them before
proposing design changes, because most obvious alternatives are already
recorded there with the reason they lost.

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
message, so write them like one). Roughly one PR per coherent chunk of a
phase, not one giant phase PR.

## Pull request reviews

Reviews follow the global rules: local by default, Codex and Claude CLI
reviews opt-in, findings handled and resolved thread by thread. This repo's
ruleset makes the resolution rule literal — it requires review-thread
resolution, so resolving is what unblocks the merge. Resolving still does not
change who merges: that is Justin, per the rule above.
