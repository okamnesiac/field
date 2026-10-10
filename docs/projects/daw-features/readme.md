---
status: draft
priority: later
---

# What other DAWs are loved for

**Goal:** a standing list of features that users of other DAWs single out as
the best thing about them, with what each one would mean for Field. This is
direction, not a plan. Nothing here is committed; a line graduates by getting
its own project directory beside this one, at `priority: later`.

Compiled 2026-08-20 from forum threads and vendor documentation for REAPER,
Logic Pro, Ableton Live, Pro Tools, Bitwig, Studio One, and the AI-native
tools ACE Studio, Greysound, and Suno Studio. Sources are in §13, and §16
records what has been picked out of the catalogue so far.

Extended 2026-08-21 with the other half of the question: **§§17–22 are what
people say they wish their DAW did**, drawn from complaint and feature-request
threads rather than from praise. That half turned out to be the more useful
one, because a feature everybody wants and nobody ships is a better lead than
a feature three vendors already have.

## 1 How to read this

Each section is one theme, not one DAW, because the interesting thing is
usually that two DAWs solved the same problem differently. Every entry says
what the feature is, who has it, why people say they love it, and **For
Field** — what adopting it would actually cost here, which is often much less
than in a conventional DAW and occasionally much more.

Field's model changes the arithmetic in three recurring ways, and they show up
throughout:

- **Assets are immutable, placement is metadata.** Anything other DAWs
  implement as destructive-with-undo, Field implements as a YAML layer over a
  hash-pinned asset. Comping, pitch correction, and clip gain are all this
  shape.
- **Every action is a verb.** Features that other DAWs expose only through a
  gesture are, here, a command an agent can also call — so the design question
  is usually the affordance, not the mechanism.
- **The project is a Git repository.** Versioning features that cost other
  vendors years of engineering are, for Field, mostly a question of what to
  put in front of `git`.

## 2 One detail pane that follows the selection

Ableton Live keeps a single detail view pinned to the bottom of the window.
Select a track and it shows that track's device chain; select a clip and it
shows the clip's contents. It is one pane with one job — show me the thing I
just clicked — and it collapses when there is nothing to show.

Logic Pro's editors are the counterexample people reach for: the piano roll is
a pane you open and then have to close, and it does not reliably follow what
you selected. The complaint is not that the editor is bad — Logic's piano roll
is separately one of the best (§5) — it is that the window's shape is
something you manage by hand.

**For Field.** [ui.md](../ui/readme.md) and `ui-timeline.md` (not yet written) are the
place to settle this before there are three editors competing for screen. The
rule to adopt: one detail region, driven entirely by the current selection,
with an empty state rather than a close button. Field's selection is already
well defined — a label ([build-graph.md](../../build-graph.md)) names exactly
one buildable thing — so "what is selected" needs no new concept.

The rule extends past devices to audio, and this is the part to hold firm on:
**clicking a clip brings up its editing surface, in that same pane, with no
menu in between.** Trim, gain, fades, pitch, and timing are things you reach
for constantly while listening, and every menu between the ear and the edit is
paid for on every pass. Ableton earns its reputation here by making the pane
the only place you look; the failure mode to avoid is Logic's, where the
editor is a thing you go and get. §15 is the same rule applied to key.

## 3 Drag a plugin onto a track, and audition it in place

Two Ableton behaviours get named constantly:

- **Drag and drop from the browser.** You drag a device or preset from the
  browser onto a track and it lands in the chain, or onto an existing device
  and it replaces it. There is no dialog and no insert slot to pick first.
- **Hot-Swap (`Q`).** The preset on the track is temporarily linked to the
  browser, so arrow-keying down the list auditions each preset in place, in
  the mix, at tempo. You keep the one you stopped on.

**For Field.** `field insert add` already writes a pinned insert with an
interactive chooser ([add-insert.md](../add-insert/readme.md)); the UI gesture is the
same command with the drop target supplying the track and the order position.
Hot-Swap is the harder and more interesting one, because Field has no concept
of a change that has not landed in a file yet. The honest shape is a
session-only override the daemon holds — the same mechanism solo already uses
in [ui.md](../ui/readme.md) §3 — which either gets written on commit or evaporates. That
is a real design decision and worth its own document if it graduates.

## 4 Comping: take folders, playlists, and swipes

This is the most consistently praised editing feature in any DAW, and both
major implementations are worth copying from.

