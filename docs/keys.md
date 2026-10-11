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

Name an instrument and `field keys` plays it too, from the keyboard and
from every other MIDI source:

```console
$ cd examples/bloom
$ field keys still-water-pad
Playing musical-typing as the MIDI source "Field Keys". Esc or Ctrl-C quits.
Field Keys · musical-typing · transpose 0 · velocity 100 · D4 · still-water-pad live at 48000 Hz on MacBook Pro Speakers
```

To keep what you play, record it into a track; see
[Record what you play](#record-what-you-play).

## Before you start

- **A terminal with the kitty keyboard protocol.** A terminal normally
  reports only key presses, and a note needs its release. Ghostty,
  iTerm2 3.5 and later, kitty, and WezTerm report releases through the
  kitty keyboard protocol. Apple's Terminal does not, and `field keys`
  refuses to start there with a message that says so.
- **`field-audiod`.** The virtual MIDI source belongs to the native
  binary, so build it first with `field upgrade audiod`.
- **macOS or Linux.** On Linux the virtual source needs the ALSA
  sequencer (`/dev/snd/seq`). Windows has no virtual MIDI sources, and
  `field keys` reports that.
- **SuperCollider, to play an instrument.** `field keys` finds `sclang`
  the way `field build` does: `FIELD_SCLANG`, then your `PATH`, then
  the macOS app bundle.

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

To check that notes go out, watch the source from another terminal.
`field-audiod` is not on your `PATH`, because installing Field links
only `field`; run it from your Field checkout, or through
`$FIELD_AUDIOD` if you set that:

```console
$ native/audiod/build/field-audiod_artefacts/Release/field-audiod --midi-monitor "Field Keys"
{"ready":true,"name":"Field Keys"}
{"midi":[144,60,100]}
{"midi":[128,60,0]}
```

The monitor prints every MIDI message from the source you name, so it
also checks a USB controller: give it the controller's name.

## Play an instrument

`field keys <instrument>` plays a SuperCollider instrument from the
project's `shared/instruments/` shelf, by the name a `supercollider:`
entry gives it, with or without `.scd`. A path works too. Inside a
project it resolves from the project root, as a `supercollider:` entry's
`source:` does, so give it from the root even in a subdirectory; outside
a project a path is the only way to name an instrument, and it resolves
from where you are.

1. `field keys` publishes `Field Keys`, then starts a *voice host*:
   `sclang` running Field's `sc/voice-host.scd`. The status line says
   the instrument is starting.
2. The host boots its own `scsynth` on the output device: the one you
   give with `--device` (`field devices` lists them), or the system
   output. It runs at the device's current sample rate and never
   changes it, so `field play` and `field keys` can share a device.
3. The host loads the instrument's voice and plays it from every MIDI
   source, so a USB controller plays it too. The status line shows the
   instrument live, with its device and rate.

The voice's sound goes straight to the device, beside `field play`'s
rather than through the song's inserts and master chain. If something
moves the device to another sample rate while you play, such as a
`field play` of a song at another rate, the host restarts its server at
the new rate, and notes sounding at the switch stop. Without that
restart every note would play sharp or flat.

An instrument that cannot play stops `field keys` with the reason, such
as `creek-kit.scd does not answer FIELD_MODE=voice`.

### Make an instrument playable

An instrument program renders from a spec when Field builds it. To play
it from notes as well, give it a voice mode: when `FIELD_MODE` is
`voice`, its value, the file's last expression, must be a SynthDef with
these controls, and it must not render or exit.

| Control | What the voice host sets |
| --- | --- |
| `freq` | The note's frequency in Hz |
| `amp` | The velocity divided by 127 |
| `gate` | 1 at note-on, 0 at note-off |
| `out` | The output bus, 0 |

The voice writes two channels and frees itself after `gate` goes to 0,
with an envelope that ends in `doneAction: 2`. The render variables are
absent in voice mode, so check `FIELD_MODE` before you read them:

```supercollider
(
if ("FIELD_MODE".getenv == "voice") {
	SynthDef(\myKey, { |out = 0, freq = 220, amp = 0.5, gate = 1|
		var env = EnvGen.kr(Env.asr(0.01, 1, 0.5), gate, doneAction: 2);
		Out.ar(out, Pan2.ar(SinOsc.ar(freq) * amp * 0.2 * env));
	})
} {
	// render mode: the program as it reads today
}
)
```

The host owns everything between MIDI and voices: one voice per
sounding note, the sustain pedal (CC 64), All Notes Off (CC 123), and
pitch bend, which it applies to `freq` on every sounding voice, up to
two semitones either way. It ignores modulation (CC 1) for now. In
`examples/bloom`, `still-water-pad` answers voice mode; its render
branch is unchanged and renders the same bytes as before.

## Record what you play

A track records what you play when its `record:` entry names an
instrument. The take keeps the notes, not the sound, and the build
renders them through the instrument, so changing the instrument
changes every take recorded for it.

1. Give the track a record entry with the instrument:

   ```yaml
   # songs/creek/tracks/keys.yaml
   name: keys
   inputs:
     - record:
         instrument: still-water-pad
   ```

2. In one terminal, play the instrument so you hear it while you
   record: `field keys still-water-pad`.
3. In another, record against the song. With nothing playing, `field
   record` loads the song as the bed. Press Ctrl-C to stop.

   ```console
   $ field record creek/track:keys --at 17
   live    creek
   armed   MIDI from Field Keys  (48000 Hz, latency out 512 samples)
   recording take-20261010-143012 from 17.1.1 (0:32.0)
     17.3.2 (0:33.2)  14 events 1.2s
   take    creek/keys ← take-20261010-143012 at bar 17, chosen (audio/keys/take-20261010-143012.notes.yaml, 4.2 s, 31 events)
   ```

4. `field build creek` renders the take through the instrument, and
   `field play creek` plays it in the mix.

A MIDI take listens to every MIDI source on the machine when
`field record` arms, so a controller records too. Start `field keys`
and connect controllers first: a source that appears after the arm is
not heard. `--at`, `--until`, `--click`, and `--count-in`
work as they do for audio; `--input`, `--device`, and `--loop` are for
audio takes only. The take is placed by the output latency alone,
because you play in time with what you hear. `field choose` picks
among takes as it does for audio. For the files a take leaves, see
[project-model.md](project-model.md) "MIDI takes".

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

## The other built-in keymaps

Two more keymaps ship with Field. Each puts octave and velocity on the
arrows and sustain on `Space`, because notes take the rows Musical
Typing keeps for controls.

| Keymap | What it plays | Range |
| --- | --- | --- |
| `tracker` | The layout trackers use, from FastTracker 2 to Renoise: the `Z` row and the `Q` row as two piano octaves, each with its black keys on the row above. `Z` plays C3. | 32 notes |
| `fourths` | An isomorphic grid: one semitone per key to the right, and each row a perfect fourth above the row below, as on a bass guitar or Ableton Push. A chord shape plays the same in every key. `Z` plays C3. | 27 notes |

Run `field keys --keymap tracker --print` or `--keymap fourths --print`
to see either one laid out on the keyboard.

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
notes already sounding finish as they started. A controller you toggled
on, such as this example's sustain, goes back to 0 on the reload, so the
notes it was holding end. If the saved file has an error, `field keys`
keeps the keymap it has and shows the error in the status line.
`field keys --keymap ~/keymaps/mine.yaml --print` draws it without a
supported terminal, which helps while you design one.

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
| `{ cc: <n>, value: <v>, mode: <m> }` | Controller n. Mode `set`, the default, sends v at each press. `hold` sends v while held and 0 on release. `toggle` alternates v and 0, and goes back to 0 when you quit, press `panic`, or reload the keymap. `value` defaults to 127. |
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
