---
status: in-progress
priority: now
---

# The UI, first version

**Goal:** a graphical face for a playing project — transport and
position, the song's tracks with their levels, edits landing as YAML
diffs through the same write-back machinery every tool already uses —
served locally by a `field ui` command, written in TypeScript on
Vite + React (§5).

## 1 What the first version is

Watching and mixing, nothing else: open the UI on a project, see the
song playing (or start it), and move levels while it plays. That is
already most of what a session does between edits, it exercises every
piece of plumbing a bigger UI will need — the daemon bridge, the file
write-back, the watch round-trip — and it stays small enough that the
technology choice below is cheap to revisit if it proves wrong. The
first version is judged the way the engine was: use it on bloom for
real, then grow it.

## 2 Files stay the source of truth

The UI is views over what already exists — the project's YAML and the
daemon's socket — never a second store. This is the constraint every
other tool here already lives under, and the UI does not get an
exemption:

- **A fader move is a file edit.** The gesture ends in `gain_db`
  written on the placement through the same comment-preserving
  `Document` machinery the pinner and `field insert add` use, and the
  watch loop carries it into the live session exactly as a hand edit
  would — ramps for gain, a swap for structure. The UI holds no state
  the files don't; two UIs (or a UI and an editor) looking at one
  project converge because the files are the meeting point.
- **The daemon stays musically ignorant.** Bars and beats project
  client-side from the tempo map, the rule playback.md set for the
  CLI readout; samples cross the socket, music does not.
- **Plugin editors stay native.** An AU or VST3 editor window is
  chunk 3's owner-attached session (plugin-hosting.md §5 chunk 3,
  decision 7) — the UI launches `field open`, it never embeds or
  reimplements a plugin view. A browser cannot host one anyway, which
  is a fact worth designing from rather than around.

## 3 First-version scope

