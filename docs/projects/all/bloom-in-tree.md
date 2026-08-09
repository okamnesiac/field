# Plan: bloom moves into field

**Status:** Designed, not started (2026-08-08). Nothing has been written
and bloom is deliberately untouched until it moves. Blocked on §3, which
is a schema change rather than a copy.

**Goal:** bloom lives at `examples/bloom` in this repo, and CI runs
`field check` against it, so a change that breaks the only real project
using the format fails in the pull request that makes it rather than in
the next session.

## 1 Why (2026-08-08)

Keeping the tool and its only real project in two repos cost most of one
day. Every one of these was a coordination failure rather than a bug:

- A flag day half-landed. field #79 moved the bare song name to
  `track:main`; bloom #6 sat unmerged for an hour, during which
  `field build creek` was broken with no test anywhere able to notice.
- `tall-grass` was missed. The migration covered creek because creek was
  what I looked at; the second song surfaced only when a later branch's
  guard happened to fire on it.
- A track fader went silent. Retiring the mix rule left `gain_db`
  accepted and unread; the five bloom files carrying one could not
  contribute a failing test because they were in the other repo.

A test can only see one repo. That is the whole argument.

*Rejected: a submodule or subtree.* This repo squash-merges and requires
linear history, so whatever a pull request contains lands as one commit —
bloom's history cannot survive the merge no matter how it arrives. A
submodule keeps two repos and adds a pointer to forget to bump, which is
the coordination problem with an extra step.

## 2 Decisions (DECIDED, 2026-08-08)

1. **A copy, not a migration.** bloom's 33 commits stay in
   `okamnesiac/bloom`, archived read-only, linked from
   `examples/bloom/README.md`. Losing `git blame` on a track file is a
   real cost and the ruleset makes it unavoidable; naming where the
   history went is what makes it survivable.

2. **`examples/` is the right word.** Nothing in bloom is real music —
   creek exists to exercise the format. A directory that says "example"
   tells the next person how much to protect it, and that answer is
   "not much".

3. **No Git LFS.** bloom uses it for `*.wav`; field does not use it at
   all. LFS earns its keep in a repo whose audio grows without bound,
   which an example is not, and adding it would make `git lfs` a
   prerequisite for checking out a TypeScript repo.

4. **No audio in the tree at all**, which is what §3 exists to make
   possible. The example ships recipes; whoever clones it generates their
   own takes and chooses among them. Two people's bloom sounding
   different is the intended outcome rather than a tolerated one — it is
   also the strongest demonstration the format has that a project is its
   recipes.

   *Rejected: committing the 6.9 MB.* It works today and would make CI
   able to `build` as well as `check`. It loses decision 4's
   demonstration, and it puts generated audio under review, where a diff
   says nothing.

## 3 What has to change first

A `generative` sound cannot currently exist before its takes do. A recipe
carrying only `name`, `type`, and `prompt`:

```
Invalid input: expected string, received undefined at model
Invalid input: expected number, received undefined at seed
Invalid input: expected array, received undefined at variants
Invalid input: expected string, received undefined at generated_at
```

Four fields, and every one of them is recorded *from* a run — `model` and
`seed` are what was asked of the generator, `generated_at` is literally
`new Date().toISOString()` at the moment one finishes. A recipe written
before a run can supply none of them. The file is a record of something
that happened; decision 4 needs it to also be able to be a request for
something that has not.

- **`model`, `seed`, and `generated_at` move to the variant.** They
  describe a run, and a sound can have several — two takes a month apart
  may come from different model versions, and certainly have two
  generation times, neither of which the current shape can record.
  `generated_at` is the purest case: one timestamp for a list of takes is
  already wrong in a project that never wanted this move. A provenance
  improvement that happens to unblock it, not a concession to it.
- **`variants` defaults to `[]`**, so an absent key and an empty list mean
  the same thing. They are separate failures today — omitting it gives
  the `received undefined` above, writing `variants: []` gives `Too small:
  expected array to have >=1 items` — and a chunk that fixed only the
  `.min(1)` would leave a hand-written recipe failing on the other one.
- **`check` passes on a project whose takes are not generated yet.** The
  project is well-formed; the audio is simply absent.
- **`build` and `play` are what report it**, naming the sound and the
  command that fills it. That is the relationship a lockfile has to
  uninstalled dependencies, and it keeps `check` answering "is this
  project coherent" rather than "is this machine ready".

Open: whether `field build` should generate automatically or refuse and
tell you. Refusing is what the design already says — deliberate
generators are human-triggered because "automatic re-run would replace
chosen audio under your feet and burn model-minutes uninvited"
([project-layout.md](project-layout.md) §1.2) — but a fresh clone that
can only say "no" is a worse first five minutes than one that offers, so
it is worth deciding rather than inheriting.

## 4 The two raw recordings

Neither is generated, and both must leave the tree for §2.4.

- **`water`** (2.0 MB) — a *shared* asset rather than creek's own:
  `shared/assets.yaml` pins it, the bytes sit at `shared/samples/water.wav`,
  and creek reaches it across the scope boundary as `//shared/asset:water`.
  It was downloaded from a free source and then normalized, so its recorded
  hash is of the *processed* file. A download rule would therefore have to
  be `download` → `normalize` with the pin on the output, not a URL field
  on the ledger. Deferred to its own plan; until it exists, the example
  touches four files across both scopes — the pin in `shared/assets.yaml`
  and the bytes under `shared/samples/`, then `songs/creek/tracks/water.yaml`
  and that track's placement in `songs/creek/tracks/main.yaml`. Only creek
  references it, so nothing else
  moves; but a deletion that stops at the track file leaves a pin whose
  file is gone, which is the shared shelf's characteristic way to fail.
- **`seven-eight-loop`** (300 KB, tall-grass) — replaced with a
  `supercollider` sound, which needs no committed bytes and is
  deterministic.

bloom is not touched before the move. `tall-grass` in particular is left
exactly as it is; its loop is replaced in the copy, in chunk 2, so there
is never a window where the two repos disagree about it.

## 5 Chunks

1. **Recipes without takes** (§3). Schema, `check`, and the `build`/`play`
   message. No move yet; bloom stays where it is and keeps working, which
   is what makes this chunk independently reviewable.
2. **The move.** Copy bloom to `examples/bloom` without its audio, add the
   gitignores, and do §4's substitutions in the copy: drop `water` from
   both scopes as §4 lists, and replace `seven-eight-loop` with a
   `supercollider` sound. A README points at the archived repo for
   history.
3. **CI.** `field check` on `examples/bloom` in the existing linux job.
   This is the chunk the whole plan is for, so it is worth confirming it
   fails: break a schema on a branch and watch the example catch it.
4. **Archive `okamnesiac/bloom`** read-only, once the copy is proven.

## 6 Definition of done

`git ls-files examples/bloom | grep -c '\.wav$'` prints `0`, `field check`
on a fresh clone passes with no generation having been run, CI fails when
a schema change breaks the example, and `field generate` followed by
`field choose` produces a playable creek that is nobody else's creek.
