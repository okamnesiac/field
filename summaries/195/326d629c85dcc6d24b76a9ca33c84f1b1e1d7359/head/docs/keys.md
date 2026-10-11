# Keys: the computer keyboard as an instrument

`field keys` turns your computer keyboard into a MIDI instrument. It
publishes a virtual MIDI source named `Field Keys`, so Logic, the
SuperCollider IDE, or any other application that lists MIDI inputs can
play from it. A *keymap* decides what each key plays: a note, a chord,
or a control such as transpose or sustain. Logic Pro's Musical Typing is
the default keymap, and you can write your own.

```console
$ field keys
Field Keys · musical-typing · transpose 0 · velocity 100 · bend +0 · mod 0 · C4 E4 G4
```

Name an instrument and `field keys` plays it too, from the keyboard and
from every other MIDI source:

```console
$ cd examples/bloom
$ field keys pad
pad live at 48000 Hz on MacBook Pro Speakers
Field Keys · musical-typing · transpose 0 · velocity 100 · bend +0 · mod 0 · D4
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
  binary, so build it first with `pnpm build:native`.
- **macOS or Linux.** On Linux the virtual source needs the ALSA
  sequencer (`/dev/snd/seq`). Windows has no virtual MIDI sources, and
  `field keys` reports that.
- **SuperCollider, to play an instrument.** `field keys` finds `sclang`
  the way `field build` does: `FIELD_SCLANG`, then your `PATH`
  (`sclang.exe` on Windows), then where the SuperCollider installer put
  it, which is the macOS app bundle or the newest
  `SuperCollider-<version>` folder under Program Files on Windows.

You do not need to be inside a Field project.

If `field keys` says it cannot create a virtual MIDI source on macOS,
run it again. CoreMIDI has refused the first source a new process asked
for, once, and a new process gets a new MIDI client.

## Play

1. Run `field keys` in a supported terminal.
2. In the application you want to play, choose `Field Keys` as the MIDI
   input. In Logic, `Field Keys` appears with your other MIDI inputs.
3. Play. The status line shows the keymap, the transpose, the velocity,
   the pitch bend and the modulation wheel when the keymap has keys that
   set them, and last the notes sounding, so playing changes only the
   end of the line. The bend runs from `-1` to `+1` and always carries
   its sign, so bending a chord does not move the notes; the wheel runs
   from 0 to 127. Both are what `field keys` last sent; a controller's
   bender and wheel do not change them. On a narrow terminal the text before the notes is shortened,
   and the notes only when they alone are wider than the terminal.
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
entry gives it; `.scd` is added to a name with no extension. A path
works too. Inside a project it resolves from the project root, as a
`supercollider:` entry's `source:` does, so give it from the root even
in a subdirectory; outside a project a path is the only way to name an
instrument, and it resolves from where you are.

1. `field keys` publishes `Field Keys`, then starts a *voice host*:
   `sclang` running Field's `sc/voice-host.scd`. The instrument's line,
   above the status line, says it is starting.
2. The host boots its own `scsynth` on the output device: the one you
   give with `--device` (`field devices` lists them), or the system
   output. It runs at the device's current sample rate and never
   changes it, so `field play` and `field keys` can share a device.
3. The host loads the instrument's voice and plays it from every MIDI
   source, so a USB controller plays it too. The instrument's line
   shows it live, with its device and rate.

The voice's sound goes straight to the device, beside `field play`'s
rather than through the song's inserts and master chain. If something
moves the device to another sample rate while you play, such as a
`field play` of a song at another rate, the host restarts its server at
the new rate, and notes sounding at the switch stop. Without that
restart every note would play sharp or flat.

An instrument that cannot play stops `field keys` with the reason, such
as `creek-kit.scd does not answer FIELD_MODE=voice`. A name that is not
on the shelf lists what is, split into the instruments that play from
notes and those that only render, by whether each program reads
`FIELD_MODE`:

```console
$ field keys organ
field keys organ: no instrument program at …/examples/bloom/shared/instruments/organ.scd
In shared/instruments/:
  plays from notes: bass, juno, pad
  renders only:     creek-kit, seven-eight-loop (no FIELD_MODE=voice branch; Field's docs/keys.md says how to add one)
```

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
| `mod` | Optional: the modulation wheel (CC 1), from 0 to 1, at note-on and whenever it moves |

A voice may leave `mod` out, and then the wheel does nothing to it. In
`musical-typing`, the keys `3` to `8` set the wheel from 0 to full, as
they do in Logic. The voice writes two channels and frees itself after
`gate` goes to 0, with an envelope that ends in `doneAction: 2`. The
render variables are absent in voice mode, so check `FIELD_MODE` before
you read them:

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
sounding note, the sustain pedal (CC 64), All Notes Off (CC 123), pitch
bend, which it applies to `freq` on every sounding voice, up to two
semitones either way, and the modulation wheel, which it sets as `mod`
on every sounding voice and on each new one.

Saving the program while `field keys` plays loads it again. The next
note plays the new voice, and notes already sounding finish as they
started. A save that does not load, such as one with a syntax error,
leaves the last voice that loaded playing, and the instrument's line
says why:

```console
juno kept its last voice: juno.scd does not compile: syntax error, unexpected end of file
```

The next save that loads puts `· reloaded` on the line instead.

`examples/bloom` has three instruments that answer voice mode:

- **`pad`** — the song's sine pad; its render branch is
  unchanged and renders the same bytes as before.
- **`juno`** — the JU-06A, a model of the Roland Juno's chain from
  [okamnesiac/offset](https://github.com/okamnesiac/offset), set to the
  classic Juno pad: saw and pulse with the width swept, a slow attack,
  and the chorus on. The modulation wheel adds vibrato, as the lever on
  a Juno's bender does.
- **`bass`** — the same JU-06A set as offset's bass: a saw with a square
  sub an octave down, a short envelope that opens the filter on each
  note, and no chorus. The modulation wheel opens the filter, up to four
  times its cutoff. It plays at true pitch, so in `musical-typing` press
  `Z` to drop an octave.

## Play a track

Name a track instead of an instrument, and `field keys` plays the
instrument the track's record entry names, whether or not the track has
any takes yet. Name several, and every key plays all of them at once:

```console
$ field keys creek/track:keys creek/track:bass
keys (juno) + bass (bass) live at 48000 Hz on MacBook Pro Speakers
Field Keys · musical-typing · transpose 0 · velocity 100 · bend +0 · mod 0 · C3
```

A target with `track:` in it is a track; anything else is an
instrument, so you can mix the two. A track whose record entry names no
instrument plays the MIDI track under it, down its `track:` inputs, so
naming a bus plays the part it carries. If more than one MIDI track is
under it, `field keys` lists them and stops, and you name the ones you
mean.

The instrument still plays straight to the device, so the inserts on
the track and on the tracks above it are not heard yet. When a track you
named has any, the instrument's line ends
`· dry: the effects on keys-bus are not heard yet`. Hearing them is the
work of
[the live-supercollider plan](projects/live-supercollider/readme.md).

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
         instrument: pad
   ```

2. In one terminal, play the instrument so you hear it while you
   record: `field keys pad`.
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

Name several tracks to record them in one pass: every MIDI track you
name records the same notes, and an audio track records its own input,
so you can sing and play at once:

```console
$ field record creek/track:vox creek/track:keys --at 17
```

A take starts with the modulation wheel at 0, because it records only
the messages that arrive once it has started. A wheel you left up
before then plays live but not in the take's render, so set it again
after the take starts: move the wheel, or press the key that sets it.

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
