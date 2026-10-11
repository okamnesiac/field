---
status: ready
priority: next
---

# Plan: Instrument knobs

**Goal:** an instrument names the knobs it exposes, `field keys` shows
them on a line of their own, and you choose one with the left and right
arrows and turn it with up and down, faster the longer you hold, while
every sounding voice and every take you record follows.

## 1 Problem

`field keys <instrument>` plays a SuperCollider instrument from the
computer keyboard. It publishes the MIDI source `Field Keys`, and a
voice host, `sc/voice-host.scd`, turns each note into a voice of the
instrument ([keyboard-instrument.md](../keyboard-instrument/readme.md)
§2.6). The voice contract names the controls Field sets: `freq`, `amp`,
`gate`, `out`, and an optional `mod`, which the modulation wheel (MIDI
controller 1) sets from 0 to 1 (keyboard-instrument.md §14). Field
knows nothing about any other control a voice has.

So while you play, the one thing about the sound you can change is the
wheel, and in Musical Typing only to six fixed steps, on keys `3` to
`8`. Everything else is fixed when the program loads. `juno.scd` keeps
its sound in a settings Event (`vcfFreq`, `vcfRes`, `atk`, `rel`, and
twenty-two more) that its voice bakes into the SynthDef as constants;
its own comment says "the knobs are fixed per instrument, so they shape
the graph rather than arriving as controls". To hear `juno` with a
darker filter, you edit the file and save, and the reload
(keyboard-instrument.md §14) gives the next note the new value. That
is an edit loop, not playing: you cannot sweep the filter under a held
chord, hear where you are in its range, or record the sweep.

Justin asked on 2026-10-11 for a different way to change parameters
than keys `3` to `8`: the arrows to move between knobs, up and down to
change the value, and holding to move faster, with each instrument
listing the knobs it exposes by name and `field keys` showing them.

## 2 Solution

An instrument declares its knobs in its voice. Each knob is a control
of the voice's SynthDef with a `ControlSpec`, SuperCollider's own
description of a control's range, curve, step, and units, and the
SynthDef's metadata lists the knobs in order with the MIDI controller
(CC) that turns each. The voice host reads the list when it loads the
program, before any audio runs, and reports it to `field keys`, which
puts the modulation wheel first as the knob `mod`. Two new keymap
actions choose a knob (`knob`) and turn it (`turn`), and Musical Typing
binds them to the arrows. A turn sends the knob's controller through
`Field Keys` like any other control change. The voicer sets the control
on every sounding voice and starts every new voice with it, a take
captures it, and the take's render maps it through the same
declaration. Holding a turn key turns faster the longer you hold it,
timed by `field keys` from the press to the release. A knob line
between the instrument's line and the status line shows every knob,
the chosen one in reverse video, each value at a fixed width. Last, a
take starts with the knob positions you had: `field keys` publishes
the controllers it has sent, `field record` passes them to the daemon
when it arms, and the daemon writes the latest value of each
controller at the take's first sample.

### 2.1 What happens when you turn a knob

1. In `examples/bloom`, you run `field keys juno`. The voice host loads
   `juno.scd` in voice mode with `sc/voice-load.scd`, which reads the
   voice's knob list and checks it (§2.2). The host prints one `knob`
   line per knob and then a `knobs` line (§2.4), before it boots
   `scsynth`.
2. `field keys` builds its knob list: `mod`, then `juno`'s knobs in the
   order `juno` lists them. It draws the knob line with `mod` chosen. A
   knob you have not turned shows its default, which is what the voice
   plays.
3. You press `ArrowRight`, which Musical Typing binds to `{ knob: 1 }`.
   The choice moves to `cutoff`. Nothing is sent.
4. You hold a chord and press `ArrowUp`, bound to `{ turn: 1 }`.
   `field keys` moves `cutoff`'s controller value one step up and sends
   CC 74 with it on the keymap's channel. Before the first turn, the
   value it moves from is the default, unmapped to 0 to 127 and
   rounded.
