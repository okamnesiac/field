# CLI

`field` is the whole interface to a Field project. It validates the
project, builds audio through the dependency graph, plays a song live in
the engine, and edits the YAML that describes all of it.

Every command runs from inside a project. `field` finds the project root
by walking up from your working directory until it finds `field.yaml`,
so any subdirectory works; outside a project you get `not inside a Field
project`. Commands print results to stdout, errors to stderr, and exit
non-zero when they fail.

This page is the task-oriented manual. For the concepts underneath
it — what a track is, why the cache is the freeze — start at
[README](README.md), and read [build-graph.md](build-graph.md) for
labels and caching in depth. For a project to run these commands
against, use [`examples/bloom`](../examples/bloom/README.md).

## Install

Field needs Node 24 (the version in [`.nvmrc`](../.nvmrc)) and pnpm —
never npm or yarn. From the checkout:

```sh
pnpm install
pnpm build
pnpm build:native    # field-audiod, the playback and render daemon
pnpm setup           # once, if pnpm has never linked a global binary
pnpm add -g .        # links `field` onto your PATH
```

`pnpm add -g .` links this checkout rather than copying it, so a later
`pnpm build` takes effect with no re-linking. To run from source without
installing, use `pnpm field <args>`. To remove it, `pnpm remove -g
field`.

Build the daemon before you build *or* play anything. `field-audiod` is
the renderer as well as the player: `eq`, `limit`, `reverb`, `plate` and
`hall` targets render by spawning it, so `field build` fails without it
rather than falling back to anything. `field play` also needs it for
`--from`, `--device`, `--loop`, `--click` and `--watch`.

