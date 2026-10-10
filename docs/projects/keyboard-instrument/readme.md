---
status: ready
priority: now
---

# Plan: Keyboard instrument

**Goal:** `field keys` turns the computer keyboard into a MIDI device
that any application can play from, and `field keys <instrument>` plays
a SuperCollider instrument from it live, so you can audition an
instrument under your fingers. Recording what you play comes last.

## 1 The problem

Field makes sound only by rendering. A SuperCollider instrument in
`shared/instruments/` is a program that `sclang` runs offline, in
scsynth's non-realtime (NRT) mode, from a spec passed in environment
variables: seed, duration, sample rate, and channels. It writes one WAV
and exits ([sc-render.md](../sc-render/readme.md) §2). Nothing in Field
takes notes. No code opens a MIDI input, the daemon hands every hosted
plugin an empty `juce::MidiBuffer`, and no command reads the keyboard
as anything but commands.

So the only way to hear an instrument is to edit its program, render
it, and play the file. That loop suits a pad that renders a fixed
chord. It cannot tell you how a sound responds to a player, which is
how a player judges an instrument. The design expects both:
[project-layout.md](../project-layout/readme.md) §1 decision 6 says the
same `.scd` renders from a spec in one place and responds to notes in
another, depending on how it is invoked. Only the first half exists.

## 2 The solution

`field keys` reads key presses and releases from the terminal and
publishes them as a virtual MIDI source named `Field Keys`, through a
small mode of `field-audiod`. Given an instrument, it also starts a
*voice host*: an `sclang` process that boots its own `scsynth` on the
output device, loads the instrument's *voice* (one SynthDef that plays
one note), and plays it from every MIDI source. A USB controller
therefore plays the same voice as the keyboard does. Last, recording
captures the notes of a performance as a take, timed by the daemon
against the song's transport and rendered offline through the same
voice, so a recorded part builds like any other node.

### 2.1 What happens when you play

1. You run `field keys still-water-pad` in Ghostty or iTerm2, inside a
   project.
2. `field keys` checks that the terminal speaks the kitty keyboard
   protocol (§2.2). If it does not, the command exits with a message
   that names terminals that do.
3. It spawns `field-audiod --midi-source "Field Keys"`. The helper
   creates the virtual source with JUCE's `MidiOutput::createNewDevice`
   and prints a ready line (§2.4).
4. It adds `.scd` to a name that has no extension, and resolves the
   result exactly as a `supercollider:` entry resolves `source:`, to
   `shared/instruments/still-water-pad.scd`. Then it spawns `sclang`
   on the voice host, `sc/voice-host.scd`, with the instrument path,
   the output device, and an `scsynth` port in the environment.
5. The voice host boots `scsynth`, runs the instrument program with
   `FIELD_MODE=voice`, adds the SynthDef the program returns, connects
   every MIDI source, and prints a ready line. The status line in
   `field keys` shows the instrument as live, with the device and its
   sample rate.
6. You press `A`. The terminal reports a press of the key in that
   position. `field keys` maps it to note 60 at the current octave and
   velocity, writes a note-on to the helper, and remembers that `A`
   holds note 60.
7. The helper sends the note-on from `Field Keys`. CoreMIDI delivers it
   to the voice host, which starts a voice with `freq` 261.63, `amp`
   from the velocity, and `gate` 1.
8. You release `A`. `field keys` sends a note-off for the note that `A`
   started, which is 60 even if you changed octave while you held it.
   The voice host sets that voice's `gate` to 0, and the voice frees
   itself when its envelope ends.
9. You press `Esc` or `Ctrl-C`. `field keys` sends a note-off for each
   held note and then All Notes Off (CC 123), and restores the
   terminal. It closes the helper's input, which removes `Field Keys`.
   Last, it sends `/quit` to `scsynth` and stops `sclang`.

Without an instrument, `field keys` stops after step 3 and is a MIDI
device for Logic, the SuperCollider IDE, or anything else that lists
MIDI inputs.

