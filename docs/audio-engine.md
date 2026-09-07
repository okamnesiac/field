# Audio engine

`field-audiod` exists today as the daemon that plays and captures:
device I/O, a sample-accurate transport, audition of built labels, live
evaluation of the session graph with the build cache as automatic track
freezing ([projects/realtime/readme.md](projects/realtime/readme.md)),
hosted plugins, and the input side of recording — arm, record, stop, a
crash-safe transaction and its recovery — described in
[architecture.md](architecture.md) and under
[Capture as built](#capture-as-built) below. Landing a take in the
project and monitoring through the engine are what remains of
[projects/recording/readme.md](projects/recording/readme.md). This
document records the decisions already settled so the phases that build
it start from agreement, not from scratch. Language and framework
decisions (C++/JUCE, and the alternatives rejected) also live in
[architecture.md](architecture.md).

## Responsibilities

Device discovery and I/O (Core Audio, Apollo), sample-rate and buffer
management, transport and timeline clock, playback, recording,
low-latency monitoring, metronome/count-in/looping/pre-roll/punch,
multitrack sync, AU discovery/hosting/parameter/state management, UAD-2
and UADx execution, plugin latency reporting and delay compensation,
routing/buses/sends, real-time automation, offline rendering where
supported, safe file writing, crash recovery, and peak generation.

Sends did not wait for this engine:
[projects/nested-tracks/readme.md](projects/nested-tracks/readme.md) §19
renders them offline, and that shipped first. A label links exactly one
send to one receive, the edge carries a level and a tap point and never
an offset, and a receive may sit only where its path to the cable's
common ancestor accumulates zero time displacement — which is what makes
arrival times derivable rather than invented (the ambiguity §14
recorded). The engine inherits that schema unchanged: routing/buses/
sends stays on the responsibility list above as the live half of the
same design, and plugin latency compensates to the same answer the
offline render reaches.

## Three real-time paths

During recording, three related but distinct paths run simultaneously:

- **Playback**: existing tracks → instruments/generated nodes → inserts
  → buses → monitor output.
- **Monitoring**: live input → optional monitor effects → cue/monitor
  bus → output. Monitor effects are not printed.
- **Capture**: live input → recording tap → safe disk writer → take
  asset. Capture takes the dry input by default; printed capture
  (`capture.mode: printed`) requires explicit user action because it is
  destructive.

## Monitoring: host vs. Apollo direct

- **Host monitoring** — input through Field's engine and effects, out to
  the interface. Fully project-visible and controllable; costs buffer
  plus plugin latency.
- **Apollo direct** — input monitored in the Apollo's DSP (Console) at
  near-zero latency while Field handles playback and capture.

**Decision — Console is configured manually in V1.** Console is the
mixer in the Apollo's DSP and matters only on the input side (preamp
gain, Unison, direct monitoring, cue mixes); for playback and mixing the
Apollo is just an output device. UA publishes no Console API, so Field
references an expected Console preset (`monitoring.mode: apollo-direct`,
`console_preset: vocal-tracking`) and does not promise automation.

## Latency

Latency is explicit and observable: input, output, buffer, plugin, and
look-ahead latencies, total host-monitoring latency, recorded-file
placement offset, and playback delay compensation are all tracked and
reportable. A latency policy can bypass or substitute high-latency
plugins (look-ahead limiters, linear-phase EQ) when entering record
mode; any changes made for low-latency mode are clearly reported.

## Crash-safe recording

Recording is transactional: a `.field/recording/<transaction-id>/`
directory holds a manifest, a journal, and audio written continuously in
recoverable chunks. A normal stop finalizes the asset and writes a take
manifest (timeline placement, device, latency, monitoring context,
session metadata); after a crash, Field recovers any valid audio from
the transaction.

## Capture as built

The daemon opens its device output-only until something arms
([recording.md](projects/recording/readme.md) §5), so a playback-only
session never asks for the microphone. `arm` names a track, an input
device, and a channel counted from 1; the daemon reopens the device
with that one input channel active and reports the input and output
latency the device declares, in samples. `record` starts a take: it
locates the bed to `at` when you give one, starts the transport if it
is stopped, and captures from the next callback block. The callback
latches that block's transport position as `started_at_samples`, so the
first captured sample and the position it is placed at describe the
same instant. `stop` and `pause` finalize the take and return its
manifest; a `take` event carries the same manifest to every connected
client, which is how a `field record` blocking in one terminal learns
that `field transport stop` in another ended its take.

A transaction is one directory, `.field/recording/take-YYYYMMDD-HHMMSS/`:

- `take.wav` — float32 mono at the device's rate, appended block by
  block. The header's sizes read zero until finalize patches them,
  which is what marks a transaction incomplete on disk.
- `journal.json` — the frames `fsync` has reached the disk with,
  rewritten once a second, and the frames the FIFO refused.
- `manifest.json` — track, device, input, the take's rate and the bed's,
  both latencies, `started_at_samples`, and `complete: true` with
  `frames` once finalized.

The audio callback copies the armed channel into a lock-free FIFO and
does no I/O. A writer thread drains the FIFO to the file every 20 ms. If
the writer falls more than the FIFO holds behind — about twenty seconds
at 48 kHz — the frames that did not fit are counted in `dropped` rather
than blocking the callback, and the manifest carries the count.

To recover a take a dead daemon left behind:

1. Start the daemon. Any `field record` or `field play` does; it lists
   incomplete transactions in `.field/audiod.log`.
2. Run `field record --list` to see every transaction with the frames
   on disk.
3. Run `field record --recover <id>`. The daemon patches the header from
   the file size and marks the manifest `recovered`.

An armed or recording daemon never idle-exits. While a take runs, the
daemon refuses `locate`, `load`, `device.select`, a second `arm`, and
`disarm`, and it defers default-output following and sample-rate
switching until the take ends, because each would restart the device
and gap the capture. A session swap is allowed: it carries the
transport. Landing a finalized take in the project — `audio/<name>/`,
the ledger row, `takes.yaml` — is recording.md chunk 2, so today a take
ends as a path under `.field/recording/`.