- **Transport**: play / pause / stop / locate, the device picker, and
  a position readout in musical time — seeded by `status()` and
  `devices()` at connection and re-queried after each transport or
  device op, with the daemon's `position`, `state`, and `device`
  events layered on top. The events alone are change notifications,
  not truth (Codex on #156): `position` is broadcast only while
  playing, so a locate while paused must re-query or go stale, and
  `device` names only the *selected* output — the picker's list
  re-queries `devices()` rather than waiting for an event the daemon
  does not send.
- **Tracks and levels**: the song's tracks as the project files spell
  them, each placement's `gain_db` (and `pan`) as a control; moving
  one writes the file. Mute is a **non-goal until a `mute:` field
  exists** (a session already wanted one, so the schema line is
  probably coming): spelling it as a gain gesture would overwrite the
  authored level, and remembering the old value anywhere but the file
  is a second store — the exact thing §2 forbids, and two UIs holding
  it privately would not converge (Codex on #156).
- **Inserts, read-only**: each track's chain listed by name, with a
  "open editor" affordance that prints/launches `field open` per
  chunk 3's state, and an "add" affordance that names
  `field insert add` rather than reimplementing its choosers in HTML
  for the first version.
- **Non-goals, first version**: arrangement editing, waveforms,
  clip/take manipulation, the generate/choose flows, automation lanes
  (automation.md's realtime routing and lane UI is its own project),
  plugin parameter surfaces (chunk 3's editors own knobs), and any
  remote/multi-user story — the server binds localhost, one project,
  one user.

## 4 Architecture: `field ui`

- **The bridge is field itself.** The daemon speaks a unix socket a
  browser cannot reach, and every write path the UI needs —
  `loadProject`, the YAML writers, `AudiodClient`, the watch loop —
  already lives in field's Node process. `field ui <song>` starts a
  local HTTP server in that process — the song argument is the same
  grammar `field play` uses, and a multi-song project names one
  rather than guessing (bloom carries two; Codex on #156) — static
  assets out, one WebSocket per client carrying daemon events and
  file-change invalidations down and edit operations up. No second
  daemon, no protocol fork; the WebSocket vocabulary is deliberately
  thin (state, position, project snapshot, edit ops) so the socket
  protocol stays the one already documented. Two guards on that
  socket, both required because it accepts writes: the server checks
  `Origin` and a per-session token minted at launch (dev-proxy mode
  included) — binding localhost excludes the network, not the other
  pages a browser is running (Codex on #156) — and every edit op
  carries the content hash of the file version it was derived from,
  with a stale hash rejected and the view refreshed rather than
  written through: placement ids are optional and duplicates legal,
  so a write racing an editor cannot always be re-anchored by name,
  and reject-and-refresh is what makes two views converge instead of
  overwriting each other (Codex on #156).
- **The client is a TypeScript SPA** rendering server truth. Local
  state exists only inside a gesture: the fader follows the pointer,
  and the file write lands on release — decision 7's knob-quantum
  rule applied to our own controls (whether the drag itself sends
  live ramps is §5's question). After the write, the same
  invalidation path every other editor triggers refreshes the view;
  the UI believes the file, not its last render.
- **Build and serve**: the client builds to static assets shipped
  with the package; `field ui` serves them and opens the browser. Dev
  mode proxies the bundler for hot reload. The stack additions this
  implies are recorded against project-core.md §5 by the PR that
  flips this plan to `in-progress`, like every stack decision.

## 5 Open questions

Two are settled inline and dated; the rest are the
flip-to-`in-progress` PR's to answer, however many remain when it
opens — counted then, not here, so the next settlement does not
stale this line.

- **React, or Next.js — settled (DECIDED, 2026-08-12): Vite + React
  SPA.** The server half of Next duplicates a server field already
  is — routing, SSR, server components, and API routes solve
  web-product problems (SEO, first-paint over a network, per-route
  data) that a localhost tool with a resident stateful process does
  not have, and a second server runtime is a real cost in a repo
  whose stack is deliberately short. The remote story exists but
  points the same way: this UI is local first, and the elements that
  eventually serve audiofield.io get *pulled out* into that product
  later — components built clean enough to extract, not a framework
  carried now for a site that does not exist yet.
- **Browser tab, or a desktop shell.** `field ui` opening a
  localhost tab costs nothing and window-manages itself; Electron or
  Tauri buy native menus, a dock icon, and window adjacency with
  chunk 3's plugin editors, at the price of a shell runtime and its
  updates. Leaning: browser first, shell when editor adjacency
  actually hurts. **Settled 2026-08-20: the shell, and the lean was
  wrong about which cost bites first** — see §6. Adjacency never came
  up; being unable to see a blank window's console did, on the first
  day the thing was opened.
- **Where the client lives.** A pnpm workspace package (`ui/`), or
  `src/ui/` with its own tsconfig for DOM types. The repo is a single
  package today; the workspace split is cleaner for a DOM/bundler
  toolchain but is itself a structure decision to record. Leaning:
  workspace.
- **Fader drags: write-on-release only, or live ramps during the
  drag.** The daemon's `ramp` op could follow the pointer (throttled)
  with the file write still landing once on release — and hearing the
  move is the point of a fader, which is decision 7's own principle:
  the live chain applies values immediately, *you hear the knob now*,
  and only the file write waits for release. What live ramps add is a
  socket op inside the gesture, where chunk 3 has none — its editor
  lives in the daemon, so the knob is audible without crossing the
  socket, and a browser fader is on the far side of one. The trade is
  throttled socket traffic against an audible fader; decision 7's
  file write lands once, on release, either way. Two facts bound the
  option (Codex on #156). Reach: the ramp verb touches exactly the
  output track's input gains — every other track pre-renders with
  gains baked into its buffers, which is why `diffSessions` masks by
  position and classifies nested-gain edits as swaps — so live drags
  are audible for output-track placements only, and a nested fader
  lands on release regardless; moving faders that change nothing are
  worse than none, so the control must say which kind it is. And
  interruption: a tab close or `pointercancel` mid-drag would leave
  the daemon ahead of the file with no release write coming — chunk 3
  prevents exactly this with owner acknowledgements and rollback on
  detach, the bare ramp op has no such transaction — so taking the
  option means specifying rollback to the file's value (or a write)
  on every way a gesture can end, not only the happy release.
- **The TUI — settled (DECIDED, 2026-08-12): it coexists, and it is
  wanted outright.** The full terminal face recorded with the
  disposable-picker decision (add-insert.md §3) is its own future
  project, now carried as its own project ([tui](../tui/readme.md)) —
  this UI neither replaces nor waits for it, and the disposable
  pickers stay disposable in the meantime.
- **Styling**: hand-rolled CSS to start, or a component system. The
  first version's surface is small enough that this can stay
  hand-rolled and be revisited with evidence; recorded so the first
  stylesheet is not mistaken for a decision.

## 6 Implemented (2026-08-18), with mute and solo

The plan is ninjudd's from #156, brought over whole; this section is
what the first implementation settled, added at the end so §1–§5 keep
their numbers. Everything in §3's scope shipped as written, except
where this section says otherwise, and the mute non-goal fell the way
§3 predicted: the schema line came. The pull request that carried the
first version also crossed four more of §3's non-goals once the view
was in use; the last bullets below record each, with the reason it
was taken.

- **`mute:` exists** (schema/track.ts): a boolean on the placement
  beside `gain_db` and `pan`, the loop entry's `enabled:` shape
  applied to a whole placement — a field rather than a gain gesture for
  §2's own reason, and on the placement rather than the track because
  levels live there and a track placed twice can be muted in one home.
  `planFor` excludes muted placements, so the stem spec, its action
  key, the deps, and the live session agree; a toggle re-keys, and
  re-muting is a cache hit. The UI writes it like any other placement
  field.
- **Solo is session-only** (model/solo.ts): a listening gesture, so it
  lives where play/pause does — in the running session, held by the
  `field ui` server, written nowhere. Soloing compiles an alternate
  feed: the soloed track's subtree whole, its carriers keeping only the
  inputs that lead to it, and its send receivers audible transitively
  (solo drums, keep the room drums feed). Muted placements cannot carry
  a solo. While a solo is held, every file edit swaps the soloed
  compile rather than ramping, because ramp indexes address the
  daemon's session and the soloed session's indexes are not the
  un-soloed compile's. Solo offers on track lanes only in this version:
  the walk starts from a track, and an audio placement of `main` has
  no subtree to walk.
- **One lane per `main` placement, opening into nested rows**: the
  top level is one lane per placement in `main`, and lane-per-placement
  rather than lane-per-track is what makes mute-on-the-placement the
  button's exact meaning. A lane that places a track opens, on request,
  into the placements in that track's file, as deep as the tree goes
  (amended 2026-10-10; this bullet first said the lanes stay flat and
  the nesting an engine concern). Each row carries the file it lives
  in, that file's hash, and its index in `inputs:`, so a child row's
  edit writes the placing track's file under that file's own stale
  guard. Which rows are open is view state, persisted nowhere.
- **Musical time is projected in the browser after all** (amended
  2026-08-20; this bullet said the opposite for two days, and §2 said
  client-side before that). The first implementation kept the projection
  in field's own process and shipped rendered strings, which is cheaper
  and was wrong for one reason nobody had measured: **the daemon emits
  position on a 250 ms heartbeat** (`main.cpp`'s `Heartbeat`), so a
  readout that only moves when an event arrives moves four times a
  second. That reads as broken — reported as "the time thing is really
  jumpy… it needs to flow" — and no amount of machine speed fixes it,
  because the samples in between are never sent. A view that runs its
  own playhead between events and resynchronises on each one is the only
  shape that flows, and that view needs the tempo map.

  What kept the earlier decision honest still holds, and is why this is
  cheap rather than a second implementation: the snapshot carries the
  song's own tempo and meter **event arrays**, and the client builds the
  same `TempoMap`/`MeterMap` from `src/time/tempo.ts` that the CLI uses
  — pure arithmetic with no Node dependency, imported rather than
  ported, so the two projections cannot drift. `ramp` travels with the
  tempo events, or a ramped song would disagree. The load-bearing rule
  is untouched: the daemon still hears only samples (playback.md §3.6).
  The server keeps formatting the snapshot's `musical` string as the
  value a song with no tempo map falls back to.
- **§5's remaining questions, answered by the flip**: the client lives
  in a `ui/` workspace package; fader drags write on release with no
  live ramps inside the gesture (the bounded option §5 recorded stays
  open for later, with its rollback obligations noted); hand-rolled
  CSS.
- **A desktop shell, not a browser tab — and not for §5's reason**
  (amended 2026-08-20; this bullet said "browser tab, no shell" when
  first written, and shipped the opposite two days later). §5 conditioned
  the shell on window adjacency with chunk 3's plugin editors, and that
  trigger has not fired — those editors do not exist yet. Two other
  reasons did fire, on the first session that opened the thing:
  a browser tab is the wrong answer to "open my project" when the tab
  belongs to whatever browser happens to be default and the window
  cannot own its own lifetime; and **a blank tab cannot be diagnosed
  remotely**. The first render crashed on a React error nobody could
  see, and the fix that found it was the shell mirroring the renderer's
  console to the terminal `field ui` was launched from. A tool whose
  failures are invisible to the person who can fix them is the more
  expensive kind of cheap. Electron, because the client is already a web
  app and Tauri would add a Rust toolchain the stack does not have;
  `--browser` keeps the tab as an opt-out, and a missing Electron falls
  back to it rather than failing. Its weight is real and recorded with
  the rest in [project-core.md](../project-core/readme.md) §5. The stack record itself is
  amended in [project-core.md](../project-core/readme.md) §5 (2026-08-18): the
  `ui/` workspace member against §5's single-package sentence, `ws` on
  the server, react + vite inside the member only — with the reasons
  and what each amends, where `AGENTS.md` says decided records change.
- **The timeline, with waveforms** (amended 2026-10-10; §3 listed
  waveforms and arrangement editing as non-goals). The lanes draw on
  one time axis under a bar ruler, with a playhead. Geometry comes from
  the planner's own `placedWindow`, so the picture cannot disagree with
  the render. §3's argument against waveforms was about doing them
  properly — a peaks artifact with a build rule, a cache, and an
  invalidation story — and it still stands for long material. What
  shipped is the cheap half: an envelope computed on demand from the
  stem the build already wrote, memoised by the file's identity, which
  is enough for songs of a few minutes. The commits cite
  "ui-timeline.md chunk 1"; that plan was never committed, and this
  bullet is the record in its place.
- **Clip move, split, and trims** (amended 2026-10-10; §3 listed
  clip manipulation as a non-goal). Selecting a clip and dragging it,
  cutting it at the playhead, and dragging either edge were the
  gestures the timeline asked for as soon as it existed, and each is a
  file edit like the fader: one write on release, in the spelling the
  author used, with the stale guard and a load of the edited project
  before the write (`src/commands/ui-edits.ts`, `src/commands/ui.ts`).
  A looped or cross-rate clip refuses the gestures whose arithmetic
  would be wrong for it.
- **The insert editor** (amended 2026-10-10; §3 kept inserts read-only
  and pointed at `field insert add`). Selecting a clip shows its
  track's chain, with add, edit, and remove for the built-in effects:
  a knob strip for `limit`, `reverb`, `plate`, and `hall`, and for the
  `eq` a response curve with draggable bands. Every write is validated
  by the same zod objects the track schema is built from, and a hosted
  plugin stays read-only, its parameters belonging to its own editor
  window (plugin-hosting.md §5). The EQ curve is computed in the view
  because it redraws under a drag at frame rate, which a socket round
  trip per pointer move cannot; its arithmetic lives in
  `src/audio/eq-response.ts` under the suite, as render-pipeline.md
  decision 4's amendment records.
- **Verified on a live session**: play through a real device with
  position streaming, a mute landing in YAML and riding the watch back
  into the running audio, solo/un-solo swapping mid-play with the
  transport carried, and a stale-hash edit rejected with a refresh.