### 2.2 Key releases come from the kitty keyboard protocol

A terminal normally reports only key presses, as the text they type,
and repeats a held key. A note needs its release. The kitty keyboard
protocol adds press, repeat, and release events for a program that
asks for them. Ghostty, iTerm2 3.5 and later, kitty, WezTerm, and foot
implement it. Apple's Terminal does not.

| Step | Bytes `field keys` writes | Why |
| --- | --- | --- |
| Probe | `CSI ? u`, then `CSI c` | A terminal with the protocol answers `CSI ? <flags> u` before its answer to `CSI c`. A terminal that answers only `CSI c` lacks it. |
| Enable | `CSI > 15 u` | Pushes flags 1, 2, 4, and 8. Flag 2 reports event types. Flag 8 reports letter keys as escape codes, which is what gives them release events. Flag 4 adds the base-layout key, the key in that position on a US keyboard, so the layout follows physical position on any keyboard layout. |
| Focus | `CSI ? 1004 h` | Turns on focus reports. On focus-out (`CSI O`), `field keys` releases every held note, because a terminal that has lost focus never reports the release. |
| Restore | `CSI < u`, `CSI ? 1004 l` | Pops the flags and turns off focus reports, on every exit path, including a thrown error. |

In raw mode `Ctrl-C` never raises `SIGINT`, and under the protocol it
arrives as an escape sequence (`CSI 99;5 u`), so `field keys` handles
it as a key. It ignores repeat events: holding a key holds its note.

### 2.3 The layout follows Logic's Musical Typing

| Keys | Action |
| --- | --- |
| `A S D F G H J K L ; '` | White keys, C up to the F an octave above |
| `W E`, `T Y U`, `O P` | Black keys |
| `Z`, `X` | Octave down, octave up |
| `C`, `V` | Velocity down, velocity up, in steps of 10 between 1 and 127 |
| `Tab` | Sustain pedal (CC 64) while held |
| `Esc`, `Ctrl-C` | Quit |

`A` starts at MIDI note 60. The octave keys stop where any key's note
would leave 0 to 127. Notes go out on channel 1 at velocity 100 until
you change it. One status line shows the octave, the velocity, the held
notes, and the instrument's state. It is drawn with raw ANSI codes the
way `src/commands/picker.ts` draws, so it needs no new dependency.

### 2.4 The helper is a byte pipe into CoreMIDI

`field-audiod --midi-source <name>` is a short-lived mode like
`--scan`. It is a separate process from the shared daemon and never
touches the transport. It speaks NDJSON:

| Direction | Line | Meaning |
| --- | --- | --- |
| helper to `field keys` | `{"ready":true,"name":"Field Keys"}` | The virtual source exists. |
| `field keys` to helper | `{"midi":[144,60,100]}` | Send these bytes now, as one message. |
| helper to `field keys` | `{"error":"…"}`, then exit 1 | The platform cannot create a virtual source, or a line did not parse. |

At the end of its input, the helper closes the source and exits 0. So
when `field keys` exits for any reason, `Field Keys` disappears with
it. The helper knows nothing about keys or notes. That logic is
TypeScript, which vitest covers without the native build.

A second mode, `field-audiod --midi-monitor <name>`, prints every
message from the named source as an NDJSON line. The round-trip test
uses it (§4), and it answers "is my controller sending anything" by
hand.

JUCE creates virtual sources through CoreMIDI on macOS and through the
ALSA sequencer on Linux. On Windows it cannot, so the helper reports an
error and `field keys` passes the message on.

### 2.5 The voice contract

An instrument becomes playable by answering a second mode. The render
contract in sc-render.md §2 does not change, and this plan calls it
*render* mode. When `FIELD_MODE` is `voice`, the program must not
render or exit. The value of the file, which is its last expression,
must be a SynthDef with these controls:

