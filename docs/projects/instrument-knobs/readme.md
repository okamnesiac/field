---
status: ready
priority: next
---

# Instrument knobs

**Goal:** `field keys` becomes a MIDI controller with knobs. It reads
an instrument's knobs from a knob file and shows them on a line of
their own. You choose a knob with the left and right arrows, turn it
with up and down, faster the longer you hold, or type its value on the
number row. Every change leaves as a plain MIDI controller message
that any instrument can answer and every take you record keeps.

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
Reviewing this plan in #202, he asked for two more things. The keymap
should leave keys `1` and `2` alone too, so that the number row can
type a knob's value. And the knobs should belong to `field keys` as a
MIDI controller, so that they drive any MIDI instrument, not only a
SuperCollider one.

## 2 Solution

`field keys` gains knobs the way a hardware controller has them. A
*knob file*, a small YAML file, describes an instrument's knobs: each
one's name, the MIDI controller (CC) that turns it, and its range,
curve, step, units, and default. A SuperCollider instrument keeps its
knob file beside its program. Any other instrument, such as a hardware
synth or an instrument in Logic, gets a knob file that you name with
`--knobs`. `field keys` reads the files once, in TypeScript, puts the
modulation wheel first as the knob `mod`, and works only from that
list. Three keymap actions choose a knob (`knob`), turn it (`turn`),
and type a character of its value (`type`). `musical`, Field's
adaptation of Logic's Musical Typing, replaces `musical-typing` as the
default keymap: the arrows choose and turn, the number row types, and
the pitch bend moves to `,` and `.`. Holding a turn key turns faster
the longer you hold it, and a typed value glides to its target at a
speed the keymap sets. Everything a knob does leaves `field keys` as
control changes on `Field Keys`, so a take records it and any
instrument can answer it. A SuperCollider instrument answers through
the voicer, which hands each controller to its voices as a control
named for its number, as it already hands the wheel over as `mod`. The
instrument maps that control to its own parameter, as a hardware synth
maps a controller to its own. A knob line between the instrument's line
and the status line shows every knob. Last, a take starts with the knob
positions you had: `field keys` publishes the controllers it has sent,
`field record` passes them to the daemon when it arms, and the daemon
writes them at the take's first sample.

### 2.1 What happens when you turn a knob

1. In `examples/bloom`, you run `field keys juno`. `field keys`
   resolves `juno` to `shared/instruments/juno.scd`, reads
   `juno.knobs.yaml` beside it, and checks it before the voice host
   starts (§2.2). It loads `musical`, builds its knob list, `mod` and
   then `juno`'s knobs in the file's order, and draws the knob line
   with `mod` chosen. A knob you have not changed shows its default.
2. You press `ArrowRight`, bound to `{ knob: 1 }`. The choice moves to
   `cutoff`. Nothing is sent.
3. You hold a chord and press `ArrowUp`, bound to `{ turn: 1 }`.
   `field keys` moves `cutoff`'s controller value one step up and sends
   CC 74 with it on the keymap's channel. Before the first change, the
   value it moves from is the default, unmapped to 0 to 127 and
   rounded.
4. The voicer in the voice host stores CC 74 and sets `cc74`, from 0 to
   1, on every sounding voice. `juno` maps `cc74` through the range in
   its knob file to its filter's cutoff (§2.4). The chord's filter
   opens, and every new voice starts with it.
5. You keep holding `ArrowUp`. The knob turns again every 40 ms, more
   steps at a time the longer you hold (§2.6), and stops at the top of
   its range or when you release the key.
6. Still holding the chord, you type `800`. The knob line shows
   `cutoff  800_ Hz`, and the chord keeps sounding. You press `Enter`.
   The controller value nearest 800 Hz is 62, which maps to 810 Hz, and
   `field keys` glides CC 74 there over about half a second (§2.7).
7. You save `juno.knobs.yaml`. `field keys` checks it, takes the new
   list, keeps each controller's value, and keeps the choice on the same
   knob by name. It then reloads `juno`'s voice, as a save of `juno.scd`
   does (keyboard-instrument.md §14), because the voice maps its
   controls from the file. A save that fails the check changes only the
   status line.
8. You press `Ctrl-C` to quit. Knob positions last only for the
   session.

Without an instrument, `field keys --knobs ~/knobs/ju-06a.yaml` does
steps 2 to 6 for whatever listens to `Field Keys`, such as a hardware
synth or an instrument in Logic, which answers the same controller
messages in its own way. A take records each change you make during
it, and its render plays the changes back through the instrument; §2.8
makes the take start where your knobs were before it.

### 2.2 A knob file describes an instrument's knobs

