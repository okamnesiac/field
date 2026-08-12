---
status: Draft
---

# Plan: the UI, first version

**Goal:** a graphical face for a playing project — transport and
position, the song's tracks with their levels, edits landing as YAML
diffs through the same write-back machinery every tool already uses —
served locally by a `field ui` command, written in TypeScript, on the
framework §5 settles.

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
  a position readout in musical time — driven by the daemon's
  `position`, `state`, and `device` events over the socket, the same
  stream the CLI readout consumes.
- **Tracks and levels**: the song's tracks as the project files spell
  them, each placement's `gain_db` (and `pan`) as a control; moving
  one writes the file. Mute is a gain gesture until a `mute:` field
  exists — the plan notes it because a session already wanted one.
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
  already lives in field's Node process. `field ui` starts a local
  HTTP server in that process: static assets out, one WebSocket per
  client carrying daemon events and file-change invalidations down
  and edit operations up. No second daemon, no protocol fork; the
  WebSocket vocabulary is deliberately thin (state, position, project
  snapshot, edit ops) so the socket protocol stays the one already
  documented.
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
  flips this plan Active, like every stack decision.

## 5 Open questions

Each is the flip-to-Active PR's to answer; the first is the one to
discuss before anything is built.

- **React, or Next.js.** Obviously TypeScript; the question is the
  framework. The case for plain React (bundled by Vite, served by
  `field ui`): the server half of Next duplicates a server field
  already is — routing, SSR, server components, and API routes solve
  web-product problems (SEO, first-paint over a network, per-route
  data) that a localhost tool with a resident stateful process does
  not have, and a second server runtime is a real cost in a repo
  whose stack is deliberately short. The case for Next.js: it is the
  fuller batteries-included path — file routing, fast-refresh
  ergonomics, a future remote story if the UI ever serves a machine
  the project is not on. Leaning: Vite + React SPA, revisited only if
  the remote story becomes real. To discuss.
- **Browser tab, or a desktop shell.** `field ui` opening a
  localhost tab costs nothing and window-manages itself; Electron or
  Tauri buy native menus, a dock icon, and window adjacency with
  chunk 3's plugin editors, at the price of a shell runtime and its
  updates. Leaning: browser first, shell when editor adjacency
  actually hurts.
- **Where the client lives.** A pnpm workspace package (`ui/`), or
  `src/ui/` with its own tsconfig for DOM types. The repo is a single
  package today; the workspace split is cleaner for a DOM/bundler
  toolchain but is itself a structure decision to record. Leaning:
  workspace.
- **Fader drags: write-on-release only, or live ramps during the
  drag.** The daemon's `ramp` op could follow the pointer (throttled)
  with the file write still landing once on release — hearing the
  move is the point of a fader, but it puts a socket op inside the
  gesture where chunk 3 keeps gestures file-only until release.
- **Does this retire the "full TUI eventually" want** recorded with
  the disposable-picker decision (add-insert.md §3), or coexist with
  it — terminal sessions keep the pickers either way; the question is
  whether anyone still wants a full-screen terminal face once a
  browser face exists.
- **Styling**: hand-rolled CSS to start, or a component system. The
  first version's surface is small enough that this can stay
  hand-rolled and be revisited with evidence; recorded so the first
  stylesheet is not mistaken for a decision.
