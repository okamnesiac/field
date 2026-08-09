# Audio engine

The real-time engine, `field-audiod`, is future work — deferred until the
playback phase because the generation-first milestones need no real-time code.
This document records the decisions already settled so the phases that build
it start from agreement, not from scratch. Language and framework decisions
(C++/JUCE, and the alternatives rejected) live in
[architecture.md](architecture.md).

## Responsibilities

Device discovery and I/O (Core Audio, Apollo), sample-rate and buffer
management, transport and timeline clock, playback, recording, low-latency
monitoring, metronome/count-in/looping/pre-roll/punch, multitrack sync, AU
discovery/hosting/parameter/state management, UAD-2 and UADx execution, plugin
latency reporting and delay compensation, routing/buses/sends, real-time
automation, offline rendering where supported, safe file writing, crash
recovery, peak generation.

Sends arrive here rather than in the offline renderer, and their rules are
already decided: target anything that is not a descendant, detect cycles,
name a send that reaches into itself, and carry a level and never an
offset ([projects/all/nested-tracks.md](projects/all/nested-tracks.md)
§1.7, §1.8). §14 there records why they waited — a send expresses flow,
and offsets are how an offline model spells position, so building one
offline means inventing arrival times that real time would immediately
contradict.

## Three real-time paths

During recording, three related but distinct paths run simultaneously:

- **Playback**: existing tracks → instruments/generated nodes → inserts →
  buses → monitor output.
- **Monitoring**: live input → optional monitor effects → cue/monitor bus →
  output. Monitor effects are not printed.
- **Capture**: live input → recording tap → safe disk writer → take asset.
  Captures the dry input by default; printed capture (`capture.mode: printed`)
  requires explicit user action because it is destructive.

## Monitoring: host vs. Apollo direct

- **Host monitoring** — input through Field's engine and effects, out to the
  interface. Fully project-visible and controllable; costs buffer + plugin
  latency.
- **Apollo direct** — input monitored in the Apollo's DSP (Console) at
  near-zero latency while Field handles playback and capture.

**Decision — Console is configured manually in V1.** Console is the mixer in
the Apollo's DSP and matters only on the input side (preamp gain, Unison,
direct monitoring, cue mixes); for playback and mixing the Apollo is just an
output device. UA publishes no Console API, so Field references an expected
Console preset (`monitoring.mode: apollo-direct`, `console_preset:
vocal-tracking`) and does not promise automation.

## Latency

Latency is explicit and observable: input/output/buffer/plugin/look-ahead
latencies, total host-monitoring latency, recorded-file placement offset, and
playback delay compensation are all tracked and reportable. A latency policy
can bypass or substitute high-latency plugins (look-ahead limiters,
linear-phase EQ) when entering record mode; any changes made for low-latency
mode are clearly reported.

## Crash-safe recording

Recording is transactional: a `.field/recording/<transaction-id>/` directory
holds a manifest, journal, and audio written continuously in recoverable
chunks. Normal stop finalizes the asset and writes a take manifest (timeline
placement, device, latency, monitoring context, session metadata); after a
crash, Field recovers any valid audio from the transaction.
