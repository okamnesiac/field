# Keys: the computer keyboard as an instrument

`field keys` turns your computer keyboard into a MIDI instrument. It
publishes a virtual MIDI source named `Field Keys`, so Logic, the
SuperCollider IDE, or any other application that lists MIDI inputs can
play from it. A *keymap* decides what each key plays: a note, a chord,
or a control such as transpose or sustain. Logic Pro's Musical Typing is
the default keymap, and you can write your own.

```console
$ field keys
Playing musical-typing as the MIDI source "Field Keys". Esc or Ctrl-C quits.
Field Keys · musical-typing · transpose 0 · velocity 100 · C4 E4 G4
```

Playing a SuperCollider instrument from `field keys` directly, and
recording what you play, are the later chunks of
[the keyboard-instrument plan](projects/keyboard-instrument/readme.md).

## Before you start

- **A terminal with the kitty keyboard protocol.** A terminal normally
  reports only key presses, and a note needs its release. Ghostty,
  iTerm2 3.5 and later, kitty, and WezTerm report releases through the
  kitty keyboard protocol. Apple's Terminal does not, and `field keys`
  refuses to start there with a message that says so.
- **`field-audiod`.** The virtual MIDI source belongs to the native
  binary, so build it first with `pnpm build:native`.
- **macOS or Linux.** On Linux the virtual source needs the ALSA
  sequencer (`/dev/snd/seq`). Windows has no virtual MIDI sources, and
  `field keys` reports that.

You do not need to be inside a Field project.

If `field keys` says it cannot create a virtual MIDI source on macOS,
run it again. CoreMIDI has refused the first source a new process asked
for, once, and a new process gets a new MIDI client.

## Play

1. Run `field keys` in a supported terminal.
2. In the application you want to play, choose `Field Keys` as the MIDI
   input. In Logic, `Field Keys` appears with your other MIDI inputs.
3. Play. The status line shows the keymap, the transpose, the velocity,
   and the notes sounding.
4. Press `Esc` or `Ctrl-C` to quit. `field keys` sends a note-off for
   every held note and then All Notes Off, so nothing is left sounding,
   and `Field Keys` disappears.

Holding a key holds its note; the terminal's key repeat does nothing.
When the terminal loses focus, `field keys` releases every held note,
because a terminal that has lost focus never reports the release.

To check that notes go out, watch the source from another terminal:

```console
$ field-audiod --midi-monitor "Field Keys"
{"ready":true,"name":"Field Keys"}
{"midi":[144,60,100]}
{"midi":[128,60,0]}
```

The monitor prints every MIDI message from the source you name, so it
also checks a USB controller: give it the controller's name.

## Keys are read by position

A keymap binds *positions*: physical keys, named by their W3C
`KeyboardEvent.code` value, such as `KeyA`, `Semicolon`, `Digit1`, or
`Space`. The name comes from the key a US keyboard has in that place,
but it means the place, whatever your keyboard layout types there. On
Dvorak, `KeyS` types `o`; on AZERTY, `KeyA` types `q`. Both still play
what `KeyS` and `KeyA` play on QWERTY, so you never switch layouts to
play.

`field keys` finds the position from the terminal's *base layout key*
when the terminal sends one, which Ghostty does. Otherwise, on macOS, it
reads your keyboard layout and works back from the character typed. It
follows a layout switch while you play. On Linux it relies on the
terminal alone.

A dead key types nothing on its own and waits for the next key, such as
`'` on U.S. International. The terminal holds it for composition, so it
may never reach `field keys`. When your layout has a dead key where the
keymap binds one, the status line names that position as one that
cannot play.

## The default keymap

`field keys --print` draws a keymap as a keyboard, with the note or
control in each key's place, and lists what each control does. Notes are
in scientific pitch notation, where MIDI note 60 is C4. Logic names the
same note C3.

```console
$ field keys --print
musical-typing: Logic Pro's Musical Typing. White keys on the home row, black keys above.

·     B-1   B+1   cc1   cc1   cc1   cc1   cc1   cc1   ·     ·     ·     ·
   cc64  ·     C#4   D#4   ·     F#4   G#4   A#4   ·     C#5   D#5   ·     ·     ·
          C4    D4    E4    F4    G4    A4    B4    C5    D5    E5    F5
             T-12  T+12  V-20  V+20  ·     ·     ·     ·     ·     ·
```

| Keys | What they do |
| --- | --- |
| `A S D F G H J K L ; '` | White keys, C4 up to F5 |
| `W E`, `T Y U`, `O P` | Black keys |
| `Z`, `X` | Transpose down or up an octave |
| `C`, `V` | Velocity down or up by 20, between 1 and 127 |
| `Tab` | Sustain (CC 64) while held |
| `1`, `2` | Pitch bend fully down or up while held |
| `3` to `8` | Modulation (CC 1): off, then five steps up to 127 |
| `Esc`, `Ctrl-C` | Quit |