| Control | What the voice host sets |
| --- | --- |
| `freq` | The note's frequency in Hz (`note.midicps`) |
| `amp` | `velocity / 127` |
| `gate` | 1 at note-on, 0 at note-off |
| `out` | The output bus, 0 |

The voice writes two channels to `out` and frees itself after `gate`
goes to 0, with an envelope that ends in `doneAction: 2`. The render
variables (`FIELD_OUTPUT`, `FIELD_SEED`, and the rest) are absent in
voice mode, so a program checks `FIELD_MODE` before it reads them:

```supercollider
(
if ("FIELD_MODE".getenv == "voice") {
	SynthDef(\stillWaterKey, { |out = 0, freq = 220, amp = 0.5, gate = 1|
		var env = EnvGen.kr(Env.asr(1.5, 1, 2.5, \sine), gate, doneAction: 2);
		var sig = SinOsc.ar(freq) + (0.35 * SinOsc.ar(freq * 2));
		Out.ar(out, Pan2.ar(sig * amp * 0.2 * env));
	})
} {
	// render mode: the program as it reads today
}
)
```

The voice host owns everything between MIDI and voices:

- **One voice per sounding note.** A note-on for a note that is still
  sounding releases the old voice first.
- **Sustain.** While CC 64 is 64 or more, note-offs wait, and lifting
  the pedal releases them.
- **All Notes Off.** CC 123 releases every voice.
- **Every source and channel.** The host connects every MIDI source at
  start. A controller plugged in later needs a restart.
