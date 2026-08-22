---
status: now
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
behind shipped 2026-08-11, and [recording.md](../recording/readme.md) already
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
chains ([render-pipeline.md](../render-pipeline/readme.md) §2 decision 1); and
the determinism policy in
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
  Said precisely: the action key stays computable from the repository
  alone, so any machine *holding the artifact* serves it without the
  plugin — today that means the machine that rendered it, because the
  cache is local and unversioned, and the remote asset store
  (later.md) is what turns this into a cross-machine story. Freezing
  is the collaboration story, not an optimization.

## 3 Decisions (DECIDED, 2026-08-11)

1. **A hosted insert is discriminated by `plugin:`,** the way input
   entries are discriminated by which field they carry — kind in the
   field name, never a value prefix. `plugin:` holds the human
   display name and is cosmetic everywhere: never hashed, never
   load-bearing. Renaming it is an ordinary edit (see decision 4 for
   why nothing breaks).
2. **The exact identity gets its own field whose name is the
   format**: `au: <type/subtype/manufacturer>` (the three 4CCs) or
   `vst3: <uid>` — JUCE's 32-bit plugin uid in hex, named plainly
   because it is *not* the VST3 class TUID: JUCE does not surface
   the 128-bit TUID, and the uid derivation is JUCE's to change (it
   moved once already, which is why `deprecatedUid` exists). That is
   decision 9's installer exposure one layer down — a JUCE upgrade
   that moves the derivation stops every `vst3:` pin resolving at
   once — recorded here so the refusal is predictable when it
   happens: nothing renders wrong, rebuilds refuse naming the pin,
   and `field plugins pin` re-pins deliberately, exactly the
   version-drift flow. No `format:` line. **You write the name; the
   tool writes the id**: a hand-authored `- plugin: 1176` resolves
   against installed plugins at first check or build, and field
   writes the identity and `version:` lines back into the file — the
   same write-back channel the knobs use, so the file self-pins the
   way a lockfile would, inline and readable. A name whose id
   resolves to a differently named plugin is a `check` warning with
   an offered fix in either direction. A product installed as both
   AU and VST3 matches one name twice; resolution is deterministic —
   AU on macOS, VST3 elsewhere — and never silent, because the pin
   *is* the disclosure: the field name the tool writes says which
   format won, and repinning to the other is a tool gesture
   (`field plugins pin <track>/<handle> --vst3`) rather than a UID
   typed by hand.
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
   asked for). The values are the plugin's *plain numeric* values,
   never display strings — a formatter that rounds 3.14 ms to
   "3.1 ms" must not launder the number (Codex caught the draft
   claiming a blanket float-ulp bound that display-style conversions
   do not honor) — and write-back stores the plain value the plugin
   itself reports for the state it is in, verifying the round-trip
   (set, read back, compare) at write time; a plugin whose
   conversion cannot round-trip gets that one param stored in
   normalized form, a `check`-visible fallback rather than a silent
   drift. Labeled parameters are the deliberate exception to
   never-display-strings: a discrete parameter whose natural spelling
   *is* a label (`Ratio: "4:1"`, a mode named `Vintage`) takes
   exactly the label the plugin offers, as a string — the scan
   records discreteness and the label set, check enforces both where
   a scan exists, and the render verifies by display round-trip —
   while a continuous parameter never takes a string, which keeps
   the no-laundering rule above true as written (minjudd caught the
   widened schema accepting both without a distinction). Display
   names are not guaranteed unique, so the stable
   parameter ID is load-bearing underneath: the YAML key is the
   display name while unique, and a plugin exposing duplicates gets
   tool-written `Name#<id>` keys — the same you-write-the-name,
   the-tool-writes-the-identity split as decision 2. A param name the plugin does not have
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
   never weakens the key. Ambiguous prefixes refuse loudly. Two
   boundaries, recorded rather than discovered: `shared/plugins/` is
   a deliberate exception to project-model.md's one-pin-per-file
   ledger contract — a ledger row would duplicate what the filename
   already is, and the drift guard here is intrinsic where the pin
   exists to add one — and project-model.md gains that exception in
   chunk 1's diff, when the behavior lands. And the blob hashes what
   the plugin *serializes*: a plugin whose state references sample
   libraries or IR files by path (Kontakt is the honest example)
   keeps those bytes outside the key — the boundary external
   instruments already live with, "knobs on hardware are outside the
   hash" (build-graph.md) — flagged through the same per-plugin
   registry as tier 2, not solved by importing gigabytes.
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
   `state:` line — the old blob stays, per decision 4. A recapture
   rewrites the `params:` map in the same diff, from the plugin's
   current values: a preset load is a param edit *and* a state edit,
   and decision 5's overlay must overlay the preset's values —
   leaving the old map in place would silently revert every
   parameter the preset moved on the next load (Codex caught this
   interaction). The owner-attached rule is transactional, not
   advisory: the daemon holds each gesture's value until the owner
   acknowledges the file write, and on a detach — the owner dying
   between the knob and the write — rolls unacknowledged values back
   to the last acknowledged state before closing the window, so the
   chain is never left ahead of a file nobody can persist. The editor
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
   gesture-scoping confines to edits somebody actually made. The
   declared `tail:` and `latency:` lines join the key too — both
   change the rendered bytes (the ring-out retained, the alignment
   trimmed), so a cached artifact must not survive an edit to
   either.