5. The voicer stores the value, and the host sets `cutoff` on `juno`'s
   synth in every sounding voice to the value the knob's spec maps it
   to. The chord's filter opens. Every new voice starts with it.
6. You keep holding `ArrowUp`. The knob turns again every 40 ms, more
   steps at a time the longer you hold (§2.6), and stops at the top of
   its range or when you release the key.
7. You save `juno.scd`. The host loads it again (keyboard-instrument.md
   §14) and reports its knobs again. `field keys` keeps each
   controller's value, and keeps the choice on the same knob by name.
8. You quit. Knob positions last only for the session, so the next
   `field keys juno` starts at the defaults.

A take records each turn you make during it, and the build renders the
take through `sc/voice-render.scd`, which loads the instrument with the
same `voice-load.scd` and drives the same voicer, so each controller
change turns the knob it turned live. §2.7 makes the take start where
your knobs were before it.

### 2.2 An instrument declares its knobs

A knob is a control of the voice's SynthDef that has a spec and is
listed under `knobs` in the SynthDef's metadata. `juno`'s voice, whose
settings Event is named `pad`, declares four:

```supercollider
SynthDef(\junoKey, { |out = 0, freq = 220, amp = 0.5, gate = 1, mod = 0|
	var k = pad.copy;
	k[\vcfFreq] = \cutoff.kr(pad[\vcfFreq], 0.05, spec: ControlSpec(50, 15000, \exp, units: "Hz"));
	k[\vcfRes] = \res.kr(pad[\vcfRes], 0.05, spec: ControlSpec(0, 0.95));
	k[\atk] = \attack.kr(pad[\atk], spec: ControlSpec(0.005, 4, \exp, units: "s"));
	k[\rel] = \release.kr(pad[\rel], spec: ControlSpec(0.02, 8, \exp, units: "s"));
	Out.ar(out, ju06a.(freq, gate, k, mod.lag(0.05)) * amp * level);
}, metadata: (knobs: [cutoff: 74, res: 71, attack: 73, release: 72]))
```

| Part | Written as | Meaning |
| --- | --- | --- |
| The control | `\cutoff.kr(default, lag, spec: …)`, or a SynthDef argument with its spec under `specs` in the metadata | The knob's name is the control's name, and its default is the control's default. A lag smooths the steps between controller values. |
| The spec | `ControlSpec(min, max, warp, step, units: …)` | The range from `min` to `max`; the warp, `\lin` or `\exp`; the `step` a value rounds to, 0 for none; and the `units` shown after the value. |
| The list | `metadata: (knobs: [name: cc, …])` | Which controls are knobs, in the order the knob line shows them, and the controller that turns each. |

A controller value `v` from 0 to 127 sets the control to
`spec.map(v / 127)`. That is `min + (max - min) * v / 127` for `\lin`
and `min * (max / min) ** (v / 127)` for `\exp`, rounded to `step`.

`voice-load.scd` checks the list when it loads the voice. A list that
breaks a rule fails the load, as a program that does not answer voice
mode does, with an error that names the knob:

- **Each knob is a control of the voice, with a spec.** `freq`, `amp`,
  `gate`, `out`, and `mod` are never knobs, because the host sets them.
- **The warp is `\lin` or `\exp`.** `field keys` draws each value with
  the same formula, and these are the two warps it mirrors.
- **The controller is free.** It is from 2 to 119, and not 6, 32, 38,
  64, or 96 to 101. Those are bank select (0 and 32), data entry,
  sustain, and the parameter-number controllers; 1 is the wheel, which
  Field owns; and 120 to 127 are channel mode messages.
- **No name or controller appears twice** in one voice.
- **The default is inside the range.**

A knob must be a value the graph uses as a signal. A setting that
decides the graph's shape, such as `juno`'s `chorusOn`, its `pwmMode`,
or its `subLevel > 0` test, stays a constant. `juno` and `bass` each
expose the four knobs above, with the same specs; `pad` declares none.
Their numbers follow General MIDI 2's defaults for the sound
controllers (71 resonance, 72 release, 73 attack, 74 cutoff), so a
hardware controller set up for General MIDI 2 turns the same knobs.
Controllers 20 to 31 and 102 to 119 have no assigned meaning and suit
the rest. The render branches keep their constants and their bytes.

