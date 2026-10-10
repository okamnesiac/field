# Project Guidelines

## Docs

`docs/` describes how the system works today, and is kept current when
behaviour changes — a change that moves behaviour and leaves the docs behind
is unfinished. The work itself lives in
[`docs/projects/`](docs/projects/README.md), whose README carries the Projector
convention: one permanent directory and lowercase `readme.md` per project,
`status: draft|ready|in-progress|completed` beside `priority: now|next|later`
in frontmatter, and plans cited by section so renumbering breaks references
silently. A project never moves when either field changes, and a stale status
is worse than none.

Use the `project` command rather than reading the tree by hand — `project
list` groups by priority, `project show <name>` prints one plan, and
`project check` validates every plan before you hand work over.

The docs are [overview](docs/README.md), [CLI](docs/cli.md),
[architecture](docs/architecture.md), [tracks](docs/tracks.md),
[project model](docs/project-model.md), [build graph](docs/build-graph.md),
[audio engine](docs/audio-engine.md), [remote](docs/remote.md).

Where code does not exist yet these describe how the system is *designed* to
work and are the source of truth for it, which is less of the repo than it
once was. Read them before proposing design changes either way, because most
obvious alternatives are already recorded there with the reason they lost.

Settled decisions are recorded `(DECIDED)` with the alternatives that lost and
why. Do not reopen one casually — the ID scheme in particular has a full
decision record ([project-core.md §6](docs/projects/project-core/readme.md))
written so it never gets re-litigated. If new evidence genuinely overturns a
decision, update the record with what changed, don't just diverge from it.

## Stack

Stack choices (Node 24, pnpm, ESM-only, strict TypeScript, zod v4 +
generated JSON Schema, commander, vitest, afconvert) are recorded in
[project-core.md §5](docs/projects/project-core/readme.md). Use pnpm — never npm
or yarn, and never generate a package-lock.json.

## Pull requests

Roughly one PR per coherent chunk of a phase, not one giant phase PR. Open pull
requests; never merge them — merging is the review checkpoint, however small the
change. This repo's ruleset is the standard one used across these repos: main
takes no direct pushes, history stays linear, every review thread must be
resolved before a merge, and merges are squashed with the PR title and body
taken as the commit message.

<!-- projector:begin 1 -->
## Projector conventions

This repository keeps its project plans in Git with
[Projector](https://github.com/ninjudd/projector). Read
`docs/projects/README.md` before you change a plan. Use the `project` command
to find and change projects instead of parsing plan files yourself, and run
`project check` before you hand work over.

Write new and substantially revised documentation in the Google developer
documentation style: second person, present tense, active voice, sentence-case
headings, exact identifiers in code font, and a command or example when it
communicates more directly than prose. Keep `docs/` describing the behavior on
the current branch, and update it in the change that alters that behavior. An
existing document keeps its register until you revise it substantially.

Write GitHub issues and review comments in the same style. Write a pull request
body as prose that explains why the change exists, because a squash merge makes
it the commit message. Match the line wrapping already used around a Markdown
edit, and do not hard-wrap prose you post to GitHub, because GitHub renders
line breaks.

Projector generates this section. To change it, change the template in
Projector and run `project init`.
<!-- projector:end -->
