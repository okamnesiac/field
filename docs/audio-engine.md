# Audio engine

`field-audiod` exists today as the playback daemon: device I/O, a
sample-accurate transport, and audition of built labels, described in
[architecture.md](architecture.md). The rest of the real-time engine —
recording, monitoring, plugin hosting — is future work, deferred because
the generation-first milestones need none of it; recording is planned in
[projects/all/recording.md](projects/all/recording.md). This document records
the decisions already settled so the phases that build it start from
agreement, not from scratch. Language and framework decisions (C++/JUCE,
and the alternatives rejected) also live in
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
[projects/all/nested-tracks.md](projects/all/nested-tracks.md) §19
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
