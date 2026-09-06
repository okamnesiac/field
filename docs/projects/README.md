# Project plans

This directory follows the [Projector](https://github.com/ninjudd/projector)
convention. Store each project in a permanent directory under `docs/projects/`.
Use a lowercase `readme.md` entry point with YAML frontmatter carrying two
fields: `status: draft|ready|in-progress|completed` records the lifecycle, and
`priority: now|next|later` records when the work should happen. Priority is
required unless the status is `completed`. Nest a project directory inside
another project when the work is a subproject. Keep supplemental files beside
the entry point that owns them.

Status and priority changes edit frontmatter. Do not create shared queue
files, status or priority directories, or symlinks, and do not move a project
when its status or priority changes. Number plan sections and never renumber
them after another document or code comment cites them.

Run `project list` to browse projects and `project check` to validate the
tree. Both commands come from the Projector CLI:

```sh
pipx install git+https://github.com/ninjudd/projector.git
```

## Conventions this repository adds

Open a plan with a `# Title` and a `**Goal:**` line that states the outcome
in a sentence or two. A reader who stops after the goal should still know what
the work delivers.

Record decisions with the alternatives they beat. Mark a settled one
`(DECIDED)` and keep the rejected options and the reason each lost. Half of
what these plans are read for later is why the obvious cheaper thing was not
done, and a plan that states only the outcome cannot answer that.

Correct the plan when review proves it wrong. A finding against a plan gets
fixed in the plan, noting what it replaced, the same as a finding against
code.

Cite a plan by section using the project name and a `.md` suffix, for example
`project-core.md §3.2`, which names
`docs/projects/project-core/readme.md`. The shorthand predates the move to
permanent directories and survives it deliberately: several hundred citations
carry it, most of them in code comments rather than here, and rewriting them
to spell out `/readme.md` would change every one of those files to say what
the short form already says. Write a link beside the citation when a reader
needs to follow it. Code comments carry these citations, so a renumbered
section breaks references that no compiler catches.

A project with no plan yet is still a project. Give it a directory and a short
`readme.md` that records the idea and why it matters, rather than a line in a
shared list.

Shipping the code does not finish a project. A plan whose implementation has
landed but which no real session has exercised stays `in-progress` at
`priority: now`, and its `**Outcome:**` line states the condition that would
close it. On this project that condition is usually that real music has been
made with it. Mark the project `completed` when the condition is met, not when
the last pull request merges.

This is the one rule the move to Projector had to carry by hand. The old
layout recorded it as membership of a `now.md` list, so a merged but unplayed
project stayed visible by sitting there. Projector has no such list, and
`priority` is not displayed for a completed project, so a project marked
`completed` on merge would lose the distinction with nowhere to put it. Keeping
the project open is what preserves it.

## What does not go here

How-it-works documentation stays in the [docs root](../README.md):
[architecture](../architecture.md), [tracks](../tracks.md),
[project model](../project-model.md), [build graph](../build-graph.md), and
[audio engine](../audio-engine.md). Those describe current design and
behaviour. These plans are point-in-time execution artifacts, read afterwards
for the *why* behind a design and the constraints it was built under.
Knowledge that outlives the project belongs in the docs root, so do not
rewrite a finished plan to match later reality.