- **Logic take folders and Quick Swipe Comping.** Loop-record a part and every
  pass lands in one folder on one track. Open it, and you swipe across the
  waveform of whichever take you want at that moment; the comp is the set of
  swipes, is non-destructive, and stays editable forever. Users call it one of
  Logic's greatest features outright.
- **Pro Tools playlists.** Each track holds alternate playlists, loop-record
  auto-creates one per pass, and you "explode" them to see every take stacked
  so you can audition and promote pieces into a master playlist. Production
  Expert's framing is that anyone who learned on tape would not go back.
- **Grouped comping.** REAPER's item grouping and Logic's track groups make
  one swipe apply across a multi-mic kit, so a drum comp stays phase-coherent.
  Losing this is the single most-reported comping mistake in the Logic forums.

**For Field.** Field already has takes — numbered, auditioned, one active,
none destroyed ([docs/README.md](../../README.md), "Take") — and `field
choose` to promote one. The gap is precise and worth naming: **the choice is
currently whole-take, and comping needs it to vary along the timeline.** A
comp is a list of ranges, each naming a take, written on the placement and
resolved by the build. That is additive to the existing model rather than a
rework of it, it diffs well, and it makes "which take is this line from?" a
question the repository can answer, which no DAW can. Grouped comping falls
out of applying one range list across a track group.

## 5 Note editing over recorded audio

Logic's piano roll is praised hardest not for MIDI but for what it does to
recorded material. Flex Pitch draws sung audio as note blocks on the grid —
pitch, drift, vibrato, and formant become handles you drag — so tuning and
melody edits happen in the same editor as everything else. Flex Time does the
equivalent for timing.

ACE Studio pushes the same idea further for synthesized voices: you edit pitch
curves, dynamics, tension, and breathiness at **phoneme** level, and
vocal-to-MIDI converts a sung performance into notes to work from.

**For Field.** This one fits Field better than it fits the DAWs that have it,
because Field never edits audio in place anyway. A pitch layer is a block of
note-level corrections keyed to an immutable take, applied by a build rule —
reviewable as a diff, reproducible, and cached like anything else. It also
closes a loop that is already half-built:
[voice-generation](../voice-generation/readme.md) commits vocals from text, and
note-level editing of a generated vocal is the obvious next verb. Pair it with
§11's note about analysis workers.

## 6 Everything is an action, and actions compose

REAPER's reputation rests on this. Every operation in the program is an entry
in a searchable action list; every entry can be bound to a key or a toolbar
button; and several entries can be combined into a custom action — a macro
that appears as one step in the undo history. Add ReaScript (Lua, EEL2,
Python) and the SWS extensions, and users describe the result as "crazy
powerful."

**For Field.** Field has the mechanism by construction — every meaningful
action is already a CLI verb — and is missing the two affordances that make
REAPER's version beloved:

- **A discoverable index.** REAPER's action list is a searchable catalogue of
  everything the program can do. Field's equivalent is a generated command
  index, which also happens to be most of what the planned MCP surface
  ([mcp-surface.md](../mcp-surface/readme.md)) needs to describe itself.
- **Committed macros.** A named sequence of Field commands, stored in the
  repository, versioned with the song. REAPER users keep these in config;
  Field would keep them in the project, which is strictly better — the macro
  travels with the music it was written for.

## 7 Alternatives, scratch pads, and safe experiments

Three vendors sell three different answers to "let me try something without
wrecking what I have":

- **Logic Project Alternatives and Track Alternatives** — whole-project or
  per-track variants inside one document, heavily used in film scoring where a
  cue needs three versions on the same reel.
- **Studio One Scratch Pads** — an independent parallel timeline in the same
  song. Drag an arranger section (or the whole song) into a scratch pad, edit
  freely, drag the result back. Unlimited, saved with the project.
- **Pro Tools session file backup** — automatic versioned copies, named by
  Production Expert as one of seven functions they cannot work without.

**For Field.** Field's answer is Git, and this is the clearest place where
Field's substrate is already ahead of the market. The work is entirely in the
affordance, and the three above are not the same feature:

- Project alternatives map to branches, and want a switcher, not a Git
  tutorial.
- Scratch pads are the interesting one, because they are deliberately *not* a
  branch — the point is that the experiment sits beside the real arrangement
  where you can A/B it in one session. In Field that is a second placement
  list on `main`, muted, which is a small YAML feature and a large workflow
  win.
- Automatic backup is what Git already is. Say so, and let the UI show the
  history rather than reimplementing it.

## 8 Named song sections you can rearrange

