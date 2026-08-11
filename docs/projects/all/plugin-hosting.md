---
status: Draft
---

# Plan: hosted plugins — AU and VST3 as inserts

**Goal:** third-party plugins join insert chains as first-class
content — named readably, pinned exactly, their state content-addressed
in the repo — rendered by the daemon offline and in the live graph,
with the plugin editor's knobs writing back into the YAML. This is the
project that makes Field's sound ceiling everyone else's plugins
instead of the in-tree DSP, and it deliberately goes ahead of
recording (§1).

## 1 Why this lands before recording

Recording is the smaller project now — the realtime engine it waited
behind shipped 2026-08-11, and [recording.md](recording.md) already
holds its drafted plan — so the ordering is a choice, made here
deliberately:

- **Value is asymmetric.** Recording pays off when a musician is at an
  interface; hosting pays off on every existing song immediately. The
  sonic ceiling of Field today is the in-tree DSP plus SuperCollider,
  and creek's sends could run real plugins the day chunk 1 lands.
- **Hosting-first makes recording better.** Monitoring through a
  chain — a vocal recorded through an 1176 emulation — needs hosting
  and delay compensation either way. Built in this order, recording
  inherits a live chain that already compensates latency; built the
  other way, recording grows monitoring plumbing it has to revisit.
- **Recording does not rot by waiting.** Its plan is drafted, the
  engine it needed is shipped, and capture stays an input node away
  whenever it is taken.

The architecture was shaped for this before it was scheduled: JUCE was
chosen over Swift and Rust largely for hosting
([architecture.md](../../architecture.md) records the decision — out-of-process
scanning, editor windows, state-serialization quirks, delay
compensation); the single-executor render pipeline was forced by AU
chains (render-pipeline.md); and the determinism policy in
[build-graph.md](../../build-graph.md) was written with plugins as its
subject. This plan implements those decisions; it does not reopen
them.

## 2 What any chunk inherits

Decided elsewhere, restated here as constraints:

- **JUCE stays quarantined inside the daemon.** Hosting is daemon
  work; nothing plugin-shaped leaks into other components
  (architecture.md).