9. **`version:` lives in the YAML, per entry, and a mismatch is a
   refusal with an offer.** The installed plugin moving from 11.2.0
   to 11.3.0 does not silently re-key every song the morning after
   an installer runs; field refuses, offers to update the line, and
   accepting is a visible diff that deliberately invalidates the
   renders — with the takes machinery catching anything replaced.
   The refusal sits at instantiation, *after* cache lookup: §2 says
   only a rebuild needs the plugin, so a fully cached song plays and
   builds regardless of what the machine has installed — the gate is
   on rendering with the wrong plugin, never on serving bytes the
   key already names.
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
    latency reporting, and a state chunk — so scanning,
    instantiation, params, state round-trip, write-back and
    byte-determinism are all testable without a commercial plugin
    installed. CI owns the VST3 on Linux; AU builds and is proven by
    the local gate, the same split the workflow header already
    records for everything CoreAudio (the macOS runner was retired
    2026-08-08 for cost). Third-party plugins are exercised by hand
    on real sessions; the fixture is what the suite owns.
13. **The host supplies transport context, identically on both
    paths.** Tempo-synced plugins read the playhead — position,
    tempo, meter — and a host that supplies it only live, or only a
    default 120, breaks the determinism policy where it is hardest
    to hear. Both render paths supply the same track-local context:
    sample position from the chain's own clock (the axis the
    reverbs' LFO decision already rides), tempo and meter from the
    track's resolved `time:`. That context is an input, so the
    resolved time map joins the hosted-insert action key — a tempo
    edit re-renders a tempo-synced chain, which is what correct
    means here. No loop or play/stop state is exposed: a stem
    renders as one linear pass, and that is the timeline contract
    both paths share. The fixture plugin includes a tempo-reading
    behavior so CI owns this rather than hoping.

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
   keys per decision 8; the fixture plugin and its CI suite,
   tempo-reading behavior included (decision 13);
   RENDER_PLAN_VERSION bump with existing songs proven pure cache
   hits.
