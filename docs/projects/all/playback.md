# Plan: Playback

**Status:** Planned, not started. Follows [mix-assembly.md](mix-assembly.md);
the first native code. An interim `bloom play <pattern>` shipped early
(after #7): it builds targets and auditions the files through `afplay` —
useful today, but it plays *artifacts*, not the graph. This phase is still
about the real engine: transport, the timeline, devices, and the control
socket. The afplay path gets retired when the daemon can play.

**Goal:** `bloom play` — audition built artifacts and timeline positions from
the CLI through Core Audio, on the device Bloom selected (Apollo or
otherwise).

## 1 Shape

- The first real-time code, and deliberately minimal: play rendered assets
  with sample-accurate transport (play/pause/stop/locate). This is the seed of
  `bloom-audiod` ([architecture.md](../../architecture.md)), started at the
  smallest useful scope — device selection and enumeration, an output
  callback, a transport clock, and the versioned control socket the CLI (and
  later the widget) speaks.
- It may begin as a thin C++/JUCE tool before growing daemon lifetime
  management; what matters is that the IPC protocol and process boundary are
  the real ones from day one.
- Playing the *graph* (instruments, live SC, inserts) is explicitly later —
  this phase plays built artifacts only.

## 2 Definition of done

`bloom build && bloom play` auditions the mix through the Apollo without
leaving the terminal; transport commands work over the same socket the widget
will eventually use.