Logic's guide describes `Tab` as turning sustain on or off. This keymap
holds sustain only while `Tab` is down, as a pedal does.

## Choose a keymap

| You give | `field keys` loads |
| --- | --- |
| Nothing | `musical-typing` |
| `--keymap musical-typing` | The built-in of that name. A bare name only ever names a built-in. |
| `--keymap ~/keymaps/mine.yaml` | That file. A value with a `/`, or ending in `.yaml`, is a path, and a leading `~/` means your home directory. |
| `FIELD_KEYMAP=<name or path>` | The same, when there is no `--keymap`. |

To make your own keymap the default, set it in your shell profile:

```sh
export FIELD_KEYMAP=~/keymaps/mine.yaml
```

## Write a keymap

A keymap is a YAML file. This one plays C and E on two keys, a C major
chord on a third, and toggles sustain with the space bar:

```yaml
name: mine
base: 60
notes:
  KeyA: 0
  KeyS: 4
  KeyF: [0, 4, 7]
controls:
  Space: { cc: 64, mode: toggle }
```

Run it with `field keys --keymap ~/keymaps/mine.yaml`. While it runs,
saving the file reloads it: the next key press uses the new keymap, and
notes already sounding finish as they started. If the saved file has an
error, `field keys` keeps the keymap it has and shows the error in the
status line. `field keys --keymap ~/keymaps/mine.yaml --print` draws it
without a supported terminal, which helps while you design one.

### Fields

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | Required | Shown in the status line. |
| `description` | None | One line, shown by `--print`. |
| `base` | 60 | The MIDI note that offset 0 plays before any transpose. |
| `velocity` | 100 | The starting velocity. |
| `channel` | 1 | The MIDI channel, 1 to 16. |
| `notes` | None | Each position to an offset in semitones from `base`, or to a list of offsets, which plays a chord. |
| `grid` | None | Offsets for whole rows by a rule. An entry in `notes` or `controls` overrides the grid at that position. |
| `controls` | None | Each position to an action. |

### Grids

A grid writes an isomorphic keymap, where every interval has the same
shape everywhere, in one line. This one puts a semitone between
neighboring keys and a perfect fourth between rows:

```yaml
name: fourths
base: 48
grid: { rows: [bottom, home, top, number], column: 1, row: 5 }
controls:
  ArrowLeft: { transpose: -12 }
  ArrowRight: { transpose: 12 }
```

| Grid field | Meaning |
| --- | --- |
| `rows` | The rows, lowest first. Each is a named row, or a list of positions in which `null` skips a column so you can align rows. The named rows are `bottom` (`KeyZ` to `Slash`), `home` (`KeyA` to `Quote`), `top` (`KeyQ` to `BracketRight`), and `number` (`Digit1` to `Equal`). |
| `column` | Semitones per key to the right. |
| `row` | Semitones per row up. |

A position's offset is `column` times its index in its row, plus `row`
times its row's index. In the example, `KeyZ` plays 48, `KeyA` 53,
`KeyQ` 58, and `Digit1` 63.

### Actions

| Action | Effect |
| --- | --- |
| `{ transpose: <n> }` | Shifts every new note by n semitones, and stays shifted. A transpose that would move any note outside 0 to 127 is refused. |
| `{ velocity: <n> }` | Changes the velocity by n, kept between 1 and 127. |
| `{ bend: <x> }` | Pitch bend to x, from -1 to 1, while held; back to center on release. |
| `{ cc: <n>, value: <v>, mode: <m> }` | Controller n. Mode `set`, the default, sends v at each press. `hold` sends v while held and 0 on release. `toggle` alternates v and 0. `value` defaults to 127. |
| `panic` | Releases every note and sends All Notes Off. Write it as a bare word: `Backquote: panic`. |

### Rules

`field keys` checks a keymap before it plays, and names the position
and the rule each error breaks:

- **Every position is one a keymap can bind.** That is the four named
  rows, `Backquote`, `Backslash`, `IntlBackslash`, `Space`, `Tab`, and
  the four arrows.
- **A position is a note or a control, never both.**
- **`Escape` is reserved.** It always quits, and so does `Ctrl-C`, so no
  keymap can trap you.
- **Every note is in MIDI's range** at `base`, and the keymap plays at
  least one note.
- **Modifiers do not bind.** A key pressed with `Ctrl`, `Alt`, or `Cmd`
  held does nothing, and `Shift` plays as without it. A release always
  ends the notes its press started.
- **Two keys can share a note.** The note sounds from the first press
  until the last of those keys is released.