### 2.3 Two keymap actions choose and turn a knob

| Action | Effect |
| --- | --- |
| `{ knob: <n> }` | Moves the choice n knobs to the right, or to the left when n is negative, wrapping past either end. Sends nothing. |
| `{ turn: <n> }` | Turns the chosen knob n steps up, or down when n is negative, at the press, and keeps turning while the key is held (§2.6). |

The schema takes n as a non-zero integer. A step is one controller
value. For a knob whose spec has a `step`, a step is the next
controller value that maps to a different value, so a knob with two
positions moves in one press. A turn stops at 0 and at 127. Pressing a
second turn key while one is held turns with the second and stops the
first.

Musical Typing binds the arrows, which it leaves free today:

```yaml
  ArrowLeft: { knob: -1 }
  ArrowRight: { knob: 1 }
  ArrowUp: { turn: 1 }
  ArrowDown: { turn: -1 }
```

Keys `3` to `8` keep setting the wheel to fixed steps, and the knob
line shows where `mod` lands. `tracker` and `fourths` spend the arrows
on transpose and velocity, and do not change (§7 question 2).
`field keys --print` tags the actions `K-1`, `K+1`, `R+1`, and `R-1`,
and describes each in its list of controls. Without an instrument, the
knob list is `mod` alone, so the arrows turn the wheel for Logic or any
other receiver.

### 2.4 The voice host reports knobs, and the voicer turns them

The host prints two new `@field` lines:

| Line | Meaning |
| --- | --- |
| `{"knob":"cutoff","instrument":0,"cc":74,"min":50,"max":15000,"warp":"exp","step":0,"default":2000,"units":"Hz"}` | One knob of the program at that index in `FIELD_INSTRUMENTS`, in the order the program lists them. |
| `{"knobs":4}` | The list is complete. The `knob` lines since the last `knobs` line replace the list `field keys` has. The host prints the list after the first load, before the server boots, and after each reload that loads. |

Both are flat JSON objects, which the host's `emit` already writes.
Inside SuperCollider, the work follows the split that exists:

- **`voice-load.scd` builds the mapping once.** With the voice, it
  answers the knob list and two functions built from it: the knob
  arguments a new voice starts with, given the controller values so
  far, and the control and value that one controller change sets. The
  host and the take's render both call them.
- **The voicer keeps the controller values.** It stores the last value
  of every controller from 0 to 119 other than 1 and 64, one value per
  controller for every channel, as it keeps `mod`. It passes them to
  `start` as a fifth argument, and calls a new `turn` callback,
  `turn.(voice, cc, value)`, on every sounding voice when one changes.
- **The host turns each instrument's own knob.** A voice is a list of
  synths, one per armed instrument (arming.md §9). `start` gives each
  synth its own instrument's knob arguments, and `turn` sets the knob
  on that controller on each synth whose instrument has one. Every
  armed instrument hears every MIDI message (arming.md §3), so
  instruments that declare the same controller all follow it.

### 2.5 `field keys` shows the knobs

```console
$ field keys juno
juno live at 48000 Hz on MacBook Pro Speakers
mod   0  cutoff 2.00 kHz  res 0.300  attack  800 ms  release  1.50 s
Field Keys · musical-typing · transpose 0 · velocity 100 · bend +0 · C4 E4 G4
```

The knob line sits between the instrument's line and the status line.
`field keys` redraws it in place when its text changes, as it redraws
the instrument's line.

- **It appears when the keymap binds `knob` or `turn`.** The status
  line then leaves out its `mod` field, because the knob line shows the
  wheel. A keymap without those actions keeps today's status line.
- **The chosen knob is in reverse video.** Reverse video takes no
  columns, so moving the choice moves nothing.
