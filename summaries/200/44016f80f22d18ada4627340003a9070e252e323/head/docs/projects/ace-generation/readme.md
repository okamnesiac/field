---
status: completed
---

**Outcome:** Shipped.

# ACE generation

**Status:** Complete (2026-08-05, #17 + #18). Both chunks shipped; bloom
demonstrates the full loop — generate, audition variants in the mix,
`choose`, clip the promoted asset into creek. The goal's further verbs
(`extend`, `repaint`, …) are future phases, not this plan. §5 has the
open follow-ups. Layout superseded 2026-08-06
([project-layout.md](../project-layout/readme.md) §1.4, §4): the `generation/`
directory and `//songs/<s>/generation:` labels (§3.2, §4.2 below)
migrate to deliberate `generate` sounds in `sounds/` with variants in
`audio/`, chosen by repointing (`field choose`) rather than promotion
into the ledger (§4.8); the committed-not-cached decision (§3.1)
stands. The `ace` CLI prefix retired with §1.7.

**Goal:** `field ace generate` (then `extend`, `repaint`, `variants`, …):
committed generation recipes produce audio assets through ACE-Step running in
a Python worker, with full provenance.

## 1 Shape

- ACE lands as `src/rules/ace-generate.ts` behind the `RuleImpl` interface —
  a module, not engine code. The generic-registry polish deferred from the
  #7 review (`RuleImpl<T>`, so per-method `'wrong rule'` guards become
  compiler-proven) had "the third rule" as its agreed trigger; with the
  phase reorder, the third rule is `track-render`, so the refactor moved to
  [mix-assembly.md](../mix-assembly/readme.md) §5 and lands there, not here.

- The worker protocol comes first: a Python subprocess (`field-modeld`
  pattern) taking immutable inputs and a JSON job spec on stdio, emitting
  assets + structured metadata ([architecture.md](../../architecture.md)
  "Python model-runners"). ACE is the first client of the protocol, not a
  special case.
- A recipe commits everything: model name/version/checksum, prompt, negative
  prompt, seed, duration (bars at tempo), conditioning (chords, MIDI,
  reference audio), generation parameters, output hashes, licensing and
  provenance metadata.
- Reproducibility caveat recorded in [build-graph.md](../../build-graph.md):
  fixed seed is reproducible on the same machine, not guaranteed across
  GPU/framework versions — so generated assets are committed and never
  silently regenerated.
- Multiple variants from one recipe are takes: numbered, auditioned, one
  active ([project-model.md](../../project-model.md) "Takes").
- ACE-Step runs on Apple Silicon via MPS; performance is acceptable for
  asset-generation (not interactive) use.

## 2 Definition of done

A committed recipe generates variants; picking a variant is a take selection;
rebuilding is a cache hit; the recipe, provenance, and chosen asset all read
as a reviewable diff.

## 3 Decisions (DECIDED, 2026-08-05)

1. **ACE lives outside the build graph: outputs are committed, not
   cached.** The reproducibility caveat (§1) is structural — a fixed seed
   reproduces on the same machine, not across GPU/framework versions — so
   `field ace generate` is a *generation workflow*, not a rule: it runs
   the model, lands variants, and the chosen one is imported as an
   ordinary committed asset with the recipe recorded as provenance beside
   it. The recipe serves deliberate regeneration and audit, never a cache
   key. The graph sees a normal asset; clips and takes reference it like
   any recording.
2. **Nondeterministic-node/take-pinning machinery is deferred.** It
   exists to let nondeterministic renders live *inside* the graph
   ([build-graph.md](../../build-graph.md)); the committed-asset flow
   gives it nothing to do. Its forcing function is the recording era —
   plugin renders and realtime-bounce — which will teach the real
   requirements. Revisit then, not now. ACE's variants-as-takes UX
   (numbered, auditioned, one active) is a workflow convention in
   `generation/`, no graph support required.
