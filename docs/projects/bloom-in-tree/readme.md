---
status: done
---

**Outcome:** Shipped.

# Plan: bloom moves into field

**Status:** Done (2026-08-08). The example lives at `examples/bloom`, CI
runs `field check` against it (#85), and `okamnesiac/bloom` is deleted.
§6's definition of done is met: 0 WAVs in 35 tracked files, and an export
of HEAD checks `ok` with nothing generated. There is one repository now,
which is the whole point — a change that breaks the only real project
using the format fails in the pull request that makes it.

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

1. **A copy, and the history goes.** `okamnesiac/bloom` is deleted rather
   than archived. This started out planning to keep the old repo read-only
   and link it, on the theory that losing `git blame` on a track file
   needed compensating for; it does not. bloom is an example project whose
   33 commits record how the format was exercised while it was being
   built, and none of that is worth a second repository to point at.
   Updated 2026-08-08.

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

The move is a breaking format change, and the migration is mechanical: a
recipe's `model` and `generated_at` describe the one run that produced
every variant it lists, which is exactly what `field generate` still
writes — one model and one timestamp shared by that run's takes — so
copying each down onto every variant preserves what was recorded rather
than inventing per-take values. `seed` needs no home; each variant has
carried its own all along. The retired keys are declared as `z.never`
with those instructions, the `RETIRED_FADER` precedent, so a recipe
written before the change says where the value went instead of answering
"Unrecognized keys". They stay *required* on the variant: the migration
loses nothing, and optional provenance would weaken the format
permanently to save a one-time edit of files chunk 2 rewrites anyway.

Two things this turned up that the plan above did not, both of which had
to ship with it or the chunk would not have worked:

- **`field generate` fills an existing takeless recipe.** It refused any
  recipe that already existed — `pick a new name` — which would have made
  a shipped recipe unfillable and the whole idea a dead end. Filling reads
  the request from the file rather than the command line, so a content
  flag passed alongside is refused as a second answer; `--seed` and
  `--variants` describe the run, not the sound, and stay on the CLI. The
  file is edited in place rather than re-emitted, so a shipped recipe's
  comments survive being filled.
- **`field generate` chooses its first take.** Every take it produced is
  usable, so the sound resolves the moment it exists and `choose` means
  what its name says — switching — rather than a second mandatory step.
  This is also what keeps `check` honest: it still refuses takes with
  nothing chosen, and that state is now unreachable except by hand.

Decided: **`field build` refuses and names the command; it does not
generate.** Refusing is what the design already says — deliberate
generators are human-triggered because "automatic re-run would replace
chosen audio under your feet and burn model-minutes uninvited"
([project-layout.md](../project-layout/readme.md) §1.2) — and the worry that a
fresh clone which can only say "no" is a bad first five minutes is
answered by saying it well: the error names the sound and the exact
command, and a pattern naming several lists all of them. Building is also
the wrong place to spend model-minutes uninvited, which is the argument
that decided it rather than the phrasing.

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

1. **Recipes without takes** (§3) — done. Schema, `check`, the
   `build`/`play` message, and the two things §3 records as having turned
   up with it: `generate` fills a takeless recipe, and chooses its first
   take. It moves the recipe format, so **`okamnesiac/bloom` does not
   pass `field check` from here on** — its recipes carry the retired
   sound-level keys. They are not migrated in place, because bloom is not
   touched before the move; chunk 2 writes them in the new shape as it
   copies them, which is the migration. Until then the retirement
   messages say what to change, so the repo is stale rather than
   mysterious.
2. **The move** — done. bloom copied to `examples/bloom` without its
   audio: 36 files, none of them a WAV. §4's substitutions applied in the
   copy, both ledgers gone with the last pins they held, the two
   generative recipes shipped takeless, and the README rewritten for a
   project whose audio you generate.
3. **CI** — done (#85). `field check` on `examples/bloom` in the existing
   linux job. This is the chunk the whole plan is for, so it was worth
   confirming it fails rather than assuming: renaming a placement's
   `gain_db` on a branch turned the example red. Renaming the *clip*
   `gain_db` did not, which is worth recording — bloom carries that field
   on placements, not on clips, so the first attempt at a break proved
   nothing and looked like it had.
4. **Delete `okamnesiac/bloom`** — done 2026-08-08, by hand rather than by
   an agent, being both irreversible and outward-facing. `gh api
   repos/okamnesiac/bloom` now 404s, which is the only check this chunk
   has.

## 6 Definition of done

`git ls-files examples/bloom | grep -c '\.wav$'` prints `0`, `field check`
on a fresh clone passes with no generation having been run, CI fails when
a schema change breaks the example, and `field generate` followed by
`field choose` produces a playable creek that is nobody else's creek.

## 7 Takes leave the recipe (DECIDED, 2026-08-08)

`variants` and `chosen` moved out of `sounds/<name>.yaml` and into
`audio/<name>/variants.yaml`, beside the WAVs they pin.

The recipe is what you share. The takes and the pick are what your
machine made — so with them in the recipe, following this example's own
README modified a committed file: clone it, run `field generate`, and the
working tree is dirty before you have heard anything. `field choose`
did the same on every re-pick. Decision 4 wanted an example whose audio
you generate; that is not usable if generating is a diff.

**Inside the audio directory, not beside the recipe.** The alternative
was `sounds/<name>.variants.yaml`, which is easier to find — you read
`sounds/` to understand a song, and the file that says which take is live
would be right there. It lost on the gitignore: two rules governing the
pins and the bytes can disagree, and each way they disagree is quiet.
Change only the audio rule and you commit WAVs whose hashes nothing
records; change only the other and you commit pins to files nobody has,
which fails `check` for everyone else. In `audio/<name>/` there is one
rule, and the decision to commit the audio *is* the decision to commit
its pins. A project that commits its audio gets both, with no special
case.

*Not `takes.yaml`:* `takes/` already means recorded takes — the
`take-YYYYMMDD-HHMMSS` files with device and latency metadata — so the
word is spoken for and `variants` is what the field was already called.

*Amended 2026-08-10:* the premise above flipped — recorded takes will
follow this fold's own precedent and live beside their audio under
`audio/`, so `takes/` is no longer spoken for
([project-model.md](../../project-model.md) "Takes"). The gitignore
argument that decided this section applies to a recorded take's record
exactly as it does to a variant's pins. The name decided here stands on
its other leg: `variants` is what the field was already called.

*Rejected: `.field/generated/`.* Always local, no gitignore rule needed
at all. But it separates the record from the bytes permanently, so a
project that does commit its audio has nowhere to put the provenance that
pins it.

The split is on disk only. The loader merges the two, so `sound.variants`
and `sound.chosen` still read the same everywhere downstream — the graph,
`check` and `play` did not have to learn the file layout. Retired keys in
the recipe forward to the new file rather than answering "Unrecognized
keys", the `RETIRED_FADER` precedent.

One consequence worth stating: `field generate` no longer writes the
recipe at all, except to record a voice reference's hash, which is a
property of the request rather than of a take. Filling a shipped recipe
now leaves its bytes untouched.