- **Device and rate.** `scsynth` opens the device from `--device`, or
  the system output when you give none, which is how `field play`
  chooses. The host never sets a sample rate, so `scsynth` runs at the
  device's current rate and never changes it under a running `field
  play`. It asks for a 128-frame hardware buffer.
- **No inputs.** The host sets no input channels, so `scsynth` opens
  no input device and macOS never asks for the microphone.
- **No orphans.** `field keys` chooses the `scsynth` port, so it can
  send `/quit` even if `sclang` has died. The host checks once a second
  that `field keys` is alive, and if it is not, the host quits
  `scsynth` and exits.

If `sclang` exits before its ready line, or the program's value is not
a SynthDef, `field keys` exits 1. It prints the last lines of `sclang`'s
output, because `sclang` reports errors there, as `runScProgram`
already does. It also names the cause: the program does not answer
`FIELD_MODE=voice`.

### 2.6 Recording the keys

The third chunk records a performance against the song. It mirrors
audio recording ([recording.md](../recording/readme.md) §3 and §4), and
§7 holds the questions it settles before it starts:

1. You arm a track and play the keyboard while the song plays. The
   voice host is how you hear yourself.
2. The daemon opens the MIDI sources and stamps each event on the
   transport's sample clock. That is the clock that places an audio
   take as `started_at_samples`.
3. On stop, the take lands as an audio take does: a timestamp-named
   file under `audio/<track>/`, a row in `takes.yaml`, and `chosen`,
   which `field choose` moves.
4. The build renders the chosen take offline. The voice host runs in
   NRT mode, builds a score from the take's notes with the same voice,
   and writes audio that the build caches like a `supercollider:`
   render.

### 2.7 Files

| File | Change |
| --- | --- |
| `src/keys/terminal.ts` (new) | Probes, enables, and restores the kitty protocol and focus reports, and decodes key events from stdin bytes. The decoder is a pure function over bytes. |
| `src/keys/layout.ts` (new) | Maps a base-layout key to a semitone offset or a control (§2.3). |
| `src/keys/session.ts` (new) | The note state: which key holds which note, octave, velocity, sustain, and releasing every note on focus-out and on quit. Emits MIDI bytes. |
| `src/keys/midi-source.ts` (new) | Spawns and talks to `field-audiod --midi-source`, found with `daemonBinary()` from `src/audiod/client.ts`. |
| `src/keys/voice-host.ts` (new) | Resolves the instrument with `programPath()` from `src/generators/supercollider.ts`, picks the `scsynth` port, spawns and waits for the host, and quits it. |
| `src/generators/supercollider.ts` | Extracts the `sclang` lookup (`FIELD_SCLANG`, then `PATH`, then the app bundle) into `sclangCommand()`, shared by `runScProgram` and the voice host. |
| `sc/voice-host.scd` (new) | The voice host (§2.5). Found from the package root, as `python/` is. |
| `src/cli.ts` | `field keys [instrument] [--device <name>]`. |
| `native/audiod/src/midi.cpp`, `midi.h` (new), `main.cpp` | The `--midi-source` and `--midi-monitor` modes. |
| `examples/bloom/shared/instruments/still-water-pad.scd` | Answers voice mode with a gated version of its voice. The render branch keeps its code. |
| `docs/build-graph.md` | The `supercollider` section gains voice mode beside the render contract. |
| `docs/architecture.md` | The daemon's modes gain the MIDI helper. The SuperCollider section's live mode describes the voice host and where its sound goes. |
| `README.md` | `field keys` beside `field play`, with the supported terminals. |

Chunk 3 adds its files when it appends its section (§6).

## 3 Why this design

- **A virtual MIDI device, not a line straight to SuperCollider.**
  `field keys` could send OSC to `scsynth` and skip MIDI. Going through
  CoreMIDI costs one helper process and well under a millisecond. In
  return, a USB controller plays the voice host with no code of its
  own, and `Field Keys` plays Logic. Recording reads MIDI sources for
  the same reason: it records a controller and the keyboard alike.
- **CoreMIDI through `field-audiod`, not an npm module.** An RtMidi
  binding such as `@julusian/midi` would put the virtual source inside
  the Node process. It would also be the control plane's first native
  npm dependency, with prebuilt binaries per platform and per Node ABI.
  The control plane has three runtime dependencies today, none of them
  native. `field-audiod` already links `juce_audio_devices`, which holds
  `MidiOutput::createNewDevice`, and it already runs short-lived modes
  such as `--scan` and `--render`. The architecture keeps
  hardware-facing work and JUCE inside the daemon, and a mode keeps both
  true. The cost is that `field keys` needs `pnpm build:native`, as
  `field play` already does for everything beyond `afplay`.
- **The kitty protocol, not a guess at releases.** Every alternative is
  worse. Inferring a release from the end of auto-repeat is late by the
  repeat delay, about half a second on macOS, and misses short taps.
  Fixed-length notes make every sustained sound unplayable. Capturing
  the keyboard globally, through `CGEventTap` or IOKit HID, needs the
  Input Monitoring permission, plays notes while another window has
  focus, and moves keyboard handling into native code. Refusing Apple's
  Terminal costs one message.
- **`sclang` turns MIDI into voices, not TypeScript.** The voice host
  is SuperCollider's own idiom (`MIDIdef`, `Synth`, `set(\gate, 0)`),
  `sclang` already reads CoreMIDI, and the same code builds an NRT score
  from recorded notes in chunk 3. A TypeScript translator would need
  MIDI input in Node, which is the native dependency rejected above,
  and an OSC encoder for every message.
- **A SynthDef with `freq`, `amp`, and `gate`, not a new instrument
  format.** These are SuperCollider's standard event controls, the same
  names `Pbind` and the default event use, so an existing SynthDef
  usually needs only a gated envelope. One file that answers both modes
  is the shape project-layout.md §1 decision 6 chose for the
  instruments shelf.
- **Straight to the device, not through the live session.** `scsynth`
  opens the output device itself, and Core Audio mixes it with `field
  play` when both run. The voice skips the session's inserts and master
  chain. Putting `scsynth` inside the graph is the work of
  [live-supercollider](../live-supercollider/readme.md), and needs audio
  to cross between processes. Audition needs the instrument's own sound
  with little latency, which the direct path gives now. The voice
  host's interface, an instrument in and sound out, stays the same when
  live-supercollider changes where the sound goes.
- **The daemon stamps recorded notes, not the voice host.** A take is
  placed by the transport's sample clock (recording.md §3), and only
  the daemon has that clock. A time from `sclang` or from `field keys`
  would need its own alignment against the transport, with nothing to
  measure the alignment against.

The plan builds on existing code rather than beside it: `daemonBinary()`
for the helper, `programPath()` for the instrument, `sclang` discovery
shared with `runScProgram`, and the picker's raw-mode pattern with its
restore on every exit path. It replaces nothing.

## 4 Acceptance criteria

Chunks 1 and 2:

| # | Do | Expect |
| --- | --- | --- |
| 1 | In Ghostty, run `field keys`. In another terminal, run `field-audiod --midi-monitor "Field Keys"`. Press and release `A`. | Note-on 60, then note-off 60. `Field Keys` is listed in Audio MIDI Setup. |
| 2 | Hold `A`, press `X`, release `A`. | Note-off 60, not 72. |
| 3 | Hold `A` for two seconds. | One note-on, no repeats. |
| 4 | Hold `A`, then switch to another window. | Note-off 60 when focus leaves. |
| 5 | Hold three keys and press `Ctrl-C`. | Three note-offs, then CC 123. The shell echoes normally. `Field Keys` is gone from Audio MIDI Setup. |
| 6 | Run `field keys` in iTerm2 and repeat criterion 1. | The same. |
| 7 | Run `field keys` in Apple's Terminal. | Exit 1, with a message that names Ghostty, iTerm2, kitty, and WezTerm. The terminal is unchanged. |
| 8 | In `examples/bloom`, run `field keys still-water-pad --device "<Apollo>"`. Play a chord, then hold `Tab` and release the keys. | You hear the chord. The notes ring until you release `Tab`. |
| 9 | With criterion 8 running, play a USB controller. | It plays the same voice. |
| 10 | Run `field keys creek-kit`. | Exit 1. The message says `creek-kit.scd` does not answer `FIELD_MODE=voice`. |
| 11 | Run `field play creek --device "<Apollo>"` and criterion 8 together. | You hear both. The Apollo's sample rate in Audio MIDI Setup does not change. |
| 12 | With criterion 8 running, `kill -9` the `field keys` process. | Within two seconds, `pgrep scsynth` finds no host server, and `Field Keys` is gone. |
| 13 | In `examples/bloom`, run `field sc render shared/instruments/still-water-pad.scd --seed 90210 --duration 10 --output <file>` before and after the edit, and compare the two files with `cmp`. | Identical. A difference means the edit changed the render branch. |

These vitest tests fail before the change:

- **`src/keys/terminal.test.ts`.** Decodes press, repeat, and release of
  `a` with its base-layout key, `Ctrl-C`, `Esc`, focus in and out, and a
  sequence split across two chunks. Reads probe answers with and
  without the protocol.
- **`src/keys/session.test.ts`.** Covers an octave change while a key
  is held, ignored repeats, sustain, release on focus-out, the quit
  sequence, and the octave bounds.
- **`src/keys/midi-source.test.ts`.** Runs against a stub helper. Checks
  the ready line, an error line, and the stub seeing end of input when
  `field keys` closes it.
- **The native round trip.** Runs `--midi-source` and `--midi-monitor`
  together and checks that a note arrives. The test probes for a MIDI
  service first, and where there is none, such as a Linux container
  without the ALSA sequencer, it reports itself skipped by name. A green
  run without a MIDI service never reads as coverage.

The voice host has no automated test, because it needs `sclang` and an
audio device, and CI has neither. Criteria 8 to 13 are checked by hand,
and the pull request's Testing section records them. Chunk 3 writes its
own criteria when it appends its section.

## 5 Cost

CPU cost does not matter here. A key event is a few dozen bytes
through a pipe and one CoreMIDI send, at the rate a person types.
Latency from key to sound is what matters, and it is an estimate until
criterion 8 is played:

| Stage | Expected |
| --- | --- |
| Terminal to `field keys` | Depends on the terminal; not measured |
| Pipe and CoreMIDI | Well under 1 ms |
| `sclang` to `scsynth`, sent without a timestamp | Up to one control block of jitter: 64 samples, 1.3 ms at 48 kHz |
| `scsynth`'s hardware buffer | 128 frames, 2.7 ms at 48 kHz, plus the device's output latency |

If playing feels late, the hardware buffer is the first thing to
reduce. The one build cost is the `still-water-pad` edit. Its content
hash is a cache input, so every song that places it renders the pad
once more.

## 6 Rollout

Each chunk is one pull request, in order:

1. **`field keys` as a MIDI device.** The terminal, the layout, the
   session, the helper and its monitor mode, and the docs. It is useful
   alone, with Logic.
2. **The voice host.** `field keys <instrument>`, the voice contract,
   `still-water-pad` in voice mode, and the docs.
3. **Recording.** It starts by settling §7 questions 1 to 3 and
   appending its design, files, and criteria as a new numbered section.
   Then it builds them.

## 7 Open questions

1. **The take's file format (chunk 3).** A Standard MIDI File opens in
   Logic and rides LFS like audio. A text list of notes with sample
   times diffs in review, and an agent can edit it. It also carries the
   sample time that places a take, which a MIDI file has no field for.
   The recommendation is the text list, with `field export` writing a
   MIDI file when you need one elsewhere. Justin decides when chunk 3
   starts.
2. **The entry that plays a take (chunk 3).** It could be a `record:`
   entry with an `instrument:` field, or a new entry kind for a part
   that drives an instrument, which nested-tracks.md §18 decision 4
   expects. recording.md §4 keeps `record:` empty until a field earns
   its place, and an instrument would be the first that does. Justin
   decides with question 1.
3. **Who builds the NRT score (chunk 3).** In chunk 3, the voice host
   builds the score for a recorded take. sc-render.md §2 rejected Field
   generating scores, because the program is the recipe. The voice
   contract narrows what Field knows to `freq`, `amp`, and `gate`. The
   alternative is a third mode that hands the program the notes and
   lets it render. Justin decides with question 2.
4. **Hearing the voice through the mix.** The voice skips inserts and
   the master chain until live-supercollider puts `scsynth` in the
   graph. This is deferred to that project on purpose.
5. **Reloading the voice when its file changes.** The voice host could
   re-run the program and add the new SynthDef while you play. This is
   deferred until chunk 2 has been played with.

## 8 Background

- **No MIDI input exists.** A search of the tracked code finds no
  CoreMIDI or JUCE `MidiInput` use. `native/audiod/src/hosting.cpp`
  passes an empty `juce::MidiBuffer` to each plugin's `processBlock`
  (the member is declared in `hosting.h`). The `type: midi` track kind
  was retired as a placeholder that rendered nothing (nested-tracks.md
  §18 decision 4).
- **The two stub plans do not cover this.**
  [live-supercollider](../live-supercollider/readme.md) puts `scsynth`
  in the real-time graph, and
  [external-instruments](../external-instruments/readme.md) sends MIDI
  out to hardware. Neither takes notes in.
- **Terminal support.** The kitty protocol's own documentation lists
  Ghostty, iTerm2, kitty, WezTerm, and foot as implementations, and
  iTerm2's 3.5 releases carry fixes to its kitty key reporting. Release
  events are opt-in under flag 2, and letter keys report them only
  under flag 8. Criteria 1 and 6 confirm both terminals by hand.
- **The instruments today.** The three in `examples/bloom` are NRT
  programs that render whole passages. `still-water-pad.scd` builds a
  D-minor chord from twelve sine voices under `Env.linen`, a fixed-length
  envelope. Its voice is already one SynthDef, and a gated envelope
  makes it playable.
