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

Cite a plan by section, for example `project-core/readme.md §3.2`. Code
comments carry these citations, so a renumbered section breaks references that
no compiler catches.

A project with no plan yet is still a project. Give it a directory and a short
`readme.md` that records the idea and why it matters, rather than a line in a
shared list.

## What does not go here

How-it-works documentation stays in the [docs root](../README.md):
[architecture](../architecture.md), [tracks](../tracks.md),
[project model](../project-model.md), [build graph](../build-graph.md), and
[audio engine](../audio-engine.md). Those describe current design and
behaviour. These plans are point-in-time execution artifacts, read afterwards
for the *why* behind a design and the constraints it was built under.
Knowledge that outlives the project belongs in the docs root, so do not
rewrite a finished plan to match later reality.
