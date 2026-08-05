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
