# Projects

Work in progress lives here, in git, next to the code it describes.

## How it works

One directory of documents, and three short lists that point into it.

| | What it is |
| --- | --- |
| [Now](now.md) | What's actively being worked on. |
| [Next](next.md) | Coming up, not started yet. |
| [Later](later.md) | Wanted, nobody has committed to it. |
| [All](all) | Every project document, whatever its state. Nothing here ever moves. |

**A list entry is one line.** Name the work, link its plan if it has one, and
add at most a sentence of why it matters. The moment the line wants a second
sentence it wants a document instead — that is the whole trigger for writing
one, and the lists stay readable at a glance because of it. A line without a
document is fine and common; a paragraph sitting in a list is not.

Work flows down the lists as it gets picked up, [Later](later.md) →
[Next](next.md) → [Now](now.md), and off the end when it's done. It flows back
up too: an item that turns out bigger than expected, or loses its priority,
moves to [Later](later.md) whole, plan and all. A project is past by **not
being on any of the three lists**. There is no `done/` directory, so there is
nothing to move when work finishes — you delete a line from `now.md`. That is
deliberate: a rename churns every reference to the document, and it invites
moving things the moment code merges, which is exactly when a project is most
likely to still need attention.

Because documents never move, `docs/projects/all/<name>.md` can be linked from
code comments, other docs, or a pull request and trusted to keep working.

## Sections are part of the interface

Plans are cited by section — `project-core.md §3` — because the citation
states the behaviour and the section holds the reasoning behind it. So
renumbering or removing a section breaks references that no compiler will
catch. Add sections at the end, or grep for the citation before you renumber:

```
grep -rn "project-core.md §" docs src
```

## Starting and finishing

Starting is a line in `now.md`. It does not need a document — name the work,
and write the plan later, or never if it stays small enough to describe in a
line.

Finishing is deleting that line, when the work is genuinely over: built,
usable in a real session, and no longer something you would be surprised to
find broken. On this project that is usually **after real music has been made
with it** — a phase that merges but that no session has exercised still
belongs in `now.md`. There is no cost to a line sitting there a while longer,
and a real cost to the list quietly becoming things that are mostly finished.

Nothing is deleted from `all/`. It grows forever, which is fine — greppable
when you need it and invisible when you don't, and that is the whole advantage
over a backlog that greets you every morning.

## A file, or a folder

Default to a single file, `all/<name>.md`. Promote to a folder when a project
genuinely outgrows one document: multiple phases in flight, a design that
needs its own space, decisions worth logging separately. Promotion is one
`git mv` within `all/`, so there is no reason to decide up front. A folder's
entry point is `overview.md`.

## What goes in a document

A `# Title`, then a `**Status:**` line, then a `**Goal:**` line. The status
line is prose rather than a keyword, because the useful thing to say is which
PRs carried the work and what is left — and it gets updated when that changes.

Then write what the work needs. Two habits worth keeping:

- **Record decisions with their alternatives.** `(DECIDED)` with the rejected
  options and why beats a plan that only states the outcome. Half of what
  these documents are read for later is why the obvious cheaper thing was not
  done.
- **Correct the plan when review proves it wrong.** A finding that lands on a
  plan gets fixed in the plan, noting what it replaced, the same as a finding
  against code.

Not everything here is a plan. Post-mortems, decision logs, and reference
notes belong in a project's document too, which is why the directory is `all/`
and not `plans/`.

## What doesn't go here

How-it-works documentation stays in the [docs root](../):
[overview](../overview.md), [architecture](../architecture.md),
[project model](../project-model.md), [build graph](../build-graph.md),
[audio engine](../audio-engine.md). Those are living documents describing
current design and behaviour. These are point-in-time execution artifacts:
once the work has landed, the code and the docs root are the source of truth,
and a finished project document is read for the *why* behind a design and the
constraints it was built under. Knowledge that outlives the project belongs in
the docs root, so don't rewrite a finished plan to match later reality.
