---
status: Draft
---

# Plan: `field insert` — add an insert with a chooser

**Goal:** one command that adds an insert to a track: fully pinned at
birth, found with an interactive search over the scanned inventory
when no plugin is named on the command line, placed with an
interactive order chooser when the chain already has inserts, and
ending in the plugin's own editor window once plugin-hosting's
chunk 3 lands.

## 1 The gap

Adding an insert today is a hand edit: open the track file, spell the
`plugin:` name closely enough for the pinner to resolve it
(plugin-hosting.md decision 2), and place it in the chain by editing
list order. Every piece of that has an edge the tool already knows how
to file down. The inventory knows the real names — the hand edit is
guessing at them. The pinner knows the identity fields — the hand edit
leaves an unpinned window for `field check` to close. And order is
audible — serial chains are not commutative, a compressor before a
reverb is a different record than after — so placement deserves a
deliberate answer rather than a cursor position. The second half of
the job, hearing and adjusting the thing just added, has no command at
all today: knobs mean either hand-writing `params:` values or waiting
for chunk 3's editor.

## 2 The command

`field insert <track> [plugin]`, spelling open (§7). The track half of
the address follows decision 6's `<track>/<handle>` scheme — this
command is the `<track>` half alone, so `field open` and
`field insert` read as one grammar. With a plugin named, resolution is
decision 2's exactly: match against the inventory, warn on a
name/id disagreement, prefer AU on macOS when a product installs as
both. With no plugin named and a TTY, the chooser opens (§3). With no
plugin named and no TTY, refuse and print the exact command line to
run instead — the `--allow-mismatch` precedent, where the interactive
half has a scriptable spelling and never a hang.

The write goes through the same comment-preserving `yaml` Document
machinery the pinner and `field choose` already use (`yaml/emit.ts`),
never a serialize-from-scratch: track files carry hand-written
comments inside insert blocks, and a writer that eats them is worse
than no writer. What lands is what the pin write-back would have
written — `plugin:`, the `au:`/`vst3:` identity, `version:`, and
`latency:` when nonzero (tool-written, like version — §4 of
plugin-hosting.md) — so there is no unpinned moment and nothing for
the next `check` to fix up. When the chain would hold the same plugin
twice, decision 6 requires an `id:`; the command prompts for one at
add time instead of leaving `check` to complain about a file it just
wrote.

## 3 The plugin chooser

- The data source is the scanned inventory, read through
  `readInventory` — cached by file identity as of #152, so opening
  the chooser costs a stat, not a 75 MB parse. No inventory: refuse
  naming `field plugins scan`, the same answer the pinner gives.
- Incremental search over name and manufacturer. Each row shows
  format and version, because one product often installs as both AU
  and VST3 — decision 2 resolves that deterministically for the
  non-interactive path, and the chooser *is* the deliberate override:
  picking the VST3 row is `--vst3` without the flag.
- Selection is exact, so §2's pinned-at-birth write follows directly:
  the chooser emits an inventory entry, never a name to re-resolve.

## 4 The order chooser

Only when the track already has inserts — a first insert has exactly
one place to go and asks nothing. Offer each position in the existing
chain by name (before `1176`, between `1176` and `Altiverb 8`, at the
end), default the end, since serial chains most often append. Built-in
inserts (`effect: eq` and friends) appear as positions too: the two
discriminants coexist in one chain (§4 of plugin-hosting.md), and
placing a hosted insert relative to an eq is precisely the choice
that matters. Reordering *existing* inserts is a different verb and a
non-goal here (§6).

## 5 Opening the editor

There is no way to open a plugin's UI today — that is plugin-hosting
chunk 3 (`field open <track>/<handle>`, decision 7's gesture
write-back and owner-attached window rule), designed and not yet
built. This command's flow ends there: after the write, hand off to
`field open` on the insert just added, so add-search-place-adjust is
one gesture. Until chunk 3 lands, the command stops after the write
and prints the `field open` line it *would* have run — the flow is
useful without the editor, and the handoff is a composition, not a
reimplementation: nothing about editor sessions is specified here,
and nothing here blocks on chunk 3 except the final step.

## 6 Non-goals

- **Params at add time.** Knobs are decision 7's gesture write-back —
  the editor's job, not a CLI prompt tree. The insert lands with an
  empty `params:` surface and default state, exactly like a
  hand-written one.
- **Reordering or removing existing inserts.** Different verbs, worth
  their own line in the lists if wanted; this command only ever
  inserts.
- **State blobs.** A fresh insert has no `state:` line by
  construction (decision 5's overlay model); blobs appear when a
  session does something non-parametric, which cannot happen at add
  time.

## 7 Open questions

- **Spelling.** `field insert <track>` vs `field insert add <track>`
  vs a subcommand family that later takes `remove`/`reorder`. Also
  whether the track address needs a song qualifier when track names
  collide across songs — `field open` will face the identical
  question, and the two must answer it the same way.
- **The chooser dependency.** The repo's only interactivity is a
  readline y/N; an incremental-search picker is either a hand-rolled
  raw-mode readline loop or a small prompts library, and either way
  it is a stack decision to record against project-core.md §5, not a
  quiet `package.json` line.
- **Do built-ins join the chooser?** `eq` and friends are
  schema-authored by hand today. A unified chooser (built-ins listed
  beside hosted plugins) is more command than this plan needs, but
  refusing `field insert lead eq` with "hand-edit the file" would be
  a strange answer. Undecided.
- **Chooser ergonomics.** Whether search matches format tokens
  (`au`, `vst3`) and whether recently-used plugins sort first. Cheap
  to decide at implementation; recorded so the first version is not
  mistaken for a decision.