2. **Live.** A hosted insert in the live chain: delay compensation
   from declared latency (the stream lags and flushes, the limiter's
   contract), warmup at locate under the chain's existing −60 dB
   bound — byte-identity offline-vs-live is explicitly *not* claimed
   for hosted inserts in general (the golden stays a built-ins
   contract; the freeze handoff leans on the warmup bound instead,
   §6's answered question), transport context supplied identically
   to offline (decision 13 — blocks split at tempo-segment
   boundaries on both paths, and the fixture, whose processing is a
   pure function of the playhead, proves the plumbing by rendering
   byte-identical anyway), and the version-refusal flow runs live.
   Child-track chains run on the load thread (the engine pre-renders
   children in full); only an output-track chain processes in the
   callback, which is ordinary hosting. Hosted lifecycle is
   message-thread work at both ends (#150, #151): instantiation
   posts to the message thread and waits, so a session load must
   not hold the MessageManagerLock — the daemon dispatches the
   session op outside its blanket request lock and takes the lock
   only for the install — and a replaced session is retired *to*
   the message thread asynchronously rather than destroyed by the
   request that replaced it, because an AU instance's dispose posts
   there and waits unconditionally, making teardown under any held
   lock the same deadlock from the other side. Live growth is declared
   arithmetic only: an undeclared `tail:` grows nothing live, and a
   locate resets hosted stages in place rather than reinstantiating —
   the rebuild runs under the engine lock, where its cost is dropped
   audio rather than latency, so the "correct first, fast later"
   sequencing never applied (minjudd on #150); the warmup bound
   carries hosted state correctness exactly as before.
3. **Editor sessions and write-back.** `field open <track>/<handle>`,
   the `param_changed` protocol message, gesture-quantum file
   writes, blob recapture on non-param signals, id re-binding, the
   owner-attached window rule. The demo is decision 7's flow run
   under `field play creek --watch`.
4. **`realtime-bounce`.** The 1× capture path for plugins that
   cannot render offline (UAD-2 DSP hardware is the motivating
   case), flagged per build-graph.md's render strategies.

## 6 Open questions

Each names the chunk that owes its answer; none blocks a chunk that
does not.

- **Recapture triggers, exactly** (chunk 3's to answer). Which
  non-param signals are reliable across real plugins (program-change,
  restartComponent, property listeners), and whether the
  session-close chunk-hash backstop suffices where they are absent.
- **Freeze-swap policy** (ANSWERED by chunk 2, 2026-08-11): hosted
  chains freeze by the same rule as built-ins — cached serves the
  stem, dirty evaluates live — and the swap rides the chain's warmup
  bound (declared tail + latency + the one-second floor an eq
  already gets) rather than byte-identity. That is the default for
  *every* hosted plugin, because no tier registry exists yet to say
  otherwise: a truly free-running plugin's swap may exceed the bound
  audibly, and the registry that flags those (build-graph.md tier 3)
  remains future work — the recorded lean stands: when it exists,
  tier-3 chains stay live and never freeze. Measured against the
  fixture, live and offline are byte-identical (its processing is a
  pure function of the playhead), which is a fixture property the
  suite pins, not a general claim.
- **Editor windows vs daemon-lite** (chunk 3's to answer). The daemon
  exits when idle; an open editor is a reason not to be idle, and
  window ownership on macOS may want the daemon to run an app
  lifecycle while one is up.
- **Dynamic parameter lists** (chunk 3 revisits against real
  plugins). Chunk 1's behavior: params the scan saw are validatable,
  the rest ride the blob, and an unknown name is an error only where
  a scan exists to judge it.
- **Linux/Windows timing.** VST3 hosting is the portable half; when
  the platforms graduate from at-least-works is not this plan's call.
- **AU natural units, found in first field use** (chunk 3 owes the
  decision, with chunk 1's behavior recorded honestly): Apple's
  built-in AUs implement no text→value conversion, so JUCE's AU host
  parses a numeric param value as *normalized 0–1* — `Dry/Wet Mix:
  30` refuses (correctly, as unrecognized) and `0.3` is the working
  spelling, which is not the natural-units promise. VST3 converts
  properly through the controller, and AUs that publish value
  strings (UAD's labels) work; the gap is AU continuous params
  without ValueFromString. Candidate fixes: display-guided inversion
  (search normalized space for the value whose own display matches
  the authored number — adaptive unit displays make this non-trivial),
  or recording the conversion gap per parameter at scan time and
  validating the spelling accordingly.
- **DSP-backed plugins without their hardware, found the same hour**
  (chunk 4's to answer, and sharpened by measurement): a UAD
  Apollo plugin with no Apollo attached instantiates, reports its
  latency, and *passes audio through dry* — creek's drums rendered
  byte-equivalent to their input under an action key claiming a
  4:1+8:1 1176. Authorization and hardware presence are machine
  state the key cannot see, so chunk 4 must turn "DSP absent" into a
  refusal at instantiation the way version drift already is, not a
  silent bypass the cache then serves forever.

## 7 Definition of done

A real third-party AU on creek's lead-vocal renders offline and plays
live through the freeze; under `field play creek --watch`, `field
open` shows the editor, a knob twist is heard immediately and lands
as a one-line YAML diff that re-freezes behind the play; a stateful
plugin captures a blob a fresh clone resolves by hash, and the
rendering machine with that plugin removed still builds the song as
pure cache hits — the cross-machine version of that story waits on
the remote asset store (later.md); the fixture-plugin suite is green
in CI (VST3 on Linux; AU on the local gate, per decision 12); and
every existing project rebuilds as pure cache hits.