Studio One's Arranger Track puts named sections — intro, verse, chorus — on
their own lane, and dragging one moves or copies every track's material inside
it. Pro Tools' Markers and Memory Locations are the lighter version:
annotations you jump to, which editors rank as a workflow essential rather
than a convenience.

**For Field.** A song's structure is already its output track's placements, so
"move the second chorus earlier" is a placement reorder. Named ranges on
`main`, plus markers as plain YAML, would make that reorder a gesture instead
of an arithmetic exercise — and would give the CLI a way to build or render a
section by name. Low cost, high daily value, and it makes agent instructions
much more natural ("tighten the second verse").

## 9 Racks, macros, and modulation

- **Ableton Racks and Macro Controls.** Group a device chain into a rack and
  expose up to eight knobs, each mapped to any number of parameters across the
  chain. Users describe building a "mega-synth behind a customized interface,"
  and morphing between chains with the chain selector so only two devices are
  ever active.
- **Bitwig's modulation system.** Any modulator onto any parameter of any
  plugin, native and consistent with no workarounds. KVR's Bitwig users call
  it a core design principle rather than an add-on, and the most fun thing
  they have found in a DAW in years.

**For Field.** [automation.md](../automation/readme.md) already decides the shape —
breakpoint lanes plus control-rate generators, one compile target,
realtime-evaluable by design. A macro is the missing half: a named parameter
declared on a track that fans out to several insert parameters, so it can be
automated, modulated, or set by hand as one number. Bitwig's lesson is the one
to take seriously — modulation that works everywhere, including on hosted
plugins, is what people love, and the exceptions are what they complain about.

## 10 Rendering, routing, and the boring parts editors care about

- **REAPER's region render matrix** — render any combination of tracks and
  regions in one pass, with per-cell mono/stereo/multichannel choices and
  filename wildcards. The Gearspace wish that keeps recurring is the same idea
  stated as an outcome: every deliverable — instrumental, a cappella, stems,
  formats — from one action.
- **REAPER subprojects** — a whole project appears in a parent project as a
  single rendered item. Field's stem plus content-addressed cache already *is*
  this; the affordance is letting a song reference another song's output.
- **Clip gain, pre-insert.** Pro Tools users are emphatic that clip gain and
  volume automation are different tools because clip gain changes what hits
  the compressor and automation changes what leaves it. It is the first of
  Production Expert's indispensable seven.
- **Tab to Transient and Keyboard Focus.** Editors navigate Pro Tools by
  transient and single keystroke, which is how "edit an hour of dialogue"
  stays possible. `Shift+Tab` extends the selection to the next transient.
- **Beat Detective** — automatic slicing at transients, quantize, and
  crossfill for multitrack drums.

**For Field.** The render matrix is `field build` over several labels with a
naming convention, and is close to free. Clip gain is a decision to make
deliberately rather than a feature to add: Field needs a placement-level,
pre-insert gain distinct from the mixer's `gain_db`, or it needs to say
clearly why it does not. Transient navigation and Beat Detective both want the
analysis workers already parked as
[analysis-workers.md](../analysis-workers/readme.md), and transient
positions are exactly the kind of derived data that should be cached by
content hash rather than stored.

## 11 What the AI-native DAWs do, and which parts people say are worth having

The user-facing tools split into two camps, and the forum consensus about
which parts are good is unusually consistent.

**Generation you can keep editing.** Greysound's CoProducer takes a spoken
description and builds an **editable native effect chain** — you then tune
every parameter by hand. Its MIDI generation is the same bargain: the AI
writes the bassline, you edit every note. Suno Studio 2.0 generates *into the
timeline* — ask for a part at bar 17 and get one — and its Warp Markers let
you fix the timing of a generated section instead of regenerating it. ACE
Studio's whole premise sits between a prompt-based song generator and a DAW:
the AI sings, but you keep note-level control of the melody.

The pattern in all three is the same, and it is the one Field should adopt as
a rule: **the model's output is the same editable artifact a human would have
made**, not a rendered result you can only accept or reject.

**Tedium, not creativity.** Greysound advertises phase-aligning tracks,
stripping silence from long regions, adding fades, batch gain-staging, and
noise removal. This matches what working professionals say they actually want:
Attack Magazine and Production Expert both report that the valued use is
navigating the session, cleaning it up, and handling technical interruptions —
routing a beat, tidying a mixer — while the *disliked* use is a general mixing
assistant, because it "regresses to the middle" and produces homogenized mixes
that sound like an average of everything. The ideal people describe is the old
studio assistant who knew *your* tendencies, not a global one.