- **Recipe-reproducibility, not bit-reproducibility.** Plugin renders
  may differ across runs; the build never re-renders unchanged inputs,
  so nondeterminism surfaces only on deliberate cold rebuilds. Nodes
  that can differ *audibly* are flagged in three tiers, and renders of
  nondeterministic nodes are takes (build-graph.md "Determinism
  policy" — written for exactly this plan).
- **Render strategies are declared per node**: `offline`,
  `realtime-bounce`, `live-only` (build-graph.md). Most native
  plugins are `offline`; chunk 4 builds the bounce path for the rest.
- **The action key recipe already exists**: plugin ID, version,
  serialized state, parameters (build-graph.md "Action keys").
- **The cache is law.** Existing songs' bytes and action keys must
  not move; hosted inserts are new schema arms and a new plan-version
  bump, nothing more.
- **A machine without the plugin still builds from cache.** Stems are
  content; only a *rebuild* of a node needs its plugin installed, and
  that build fails at the node with the plugin's name and version.
  Freezing is the collaboration story, not an optimization.

## 3 Decisions (DECIDED, 2026-08-11)

1. **A hosted insert is discriminated by `plugin:`,** the way input
   entries are discriminated by which field they carry — kind in the
   field name, never a value prefix. `plugin:` holds the human
   display name and is cosmetic everywhere: never hashed, never
   load-bearing. Renaming it is an ordinary edit (see decision 4 for
   why nothing breaks).
2. **The exact identity gets its own field whose name is the
   format**: `au: <type/subtype/manufacturer>` (the three 4CCs) or
   `vst3: <class-uid>`. No `format:` line. **You write the name; the
   tool writes the id**: a hand-authored `- plugin: 1176` resolves
   against installed plugins at first check or build, and field
   writes the identity and `version:` lines back into the file — the
   same write-back channel the knobs use, so the file self-pins the
   way a lockfile would, inline and readable. A name whose id
   resolves to a differently named plugin is a `check` warning with
   an offered fix in either direction.
3. **Parameters are a `params:` map in the plugin's own natural
   units, under the plugin's own parameter names.** The point of the
   file is human-readable diffs, and normalized floats are not that.
   Values round-trip through the plugin's conversion, and
   canonicalization is **gesture-scoped**: write-back rewrites only
   the params a session actually gestured, so touching the Attack
   knob writes the plugin's own detented 6 where the file said
   `5.95`, and a param the editor never touches stays as authored,
   the plugin interpreting it at load. The file converges toward
   what the plugin does knob by knob, and — the reason the scoping
   is a decision rather than a nicety — never rewrites anything
   spontaneously, so every re-key under decision 8 traces to a
   deliberate gesture or hand edit (minjudd caught the unscoped
   draft, where a cosmetic rewrite of a hand-typed value would have
   re-keyed the node and, on a tier-3 plugin, minted a take nobody
   asked for). The cost, stated plainly: for plugins with lossy
   conversions the file is truth within a float ulp rather than
   bit-exact truth — inaudible by construction. A param name the plugin does not have
   is a `check` error when the plugin is installed (the typo guard);
   an uninstalled plugin defers validation to the machine that can
   perform it.
4. **State is content-addressed.** A plugin whose state exceeds its
   parameter list (samplers, convolution IRs, wavetables, modulation
   matrices — the chunk is the API's only complete capture) carries
   `state: <short-hash>` and the blob lives at
   `shared/plugins/<name-slug>/<full-hash>.state`. The path is a
   *write-time convention only*: reads resolve by hash, always — an
   index of `shared/plugins/**/*.state` filenames — and the drift
   guard is that content must hash to its own filename. So a renamed
   `plugin:` line breaks nothing; the stale directory is a `check`
   warning that `check --fix` tidies with a `git mv`. The directory
   is a pool, one file per distinct captured state, shared by every
   insert whose `state:` line carries that hash, across tracks and
   songs. Unreferenced blobs are kept — they are what make
   `git checkout` of an older track file cheap undo — reported by
   `check`, collected only by an explicit GC. YAML carries the short
   hash (a line a human owns); the filename carries the full one, and
   the action key uses the full hash from the file, so truncation
   never weakens the key. Ambiguous prefixes refuse loudly.
5. **Restore order is blob, then params.** The chunk loads first and
   the YAML params overlay it — the order every DAW already applies
   state and automation in. "Who wins on disagreement" is thereby an
   ordering, not an adjudication: params win for what they name, the
   blob owns everything else. A plugin inserted fresh and only ever
   knob-tweaked never grows a `state:` line and renders from default
   state plus the overlay; the blob appears at exactly the moment a
   session does something non-parametric.
6. **`id:` disambiguates instances, per the gen-node precedent and
   at the same scope**: optional, and `check` requires it only when
   one track's chain holds the same plugin twice. Addressing is
   `<track>/<handle>` — `field open lead-vocal/1176` works while
   unambiguous, `field open lead-vocal/crush` by id — and the track
   half of the path disambiguates across tracks, so project-wide
   duplicates need nothing. When automation lands it attaches to
   these same ids, the double duty placement ids already do.
7. **The knob quantum is the gesture.** Plugin editors already
   notify hosts of parameter gestures (`beginEdit`/`endEdit` exist so
   DAWs can record automation); Field repurposes them as file
   write-back. The live chain applies values immediately — you hear
   the knob now — and on release the daemon emits one
   `param_changed` on the socket; the attached field process rewrites
   that one value in the track file; the watcher sees the settled
   change and re-freezes behind the play. One gesture, one YAML
   diff, like a hand edit. The daemon never persists anything: an
   editor window opens only while an owning field process is
   attached to receive write-backs, and closes if the owner
   detaches — the live chain may be ahead of the file for the
   milliseconds between release and write, never ahead of it with
   nobody writing. Non-param actions (preset load, IR load) arrive
   as program-change or restart notifications, or as nothing; on
   those signals, and as a backstop a chunk-hash check at session
   close, field captures a *new* state blob and repoints the
   `state:` line — the old blob stays, per decision 4. The editor
   session binds to a chain position at `field open` and re-binds by
   `id` if the file changes under it, which is the second reason
   decision 6 insists on ids for duplicates: position alone cannot
   survive a reorder, and silently writing knob values into the
   other 1176 is the kind of bug that sounds fine until it doesn't.
8. **The action key hashes identity + version + full state hash +
   the params map canonicalized** (sorted by name, so reordering
   lines never re-keys), plus the ordinary chain inputs. The display
   name is never keyed. The hashed values are the **authored** ones,
   exactly as written in the file — §2 forces this: a machine
   without the plugin finds a cached stem by computing its action
   key, so the key must be computable from the repository alone, and
   plugin-canonical values would need an instantiation to obtain.
   Two spellings of one knob position therefore key differently —
   a re-render that sounds the same — which decision 3's
   gesture-scoping confines to edits somebody actually made.
9. **`version:` lives in the YAML, per entry, and a mismatch is a
   refusal with an offer.** The installed plugin moving from 11.2.0
   to 11.3.0 does not silently re-key every song the morning after
   an installer runs; field refuses, offers to update the line, and
   accepting is a visible diff that deliberately invalidates the
   renders — with the takes machinery catching anything replaced.
10. **Both formats from day one, via JUCE's format manager.** AU is
    the Mac-first instinct but `AudioPluginFormatManager` gives AU
    and VST3 through one abstraction at near-zero marginal cost, and
    VST3 is the entire Linux/Windows story. CLAP is deferred: JUCE
    does not host it natively yet.
11. **Latency and tails stay compiler arithmetic, with plugin-shaped
    inputs.** `insertLatency` is arithmetic over the session's own
    fields, and reported latency is only knowable by asking the
    plugin — so **`latency:` joins `version:` as a line the tool
    writes back** at first resolve (omitted when zero), keeping the
    compile computable from the repository alone, the same property
    decision 8 leans on. The daemon verifies it at instantiation;
    drift — a latency-changing param like an oversampling toggle —
    is updated through the write-back channel in the same session
    diff as the gesture that caused it, visible and re-keying
    deliberately. Tails come from a declared `tail:` override or a
    capped ring-out detection at −60 dB during offline render —
    reported tail times are the one thing plugins lie about
    consistently. The analytic requirement was realtime.md's, for
    effects we author; hosted plugins get the measured version.
12. **CI tests hosting against an in-repo fixture plugin.** A tiny
    JUCE plugin built in this repo — deterministic gain, delay,
    latency reporting, and a state chunk — built as both AU and VST3
    in CI, so scanning, instantiation, params, state round-trip,
    write-back and byte-determinism are all testable without a
    commercial plugin installed. Third-party plugins are exercised
    by hand on real sessions; the fixture is what the suite owns.

## 4 The YAML, concretely

```yaml
# songs/creek/tracks/lead-vocal.yaml
name: lead-vocal
sends:
  vocal-verb:
    gain_db: -10
inserts:
  - plugin: UADx 1176 Rev A
    id: crush
    au: aufx/1176/UADx
    version: 11.2.0
    params:
      Input: 8.0
      Ratio: 20         # the all-buttons-in trick
  - plugin: UADx 1176 Rev A
    id: level
    au: aufx/1176/UADx
    version: 11.2.0
    params:
      Input: 3.0
      Ratio: 4
  - plugin: Altiverb 8
    au: aufx/Alt8/AudE
    version: 8.4.1
    latency: 512        # tool-written, like version; absent when zero
    state: 3f9c2a81d4e0
    params:
      Reverb Time: 1.4
inputs:
  - audio: lead-vocal-take3
```

And the pool that `state:` line resolves into:

```
shared/plugins/altiverb-8/
  3f9c2a81d4e0….state   ← the scoring stage, referenced above
  a71bb04c99f2….state   ← a small room, referenced by drums
  c2d80e11f6a3….state   ← auditioned once, unreferenced; kept until GC
```

Built-in inserts (`effect: eq` and friends) are unchanged beside
these; the two discriminants coexist in one chain.

## 5 Chunks

1. **Offline hosting.** Out-of-process scanning (one crashy plugin
   must not kill the daemon), instantiation, offline render through
   the single executor; the `plugin:` schema/session/plan arms on
   both sides; name→id resolution with the self-pinning write-back;
   state assets with hash resolution and the `check` tidy; action
   keys per decision 8; the fixture plugin and its CI suite;
   RENDER_PLAN_VERSION bump with existing songs proven pure cache
   hits.
2. **Live.** A hosted insert in the live chain: delay compensation
   from reported latency, warmup at locate under the chain's
   existing −60 dB bound — byte-identity offline-vs-live is
   explicitly *not* claimed for hosted inserts (the golden stays a
   built-ins contract; the freeze handoff leans on the warmup bound
   instead), and the version-refusal flow runs live.
3. **Editor sessions and write-back.** `field open <track>/<handle>`,
   the `param_changed` protocol message, gesture-quantum file
   writes, blob recapture on non-param signals, id re-binding, the
   owner-attached window rule. The demo is decision 7's flow run
   under `field play creek --watch`.
4. **`realtime-bounce`.** The 1× capture path for plugins that
   cannot render offline (UAD-2 DSP hardware is the motivating
   case), flagged per build-graph.md's render strategies.

## 6 Open questions

- **Recapture triggers, exactly.** Which non-param signals are
  reliable across real plugins (program-change, restartComponent,
  property listeners), and whether the session-close chunk-hash
  backstop suffices where they are absent.
- **Freeze-swap policy for tier-3 plugins.** The inaudible-swap
  guarantee rests on byte-identity, which truly free-running plugins
  cannot give even within the warmup bound. Prompt before swapping?
  Keep the chain live and never freeze? Leaning: flag in `explain`,
  swap under the bound for tiers 1–2, keep tier-3 live until chosen.
- **Editor windows vs daemon-lite.** The daemon exits when idle; an
  open editor is a reason not to be idle, and window ownership on
  macOS may want the daemon to run an app lifecycle while one is up.
- **Dynamic parameter lists.** Plugins whose param *set* changes
  with state (a Pro-Q growing bands) blur the params/state line;
  probably "params that exist at validation time are validatable,
  the rest ride the blob," but real plugins should decide.
- **Linux/Windows timing.** VST3 hosting is the portable half; when
  the platforms graduate from at-least-works is not this plan's call.

## 7 Definition of done

A real third-party AU on creek's lead-vocal renders offline and plays
live through the freeze; under `field play creek --watch`, `field
open` shows the editor, a knob twist is heard immediately and lands
as a one-line YAML diff that re-freezes behind the play; a stateful
plugin captures a blob a collaborator's clone resolves by hash and
builds from cache without the plugin installed; the fixture-plugin
suite is green in CI on both formats; and every existing project
rebuilds as pure cache hits.
