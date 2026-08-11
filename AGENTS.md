# Project Guidelines

## Docs

`docs/` describes how the system works today, and is kept current when
behaviour changes — a change that moves behaviour and leaves the docs behind
is unfinished. The work itself lives in
[`docs/projects/`](docs/projects/README.md), whose README carries the
conventions: the three lists, plans cited by section so renumbering breaks
references silently, and why a stale status line is worse than none.

The docs are [overview](docs/README.md),
[architecture](docs/architecture.md), [tracks](docs/tracks.md),
[project model](docs/project-model.md), [build graph](docs/build-graph.md),
[audio engine](docs/audio-engine.md).

Where code does not exist yet these describe how the system is *designed* to
work and are the source of truth for it, which is less of the repo than it
once was. Read them before proposing design changes either way, because most
obvious alternatives are already recorded there with the reason they lost.

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

Roughly one PR per coherent chunk of a phase, not one giant phase PR. Open pull
requests; never merge them — merging is the review checkpoint, however small the
change. This repo's ruleset is the standard one used across these repos: main
takes no direct pushes, history stays linear, every review thread must be
resolved before a merge, and merges are squashed with the PR title and body
taken as the commit message.