3. **`field-aced`: a resident worker with the audiod lifecycle.** Model
   load costs tens of seconds and prompt iteration is the whole workflow,
   so the worker is a daemon: spawn-on-demand, flock-owned socket at
   `.field/aced.sock`, versioned NDJSON with a `hello` handshake,
   streaming `progress` events, idle-exit. One house style for Field
   daemons. The idle timeout is shorter-fused than audiod's (default
   10 min, tunable) because an idle model worker holds several GB of
   unified memory.
4. **`uv` manages the Python side, and the Python is strictly typed.**
   `python/aced/` carries its own pinned, lockfiled environment; setup is
   an explicit, loud `field ace setup` (environment + the multi-GB
   HuggingFace weights download, consented, never a surprise), with a
   `FIELD_ACED_PYTHON` override mirroring `FIELD_AUDIOD`. **Pyright in
   strict mode** gates the worker in CI (PyLance's engine, so the editor
   and the gate agree); every module is fully annotated, and the one
   untyped boundary — ACE-Step's own package — is quarantined behind a
   single typed adapter so strictness holds everywhere else. ACE-Step
   1.5 is pinned by commit from its MIT-licensed repo. Python is a
   model-runner here, as architecture.md always said — the protocol
   boundary is the contract.

## 4 Chunks

1. **The worker** (shipped, #17) — `python/aced/` (uv project, ACE-Step
   pinned), `field-aced` with the daemon-lite lifecycle and NDJSON
   protocol (`hello`, `generate`, streaming progress, `quit`),
   `field ace setup` and `field ace generate` end to end: prompt → WAV
   variants on disk + provenance YAML. First generation ran 2×12 s in
   ~15 s on the M3 Max after a one-time model load.
