---
status: now
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

`field insert add <track> [plugin]` (DECIDED, 2026-08-12): the `add`
subcommand keeps the family open for `remove` and `reorder` later —
both non-goals here (§6) — instead of burning the bare verb on one
operation. A bare track name resolves project-wide while it is
unique; when songs collide on a name, the refusal lists the qualified
`<song>/<track>` spellings, so the fix is a copy-paste (DECIDED,
2026-08-12 — `field open` should adopt the same rule when chunk 3
builds it). The track half of the address follows decision 6's
`<track>/<handle>` scheme — this
command is the `<track>` half alone, so `field open` and
`field insert` read as one grammar. With a plugin named, resolution is
decision 2's exactly: match against the inventory, warn on a
name/id disagreement, prefer AU on macOS when a product installs as
both. With no plugin named and a TTY, the chooser opens (§3). With no
plugin named and no TTY, refuse and print the exact command line to
run instead — the `--allow-mismatch` precedent, where the interactive
half has a scriptable spelling and never a hang. Placement gets the
same two spellings (§4): `--at <position|end>` places without asking,
and a non-TTY run with the plugin named and no flag appends at the
end — the order chooser's own default, taken silently — so a
populated chain never hangs a script either.

The write goes through the same comment-preserving `yaml` Document
machinery the pinner and `field choose` already use (`yaml/emit.ts`),
never a serialize-from-scratch: track files carry hand-written
comments inside insert blocks, and a writer that eats them is worse
than no writer. What lands is what the pin write-back would have
written — `plugin:`, the `au:`/`vst3:` identity, `version:`, and
`latency:` when nonzero (tool-written, like version — §4 of
plugin-hosting.md) — so there is no unpinned moment and nothing for
the next `check` to fix up. When the chain would hold the same plugin
twice, decision 6 requires an `id:` on *every* instance — the
duplicate check quantifies over the whole identity group
(`src/model/project.ts`), so prompting only the new arrival would
leave the incumbent invalid and `check` complaining about the file
this command just wrote. The command prompts for both handles at add
time: the new insert's, and the incumbent's where it lacks one. That
second write edits a line the user did not ask this command to touch,
so it is disclosed as part of the confirmation rather than slipped
into the diff — the price of decision 6's promise that a knob lands
on the right instance. Without a TTY the duplicate case refuses and
names the interactive command: backfilling a handle nobody chose is
exactly what a script should not do silently.

## 3 The plugin chooser

- The data source is the scanned inventory, read through
  `readInventory`. #152 — in review as this is written, a named
  dependency of this plan's ergonomics rather than its correctness —
  caches that read by file identity: with it the chooser opens on a
  stat, without it on the same 75 MB parse a 482-plugin machine
  already pays everywhere else today. No inventory: refuse naming
  `field plugins scan`, the same answer the pinner gives.
- Incremental search over name and manufacturer. Each row shows
  format and version, because one product often installs as both AU
  and VST3 — decision 2 resolves that deterministically for the
  non-interactive path, and the chooser *is* the deliberate override:
  picking the VST3 row is `--vst3` without the flag. Where rows still
  collide — same name, format, and version, which the scan permits —
  the identifier joins the row: selection writes a load-bearing
  identity, two indistinguishable rows would make that write a coin
  flip, and the pinner already reports exactly these identifiers when
  a name is ambiguous.
- An entry that reports no version cannot be selected: writing
  `version: ""` turns a valid file into one the schema rejects, which
  is why the pinner refuses such entries — the chooser carries the
  same refusal on the row itself, before a write is attempted rather
  than after.
- Recently used sorts first, and search matches format tokens (`au`,
  `vst3`) as well as name and manufacturer (DECIDED, 2026-08-12).
  Recency derives from the project's own files — plugins already
  pinned in track YAML float to the top — which costs no new state; a
  picked-history file is the fallback if that proves too coarse to
  feel recent.
- The picker itself is a hand-rolled raw-mode readline loop, kept
  deliberately disposable (DECIDED, 2026-08-12): a full TUI is
  eventually wanted, and that is its own stack decision to record
  against project-core.md §5 when it arrives — adopting a prompts
  library now would quietly pre-answer it with whatever the library
  grew into. ~100 lines that expect to be deleted beat a dependency
  that expects to be kept.
- Selection is exact, so §2's pinned-at-birth write follows directly:
  the chooser emits an inventory entry, never a name to re-resolve.

## 4 The order chooser

Only when the track already has inserts — a first insert has exactly
one place to go and asks nothing. Offer each position in the existing
chain by name (before `1176`, between `1176` and `Altiverb 8`, at the
end), default the end, since serial chains most often append. `--at
<position|end>` is the same choice as a flag — §2's scriptable
spelling, and what a non-TTY run falls back to (the default, the end,
taken silently). Built-in
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

- **Track addressing** — answered in §2 (DECIDED, 2026-08-12): bare
  name while unique, qualified `<song>/<track>` on collision, and the
  refusal names the spellings.
- **Built-ins, to discuss — two shapes, and they pull opposite
  directions.** (a) Make `eq` and friends *actual* AU/VST3 plugins:
  one chooser, one chain representation, editor windows and future
  automation for free. The cost is the contracts built-ins uniquely
  carry today: offline-vs-live byte-identity is explicitly a
  built-ins golden (hosted arms get only the warmup bound —
  plugin-hosting.md §5 chunk 2), and latency/tails are analytic
  compiler arithmetic where hosted inserts get declared-and-verified
  (decision 11). Wrapping them demotes both to the weaker hosted
  guarantees, and adds scanning, versioning, and state-blob machinery
  to effects that are pure schema'd params today. (b) Special-case
  them as chooser rows that write ordinary `effect:` blocks: uniform
  UX, engine and contracts untouched, at the price of two row kinds
  in one picker. The recorded contracts lean toward (b); (a) is
  really a separate "built-ins as plugins" project that this command
  should not smuggle in. For *this* plan the answer is scoped
  (DECIDED, 2026-08-12): the chooser lists scanned plugins only, and
  built-ins stay hand-authored — the (a)-versus-(b) discussion stays
  live as its own line in [later.md](../README.md), where uncommitted
  ideas belong, and nothing in this command forecloses either shape.
