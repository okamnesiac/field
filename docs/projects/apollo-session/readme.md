---
status: draft
priority: later
---

# Plan: The first Apollo session

**Goal:** a take recorded against creek on the Apollo plays back in
place, compensated, from `field build && field play`. That is the half
of [recording.md](../recording/readme.md) §9's definition of done that
only real hardware can prove.

Recording completed with three items owed to that session:

- **The loopback measurement.** Placement subtracts the round trip the
  device declares. A cable from output to input shows whether that
  figure matches what the hardware does (recording.md §12.3 and
  §13.2).
- **The other first-session checks.** The macOS microphone prompt for
  a daemon that `field` spawned detached, and the duplex open on an
  Apollo whose input and output are one device, and on a pair of
  devices JUCE combines (recording.md §12.10).
- **The `hardware/` schema.** The committed file that binds a named
  input and an expected Console preset per machine class, written from
  the first session's manifests rather than ahead of them
  (recording.md §11). [project-model.md](../../project-model.md) lists
  `hardware/apollo.yaml` as designed but not yet built.

No plan yet. This entry carries the work recording owed to the Apollo
when it completed; write the plan here when that session happens.