**Staying in sync with the host.** ACE Bridge ships as VST3/AU/AAX with ARA
link mode so playback and tempo stay locked, which is what makes it feel
native rather than like a second application.

**Separation as an editing primitive.** Suno exports up to twelve time-aligned
WAV stems; Greysound splits imported references; RipX deconstructs a mix into
note-level data with harmonics and stereo position so you can edit inside it.

**For Field.** Most of this is Field's existing thesis stated from the other
direction, and the argument is worth writing down properly somewhere public:
an agent driving Field produces a YAML diff you review, which is the "editable
artifact, not a black box" pattern by construction, and every generation is
already a committed recipe with a seed. Three concrete items fall out:

- **Generate at a position.** ACE generation is asset-first today; "generate
  eight bars at bar 17 of this song, conditioned on what is already there" is
  the Suno gesture and is a natural verb on top of
  [ace-generation.md](../ace-generation/readme.md).
- **The tedium verbs.** Strip silence, align phase, fade, gain-stage. These
  are unglamorous, they are what the professionals in every thread actually
  ask for, and in Field each is a deterministic transform writing a diff —
  reviewable, revertable, and testable, which is exactly what makes them safe
  to let an agent run.
- **Separation and analysis.** Already parked as
  [analysis-workers.md](../analysis-workers/readme.md), on the [ace-generation.md](../ace-generation/readme.md) worker
  protocol. §5 and §10 both want them, which is an argument for moving them
  up.

## 12 Anti-patterns, stated deliberately

Worth recording, because these came up as complaints in the same threads that
produced the list above.

- **Panes you have to manage by hand.** Logic's piano roll not following
  context (§2). A view that neither opens nor closes itself is a chore
  disguised as a feature.
- **Power that requires a configuration project first.** REAPER's action
  system is loved and its out-of-the-box interface is not; reviewers
  consistently pair "crazy powerful" with "the initial setup and tweaking can
  be time-consuming." Field's defaults have to be usable before its
  extensibility is interesting.
- **Assistants that regress to the mean.** See §11. A feature that makes every
  project sound like the average project is worse than no feature.
- **Prompt-only interfaces.** MusicTech's Suno Studio review and several forum
  threads land in the same place: if dialling in the prompt costs more than
  doing the thing by hand, and the result is inconsistent, it is unusable on a
  deadline. Prompting has to be one way in, next to the direct one.

## 13 Sources

Forum threads and documentation this was compiled from.