- **A value keeps its width.** A value prints with three significant
  digits, in thousands with `k` from 1000 up (`2.00 kHz`), and, for a
  knob in seconds, in thousandths with `m` below 1 (`800 ms`). It
  prints as a whole number for `mod` and for a knob whose step is
  whole. Units follow after a space. Each value is padded on the left
  to the widest that its default or any of its 128 controller values
  prints. So turning a knob moves nothing after it, and the notes are
  on another line.
- **A narrow terminal shows a window of whole knobs.** The window holds
  the chosen knob, and `‹` or `›` marks an end where knobs are hidden.
  The window moves only when the choice leaves it, so turning never
  scrolls it.
- **Several armed instruments name their knobs.** Each knob after `mod`
  carries its track's name, or its program's when you named a program,
  as in `keys.cutoff`. Two knobs on one controller share one value, and
  each shows it through its own spec.
- **Values are what `field keys` sent.** Until the host reports, the
  line shows `mod` alone. A USB controller's knob moves the voice but
  not the line, as with the bend and the wheel today.

### 2.6 Holding turns faster

`field keys` times a held turn key itself, from the press to the
release, and keeps ignoring the terminal's repeat events.

| Held for | The knob turns |
| --- | --- |
| The press | 1 step |
| 300 ms to 1 s | 1 step every 40 ms |
| 1 s to 1.5 s | 2 steps every 40 ms |
| 1.5 s and longer | 4 steps every 40 ms |

From the bottom of a range to the top takes about 2.3 seconds, and a
tap moves one step. Each tick sends one control change with the new
value, so a held key sends at most 25 a second. A release, a
focus-out, a panic, and quitting each stop the turn. The session takes
the time as an argument, `tick(now)`, so tests run the curve without
waiting.

### 2.7 A take starts where your knobs are

A take records only what arrives after it starts
(keyboard-instrument.md §14.5). Without this step, a take renders with
every knob at its default until you turn it during the take. Three
parts close the gap:

1. **`field keys` publishes what it sent.** Run inside a project, it
   writes `.field/keys.json` each time it sends a control change, by
   writing a temporary file and renaming it over the old one. It
   removes the file when it exits.

   | Field | Meaning |
   | --- | --- |
   | `pid` | The `field keys` process. A reader ignores a file whose process has exited. |
   | `controllers` | Each controller from 0 to 119 that `field keys` has sent since it started, as `{ channel, cc, value }` with the last value sent. The wheel, CC 1, is one of them. |

2. **`field record` passes them in `arm`.** When it arms a MIDI take
   and the file's process is running, it adds `controllers` to the
   `arm` request, in both the one-track and the `tracks` form. It does
   so only for a daemon that lists `midi-chase` in `hello.features`.
3. **The daemon chases controllers.** From the arm, it keeps the latest
   value of each controller from 0 to 119 on each channel: first the
   values `arm` passed, then each control change that arrives before
   the take starts, which it drops today. When the take starts, it
   writes one line per controller at `at: 0`, ahead of every other
   line, in each MIDI take of the pass. The notes file then begins
   `controls` with those rows, and the render applies them before a
   note at 0, because `renderEvents` already puts control changes
   before note-ons at one instant.

This also closes keyboard-instrument.md §14.5's gap for the wheel: a
take now starts with the wheel where you left it.

### 2.8 Files