```yaml
# shared/instruments/juno.knobs.yaml
knobs:
  - { name: cutoff, cc: 74, min: 50, max: 15000, curve: exp, units: Hz, default: 2000 }
  - { name: res, cc: 71, min: 0, max: 0.95, curve: lin, default: 0.3 }
  - { name: attack, cc: 73, min: 0.005, max: 4, curve: exp, units: s, default: 0.8 }
  - { name: release, cc: 72, min: 0.02, max: 8, curve: exp, units: s, default: 1.5 }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | Required | Shown on the knob line. |
| `cc` | Required | The controller that turns the knob. |
| `min`, `max` | 0 and 127 | The knob's range. A turn stops at its ends, and a typed value clamps to them. |
| `curve` | `lin` | How the controller's 128 values spread over the range: `lin` evenly, `exp` by equal ratios. |
| `step` | 0 | The quantum the knob's values round to; 0 for none. |
| `units` | None | Shown after the value, and the units a typed value is in. |
| `default` | `min` | The value the instrument starts at, which the knob shows until you change it. |

The list's order is the knob line's order. A controller value `v` from
0 to 127 means `min + (max - min) * v / 127` on a `lin` knob and
`min * (max / min) ** (v / 127)` on an `exp` knob, rounded to `step`.
That is SuperCollider's `ControlSpec.map` for its warps of the same
names, so a SuperCollider instrument that maps with `ControlSpec` agrees
with what `field keys` shows.

**The instrument sets each knob's range.** The knob file belongs to the
instrument, beside its program, and `min` and `max` are its range.
`field keys` never turns a knob past them.

A zod schema, `src/schema/knobs.ts`, is the one check of a knob file,
and every path that hands a file to an instrument runs it first. A file
that fails stops `field keys` at start with its errors, as a keymap
does, before the voice host starts. A save that fails keeps the last
good list, names the error on the status line, and reloads no voice. A
take's render runs the same check in its `validate` and fails with the
schema's errors. `field check` already validates every record entry's
instrument through that `validate`, so it reports the same errors
first, and the check and the build share one rule, as they do for the
program. §2.4 says how a SuperCollider voice reads only a file that
passed. The rules:

- **The controller is free.** It is from 2 to 119, and not 6, 32, 38,
  64, or 96 to 101. Those are bank select (0 and 32), data entry,
  sustain, and the parameter-number controllers; 1 is the wheel, which
  is the knob `mod`; and 120 to 127 are channel mode messages.
- **No name or controller appears twice** in one file, and no knob is
  named `mod`.
- **An `exp` range does not touch or cross zero.** `min` and `max` are
  non-zero and of one sign, as an exponential curve needs:
  `ControlSpec(0, 1, \exp)` maps every controller value above 0 to
  `nan`.
- **`min` and `max` differ, and `default` is inside the range, ends
  included.** `bass`'s attack default, 0.005, is the bottom of its
  range.

`field keys` finds knob files two ways:

| You give | `field keys` reads |
| --- | --- |
| An instrument, or a track whose record entry names one | `<program>.knobs.yaml` beside the program, when it exists: `juno.knobs.yaml` for `juno.scd`. An instrument without one has no knobs but `mod`. |
| `--knobs <name or path>` | A bare name is `shared/instruments/<name>.knobs.yaml` in the project. A value with a `/`, or ending in `.yaml`, is a path, and a leading `~/` means your home directory. Repeat the flag for more than one file. |

The knob list is `mod`, then each armed instrument's knobs, then each
`--knobs` file's. `field keys` watches each file as it watches a keymap
given by path, so a save applies at once. `juno` and `bass` each get a
knob file with the four knobs above; `bass`'s defaults are 1200, 0.4,
0.005, and 0.15. `pad` gets none. The numbers follow General MIDI 2's
defaults for the sound controllers (71 resonance, 72 release, 73
attack, 74 cutoff), so a hardware controller set up for General MIDI 2
turns the same knobs. Controllers 20 to 31 and 102 to 119 have no
assigned meaning and suit the rest.

### 2.3 The keymap chooses, turns, and types

| Action | Effect |
| --- | --- |
| `{ knob: <n> }` | Moves the choice n knobs to the right, or to the left when n is negative, wrapping past either end. Sends nothing. |
| `{ turn: <n> }` | Turns the chosen knob n steps up, or down when n is negative, at the press, and keeps turning while the key is held (§2.6). |
| `{ type: <c> }` | Types c into an entry for the chosen knob's value (§2.7). c is a digit written as a number from 0 to 9, as YAML reads `type: 1`, or the string `"-"`. The decimal point is not an action: `Period` types it while an entry is open (§2.7). |

The schema takes n as a non-zero integer. A step is one controller
value. For a knob with a `step`, a step is the next controller value
that maps to a different value, so a knob with two positions moves in
one press. A turn stops at 0 and at 127. Pressing a second turn key
while one is held turns with the second and stops the first.

A keymap gains one field:

| Field | Default | Meaning |
| --- | --- | --- |
| `glide` | 0 | The seconds a typed value takes to cross the knob's whole range; a shorter move takes its share. 0 sets the value at once. |

`keymaps/musical-typing.yaml` becomes `keymaps/musical.yaml`. It keeps
its `base` and `notes`, so every note sits where Musical Typing puts
it, and gains `glide: 1` and these controls:

```yaml
controls:
  KeyZ: { transpose: -12 }
  KeyX: { transpose: 12 }
  KeyC: { velocity: -20 }
  KeyV: { velocity: 20 }
  Comma: { bend: -1 }
  Period: { bend: 1 }
  Tab: { cc: 64, value: 127, mode: hold }
  ArrowLeft: { knob: -1 }
  ArrowRight: { knob: 1 }
  ArrowUp: { turn: 1 }
  ArrowDown: { turn: -1 }
  Digit1: { type: 1 }
  # Digit2 to Digit9 the same
  Digit0: { type: 0 }
  Minus: { type: "-" }