- REAPER: [action list reference](https://forum.cockos.com/showthread.php?t=61929),
  [custom actions](https://forum.cockos.com/showthread.php?t=240459),
  [subproject FRs](https://forum.cockos.com/archive/index.php/t-170851.html),
  [ReaScript API](https://www.reaper.fm/sdk/reascript/reascripthelp.html),
  [KVR product discussion](https://www.kvraudio.com/product/reaper-by-cockos/details).
- Logic Pro: [Quick Swipe Comping and track groups](https://www.logicprohelp.com/forums/topic/156813-track-groups-quick-swipe-comping-issue/),
  [take folders](https://gearspace.com/board/music-computers/170392-logic-8-take-folders-help-me-understand.html),
  [comping and Flex Time methods](https://logicprohelp.com/forum/viewtopic.php?t=106344),
  [project alternatives](https://www.logicprohelp.com/forums/topic/147119-project-alternatives-any-real-advantages/).
- Ableton Live: [racks and macro controls](https://www.ableton.com/en/manual/instrument-drum-and-effect-racks/),
  [working with instruments and effects](https://www.ableton.com/en/manual/working-with-instruments-and-effects/),
  [the browser](https://www.ableton.com/en/live-manual/12/working-with-the-browser/),
  [favourite-features thread](https://forum.ableton.com/viewtopic.php?t=228923&start=15).
- Pro Tools: [playlist workflows](https://www.production-expert.com/production-expert-1/pro-tools-playlists-check-out-these-powerful-workflows),
  [clip gain vs volume automation](https://www.production-expert.com/production-expert-1/clip-gain-and-volume-automation-in-pro-tools-which-should-you-use-and-when),
  [functions I cannot live without](https://www.production-expert.com/home-page/2018/10/2/14-pro-tools-functions-i-cannot-live-without-part-1),
  [most-used keyboard shortcuts](https://www.production-expert.com/production-expert-1/team-our-most-used-pro-tools-keyboard-shortcuts).
- Bitwig and Studio One: [why Bitwig over Live](https://www.kvraudio.com/forum/viewtopic.php?t=627619),
  [Studio One vs Bitwig](https://www.kvraudio.com/forum/viewtopic.php?t=515032),
  [Gearspace Bitwig review](https://gearspace.com/board/reviews/927358-bitwig-bitwig-studio.html).
- AI-native tools: [Greysound](https://greysound.ai/),
  [ACE Studio 2.0](https://discover.oreateai.com/discover/ace-studio-20-redefines-professional-music-production-beyond-simple-ai-vocal-synthesis),
  [Suno Studio review](https://musictech.com/reviews/digital-audio-workstations/suno-studio-review/),
  [Suno Studio 2.0](https://www.unite.ai/suno-studio-2-0-turns-played-midi-into-a-prompt-for-ai-generated-audio/),
  [developers on AI in DAWs](https://musictech.com/features/interviews/ai-daw-digital-audio-workstation-ripx-moises-wavtool/),
  [Attack Magazine on AI in your DAW](https://www.attackmagazine.com/features/long-read/assessing-the-shift-in-power-from-producers-to-ai-in-your-daw/),
  [AI audio tools are built for everyone](https://www.production-expert.com/production-expert-1/ai-audio-tools-are-built-for-everyone-thats-the-problem).

Wish-lists and complaints, added 2026-08-21 for §§14–15 and §§17–22.

- Version control and collaboration: [using versioning control with DAW projects](https://www.kvraudio.com/forum/viewtopic.php?t=429799),
  [version control for DAWs](https://www.kvraudio.com/forum/viewtopic.php?t=334175),
  [still impossible to collaborate on a DAW project](https://gearspace.com/board/music-computers/1411003-still-impossible-modern-age-collaborate-daw-project.html),
  [remote collaboration tools compared](https://www.production-expert.com/production-expert-1/remote-collaboration-tools-compared).
- Recovery and project rot: [the DAW feature I care about more now is mistake recovery](https://www.kvraudio.com/forum/viewtopic.php?p=9273348),
  [view your plugins without opening the project files](https://gearspace.com/board/music-computers/1130074-view-your-plugins-without-open-daw-project-files.html),
  [managing a whole production setup](https://www.kvraudio.com/forum/viewtopic.php?t=628232),
  [old, buried ideas](https://www.kvraudio.com/forum/viewtopic.php?p=9215880).
- Per-DAW gripes: [3 Pro Tools features still missing in 2026](https://www.production-expert.com/production-expert-1/3-pro-tools-features-still-missing-in-2026),
  [is Logic Pro the perfect DAW?](https://www.production-expert.com/production-expert-1/is-logic-pro-the-perfect-daw-or-are-there-things-to-improve),
  [Pro Tools and MIDI](https://duc.avid.com/showthread.php?t=387305),
  [what's wrong with REAPER?](https://gearspace.com/board/cockos-reaper/608111-whats-quot-wrong-quot-reaper-what-sucks-about.html),
  [Ableton's lacks vs Logic](https://gearspace.com/board/ableton-live/1396810-some-features-lacks-features-ableton-still-annoying-2023-especially-vs-logic.html),
  [do all DAWs suck?](https://www.kvraudio.com/forum/viewtopic.php?t=487801),
  [DAW survey 2025](https://www.production-expert.com/production-expert-1/2025-daw-survey-the-results).
- Keys and scales: [Ableton's Keys and Scales in Live 12 FAQ](https://help.ableton.com/hc/en-us/articles/11425083250972-Keys-and-Scales-in-Live-12-FAQ)
  (the "no automatic scale recognition" statement in §15),
  [Live 12.1 adds Auto Shift](https://www.ableton.com/en/blog/live-121-adds-auto-shift-drum-sampler-and-more-now-in-public-beta/).

## 14 A browser that spans projects, libraries, and outside sources

Ableton's browser is the reference implementation, and three things about it
matter more than its contents:

- **One panel, everything in it.** Sidebar categories — sounds, drums,
  instruments, effects, packs, your user library, the current project — and a
  search that crosses all of them at once.
- **Preview in the session.** Clicking a sample plays it at the project's
  tempo, in the mix. Half of why the browser feels fast is that auditioning
  costs nothing.
- **Browser history and similarity search.** Live 12 lets you back-button
  through where you have been, the way a web browser does, and can find
  comparable sounds and presets by machine learning rather than by filename.

Dragging from that panel straight onto a track (§3) is what closes the loop.

**For Field.** What is wanted here is wider than Ableton's browser — sounds
from *other* Field projects and from a personal library, not only from the
open one — and the substrate for it is unusually good:

- **Within a project, the library already exists.** `shared/` is exactly this:
  three shelves split by contract — `instruments/` makes sound, `samples/` is
  sound, `plugins/` changes sound — with `shared/assets.yaml` as its ledger
  and `//shared/asset:<name>` as the address
  ([project-model.md](../../project-model.md), "The shared library"). Browsing
  one project is browsing things that already have names.
- **Across projects is the new work, and it is an index, not a copy.** Assets
  are content-addressed, so the same sample sitting in two checkouts is
  provably one thing. The index is a hash-to-locations map over several
  projects; it can tell you where a sound already lives without moving
  anything, and pulling one in is a pin, not a duplicate.
- **The thing no other browser can do: search by provenance.** A Field sound
  carries its recipe — prompt, seed, model, SuperCollider program, how it was
  found. So the query is not only "a warm pad" but "the reverb from that
  chorus", "everything generated with this voice", or "every sample that came
  from this Splice search". That is a real advantage over tag-and-filename
  browsing, and it exists only because the recipes are committed.
- **External sources belong in the same surface.**
  [splice.md](../splice/readme.md) already has the shape — search in, audition, and
  choosing commits the sample together with the recipe of how it was found.
  Your own library and an outside source should not be two different panels.
- **Preview has to play in the session**, at tempo, and once §15 exists, in
  key.

The library this reaches spans other Field projects and a personal collection
held outside any one of them; §20 is the same requirement arriving as a
complaint.

## 15 Getting imported material into key

The state of the art is weaker than people assume, which makes this worth
doing rather than merely copying:

- **Tempo conforming is solved everywhere.** Ableton warps imported audio to
  the project tempo; Logic's Smart Tempo does the equivalent. Nobody thinks
  about this any more.
- **Key conforming is not.** Ableton Live 12.1 added Auto Shift — real-time
  pitch tracking and correction, with the quantizer able to follow the clip's
  current scale — but Ableton's own FAQ states plainly that **there is no
  automatic scale recognition in Live 12**. You choose the scale by hand.
  Logic's Flex Pitch edits pitch note by note once you are already in the
  editor, but nothing conforms an imported clip to the song's key in one move.
- **The AI tools are ahead here, on the material that needs it most.** ACE
  Studio does pitch tracking and per-note and per-phoneme correction of sung
  material; RipX deconstructs a mix into note-level data with harmonics; Suno's
  Warp Markers fix the timing of a section without regenerating it.

**For Field.** Split it in two, because they are different problems:

- **Detection — what key is this?** — is analysis, and belongs on the analysis
  workers already parked as
  [analysis-workers.md](../analysis-workers/readme.md), on the
  [ace-generation.md](../ace-generation/readme.md) worker protocol. Recorded and sung
  material is where a model earns its place; a clean loop often does not need
  one.
- **Conforming — move it** — is a transform, and **the model is the default
  path for it, not the fallback** (decided 2026-08-21). Sequenced material is
  the one case where conforming is arithmetic — transpose the notes and you
  are done — but Field's material is overwhelmingly recorded and generated
  audio rather than sequences, so the arithmetic case is the rare one. Both
  transposition and time-stretch go through the model, with the note-level
  correction layer in §5 applied against the immutable take. Designing around
  the sequenced case would be optimising for the exception.

Two consequences worth writing down now:

- **Detection results are derived data, cached by content hash.** Analyse a
  sample once and every project referencing the same bytes knows its key. That
  makes §14's browser searchable by key for free, which is the kind of
  compounding no DAW gets because no DAW has content addresses.
- **A song has a tempo map but no declared key.** `song.yaml` carries `time`
  (tempo and meter) and nothing about pitch, so "in key" currently has no
  referent. That field is the prerequisite, and it is the same class of
  decision as clip gain in §10: a property on the placement, not a destructive
  render.

## 16 Picked so far

The rest of this document is a catalogue. This section records what has
actually been chosen, so the two do not blur together. Dated, because the
reasoning above will keep moving.

**2026-08-20.**

- **REAPER's actions, custom macros, and user-bound shortcuts** (§6) — in
  scope, all three parts: the searchable index of every verb, macros as named
  sequences committed to the project, and shortcuts the user assigns across
  the whole action set.
- **A clip opens its editor with no menu in between** (§2) — clicking a clip
  brings up audio manipulation directly in the selection-driven detail pane.
  Stated as the positive form of the anti-menu position.
- **A sound browser spanning projects and libraries** (§14) — including
  sounds from other Field projects and from a personal library, not only the
  open project.
- **Imported material conformed to the song's key** (§15) — with the model as
  the default path for transposition and time-stretch, not a fallback behind
  an arithmetic one.

## 17 The version-control gap

This is the single largest thing people ask for and nobody ships, and the
threads asking for it describe Field without knowing it. One KVR poster puts
it plainly: the philosophy of version control, which is ordinary in software
development, has never percolated down to DAW-land.

**What people currently do instead.** Date-stamped filenames, saved by hand.
One user's routine is to open a project and immediately re-save it under a new
name with the current date, then mirror the folder to Dropbox — and admits to
forgetting. The DAW-native approximations are Cubase's auto-backup versions,
Mixcraft's *Copy To* archive, and Sonar's MixRecall snapshots, which take a
full project snapshot and let you choose how deep a recall goes.

**The obstacles they name**, all three of which Field has already answered:

- **Project files are binary**, so there is nothing to diff. REAPER's
  text-based projects are named as the lone exception.
- **Audio is enormous**, so keeping many full versions is prohibitive on disk.
- **Commit discipline is a developer habit.** Musicians will not do it unless
  it is invisible.

**What they explicitly ask for**, which reads as a specification:

- Version control integrated into the DAW, with visual comparison of two
  states.
- Versioning at the level of *resources* — individual takes, plugin settings —
  not just whole projects.
- Automatic cleanup of orphaned files, so history does not bloat the folder.
- A commit workflow that does not burden the user with constant commenting.

**And collaboration is the same problem wearing a hat.** A Gearspace thread is
titled, flatly, that collaborating on a DAW project is still impossible in the
modern age. Ableton's answer is *Collect All and Save*, which consolidates a
project's files into one folder so it can be sent. Pro Tools has cloud
collaboration, with the caveat that every participant needs the same plugins
installed to hear it as intended (§19).

**For Field.** Four of those five asks are already true here, and it is worth
being explicit that they are, because this is the argument for the whole
project stated by the people who want it:

- Schema-validated YAML gives the diff the binary formats cannot.
- Content-addressed assets mean two versions **share bytes** rather than
  copying them, which dissolves the storage objection that makes everyone
  else's version control impractical.
- Takes and hash-named plugin state blobs are already resource-level
  versioning.
- The ledgers make orphan detection mechanical rather than a manual audit.

The fifth is not free, and Field should not pretend otherwise. **A commit
workflow a musician will actually use is an unsolved interface problem here,
not a solved one.** Nobody is going to write commit messages between takes.
The honest target is that the states worth naming get named on their own — a
take promoted, a mix rendered, a section rearranged — and everything else is
just history you never have to look at.

## 18 Mistake recovery, and why it is a creative feature

A KVR thread titled *The DAW feature I care about more now is mistake
recovery* collects the asks: multiple timed backups rather than a single
rescue file, cleaner interfaces that cause fewer accidents, better handling
when samples move, and finer control over what marks a project dirty.

Two complaints about undo recur everywhere. It is **selective** — some
parameter changes never bubble up into the history, so `Ctrl-Z` silently does
not cover them — and it is **linear**, in every DAW, so exploring two
directions means losing one.

The most useful line in the thread is about motive rather than mechanism. One
user keeps device presets specifically because being able to get back "keeps
me more willing to try things." Recoverability is not a safety feature; it is
what makes people take risks. Duplicating a track and muting the original is
the same instinct, done by hand, and it is why people do it constantly.

Comparison is the related gap: a free open-source A/B comparator exists as a
separate application precisely because comparing two mixes inside a DAW is
awkward.

**For Field.** Git is non-linear history, which is the branching undo nobody
ships — but two things need saying rather than assuming:

- **Undo has to cover everything, or it inherits the complaint.** Field's
  structural advantage is that the file *is* the state, so an action either
  changed a file and is in history, or changed nothing. The exceptions are the
  deliberate session-only overrides — solo today, the Hot-Swap idea in §3 —
  and those need a stated rule about what happens to them, not silence.
- **A/B is a build, not a plugin.** Two versions of a mix are two labels, both
  addressable, both cacheable. Field can do natively what people currently
  install a separate application for.

## 19 Projects that still open in five years

The complaints here are specific and unglamorous:

- Old projects report plugins as **missing** because the vendor renamed the
  plugin or appended a suffix, even though the correct version is installed.
- Projects open with VST2 disabled, and re-enabling it does not restore what
  the tracks were using.
- New plugin versions break old projects outright when a developer drops
  compatibility.
- People describe 400-plus plugins, lost licence keys, and no way to tell
  which projects use which plugin — there is an active request to **see a
  project's plugins without opening the project**.
- Pro Tools cloud collaboration requires every participant to have the same
  plugins installed.

**For Field.** `field.lock` — the locked plugin and model environment — is
listed in [project-model.md](../../project-model.md) as designed but not yet
built, and these complaints are what it is for; they are worth citing in the
change that builds it. Two parts of the answer already exist: plugin state
blobs resolve **by content hash rather than by name**
([plugin-hosting.md](../plugin-hosting/readme.md) decision 4), which is exactly the
defence against a vendor renaming something underneath you; and "which plugins
does this project use?" is a `grep` here, with no application launched. That
last one is small, demonstrable, and worth showing people.

## 20 The idea buried in an old project

Stated in one line on KVR: good ideas end up buried in old projects that never
get opened again. The supporting complaints are about navigation — Pro Tools
still has no folders in its clip list, which Production Expert calls essential
once a session holds thousands of files, and Logic's file browser is named
repeatedly as an annoyance.

**For Field.** This is §14 restated as a problem instead of a feature, and it
sharpens the argument there. The reason the idea stays buried is that nothing
indexes across projects and filenames do not describe sounds. Recipes do —
which is why provenance search is the part of that browser worth building
first.

## 21 Per-DAW gripes worth learning from

Short, because the value is in the pattern: **each DAW is complained about for
the thing it does most flexibly.**

- **Logic** — cannot import 32-bit float audio; no GUI customisation; a mixer
  users call bizarrely small; show/hide track management that does not scale
  to high track counts; **Track Stacks still cannot be nested**; ARA
  integration requested for years; and support limited to the current and
  previous macOS, so the software ages out with the hardware.
- **Ableton** — had no takes and no comping at all until Live 11, and no
  multi-clip editing (fades, cuts) until linked-track editing arrived; no
  automatic scale recognition (§15); for live use, no jump markers and no
  D.S./coda equivalent, and no preset switching by MIDI program change without
  touching the GUI.
- **Pro Tools** — cannot switch playback engine without a restart; opens
  **one session at a time**, which people want changed specifically to compare
  versions and copy between projects; no folders in the clip list; MIDI that
  stops at the basics, with no note-range limits and no CC scaling or
  remapping.
- **REAPER** — the bill for its own flexibility. Settings scattered across
  preferences, project defaults, and submenus, described as a complete mess;
  a default theme people replace immediately; stock effects with ugly or
  absent GUIs; no stock instruments worth using; a piano roll that is merely
  functional; and the customisation rabbit hole itself, which one user calls a
  trap of forever trying new themes and scripts instead of working.
- **Across all of them** — imported media handled inconsistently, with
  different tempo assumptions and different sample-rate conversion, causing
  alignment problems; and dark, low-contrast interfaces that stay hard to read
  even enlarged.

Three of these land directly on Field. Nested track stacks are a years-old
Logic request that Field has already shipped ([nested-tracks.md](../nested-tracks/readme.md)).
Many sessions at once is free here — a daemon and a CLI, not a single
application window — and the UI must not regress it. And inconsistent
sample-rate conversion is precisely what [multi-rate.md](../multi-rate/readme.md) and
[cross-rate-live.md](../cross-rate-live/readme.md) made explicit and byte-identical, so
Field's answer is already built and should be said out loud.

## 22 What the wish-lists change

Sorting §§17–21 by what they mean here:

- **Already answered by the design, and worth saying plainly.** Diffable
  projects; versions that share bytes instead of copying them; resource-level
  history; plugins pinned by hash rather than by name; a project's plugin list
  readable without launching anything; many sessions at once; explicit,
  byte-identical rate conversion; nested tracks. These are not future work —
  they are arguments, and the threads in §13 are the evidence.
- **Wanted, not free, not yet designed.** A commit workflow a musician will
  actually use (§17); undo that accounts for deliberately session-only state
  (§18); `field.lock` (§19); the cross-project browser (§14, §20); key
  detection (§15).
- **Warnings.** REAPER's configuration burden is §12's anti-pattern with
  evidence attached, and it is the failure mode Field is most exposed to,
  because Field is at least as configurable. Low-contrast interfaces are a
  real complaint and a real accessibility point for the UI, not a taste
  question.