| File | Change |
| --- | --- |
| `sc/voice-load.scd` | Reads and checks the `knobs` metadata (§2.2), and answers the knob list and the two mapping functions with the voice. |
| `sc/voicer.scd` | Keeps every controller's last value, passes them to `start`, and calls `turn` when one changes (§2.4). |
| `sc/voice-host.scd` | Prints the `knob` and `knobs` lines after each load, and starts and turns each instrument's synth through its own mapping. |
| `sc/voice-render.scd` | The same `start` and `turn`, through the take's instrument. |
| `src/schema/keymap.ts` | The `knob` and `turn` actions. |
| `keymaps/musical-typing.yaml` | Binds the arrows (§2.3). |
| `src/keys/knobs.ts` (new) | The knob shape and the zod schema for the host's lines, the map from a controller value to a value, the next step of a stepped knob, and a value's text and width. |
| `src/keys/session.ts` | The controllers it has sent, by number, which the `mod` field and `setsMod()` become reads of; the knob list and the choice; and a held turn, advanced by `tick(now)`. |
| `src/keys/voice-host.ts` | Collects `knob` lines into a status at each `knobs` line. |
| `src/keys/print.ts` | The tags and descriptions of the two actions. |
| `src/commands/keys.ts` | The knob line, the timer that ticks a held turn, the knob list kept across reloads, and `.field/keys.json` (chunk 2). |
| `examples/bloom/shared/instruments/juno.scd`, `bass.scd` | Knobs in voice mode. The render branches keep their code and their bytes. |
| `src/commands/record.ts`, `src/audiod/protocol.ts`, `src/audiod/client.ts` | Read `.field/keys.json` and pass `controllers` in `arm` (chunk 2). |
| `native/audiod/src/player.cpp`, `player.h`, `server.cpp` | The chase: seeded from `arm`, updated before the start, written at the start; and the `midi-chase` feature (chunk 2). |
| `docs/keys.md` | Turning knobs, the two actions, the arrows in the Musical Typing table, declaring knobs under "Make an instrument playable", and how a take starts (chunk 2). |
| `docs/build-graph.md` | The voice contract gains knobs, and a take's render turns them as they turned live. |
| `docs/audio-engine.md`, `docs/project-model.md` | The chase, and the rows it puts at a take's start (chunk 2). |

## 3 Why this design (DECIDED, 2026-10-11, for Justin's review)

Justin set the shape: the arrows choose and turn, holding goes faster,
and each instrument lists its knobs by name. The rest is decided here
with the alternative each choice beat, and review can overturn any of
it.

- **A knob is a MIDI controller, not an OSC message to the voice
  host.** `field keys` already sends OSC to `sclang`'s port to reload,
  and OSC would carry a float and a name. But a take holds only the
  MIDI that the daemon captures and stamps (keyboard-instrument.md §3),
  so a knob sent by OSC would never reach a take, and timing it would
  need an alignment against the transport that nothing measures. As a
  controller, a turn is captured, landed, and rendered by code that
  exists, as the wheel is, and a hardware controller's knob turns it
  too. The cost is 128 steps per knob, which the control's lag
  smooths. It keeps keyboard-instrument.md §3's decision that
  `field keys` is a MIDI device, not a line straight to SuperCollider.
- **The instrument names each knob's controller.** Field could number
  knobs from a pool in the order they are declared. A take stores
  controller numbers and renders again whenever its program changes,
  so reordering the knobs would make every old take turn the wrong
  ones. A declared number is the knob's address, as on a hardware
  synth's MIDI chart.
- **The declaration lives in the SynthDef.** One file holds the control
  and its description, so a knob that names a missing control fails
  the load, and the program's content hash, already the render's cache
  input, covers a changed range. `ControlSpec` is SuperCollider's own
  vocabulary for a control's range, and `NamedControl` already stores
  it in the SynthDef's metadata. Rejected: a `juno.knobs.yaml` beside
  the program, which Field could read without `sclang`, but whose
  names and defaults would drift from the SynthDef unseen, and which
  the render would need as a second input. Rejected: a structured
  comment that Field parses, which is a second language inside the
  program. Reading the knobs needs `sclang`, which `field keys` runs
  anyway, and the knobs arrive before the server boots.
- **Only `\lin` and `\exp`.** `field keys` draws each value itself, so
  it mirrors the warp's formula. Two warps cover a frequency, a time,
  and a level, and a voice that wants another curve can shape a `\lin`
  knob inside its graph.
- **The wheel is the first knob.** It is the one continuous control any
  voice may have, so every control you can turn sits on one line, and
  a keymap with no instrument still turns something.