```

- **It is the default,** and the only built-in keymap drawn from
  Logic's. `--keymap musical-typing` fails, as any unknown bare name
  does, with a message that lists the built-ins. `docs/keys.md` shows
  Logic's number row, the bend on `1` and `2` and the wheel's steps on
  `3` to `8`, as controls to copy into a keymap of your own.
- **The bend moves to `,` and `.`,** the keys that show `<` and `>`:
  down on `Comma` and up on `Period`, held as before. Neither plays a
  note in Musical Typing, and neither is an arrow or a typing key.
  While an entry is open, `Period` types the decimal point instead
  (§2.7).
- **The wheel's steps go.** The wheel is the knob `mod`, which the
  arrows turn and the number row types.
- **`tracker` and `fourths` do not change** (§7 question 2).

`field keys --print` tags the actions `K-1`, `K+1`, `R+1`, `R-1`, and
each typing key with its character, and describes each in its list of
controls.

### 2.4 The instrument answers the controllers

Only control changes leave `field keys`. Each instrument answers them
in its own way, as it would answer a hardware controller's knobs:

- **A hardware synth or an instrument in Logic** maps each controller
  itself, through its own MIDI implementation or Logic's controller
  assignments. Its knob file only tells `field keys` what to show. If
  the file's range is wrong, the line shows the wrong number and the
  sound is unchanged.
- **The voicer hands every controller to the voices.** It already keeps
  the wheel's last value and gives it to each voice as `mod`. It does
  the same for every controller from 2 to 119 except sustain (64): it
  keeps each one's last value, one value per controller for every
  channel, and gives it to new voices and to sounding voices as a
  control named for its number, `cc74`, from 0 to 1. `scsynth` ignores
  a control a voice lacks. This is the voice host's MIDI
  implementation. It is the same for every instrument and every MIDI
  source, and it knows nothing about knobs.
- **A SuperCollider voice maps its own controls, from a file Field
  checked.** In voice mode, `FIELD_KNOBS` names a copy of the
  instrument's knob file that Field wrote after the file passed the
  schema, and is unset when the instrument has none. `field keys`
  writes a new copy only when a save passes, before it reloads the
  voice. A take's render writes the copy it checked beside its events
  file. So the voice never reads a file Field rejected, whether it loads
  at start, on a reload, or in a render, and a program saved while its
  knob file fails loads with the last good copy. `voice-load.scd` sets
  `FIELD_KNOBS` for each program from the copy Field names for it, as
  it already sets each program's own path. `juno`'s voice reads the
  copy with sclang's `parseYAMLFile` and maps each knob's control
  through a `ControlSpec` built from it, so its ranges are written once
  (§3.2 gives the alternative):

  ```supercollider
  var knobs = "FIELD_KNOBS".getenv.parseYAMLFile["knobs"];
  var knob = { |name|
      var each = knobs.detect { |knob| knob["name"] == name };
      var spec = ControlSpec(each["min"].asFloat, each["max"].asFloat, each["curve"].asSymbol);
      spec.map(("cc" ++ each["cc"]).asSymbol.kr(spec.unmap(each["default"].asFloat), 0.05))
  };
  ```

  `k[\vcfFreq] = knob.("cutoff")` then puts the knob in place of the
  constant. `parseYAMLFile` returns every number as a string, so the
  helper converts each field, and it reads every field, so `juno`'s and
  `bass`'s files spell each one out rather than lean on the defaults.
  The lag smooths the steps between controller values.
  A knob must be a value the graph uses as a signal; a setting that
  decides the graph's shape, such as `juno`'s `chorusOn`, stays a
  constant. The render branches keep their constants and their bytes.

A take's render runs the same voicer in `sc/voice-render.scd`, so the
controller messages in a take reach the voice as they did live. The
knob file is now part of how a take sounds, so it becomes one of the
render's cache inputs when it exists, and a render refuses to cache
when the file changed while it ran, as it refuses for the program. A
hardware controller's knob that sends CC 74 turns `juno`'s cutoff too,
because to the voicer it is the same controller.

### 2.5 `field keys` shows the knobs

```console
$ field keys juno
juno live at 48000 Hz on MacBook Pro Speakers
mod   0  cutoff 2.00 kHz  res 0.300  attack  800 ms  release  1.50 s
Field Keys · musical · transpose 0 · velocity 100 · bend +0 · C4 E4 G4
```

The knob line sits between the instrument's line and the status line.
`field keys` redraws it in place when its text changes, as it redraws
the instrument's line.

- **It appears when the keymap binds a knob action.** The status line
  then leaves out its `mod` field, because the knob line shows the
  wheel. A keymap without knob actions keeps today's status line.
- **The chosen knob is in reverse video.** Reverse video takes no
  columns, so moving the choice moves nothing.
- **A value keeps its width.** An `exp` knob prints three significant
  digits, in thousands with `k` from 1000 up (`2.00 kHz`) and, for a
  knob in seconds, in thousandths with `m` below 1 (`800 ms`). A `lin`
  knob prints the decimal places that give the end of its range
  farthest from zero three significant digits, so `res`, whose range
  ends at 0.95, prints `0.000` to `0.950`. `mod`, and a knob whose step
  is whole, print whole numbers. Units follow after a space. Each value
  is padded on the left to the widest that its default or any of its
  128 controller values prints. The places are fixed per knob, as the
  bend's are per keymap.
- **A glide shows as it moves.** The value runs to its target at its
  fixed width.
- **An entry takes the value's place.** While you type (§2.7), the
  chosen knob shows what you have typed, then `_`, then the units,
  padded to the value's width: `cutoff  800_ Hz`. An entry longer than
  that widens the knob until the entry closes, which moves only the
  knobs after it.
- **A narrow terminal shows a window of whole knobs.** The window holds
  the chosen knob, and `‹` or `›` marks an end where knobs are hidden.
  The window moves only when the choice leaves it, so turning never
  scrolls it.
- **Several sources name their knobs.** With more than one armed
  instrument or knob file, each knob after `mod` carries its source's
  name: the track's, the program's, or the knob file's without its
  `.knobs.yaml`, as in `keys.cutoff`. Two knobs on one controller share
  one value, and each shows it through its own range.
- **Values are what `field keys` sent.** A hardware controller's knob
  moves the voice but not the line, as with the bend and the wheel
  today.

The notes are on the status line, so nothing on the knob line, whether
a turn, a glide, an entry, or a scroll, moves them.

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

### 2.7 Typing a value

In `musical` the number row types; it plays no notes and sends nothing
until you complete an entry.

1. **The first typing key opens an entry** on the chosen knob. The
   entry holds digits, at most one `.`, and a `-` only as its first
   character; a key that would break that does nothing. `Period` types
   the `.` while an entry is open, in every keymap; with no entry open
   it does what the keymap binds there, which in `musical` is the bend
   up. So `.` cannot open an entry: type `0.5`, not `.5`. Typing keys
   are positions, as every key in a keymap is (keyboard-instrument.md
   §2.3): `.` and `-` are where QWERTY has them, whatever your layout
   prints there. The numeric keypad does not type, because its keys
   are not positions a keymap binds.
2. **You type in the knob's units,** the ones its knob file names:
   `2000` for 2 kHz on `cutoff`, and `0.8` for 800 ms on `attack`. `mod`
   takes 0 to 127. The entry shows the units as you type.
3. **`Enter` completes the entry.** `field keys` clamps the number to
   the knob's range, ends included, and takes the controller value
   whose mapped value is nearest: `800` on `cutoff` is 62, which maps to
   810 Hz; `99999` is 127, 15.0 kHz; and `20` is 0, 50.0 Hz. An entry
   with no digit completes nothing.
4. **The knob glides there.** With `glide` above 0, `field keys` moves
   the controller toward its target at `127 / glide` steps a second,
   sending one control change on each 40 ms tick, so a glide too sends
   at most 25 a second and its last tick lands on the target. With
   `glide: 0` it sends the target at once. In `musical`, a glide across
   the whole range takes one second, and 15.0 kHz to 810 Hz takes half
   a second.
5. **A knob action completes the entry first.** `ArrowLeft` or
   `ArrowRight` completes it and then moves the choice. `ArrowUp` or
   `ArrowDown` completes it and then turns, which stops the glide it
   started (below).
6. **`Backspace` deletes the last character,** and closes an empty
   entry.
7. **`Esc` cancels the entry** and leaves the knob as it was.
8. **Every other key acts as it does without an entry,** and the entry
   stays open: notes play, and the octave, velocity, sustain, and bend
   keys work, except that `Period` types. An entry has no timeout. A
   keymap reload, or a knob file reload that removes the knob, closes
   it without completing it.

A glide runs on its own, and each knob can have one:

- **Notes, the other controls, and the choice leave it alone.** Moving
  to another knob and typing there starts that knob's glide beside it.
- **A new entry on the gliding knob** leaves the glide running while
  you type. Completing it starts a new glide from where the knob is.
- **A turn of the gliding knob stops the glide** where it is and turns
  from there.
- **A panic, a keymap reload, and quitting stop every glide** where it
  is.

`Enter` and `Backspace` act only on an entry and otherwise do nothing.
Like `Esc`, they are not positions a keymap binds. `Period` is the one
key with a meaning of each kind: the entry's decimal point while an
entry is open, and the keymap's action otherwise. A `Period` press that
began a bend still ends it on release, even if an entry opened while
the key was held.

With no entry open, `Esc` no longer quits: it puts `Ctrl-C quits` on
the status line, and `Ctrl-C` is how you leave, in every keymap.
`isQuit` in `src/keys/terminal.ts` quits on `Ctrl-C` alone, and a
keymap still cannot bind `Esc`.

### 2.8 A take starts where your knobs are

A take records only what arrives after it starts
(keyboard-instrument.md §14.5). Without this step, a take renders with
every knob at its default until you change it during the take. Three
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
   writes one line per channel and controller at `at: 0`, ahead of
   every other line, in each MIDI take of the pass. It writes the
   seeded values first and the rest in the order their values last
   arrived. The voicer keeps one value per controller for every
   channel, so a render then starts on the value the voice last heard.
   The render applies these rows before a note at 0, because
   `renderEvents` already puts control changes before note-ons at one
   instant.

All of it is MIDI, so it serves any source: a hardware knob moved after
the arm starts the take where it was too. It also closes
keyboard-instrument.md §14.5's gap for the wheel.

### 2.9 Files

| File | Change |
| --- | --- |
| `src/schema/knobs.ts` (new) | The knob file's schema and the rules in §2.2. |
| `src/keys/knobs.ts` (new) | Finds an instrument's knob file and resolves `--knobs`; reads and watches knob files; maps between a controller value and a value; finds the next step of a stepped knob and the controller value nearest a typed value; and prints a value at its width. |
| `src/schema/keymap.ts` | The `knob`, `turn`, and `type` actions, the `glide` field, and the reserved `Escape`'s message, which says it cancels a typed value. |
| `keymaps/musical-typing.yaml` → `keymaps/musical.yaml` | Renamed, with the controls in §2.3 and `glide: 1`. |
| `src/keys/keymap.ts`, `src/cli.ts` | `DEFAULT_KEYMAP` is `musical`. `field keys` takes `--knobs`, and its help says `Ctrl-C` quits. |
| `src/keys/terminal.ts` | `isQuit` quits on `Ctrl-C` alone. |
| `src/keys/position.ts` | Resolves `Enter` and `Backspace`, which the terminal reports as `CSI 13 u` and `CSI 127 u`, as keys a keymap cannot bind. |
| `src/keys/session.ts` | The controllers it has sent, by number, which the `mod` field and `setsMod()` become reads of; the knob list and the choice; a held turn, the entry, and each glide, advanced by `tick(now)`. |
| `src/keys/print.ts` | The tags and descriptions of the three actions. |
| `src/commands/keys.ts` | The knob line; the timer that ticks turns and glides; `--knobs`; checking each instrument's knob file and writing the copy its voice reads, in a directory of its own that it removes on exit, before the host starts and before each reload, and reloading nothing after a save that fails; `Esc` cancelling an entry or naming `Ctrl-C`; and `.field/keys.json` (chunk 3). |
| `src/keys/voice-host.ts` | Passes each program in `FIELD_INSTRUMENTS` with the path of its knob copy, if it has one. |
| `sc/voicer.scd`, `sc/voice-host.scd`, `sc/voice-render.scd`, `sc/voice-load.scd` | The voicer keeps every controller from 2 to 119 except 64 and hands it to voices as `cc<n>`; the host and the render pass those values into each new synth. The loader sets `FIELD_KNOBS` for each program from the copy Field names for it. Nothing here reads or checks a knob file. |
| `src/generators/voice-render.ts` | Its `validate` checks the instrument's knob file with the schema, so a failing file stops the render before `sclang` runs, and `field check`, which validates each record entry's instrument through this `validate`, reports the same errors. It writes the copy it checked beside the events file and names it in `FIELD_KNOBS`. The file is a cache input, and `verifyAfterRun` refuses to cache when it changed during the render. |
| `examples/bloom/shared/instruments/juno.knobs.yaml`, `bass.knobs.yaml` (new); `juno.scd`, `bass.scd` | The knob files, and voices that map `cc<n>` through them. The render branches keep their code and their bytes, and `bass.scd`'s comment names `musical`. |
| `src/commands/record.ts`, `src/audiod/protocol.ts`, `src/audiod/client.ts` | Read `.field/keys.json` and pass `controllers` in `arm` (chunk 3). |
| `native/audiod/src/player.cpp`, `player.h`, `server.cpp` | The chase: seeded from `arm`, updated before the start, written at the start; and the `midi-chase` feature (chunk 3). |
| `docs/keys.md` | `musical` as the default, with Logic's number row to copy; knob files and `--knobs`; turning and typing a knob, and the glide; `Ctrl-C` as the way to quit in "Play", the default keymap's table, and "Rules"; the `cc<n>` controls and `FIELD_KNOBS`, the checked copy of the knob file a voice reads, under "Make an instrument playable"; and how a take starts (chunk 3). |
| `docs/build-graph.md` | The voice contract gains the `cc<n>` controls and `FIELD_KNOBS`, and the knob file joins a take's render inputs. |
| `docs/audio-engine.md`, `docs/project-model.md` | The chase, and the rows it puts at a take's start (chunk 3). |
| `docs/projects/keyboard-instrument/readme.md` | Dated notes at §2.4's rule that `Escape` always quits and at §3's choice of Musical Typing as the default, each pointing here. |

## 3 Why this design (DECIDED, 2026-10-11, Justin's review of #202)

Justin reviewed this plan in #202, accepted its design, and made the
calls in §3.1. The largest is that the knobs belong to the controller.
§3.2 records the calls his answers needed, for his review.

- **A knob is a MIDI controller, not an OSC message to the voice
  host.** A take holds only the MIDI that the daemon captures and
  stamps (keyboard-instrument.md §3), so a knob sent by OSC would never
  reach a take. As a controller, a change is captured, landed, and
  rendered by code that exists, as the wheel is, and any instrument
  that answers MIDI answers it. The cost is 128 steps per knob, which
  a voice's lag smooths.
- **The instrument names each knob's controller.** Field could number
  knobs from a pool in the order they are listed. A take stores
  controller numbers and renders again whenever its instrument
  changes, so reordering the knobs would make every old take turn the
  wrong ones. A named number is the knob's address, as on a hardware
  synth's MIDI chart.
- **Only `lin` and `exp`.** `field keys` draws each value itself, and
  a SuperCollider voice maps with `ControlSpec`'s warps of the same
  names, so the two agree. Two curves cover a frequency, a time, and a
  level, and a voice that wants another can shape a `lin` knob inside
  its graph.
- **The wheel is the first knob.** It is the one continuous control any
  instrument may answer, so every control you can set sits on one line,
  and `field keys` with no knob file still sets something.
- **`field keys` times a hold.** The kitty protocol gives it every
  release, so a hold is an exact interval. The terminal's repeat
  follows the operating system's typing setting, which can be slow or
  off and differs over SSH. Repeat events stay ignored, so every other
  held key still acts once (keyboard-instrument.md §2.2).
- **The knobs get a line of their own.** The status line keeps the
  notes last so that playing never moves them (keyboard-instrument.md
  §2.4). A separate line shows every knob by name, and nothing on it
  can move the notes.
- **The daemon writes the starting positions, seeded from
  `field keys`.** Rejected: `field keys` resending its controllers when
  the daemon arms, which needs a daemon connection of its own and races
  a take that starts at once. Rejected: knob positions saved on the
  track, which would start each take where the last take left the
  knobs. Rejected: waiting for arming.md chunk 3's lasting arm, which
  opens the MIDI inputs only from the moment you arm.
- **Not automation.** [automation.md](../automation/readme.md)
  describes curves written in project YAML. A knob turned while you
  play belongs to the performance, like the wheel, so it rides in the
  take.

The plan extends what exists rather than building beside it: the
voicer's path for the wheel, which `cc<n>` generalizes; the take's
`controls` rows and the order `renderEvents` gives them; the session's
controller tracking from #195; keymap watching; and the instrument
line's redraw. It replaces the session's `mod` field and `setsMod()`
with reads of one controller map, and `musical-typing` with `musical`.

### 3.1 Justin's calls (DECIDED, 2026-10-11, Justin)

- **The knobs belong to the controller.** Choosing, turning, typing,
  gliding, keeping each knob's value, and the knob line are
  `field keys`' work. Only control changes leave it, so the knobs drive
  Logic, a hardware synth, or an AU instrument as they drive `juno`, and
  a hardware controller's knobs turn `juno` as they turn any synth. No
  knob logic runs in SuperCollider. This replaces the plan's first
  version, which declared knobs in the SynthDef's metadata, reported
  them from the voice host, and mapped controllers to controls in
  `voice-load.scd`.
- **Every instrument describes its knobs one way,** whatever makes its
  sound (§3.2 says which way).
- **A keymap of its own, `musical`, with the number row for typing.**
  The name is a wink to Musical Typing that does not copy it. A value
  far from where a knob sits is one entry rather than a long hold.
  Rejected: adding the arrows to `musical-typing` and keeping keys `1`
  to `8`, which left no room to type.
- **`Enter` completes an entry and `Esc` cancels it.** `Esc` no longer
  quits; with no entry open it says that `Ctrl-C` quits. This amends
  keyboard-instrument.md §2.4's rule that `Escape` always quits. Its
  purpose holds: no keymap can trap you, because `Ctrl-C` always quits
  and no keymap binds `Esc` or a `Ctrl` chord.
- **The instrument sets each knob's range,** in its knob file.
- **The bend moves to `,` and `.`,** down and up, because those keys
  show `<` and `>`. This replaces this plan's earlier `B` and `N`.
- **A typed value moves at a speed you set,** rather than jumping.

### 3.2 Calls made here (DECIDED, 2026-10-11, for Justin's review)

- **One knob file format for every instrument, which only Field
  checks.** One zod schema in TypeScript checks every file, on every
  path that hands one to an instrument (§2.2). Rejected: knobs declared
  in the SynthDef's metadata, as the first version had. It keeps a
  SuperCollider program free of drift, but Field would need `sclang` to
  learn any knob, would carry SuperCollider code that knows the
  convention, and would read two formats. A knob file can still drift
  from an instrument that ignores it, such as a hardware synth's file
  written by hand. Then the line shows the wrong number and the sound is
  unchanged, which is the hardware controller's trade too.
- **A SuperCollider voice reads the copy Field checked, so each range is
  written once.** Justin has not ruled on this, and the choice is his.
  The alternative is that each program writes its own mapping, as in
  `ControlSpec(50, 15000, \exp).map(\cc74.kr(0.647, 0.05))`, so each
  range is written twice: once in the knob file, which `field keys`
  shows, and once in the program, which makes the sound. That needs no
  `FIELD_KNOBS`, no copies, and no knob file anywhere near
  SuperCollider. Its cost is drift: when the two disagree, the knob line
  shows a value the voice is not playing, and nothing reports it, as
  with a hardware synth whose knob file is wrong. Reading the checked
  copy costs the copies and `FIELD_KNOBS`, and in return a range cannot
  drift. The recommendation is the copy, because `juno` and `bass` are
  Field's own and are written alongside their knob files.
- **Knob files sit beside the program, or come from `--knobs`.** A
  knob file belongs to the instrument, so it sits where the instrument
  does and resolves the way an instrument does. Rejected: a field in a
  keymap, because a keymap belongs to the player and works with any
  instrument (keyboard-instrument.md §3). Rejected: a field in a track
  file, because a track already names its instrument.
- **The voicer hands every controller over as `cc<n>`, from 0 to 1.**
  It is what the voicer already does for the wheel. Rejected: the
  voicer mapping through the knob file, which is knob logic in
  SuperCollider. Rejected: each instrument answering MIDI itself,
  which would have every instrument rebuild the voicer.
- **`musical` replaces `musical-typing`.** Field's built-ins are its
  adaptations, each with a name of its own, and an exact copy of
  Logic's beside it would make two defaults to choose between. Anyone
  who wants Logic's number row copies its controls from
  `docs/keys.md`. This amends keyboard-instrument.md §3, which chose
  Musical Typing as the default because Logic and Ableton Live users
  already know it, and because it leaves the number row free for the
  bend and the wheel. `musical` keeps what those users know, the notes
  and the octave and velocity keys. It gives the number row to typing,
  moves the bend to `,` and `.`, and makes the wheel a knob. Rejected:
  keeping `musical-typing` beside it. When `tracker` and `fourths` are
  adapted, the proposed names are `tracked` and `quartal`.
- **`Period` types the decimal point only while an entry is open.**
  The bend up now sits on `Period`, which the decimal point used. The
  key prints `.`, and a decimal point means something only inside an
  entry, so the key types it there, as `Enter` and `Backspace` act only
  on an entry. The cost is that `.` cannot open an entry, so you type
  `0.5`, and that the bend up waits while an entry is open. Rejected:
  moving the decimal point to a free key such as `=` or `/`, which
  prints no `.`, so every fraction would mean remembering where it went.
  Rejected: a second, entry-only action for any position, such as an
  `entry:` map in the keymap, which is a second way to bind a key for
  the sake of one key.
- **`glide` is a keymap field: seconds to cross a knob's whole range.**
  How a typed value moves is how you play, like the keymap's starting
  `velocity`, not a property of the instrument. A time for the whole
  range is a speed you can picture, on the same scale as a held turn's
  2.3 seconds. The schema's default, 0, sets a value at once, so a
  keymap that never mentions glides behaves as typing does elsewhere.
  `musical` sets 1, because it is the keymap built for knobs and Justin
  asked for typed values to move. Rejected: a field in the knob file,
  and a command-line flag, which adds a second place to set it.
- **A glide is a run of control changes.** A take records it and any
  instrument answers it. Rejected: a glide inside the instrument, such
  as a longer lag, which a hardware synth cannot be told and a take
  could not hold.
- **Typing keys are actions, not a keymap flag.** A `type` action per
  key keeps one rule, that a position maps to an action, so the
  schema's checks and `--print` cover typing keys with no new case.
  Rejected: a flag such as `typing: true` that claims the number row.
- **You type in the knob file's units.** The unit on the line moves
  with the value (`810 Hz`, then `2.00 kHz`), so typing in it would
  make `2` mean 2 Hz or 2 kHz depending on where the knob sits. A
  suffix such as `k` cannot be typed, because letters are notes.
- **A value outside the range clamps.** A turn stops at the ends too,
  and the line shows where the value landed. Rejected: refusing it,
  which would hold the entry open with nowhere to say why.
- **An entry closes only when you close it.** A knob action completes
  it first, as a spreadsheet completes a cell when you move off it.
  Rejected: a timeout, which would complete a number you stopped in the
  middle of to play, or throw it away.
- **A typed value lands on a step.** The controller carries 128 steps,
  so `field keys` sends the nearest and shows it, rather than showing
  the number you typed and playing another.

## 4 Acceptance criteria

Run these in `examples/bloom`, in Ghostty or iTerm2. The monitor is
`native/audiod/build/field-audiod_artefacts/Release/field-audiod
--midi-monitor "Field Keys"`, run from the Field checkout in another
terminal.

| # | Do | Expect |
| --- | --- | --- |
| 1 | Run `field keys juno`. | The status line names `musical` and has no `mod` field. The knob line reads `mod   0  cutoff 2.00 kHz  res 0.300  attack  800 ms  release  1.50 s`, with `mod` in reverse video. |
| 2 | Press `ArrowRight`, and hold `ArrowDown` until `cutoff` stops at `50.0 Hz`. Hold a chord, hold `ArrowUp` for three seconds, then tap `ArrowDown`. | The chord's filter opens, slowly and then faster, and `cutoff` stops at `15.0 kHz` about 2.3 seconds after the press; the tap drops it one step. Nothing after `cutoff` moves, and the notes stay where they were. |
| 3 | With `mod` chosen, press `ArrowLeft`. | `release` is chosen. |
| 4 | With `cutoff` at `15.0 kHz`, hold a chord, type `800`, and press `Enter`. | While you type, the knob reads `800_ Hz` and the chord keeps sounding. After `Enter`, the value runs down to `810 Hz` in about half a second, and the filter closes with it. |
| 5 | On `cutoff`, type `99999` and press `Enter`; then type `20` and press `Enter`. | `15.0 kHz`, then `50.0 Hz`. |
| 6 | On `cutoff`, type `12`, press `Backspace`, type `5`, and press `Esc`. Press `Esc` again, then `Ctrl-C`. | The entry reads `15_ Hz`. The first `Esc` closes it and leaves `cutoff` as it was. The second puts `Ctrl-C quits` on the status line, and `field keys` keeps running. `Ctrl-C` quits. |
| 7 | On `cutoff`, type `300` and press `ArrowRight`. | `cutoff` glides to `301 Hz`, and `res` is chosen. |
| 8 | Type `15000` on `cutoff` at `50.0 Hz`, press `Enter`, and press `ArrowUp` while it glides. | The glide stops, and `cutoff` turns one step up from where it stopped. |
| 9 | Hold `.` over a held note, then release it; then hold `,`. | The note bends up two semitones and returns, and the status line shows `bend +1`, then `bend +0`; `,` bends it down to `bend -1`. |
| 10 | Run `field keys --keymap musical-typing`. | Exit 1. The message lists `musical`, `tracker`, and `fourths`. |
| 11 | With `cutoff` changed and chosen, delete the `attack` and `release` lines from `juno.knobs.yaml` and save. Then change `res`'s `cc` to 1 and save. | The line shows `mod`, `cutoff`, and `res`, and `cutoff` keeps its value and stays chosen. After the second save, the status line names the error, the knobs stay as they were, the voice is not reloaded, and turning `res` still changes the sound. |
| 12 | Write `~/knobs/test.yaml` with juno's `cutoff` line alone. Start the monitor, run `field keys --knobs ~/knobs/test.yaml`, choose `cutoff`, hold `ArrowUp` for a second, then type `800` and press `Enter`. | The monitor shows CC 74 rising, never more than 25 in one second, then a run of CC 74 values that ends at 62. No instrument runs: this is what Logic or a hardware synth would receive. |
| 13 | With `field keys juno` running, turn a USB controller's knob that sends CC 74. | `juno`'s filter moves, and the knob line does not. |
| 14 | Run `field keys pad`, type `64`, and press `Enter`. | The knob line shows `mod` alone, and it reads `64`. |
| 15 | Run `field keys juno --keymap tracker`. | No knob line, and today's status line. |
| 16 | Narrow the terminal to 40 columns, press `ArrowRight` past the last knob shown, then turn it. | The window moves to show it, with `‹` at the left. Turning does not move the window. |
| 17 | Give `creek` a track `keys` with `instrument: juno` and a track `bass` with `instrument: bass`. Run `field keys creek/track:keys creek/track:bass`, choose `keys.cutoff`, and turn it. | Both instruments' filters move. `bass.cutoff` shows its own value for CC 74. |
| 18 | Record a take on `keys`, sweeping `cutoff` and typing a value during it, then build and play. | The render sweeps and glides where you did. |
| 19 | Run `field sc render shared/instruments/juno.scd --seed 1 --duration 4 --output <file>` before and after the change, and the same for `bass.scd`. Compare each pair with `cmp`. | Identical. A difference means the change touched a render branch. |
| 20 | In one terminal run `field keys juno` and turn `cutoff` down. In another run `field record creek/track:keys --at 17`. Play without touching a knob, stop, build, and play. | The take renders dark from its first note, and the notes file's first `controls` row is `{ at: 0, cc: 74, value: … }`. |
| 21 | Run criterion 20's `field record` with `--count-in 1`, and turn `res` during the count-in. | The take starts with that `res`. |
| 22 | With a take on `keys`, set `cutoff`'s `min` in `juno.knobs.yaml` to 0, then run `field check` and `field build creek`. | `field check` names the knob file's error, and the build fails the take's render with the same error instead of rendering it. Restoring the file renders the take again. |
| 23 | With a note held, choose `attack`, type `0`, `.`, and `8`, and press `Enter`. Then press `.` again. | The entry reads `0.8_ s`, the note does not bend, and `attack` lands on `782 ms`. With the entry closed, `.` bends the note up. |

These vitest tests fail before the change:

- **`src/schema/knobs.test.ts` (new).** Accepts `juno`'s and `bass`'s
  files, and a default at the end of its range. Fills `min`, `max`,
  `curve`, `step`, and `default`. Rejects a repeated name or
  controller, a knob named `mod`, a reserved controller, an `exp` range
  that touches 0, equal `min` and `max`, and a default outside the
  range.
- **`src/keys/knobs.test.ts` (new).** Finds `juno.knobs.yaml` beside
  `juno.scd`, and resolves `--knobs` by bare name and by path. Maps
  controller 62 on `juno`'s `cutoff` to 809.6 Hz, as `ControlSpec.map`
  does, and finds 62 as the value nearest 800. Finds the next step of a
  two-position knob. Prints `2.00 kHz`, `800 ms`, `res` from `0.000` to
  `0.950`, and whole numbers, at one width across each knob's values.
- **`src/schema/keymap.test.ts` and `src/keys/keymap.test.ts`.** Accept
  `knob` and `turn` and reject a zero step and a fraction. Accept
  `type` with a number from 0 to 9 or the string `"-"`, as `musical`
  writes them, and reject `"."`, 10, and any other character. `glide`
  defaults to 0. With no `--keymap` and no `FIELD_KEYMAP`, the keymap
  is `musical`, which binds the arrows, the bend on `Comma` and
  `Period`, and the number row. `musical-typing` is not a built-in.
- **`src/keys/terminal.test.ts` and `src/keys/position.test.ts`.**
  `Esc` is not a quit and `Ctrl-C` is. `CSI 13 u` resolves to `Enter`
  and `CSI 127 u` to `Backspace`.
- **`src/keys/session.test.ts`.** `knob` wraps both ways. `turn` sends
  the knob's controller on the keymap's channel from the default's
  unmapped value, and stops at 0 and 127. Driven by `tick(now)`, a held
  turn moves 1 step at the press, none before 300 ms, then 1, 2, and 4
  steps a tick at the times in §2.6. `Period` types `.` while an entry
  is open and bends otherwise, and a bend it began ends on its release
  even if an entry opened meanwhile. An entry ignores a second `.` and
  a later `-`, deletes on `Backspace`, completes on `Enter` and before
  a knob action, and lets a note play while it is open. With `glide: 1`
  a value from 127 to 62 glides in 13 ticks and lands on 62; a turn
  stops it; a panic stops every glide; with `glide: 0` it is one
  control change. A `cc: 1` key moves `mod`. A new knob list keeps
  values by controller and the choice by name.
- **`src/commands/keys.test.ts`.** The knob line at rest, the chosen
  knob's reverse video, the same length through a turn and a glide, an
  entry in the value's place, the window on a narrow terminal, and the
  status line with and without `mod`. `Esc` with an entry open cancels
  it; `Esc` without one shows `Ctrl-C quits` and does not quit. A
  saved knob file that fails leaves the voice's copy as it was and
  sends no reload; one that passes rewrites the copy before the reload.
- **`src/keys/voice-host.test.ts`, against a stub `sclang`.**
  `FIELD_INSTRUMENTS` carries each program with its knob copy, and a
  program without a knob file with none.
- **`src/keys/print.test.ts`.** The `musical` diagram matches a stored
  copy.
- **`src/keys/voicer.test.ts`, through real `sclang`.** CC 74 at 127
  sets `cc74` to 1.0 on the sounding voice, and a new voice starts with
  it. CC 64 never becomes a control, and CC 1 still arrives as `mod`.
- **`src/generators/voice-render.test.ts`, through real `sclang`.** A
  take with CC 74 renders differently from the same take without it
  through a voice that reads `cc74`, and editing the knob file renders
  the take again. A knob file the schema rejects fails `validate` with
  the schema's errors, so the render stops before `sclang` runs.
- **`src/model/project.test.ts`.** `field check` reports a record
  entry's instrument whose knob file fails the schema, with the errors
  the render's `validate` gives.
- **`src/commands/record-midi-daemon.test.ts` and
  `src/commands/record-plan.test.ts`, chunk 3.** A seeded controller
  lands at `at: 0`. A control change sent after the arm and before the
  start replaces its seed, and two channels' rows come in the order
  their values last arrived. One sent after the start lands at its own
  time. Controllers 120 to 127 are never chased. `field record` reads
  `.field/keys.json` only while its process runs, and only for a daemon
  with `midi-chase`.

The tests through real `sclang` skip by name where it is absent, as
they do today. Most criteria in the table need a terminal with the
kitty protocol, and most make sound, so each pull request's Testing
section records the ones it ran.

## 5 Cost

The hot path is a held turn key or a glide. Each sends at most 25
control changes a second, each one pipe write and one CoreMIDI send,
which keyboard-instrument.md §5 puts well under a millisecond. The
voice host sets one control per sounding synth per change: a five-note
chord on two instruments is 10 sets a tick, 250 a second, which
`scsynth` handles without strain. `field keys` redraws the knob line at
most once a tick, and in chunk 3 writes `.field/keys.json` as often, a
few hundred bytes by rename. Reading a knob file is one small YAML
parse at start and at each save.

The rest is small. A two-second sweep adds about 50 rows to a take's
notes file, and one set per sounding voice per row to its render. The
daemon's chase is a table of 16 channels by 120 controllers that the
audio callback updates in constant time per message before the start,
and writes once, as a few lines in practice. Editing `juno.scd` and
`bass.scd` changes their content hashes, so a take rendered through
either renders once more.

## 6 Rollout

1. **Knobs, live and in takes.** Knob files and `--knobs`; choosing,
   turning, and the knob line; `musical` as the default, with the
   arrows and the bend on `,` and `.`; the voicer's `cc<n>` and
   `FIELD_KNOBS`; the checked copies a voice reads, the render's check,
   and `field check`; `juno` and `bass` with their knob files; the docs;
   and the note at keyboard-instrument.md §3. Criteria 1 to 3, 9 to 11,
   13, 15 to 17, 19, and 22, and criteria 12 and 18 up to their typed
   values.
2. **Typing and the glide.** The `type` action and the number row,
   `Enter`, `Backspace`, and `Period` as the decimal point, `Esc`
   cancelling and no longer quitting, `glide`, and the entry and the
   glide on the knob line, with the note at keyboard-instrument.md
   §2.4. It needs chunk 1's knobs. Criteria 4 to 8, 12, 14, 18, and 23.
3. **Where a take starts.** `.field/keys.json`, `controllers` in `arm`,
   and the daemon's chase. It needs chunk 1's controller map. Criteria
   20 and 21.

## 7 Open questions

Each question is deferred out of this plan, so none blocks a chunk.

1. **Knobs in the Electron UI.** The UI draws knobs for inserts
   (`ui/src/Inserts.tsx`) but nothing of `field keys`, and has no
   channel to it. This plan shows knobs in `field keys` and puts them in
   YAML files that the UI can read as they are. Showing an armed
   instrument's knobs in the UI waits until the UI plays instruments,
   which arming.md chunk 3's arm buttons begin. Justin decides then
   whether it shows them.
2. **Knob keys in `tracker` and `fourths`.** Both spend the arrows on
   transpose and velocity and every row on notes, so neither binds the
   knob actions in this plan, and criterion 15 checks that `tracker`
   is unchanged. A keymap of your own can bind them meanwhile. Justin
   decides, once `musical` has been played with, whether to adapt them
   as `tracked` and `quartal` (§3.2).
3. **More than 128 steps.** Deferred until a knob's steps are audible
   through its lag. MIDI 1.0's 14-bit controller pairs and NRPN are the
   two ways to finer steps, and either changes how a knob names its
   controller. Finer steps would also let a typed value land exactly.
4. **Keeping a sound you dialed in.** Knob positions last for the
   session. Writing them back as the knob file's defaults, or as named
   patches beside it, is deferred until someone wants to keep one;
   until then you copy the values into the file.

## 8 Background

- **The voice contract.** `docs/keys.md` "Make an instrument playable"
  and `docs/build-graph.md` list `freq`, `amp`, `gate`, `out`, and an
  optional `mod`, and nothing else a voice can take. The voicer turns
  CC 1 into `mod` and ignores every other controller but 64 and 123.
- **The instruments.** `juno.scd` and `bass.scd` hold 26 settings in an
  Event and pass it to `ju06a`, whose comment says they "shape the graph
  rather than arriving as controls". `ju06a` tests `pwmMode`,
  `subLevel`, `noiseLevel`, and `chorusOn` with `if`, so those decide
  the graph's shape.
- **Musical Typing's keys.** `keymaps/musical-typing.yaml` plays notes
  on the home row and on `W E T Y U O P`, and binds `Z X C V`, `Tab`,
  and `1` to `8`. `B`, `N`, `M`, `,`, `.`, `/`, `9`, `0`, `-`, `=`,
  `Q`, `R`, `I`, the brackets, and the arrows are free.
- **Esc, Enter, and Backspace.** `isQuit` in `src/keys/terminal.ts`
  quits on an `Esc` press, and `field keys` checks it before the
  session sees the key. Under the protocol's flag 8 the terminal
  reports `Enter` and `Backspace` as `CSI 13 u` and `CSI 127 u`, but
  `positionOf` in `src/keys/position.ts` names only `Tab` and `Space`
  among such keys, so both resolve to nothing today.
- **What a take keeps.** Before the start, the daemon drains MIDI
  arrivals and discards them (`Player` in `native/audiod/src/player.cpp`,
  and `stampMidiBlock` drops any `at` below 0).
- **SuperCollider 3.14.1.** `String.parseYAMLFile` reads a knob file,
  and returns its numbers as strings. `ControlSpec(50, 15000,
  \exp).map(62 / 127)` gives 809.6, which is §2.7's 810 Hz.
- **The sound controllers.** General MIDI 2 adopts the MIDI 1.0 sound
  controller defaults: 71 resonance, 72 release time, 73 attack time,
  74 brightness, which synths use for cutoff, and 75 to 78 decay and
  vibrato.