SuperCollider renders every `supercollider:` entry. `field build` runs
`sclang` from your `PATH`, from the macOS app bundle, or from
`FIELD_SCLANG` — see [Environment variables](#environment-variables).

To see what you have, ask the version:

```console
$ field --version
field 0.1.0  (bfa8660 on main)
worker protocol 2

daemons in .
  field-audiod  not running
  field-aced    not running
  field-voiced  not running
```

The first line is the CLI build and the commit it came from, and it says
so when the checkout has moved on or carries uncommitted changes. The
rest reports which daemons run for *this* project and which build each
one is on — a daemon started before your last `pnpm build:native` still
runs the old code, and `field transport quit` is how you retire it.

## Address things with labels

A label is the address of something buildable. The absolute form is
canonical, and the CLI accepts a songs-relative shorthand everywhere:

| Form | Means |
| --- | --- |
| `//songs/creek/track:main` | a track's stem — the canonical spelling |
| `creek/track:main` | the same label, songs-relative |
| `creek` | the song's output track, `track:main` |
| `//songs/creek/gen:lead-take` | a generated node's chosen variant |
| `creek/gen:lead-take-2` | variant 2 specifically, for auditioning |
| `//shared/asset:rain` | shared material, which has no shorthand |
| `creek/...` | every label in the song, as a pattern |

Commands that take labels take several at once, and `build`, `export`
and `play` all accept patterns.

## Check the project

`field check` validates schemas, references, asset content and canonical
formatting. It is the gate every build and every watch rebuild runs
first, and it is what CI runs.

```console
$ field check
ok
```

A failing check prints one line per problem and exits 1. When the only
complaint is formatting, `field fmt` rewrites the files:

```console
$ field fmt
formatted songs/creek/tracks/keys.yaml
```

`field fmt` refuses to format a project with validation errors — fix
those first, since canonically formatting an invalid file means nothing.

## Look around

`field status` summarizes the project:

```console
$ field status
project bloom @ 48000 Hz
  creek: 14 tracks, 25 inputs
  tall-grass: 6 tracks, 6 inputs
```

`field arrangement <song>` derives the song's structure from its output
track's placements — the timeline nobody wrote down:

```console
$ field arrangement creek
creek (12 bars)
  1.1.1 0:00.0  lead-vocal  (+3 dB, pan 0.2)
  1.1.1 0:00.0  pad  (-6 dB, pan -0.2)
  1.1.1 0:00.0  phrase
  1.1.1 0:00.0  space  (-3 dB)
  5.1.1 0:10.0  phrase
  9.1.1 0:20.0  phrase
```

The bar count appears when the song declares a `length:`. A song that
declares none is as long as its material, which is also what governs
where playback stops.

`field query` asks the graph a question — a pattern, or `deps(...)` for
everything a label depends on:

```console
$ field query "deps(creek/track:space)"
```

`field explain <label>` is the one to reach for when something surprises
you. It reports the label's type, its inputs and their hashes, its
action key and whether that key is cached, and — for a track — where the
signal actually goes:

```console
$ field explain creek/track:space
...
reaches: track:main -3.0 dB
cable: receive "keys-verb" ← track:keys, -14.0 dB (tap post), 3 arrivals at samples 0, 480000, 960000
```

## Build

`field build <patterns...>` builds labels. Each line says what happened:
`built` ran the work, `cached` returned a stored artifact, and `source`
is a committed file that was never built at all.

```console
$ field build tall-grass
cached  //songs/tall-grass/track:bass → .field/out/songs/tall-grass/track/bass.wav
built   //songs/tall-grass/gen:seven-eight-loop → .field/out/songs/tall-grass/gen/seven-eight-loop.wav
built   //songs/tall-grass/track:seven-eight-loop → .field/out/songs/tall-grass/track/seven-eight-loop.wav
built   //songs/tall-grass/track:drums → .field/out/songs/tall-grass/track/drums.wav
built   //songs/tall-grass/track:room → .field/out/songs/tall-grass/track/room.wav
built   //songs/tall-grass/track:main → .field/out/songs/tall-grass/track/main.wav
```

Outputs live under their content hash and are materialized at
`.field/out/<label>.wav`. Those are addresses for the engine, not names
to hand to anyone — use `field export` for that.

`field build <patterns...> --watch` rebuilds on every settled change
until ctrl-c, and answers "did anything audible change" as an
output-hash question: a fader move re-runs one sum, a comment edit
reports silence.

```console
$ field build creek --watch
...
watching for changes (ctrl-c stops)
· no audible change
↻ //songs/creek/track:main 4f2a91c0b8de
```

A project that fails `check` mid-edit — a half-saved file, the common
case — prints its diagnostics, keeps the last good outputs, and retries
on the next change. Unlike a plain build, watch starts fine on a project
that does not currently check.

## Play

`field play <song>` plays the song live in the engine. Clean subgraphs
arrive as cached stems and only dirty ones cost anything, so live
evaluation and playback are the same thing — there is no separate freeze
to manage. Ctrl-c stops.

```console
$ field play tall-grass
live    tall-grass (live)
3.5.295 (0:04.2)
```

The position line is `bar.beat.tick (m:ss.t)`, updating in place.
Playback ends when the song does: a song that declares a `length:` runs
to it, and one that does not runs as long as its material and its tails.

Naming a bare song plays it live. Naming an explicit label — a track, a
gen node, an asset — plays the *built artifact* from disk instead, and
several patterns make a queue played in order. That distinction decides
which options apply:

| Option | Does |
| --- | --- |
| `--loop` | loops the song at its extent, or replays an artifact queue |
| `--device <name>` | picks an output device; `field devices` lists them |
| `--watch` | follows the project so edits land mid-play (live songs only) |
| `--from <position>` | starts at `bar[.beat[.tick]]` (one target only) |
| `--click` | overlays a metronome (artifacts only) |

Two combinations are refused rather than approximated, and the error
says what to type instead: `--click` on a live song, because the click
renders CLI-side over a file; and `--from` with `--loop` on a live song,
because that is a region loop and only file playback has one.

`field devices` lists output devices, spawning the daemon if it is not
already running:

```console
$ field devices
* Speakers (FxSound Audio Enhancer)
  Speakers (Realtek(R) Audio)
```

The `*` marks the default.

### Follow your edits while it plays

`field play <song> --watch` composes watch mode with playback, minus the
wait. Each settled change recompiles the session: a gain move ramps in
on the next block, anything structural swaps the session at a block
boundary with the transport carried, and dirty stems rebuild behind the
play and freeze on the next compile — a swap with nothing to hear,
because live and offline evaluation are bit-identical.

Because `field choose` is only a YAML edit, running it against a playing
watch session is live variant A/B-ing.

## Control the running daemon

`field play` starts the daemon; `field transport` drives it from another
terminal.

```console
$ field transport status
stopped (nothing loaded)
device: Speakers (FxSound Audio Enhancer) @ 48000 Hz
daemon: field-audiod 0.11.0
```

| Command | Does |
| --- | --- |
| `field transport status` | state, position, file, and device |
| `field transport play` | starts or resumes the transport |
| `field transport pause` | pauses, holding position |
| `field transport stop` | stops the transport |
| `field transport locate <position>` | jumps to `bar[.beat[.tick]]` |
| `field transport quit` | shuts the daemon down |

`quit` is how you pick up a new build: the daemon respawns on the next
`field play`, running the binary you just compiled.

## Get a file out

`field export <patterns...>` builds the labels and copies the results to
`~/Desktop` as numbered versions, so the thing you send someone has a
name and a version rather than a hash.

```console
$ field export creek --rate 44100 --bit-depth 16
exported //songs/creek/track:main → ~/Desktop/creek-main-v3.wav
```

| Option | Does |
| --- | --- |
| `--to <dir>` | writes somewhere other than `~/Desktop` (must exist) |
| `--rate <hz>` | delivers at this sample rate (default: the source's) |
| `--bit-depth <bits>` | delivers at 16, 24 or 32 (a float source must choose) |

Each line reports one of three outcomes. `exported` wrote a new version,
`current` found the newest version already identical, and `reverted` is
the one to stop on: these bytes match an *older* version, so a change was
undone and the highest-numbered export is not what you just built.

## Create and edit

| Command | Does |
| --- | --- |
| `field init` | initialize a project in the current directory |
| `field song create <name>` | create a song with default tempo and meter |
| `field track create <song> <name>` | create a track in a song |
| `field import <file> --song <name>` | copy audio in and record it in `assets.yaml` |

`field init` takes `--name <slug>` and `--sample-rate <hz>`; without
them it uses the directory name and the default rate.

`field import` records the file's content hash and its WAV facts — rate,
bit depth, channels, frame count — and refuses a WAV whose sample rate
differs from the project's. In a terminal it asks; in a script, pass
`--allow-mismatch` to accept the mismatch deliberately.

```console
$ field import ~/Recordings/rain.wav --song creek
imported rain (songs/creek/audio/rain.wav, 5292044 bytes, 48000 Hz 24-bit 2ch, 882000 frames)
sha256 9f2c1d…
```

## Generate

Generation is a committed recipe, not a lost session. The workers are
explicit and never automatic:

```console
$ field setup aced
$ field generate creek/still-water-keys --seed 90210 --variants 2
$ field choose creek/still-water-keys --variant 2
```

`field setup [worker]` prepares the worker environments with `uv`; with
no argument it sets up all of them. `field generate <song>/<name>` fills
a generative entry — a new name scaffolds a leaf track — and writes
variants into `songs/<song>/audio/<name>/` with a recipe recording the
model, the seed and the hash of every take. A missing `--seed` draws one
and the output says what it drew, because a seed here is provenance
rather than reproducibility: inference does not reproduce across GPU and
framework versions.

Music generation takes `--prompt`, `--bars` or `--duration`, `--lyrics`
and `--bpm`. Voice takes `--text`, `--voice-ref`, `--exaggeration` and
`--conviction`. Both take `--variants <n>` (1–8, default 2).

`field choose <song>/<name> --variant <n>` repoints which take the label
resolves to. Every placement follows, and in a project that commits its
generated audio that is a one-line Git diff.

## Plugins

| Command | Does |
| --- | --- |
| `field plugins scan` | scan installed AU/VST3 plugins into `.field/plugins.json` |
| `field plugins list` | print the scanned inventory |
| `field plugins pin` | write identities, versions and latency into track files |
| `field insert add <track> [plugin]` | add an insert to a track |

```console
$ field plugins scan
LABS — vst3 9acb4b39 3.0.26 (Spitfire Audio)
scanned: 1 plugin, 0 failed
```

`field plugins pin` takes `--au` or `--vst3` to break a name matching
both formats, and `--update` to accept installed versions over drifted
pins — a deliberate re-render, since the pinned version is a cache input.

`field insert add` with no plugin named opens an incremental-search
chooser in a terminal: type to filter (every whitespace-separated token
must match, so `au delay` narrows to AU delays), arrow keys to move,
Enter to take, Escape to cancel. It then asks where in the chain the
insert goes. Outside a terminal — in a script or an agent — the
interactive halves do not exist: name the plugin, and it lands at the
end of the chain. Use `--at <position>` to place it explicitly and
`--id <handle>` when the chain repeats a plugin.

## Render an SC program directly

`field sc render <program> --seed <n> --duration <seconds>` runs a
SuperCollider program straight to a WAV, uncached, for iteration. The
cached form is a `supercollider:` entry in a track, which the build
graph keys on the program's content hash.

```console
$ field sc render shared/instruments/creek-kit.scd --seed 7801 --duration 3.182
rendered /path/to/creek-kit.wav (seed 7801, 3.182s @ 48000 Hz)
```

`--channels <n>` takes 1 or 2 (default 2), and `--output <path>` writes
somewhere other than `<program>.wav` in the current directory.

## Environment variables

| Variable | Does |
| --- | --- |
| `FIELD_SCLANG` | path to `sclang`, ahead of `PATH` and the macOS app bundle |
| `FIELD_AUDIOD` | path to the `field-audiod` binary, ahead of the built one |

Both point at a binary the default search does not find. `FIELD_AUDIOD`
is resolved to an absolute path immediately, because the daemon spawns
with its working directory at the project root, where a relative path
would mean something else.

## Platform notes

macOS on Apple Silicon is the reference platform — see [V1 platform
scope](README.md#v1-platform-scope) for what that commits to and what it
does not. Two differences show up at the command line wherever you run.

Plugin formats differ by platform. Audio Units are an Apple format with
no implementation elsewhere, so `field plugins scan` scans VST3 only off
macOS, and a track pinning `au:` cannot render there. VST3 hosting is
unaffected.

`field play` needs `field-audiod`. On macOS, a machine without the built
daemon falls back to `afplay` for plain artifact playback, with no
transport and no options. The fallback is attempted everywhere and only
exists on macOS: today, off macOS, an unbuilt daemon fails with
`afplay failed: spawn afplay ENOENT` after a stderr line pointing at
`pnpm build:native`. The Windows port (#161, in review) replaces that
with a plain refusal naming the build command on every non-macOS
platform — the decision is recorded in
[windows-portability.md](projects/windows-portability/readme.md) §2.2 as
amended. Porting the rest is tracked there and in
[linux-portability.md](projects/linux-portability/readme.md).

## Command reference

| Command | Does |
| --- | --- |
| `field --version` | the CLI build, and which build each daemon runs |
| `field init` | initialize a project in the current directory |
| `field check` | validate schemas, references, assets, formatting |
| `field fmt` | rewrite project files to canonical formatting |
| `field status` | summarize the project |
| `field arrangement <song>` | the song's derived timeline |
| `field query <expr>` | query the graph: a pattern, or `deps(...)` |
| `field explain <label>` | type, inputs, action key, cache status, levels |
| `field build <patterns...>` | build labels; `--watch` to follow changes |
| `field export <patterns...>` | build and deliver numbered versions |
| `field play <patterns...>` | play a song live, or audition artifacts |
| `field devices` | list output devices |
| `field transport <op>` | drive the running daemon |
| `field song create <name>` | create a song |
| `field track create <song> <name>` | create a track |
| `field import <file> --song <name>` | import audio and record it |
| `field insert add <track> [plugin]` | add an insert to a track |
| `field plugins scan\|list\|pin` | the hosted plugin inventory |
| `field setup [worker]` | set up generation worker environments |
| `field generate <song>/<name>` | run a deliberate generator |
| `field choose <song>/<name> --variant <n>` | repoint which take plays |
| `field sc render <program>` | render an SC program directly, uncached |

Every command takes `--help`.