- **Keys `3` to `8` stay.** The keymap is named for Logic's, which puts
  the wheel there, and the knob line shows where they set it. Rejected:
  removing them, which breaks the match with Logic and frees keys that
  nothing else needs.
- **`field keys` times a hold.** The kitty protocol gives it every
  release, so a hold is an exact interval. The terminal's repeat
  follows the operating system's typing setting, which can be slow or
  off and differs over SSH, so the speed of a sweep would be a typing
  preference. Repeat events stay ignored, so every other held key still
  acts once (keyboard-instrument.md §2.2).
- **The knobs get a line of their own.** The status line keeps the
  notes last so that playing never moves them (keyboard-instrument.md
  §2.4). The chosen knob on that line would show one knob at a time.
  A separate line shows every knob by name, and turning cannot move the
  notes.
- **The daemon writes the starting positions, seeded from
  `field keys`.** Rejected: `field keys` resending its controllers when
  the daemon arms, which needs a daemon connection of its own and races
  a take that starts at once. Rejected: knob positions saved on the
  track, which would start each take where the last take left the
  knobs, not where you set them. Rejected: waiting for arming.md
  chunk 3's lasting arm, which opens the MIDI inputs only from the
  moment you arm. The chase also serves a hardware knob turned after
  the arm.
- **Not automation.** [automation.md](../automation/readme.md)
  describes curves written in project YAML. A knob turned while you
  play belongs to the performance, like the wheel, so it rides in the
  take.

The plan extends what exists rather than building beside it: the
voicer's `set` path that carries `mod`, `voice-load.scd` shared by the
host and the render, the `@field` lines and their `emit`, the take's
`controls` rows and the order `renderEvents` gives them, the session's
controller tracking from #195, and the instrument line's redraw. It
replaces the session's `mod` field and `setsMod()` with reads of one
controller map, and it moves the wheel from the status line to the
knob line when a keymap binds knob actions.

## 4 Acceptance criteria

Run these in `examples/bloom`, in Ghostty or iTerm2:

| # | Do | Expect |
| --- | --- | --- |
| 1 | Run `field keys juno`. | The knob line reads `mod   0  cutoff 2.00 kHz  res 0.300  attack  800 ms  release  1.50 s`, with `mod` in reverse video. The status line has no `mod` field. |
| 2 | Press `ArrowRight`, and hold `ArrowDown` until `cutoff` stops at `50.0 Hz`. Hold a chord, and hold `ArrowUp` for three seconds. | The chord's filter opens, slowly and then faster, and `cutoff` stops at `15.0 kHz` about 2.3 seconds after the press. Nothing after `cutoff` moves, and the notes stay where they were. |
| 3 | Tap `ArrowDown` once. | `cutoff` drops by one step. |
| 4 | Repeat criterion 2 while `native/audiod/build/field-audiod_artefacts/Release/field-audiod --midi-monitor "Field Keys"` runs from the Field checkout in another terminal. | Rising CC 74 values, never more than 25 in one second. |
| 5 | With `mod` chosen, press `ArrowLeft`. | `release` is chosen. |
| 6 | With `cutoff` turned and chosen, change `juno.scd`'s list to `[cutoff: 74, res: 71]` and save. | The line shows `mod`, `cutoff`, and `res`. `cutoff` keeps its value and stays chosen. |
| 7 | Change the list to `[cutof: 74]` and save. | The instrument's line starts `juno kept its last voice:` and names `cutof` as a knob that is not a control of the voice. |
| 8 | Run `field keys pad`, then `field keys` with no instrument. | Each knob line shows `mod` alone, and `ArrowUp` turns it. |
| 9 | Run `field keys juno --keymap tracker`. | No knob line, and today's status line. |
| 10 | Narrow the terminal to 40 columns, press `ArrowRight` past the last knob shown, then turn it. | The window moves to show it, with `‹` at the left. Turning does not move the window. |
| 11 | Give `creek` a track `keys` with `instrument: juno` and a track `bass` with `instrument: bass`. Run `field keys creek/track:keys creek/track:bass`, choose `keys.cutoff`, and turn it. | Both instruments' filters move. `bass.cutoff` shows its own value for CC 74. |
| 12 | Record a take on `keys`, sweeping `cutoff` during it, then build and play. | The render sweeps where you swept. |
| 13 | Run `field sc render shared/instruments/juno.scd --seed 1 --duration 4 --output <file>` before and after the change, and the same for `bass.scd`. Compare each pair with `cmp`. | Identical. A difference means the change touched a render branch. |
| 14 | Chunk 2. In one terminal run `field keys juno` and turn `cutoff` down. In another run `field record creek/track:keys --at 17`. Play without touching a knob, stop, build, and play. | The take renders dark from its first note, and the notes file's first `controls` row is `{ at: 0, cc: 74, value: … }`. |
| 15 | Chunk 2. Run criterion 14's `field record` with `--count-in 1`, and turn `res` during the count-in. | The take starts with that `res`. |