2. **Variants as takes** (shipped, #18) — the `generation/` recipe schema,
   numbered variants with hashes, audition via `field play`
   (`//songs/<song>/generation:<name>-<n>`), and `field ace choose`
   promoting the active variant to a committed asset wired for clips — in
   place, no bytes copied, reversibly; bloom demonstrates with a generated
   part in creek.

## 5 Follow-ups

- The worker enforces a 10-second duration floor, so 1–2 bar loops at
  common tempos can't generate directly. Tolerable because a clip can
  reference just the first N bars of a longer generation; revisit if it
  chafes in practice.
- `quit`/SIGTERM mid-generation kills the worker thread silently. Safe —
  the CLI writes the recipe only after all variants land — but a politer
  cancel could come with the recording era's job control.
- ACE-Step writes `.cache/acestep/progress_estimates.json` into the
  daemon's cwd, i.e. the user's project. Redirect next to the weights in
  `~/.field/models` if ACE-Step's env allows it.

## 6 §3.4's setup contract was a description, not a mechanism (2026-08-07)

"Setup is an explicit, loud `field ace setup` … consented, never a
surprise" was true of the command and false of everything else. The
shared client started workers with `uv run --project …`, and `uv run`
syncs the project environment before running it — so on a fresh checkout
the first `field generate` installed torch and Chatterbox on its own,
with no consent step and no output saying what it was doing. Setup was a
label on a door that was never locked; the #61 review found it at the
voice seam, where the automatic install is a couple of gigabytes.

Fixed by making the mechanism match the sentence: `uv run --no-sync`, so
starting a daemon can only ever *use* an environment, plus a check
before the spawn that says `field setup <worker>` when there is nothing
usable. Without that check the refusal is real but useless — uv exits
immediately, the daemon never binds, and the caller waits out a
sixty-second connect timeout to be told "did not start".

What "usable" means took a second pass. The first check asked whether
`.venv` existed, which is a directory `uv sync --only-group dev` also
creates — the pyright gate above builds exactly that, so both workers in
a normal checkout passed a gate neither could launch through, restoring
the timeout the gate exists to remove. It now asks for the console script
uv installs with the project (`.venv/bin/<script>`, which is what
`uv run` spawns and what `--only-group dev` omits) and then for
`uv sync --check`, since installed is not the same as current. Both
markers were verified against uv rather than reasoned about.

And then a third pass, because the check that enforces "never automatic"
was itself installing software. `uv sync --check` does not modify the
project environment, but uv downloads a compatible CPython when it cannot
find one, and on a machine without a suitable Python the probe completed
a 24 MB interpreter install on its way to reporting that the worker was
not installed. It now detects uv with `--version` — a question that names
no project, so nothing can resolve — asks uv about the project only when
the answer is not already decided, and passes `--no-python-downloads`
and `--locked` when it does, so the probe can neither install an
interpreter nor rewrite `uv.lock`.

That flag was `--frozen` when this shipped, and the difference matters
(#61 follow-up, 2026-08-08). `--frozen` means "sync without updating the
lock" — permission to proceed on a stale one. `--locked` means "assert
`uv.lock` will remain unchanged" — a check that it is current. Both keep
the probe from writing, which is why `--frozen` looked sufficient; only
`--locked` also notices that pyproject has moved past the lock, so a
worker whose environment matches an outdated lockfile is refused here
rather than launched with `--no-sync` and left to fail on the dependency
it never got. This section previously recorded a cost for that choice —
staleness measured against the lockfile rather than against pyproject —
which was not a cost of the goal but of the wrong flag.

The lesson is in where the tests were. The verdict had been made a pure
function precisely so it could be tested exhaustively, and it was: every
combination of the three facts it reads. The defect was in the two lines
that produce those facts, where a subprocess with a side effect returns
a perfectly correct boolean. Purity moved the logic somewhere testable
and moved the danger somewhere untested, so the probe now takes its
runner as a parameter and the tests assert on the commands themselves —
which arguments, in which order, and which are not issued at all.

The interpreter override (`FIELD_ACED_PYTHON`, `FIELD_VOICED_PYTHON`)
skips both, as it always skipped uv: it names an interpreter that already
has what it needs, which is what makes the daemon tests possible without
a model environment.

## 7 A worker refuses what it does not understand (2026-08-08)

§3's protocol parsed a job by reading the keys it knew, which means it
ignored the rest. That is the friendliest possible failure and the wrong
one here: a worker that drops an unrecognised field *succeeds*, and the
recipe written afterwards records an input the model never received —
provenance that lies, which §1's whole commit-the-output argument exists
to prevent.

**Found by living it.** `field generate --exaggeration 0.3` reached a
field-voiced started before voice-generation.md §8 added the field. The
daemon had every reason to think the job well-formed; it generated at
default pacing, and only killing the process stopped a take being
committed under a recipe claiming 0.3. The daemon-lite lifecycle exists
so a model loads once and the process outlives many jobs, so "it was
already running" is the normal case rather than an edge one — a
long-lived daemon is by construction the one most likely to be older
than the CLI talking to it.

`reject_unknown` now refuses any request key the job spec does not
declare, which is [render-pipeline.md](../render-pipeline/readme.md) decision 6's
fail-closed rule applied to the wire rather than to plans. The allowed
set is the job dataclass's own fields, not a list beside it: the field
names *are* the wire keys, so a field added to the spec cannot be
forgotten here, and this check can never become the reason a valid
request is refused. Both workers get it from the shared lifecycle, which
is the third thing #59's extraction has paid for.

**A daemon predating this change still ignores what it does not know**,
because the code that would refuse is the code it lacks. That much is
nature. What is not nature is whether anyone can *tell*: the handshake
has always compared `protocol` and refused a mismatch, so the check
standing in front of this exact failure was already there — and shipping
a change to what the wire accepts without moving the number would have
left a fail-closed daemon and a silently-stripping one answering `hello`
identically, forever (#69 review). So `PROTOCOL_VERSION` is 2, and the
mismatch message says what to do about it, the way cli.ts already tells
someone their `field-audiod` predates `--watch`.

That is the general rule this section is really about, and it is worth
stating separately from the bug that produced it: **a change to what the
wire accepts is a change to the protocol version.** Not to the daemon
version, which is prose, and not to nothing, which is what happened
here until it was caught.