These vitest tests fail before the change:

- **`src/schema/keymap.test.ts`.** Accepts `knob` and `turn` with
  non-zero integers and rejects 0 and fractions. `musical-typing`
  binds the four arrows.
- **`src/keys/knobs.test.ts` (new).** Maps controller values through
  `\lin`, `\exp`, and stepped specs to the numbers `ControlSpec.map`
  gives. Finds the next step of a two-position knob. Prints `2.00 kHz`,
  `800 ms`, `0.300`, and whole numbers, with one width across all 128
  values. Parses the host's `knob` and `knobs` lines.
- **`src/keys/session.test.ts`.** `knob` wraps both ways. `turn` sends
  the knob's controller on the keymap's channel from the default's
  unmapped value, and stops at 0 and 127. Driven by `tick(now)`, a held
  turn moves 1 step at the press, none before 300 ms, then 1, 2, and 4
  steps a tick at the times in §2.6, and stops on release and on
  focus-out. Keys `3` to `8` move the `mod` knob. A new knob list keeps
  values by controller and the choice by name.
- **`src/commands/keys.test.ts`.** The knob line at rest, the chosen
  knob's reverse video, the same length before and after a turn, the
  window and its marks on a narrow terminal, and the status line
  without `mod` when the keymap binds knob actions and with it when it
  does not.
- **`src/keys/voice-host.test.ts`, against a stub `sclang`.** Three
  `knob` lines and a `knobs` line become a status with three knobs, and
  a later list replaces it.
- **`src/keys/voicer.test.ts`, through real `sclang`.** With a voice
  that has a `cutoff` knob on CC 74, a voice starts without it, CC 74
  at 127 sets 15000 on the sounding voice, and a new voice starts at
  15000. `voice-load.scd` rejects a knob with no spec, a name that is
  not a control, a reserved controller, a repeated controller, and a
  `\db` warp.
- **`src/generators/voice-render.test.ts`, through real `sclang`.** A
  take with a knob's controller at 0 renders differently from the same
  take without it.
- **`src/commands/record-midi-daemon.test.ts`, chunk 2.** A seeded
  controller lands at `at: 0`. A control change sent after the arm and
  before the start replaces its seed at `at: 0`. One sent after the
  start lands at its own time. Controllers 120 to 127 are never chased.
- **`src/commands/record-plan.test.ts`, chunk 2.** `field record` reads
  `.field/keys.json` only while its process runs, and only for a daemon
  with `midi-chase`.

The tests through real `sclang` skip by name where it is absent, as
they do today. Every criterion in the table makes sound or needs a
terminal with the kitty protocol, so each pull request's Testing
section records the ones it ran.

## 5 Cost

The hot path is a held turn key. It sends at most 25 control changes a
second, each one pipe write and one CoreMIDI send, which
keyboard-instrument.md §5 puts well under a millisecond. The host sets
one control per sounding synth per change: a five-note chord on two
instruments is 10 sets a tick, 250 a second, which `scsynth` handles
without strain. `field keys` redraws the knob line at most 25 times a
second, one write each, and in chunk 2 writes `.field/keys.json` as
often, a few hundred bytes by rename.

The rest is small. Checking the knob list adds nothing to the host's
start beyond a scan of the SynthDef's controls. A two-second sweep adds
about 50 rows to a take's notes file, and one set per sounding voice
per row to its render. The daemon's chase is a table of 16 channels by
120 controllers that the audio callback updates in constant time per
message before the start, and writes once, as a few lines in practice.
Editing `juno.scd` and `bass.scd` changes their content hashes, so a
take rendered through either renders once more.

## 6 Rollout

1. **Knobs, live and in takes.** The declaration and its checks, the
   voicer, host, and render, the two actions, the session, the knob
   line, `juno` and `bass`, and the docs. A knob turned during a take is
   recorded and rendered from here on. Criteria 1 to 13.
2. **Where a take starts.** `.field/keys.json`, `controllers` in `arm`,
   and the daemon's chase. It needs chunk 1's controller map. Criteria
   14 and 15.

## 7 Open questions

1. **Knobs in the Electron UI.** The UI draws knobs for inserts
   (`ui/src/Inserts.tsx`) but nothing of `field keys`, and neither
   `field keys` nor its voice host has a channel to it. Showing an
   armed instrument's knobs there follows the UI playing instruments,
   which arming.md chunk 3's arm buttons begin. Justin decides whether
   "display them in the UI" includes the Electron UI, and when. The
   declaration and the host's lines are what it would read, through a
   command that loads a program and prints its knobs without playing.
2. **Knob keys in `tracker` and `fourths`.** Both spend the arrows on
   transpose and velocity and every row on notes, so neither binds the
   new actions in this plan, and a keymap of your own can. Justin
   decides whether either should give its velocity keys to `turn`.
3. **More than 128 steps.** Deferred until a knob's steps are audible
   through its lag. MIDI 1.0's 14-bit controller pairs and NRPN are the
   two ways to finer steps, and either changes how a knob names its
   controller.
4. **Keeping a sound you dialed in.** Knob positions last for the
   session. Writing them back as the program's defaults, or as named
   patches beside it, is deferred until someone wants to keep one; until
   then you copy the values into the program.

## 8 Background

- **The voice contract.** `docs/keys.md` "Make an instrument playable"
  and `docs/build-graph.md` list `freq`, `amp`, `gate`, `out`, and an
  optional `mod`, and nothing else a voice can take.
- **The instruments.** `juno.scd` and `bass.scd` hold 26 settings in an
  Event and pass it to `ju06a`, whose comment says they "shape the graph
  rather than arriving as controls". `ju06a` tests `pwmMode`,
  `subLevel`, `noiseLevel`, and `chorusOn` with `if`, so those decide
  the graph's shape. Both voices declare only `mod` beyond the contract.
- **Repeats.** `KeysSession.handleKey` returns nothing for a `repeat`
  event, and the protocol's flag 2, which `field keys` sets, reports
  them.
- **The status line.** #195 added `bend` and `mod`. The bend prints
  with a sign and fixed decimal places so the notes do not move; `mod`
  prints 0 to 127 unpadded.
- **What a take keeps.** Before the start, the daemon drains MIDI
  arrivals and discards them (`Player` in `native/audiod/src/player.cpp`,
  and `stampMidiBlock` drops any `at` below 0). `field record` polls
  status every 250 ms and learns of a start from it.
- **SuperCollider 3.14.1.** `Symbol.kr(val, lag, fixedLag, spec)` calls
  `NamedControl.kr`, which stores the spec under the SynthDef's
  `metadata[\specs]`. `ControlSpec.map` applies the warp, then rounds
  to `step`, which is the formula in §2.2.
- **The sound controllers.** General MIDI 2 adopts the MIDI 1.0 sound
  controller defaults: 71 resonance, 72 release time, 73 attack time,
  74 brightness, which synths use for cutoff, and 75 to 78 decay and
  vibrato.
